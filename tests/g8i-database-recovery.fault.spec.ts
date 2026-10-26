import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { createPool } from '../apps/api/src/config.js';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { createCore, startWorker } from '../packages/core/src/index.js';
import type { CoreService } from '../packages/contracts/src/index.js';
import type { WorkerHandle } from '../packages/core/src/worker.js';
import { startG8iPostgres, type G8iDatabase } from './fixtures/g8i-isolated-postgres.js';
import { startG8iPgFaultProxy } from './fixtures/g8i-pg-fault-proxy.js';

let database:G8iDatabase,proxy:Awaited<ReturnType<typeof startG8iPgFaultProxy>>|undefined,pool:Pool|undefined,worker:WorkerHandle|undefined;
let core:CoreService,schema:string,actor:{userId:string};
const report:{boundary:string;isolation?:unknown;cases:Record<string,unknown>[];cleanup?:unknown}={boundary:'Real PostgreSQL backend termination and TCP response loss in an exclusive container. Application and synthetic provider remain separate transactions in the same database; no independent external bank availability or host power-loss claim.',cases:[]};
const reportPath=resolve('evals/results',`${new Date().toISOString().replaceAll(':','-')}-g8i-db-fault-evidence.json`);
beforeAll(async()=>{database=await startG8iPostgres();report.isolation=database.evidence;});
beforeEach(async()=>{
 const id=randomUUID().replaceAll('-','').slice(0,16);schema=`g8i_fault_${id}`;actor={userId:`g8i-actor-${id}`};
 proxy=await startG8iPgFaultProxy(database.port,database.admin,database.database);
 const url=new URL(database.connectionString);url.port=String(proxy.port);
 const priorDatabaseUrl=process.env.DATABASE_URL;
 try{process.env.DATABASE_URL=url.toString();pool=createPool();}
 finally{if(priorDatabaseUrl===undefined)delete process.env.DATABASE_URL;else process.env.DATABASE_URL=priorDatabaseUrl;}
 pool.options.application_name=`g8i_fault_${id}`;pool.options.connectionTimeoutMillis=2000;
 core=createCore(pool,{schema,reconcileDelayMs:60_000});await core.migrate();await core.seedDemo(actor);
});
afterEach(async()=>{
 try{await worker?.stop();worker=undefined;}
 finally{try{await pool?.end();pool=undefined;}finally{await proxy?.close();proxy=undefined;if(schema){await database.admin.query(`DROP SCHEMA IF EXISTS "${schema}_jobs" CASCADE`);await database.admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);}}}
});
afterAll(async()=>{report.cleanup=await database?.close();await mkdir(resolve('evals/results'),{recursive:true});await writeFile(reportPath,JSON.stringify(report,null,2)+'\n');expect(report.cleanup).toMatchObject({containerRemoved:true,volumeRemoved:true,portClosed:true,errors:[]});});
const proof=(action:{actionHash:string})=>({proofId:randomUUID(),actionHash:action.actionHash,level:'CONFIRMATION' as const});
async function draft(){return core.createTransfer(actor,{commandId:randomUUID(),accountId:`acc-main-${actor.userId}`,payeeId:'payee-lin',amountMinor:'30750',memo:'G8I isolated database recovery'});}
async function snapshot(actionId:string){
 const q=(sql:string,values:unknown[]=[])=>database.admin.query(sql,values);
 const action=(await q(`SELECT id,status,reserved,auth_proof_id,receipt FROM "${schema}".actions WHERE id=$1`,[actionId])).rows[0];
 const balance=(await q(`SELECT balance_minor::text AS local FROM "${schema}".accounts WHERE user_id=$1`,[actor.userId])).rows[0].local;
 const provider=(await q(`SELECT balance_minor::text AS provider FROM "${schema}".provider_accounts WHERE id=$1`,[`acc-main-${actor.userId}`])).rows[0].provider;
 const transfers=(await q(`SELECT provider_key,receipt FROM "${schema}".provider_transfers`)).rows;
 const entries=(await q(`SELECT provider_key,side,amount_minor::text FROM "${schema}".provider_entries ORDER BY side`)).rows;
 const proofs=(await q(`SELECT proof_id,action_id FROM "${schema}".authorization_proofs`)).rows;
 return{action,balance,provider,transfers,entries,proofs};
}
async function runWorkerToSuccess(actionId:string){worker=await startWorker(pool!,core);await expect.poll(async()=>(await core.getAction(actor,actionId)).status,{timeout:12_000,interval:100}).toBe('SUCCEEDED');await worker.stop();worker=undefined;}
function exactlyOnce(value:Awaited<ReturnType<typeof snapshot>>){expect(value.balance).toBe('769250');expect(value.provider).toBe('769250');expect(value.action.status).toBe('SUCCEEDED');expect(value.action.reserved).toBe(false);expect(value.transfers).toHaveLength(1);expect(value.proofs).toHaveLength(1);expect(value.entries).toEqual([{provider_key:value.transfers[0].provider_key,side:'CREDIT',amount_minor:'30750'},{provider_key:value.transfers[0].provider_key,side:'DEBIT',amount_minor:'30750'}]);}

it('real backend termination before authorization COMMIT rolls back and original proof safely retries',async()=>{
 const action=await draft(),authorization=proof(action);
 const injected=proxy!.arm('terminate_before_commit',`INSERT INTO "${schema}".authorization_proofs`,async()=>false);
 const [request,fault]=await Promise.allSettled([core.authorize(actor,action.id,authorization),injected]);
 expect(request.status).toBe('rejected');expect(fault.status).toBe('fulfilled');
 const observed=(fault as PromiseFulfilledResult<unknown>).value;report.cases.push({name:'authorization-before-commit',fault:observed});
 expect(observed).toMatchObject({commitForwarded:false,commitObserved:false,terminationConfirmed:true,connectionClosed:true});
 const rolledBack=await snapshot(action.id);expect(rolledBack.action.status).toBe('AWAITING_CONFIRMATION');expect(rolledBack.action.reserved).toBe(false);expect(rolledBack.proofs).toEqual([]);expect(rolledBack.transfers).toEqual([]);expect(rolledBack.balance).toBe('800000');
 core=createCore(pool!,{schema,reconcileDelayMs:60_000});expect((await core.authorize(actor,action.id,authorization)).status).toBe('AUTHORIZED');
 await runWorkerToSuccess(action.id);await core.execute(action.id);await core.reconcile(action.id);
 const final=await snapshot(action.id);exactlyOnce(final);Object.assign(report.cases.at(-1)!,{rolledBack,final});
});
it('lost authorization COMMIT response preserves one proof/reservation and original action replays safely',async()=>{
 const action=await draft(),authorization=proof(action);
 const injected=proxy!.arm('drop_committed_response',`INSERT INTO "${schema}".authorization_proofs`,async()=>(await database.admin.query(`SELECT 1 FROM "${schema}".authorization_proofs WHERE proof_id=$1`,[authorization.proofId])).rowCount===1);
 const [request,fault]=await Promise.allSettled([core.authorize(actor,action.id,authorization),injected]);
 expect(request.status).toBe('rejected');expect(fault.status).toBe('fulfilled');const observed=(fault as PromiseFulfilledResult<unknown>).value;report.cases.push({name:'authorization-commit-response-lost',fault:observed});
 expect(observed).toMatchObject({commitForwarded:true,commitObserved:true,terminationConfirmed:false,connectionClosed:true});
 const committed=await snapshot(action.id);expect(committed.action.status).toBe('AUTHORIZED');expect(committed.action.reserved).toBe(true);expect(committed.proofs).toHaveLength(1);expect(committed.transfers).toEqual([]);expect(committed.balance).toBe('800000');
 core=createCore(pool!,{schema,reconcileDelayMs:60_000});
 // Core intentionally rejects duplicate authorization. Recovery reads the same
 // action and continues its durable outbox; no replacement proof is manufactured.
 await expect(core.authorize(actor,action.id,authorization)).rejects.toMatchObject({code:'INVALID_STATE'});
 expect(await snapshot(action.id)).toEqual(committed);
 expect((await core.getAction(actor,action.id)).status).toBe('AUTHORIZED');
 await runWorkerToSuccess(action.id);await core.execute(action.id);
 const final=await snapshot(action.id);exactlyOnce(final);Object.assign(report.cases.at(-1)!,{committed,final});
});
it('lost synthetic-provider COMMIT response retains UNKNOWN reservation then reconciles only the original receipt',async()=>{
 const action=await draft();await core.authorize(actor,action.id,proof(action));
 const providerKey=(await database.admin.query(`SELECT provider_key FROM "${schema}".actions WHERE id=$1`,[action.id])).rows[0].provider_key;
 const injected=proxy!.arm('drop_committed_response',`INSERT INTO "${schema}".provider_transfers`,async()=>(await database.admin.query(`SELECT 1 FROM "${schema}".provider_transfers WHERE provider_key=$1`,[providerKey])).rowCount===1);
 const [request,fault]=await Promise.allSettled([core.execute(action.id),injected]);
 expect(fault.status).toBe('fulfilled');expect(request.status).toBe('fulfilled');const observed=(fault as PromiseFulfilledResult<unknown>).value;report.cases.push({name:'provider-commit-response-lost',fault:observed});
 expect((request as PromiseFulfilledResult<{status:string}>).value.status).toBe('UNKNOWN');expect(observed).toMatchObject({commitForwarded:true,commitObserved:true,connectionClosed:true});
 const unknown=await snapshot(action.id);expect(unknown.balance).toBe('800000');expect(unknown.provider).toBe('769250');expect(unknown.action.reserved).toBe(true);expect(unknown.transfers).toHaveLength(1);expect(unknown.entries).toHaveLength(2);
 core=createCore(pool!,{schema,reconcileDelayMs:60_000});await core.reconcile(action.id);await core.execute(action.id);await core.reconcile(action.id);
 const final=await snapshot(action.id);exactlyOnce(final);expect(final.action.receipt).toEqual(unknown.transfers[0].receipt);Object.assign(report.cases.at(-1)!,{unknown,final});
});

it('SIGKILL of only the isolated database container preserves the authorized outbox and the running worker reconnects',async()=>{
 const action=await draft();await core.authorize(actor,action.id,proof(action));
 const lock=await database.admin.connect();let lockReleased=false,lockErrors=0;
 lock.on('error',()=>{lockErrors++;});
 try{
  await lock.query('BEGIN');await lock.query(`SELECT id FROM "${schema}".outbox WHERE action_id=$1 FOR UPDATE`,[action.id]);
  worker=await startWorker(pool!,core);
  const before=await snapshot(action.id);expect(before.action.status).toBe('AUTHORIZED');expect(before.transfers).toEqual([]);
  expect((await database.admin.query(`SELECT sent_at FROM "${schema}".outbox WHERE action_id=$1`,[action.id])).rows[0].sent_at).toBeNull();
  const fault=await database.killAndRestart();lock.release(true);lockReleased=true;
  report.cases.push({name:'isolated-container-sigkill-restart',fault,before,lockErrors});
  await expect.poll(async()=>(await core.getAction(actor,action.id)).status,{timeout:15_000,interval:150}).toBe('SUCCEEDED');
  await worker.stop();worker=undefined;
  await core.execute(action.id);await core.reconcile(action.id);
  const final=await snapshot(action.id);exactlyOnce(final);Object.assign(report.cases.at(-1)!,{final});
 }finally{if(!lockReleased)lock.release(true);}
});
