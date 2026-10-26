import { createConversationService } from '../apps/api/src/conversations.js';
import { createPlanningJournal } from '../apps/api/src/planning-journal.js';
import { registerCheckpointAttempt, setupCheckpointFencing, transferCheckpointAttempt } from '../packages/agents/src/checkpoint-fencing.js';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { createApp, migrateApi } from '../apps/api/src/app.js';
import { createCore, createFinance } from '../packages/core/src/index.js';
import { observePoolErrors } from '../packages/core/src/database.js';
import { createPlanner } from '../packages/agents/src/index.js';
import { startG8iPostgres, type G8iDatabase } from './fixtures/g8i-isolated-postgres.js';
import { startG8iPgFaultProxy } from './fixtures/g8i-pg-fault-proxy.js';

let database:G8iDatabase, proxy:Awaited<ReturnType<typeof startG8iPgFaultProxy>>, pool:Pool;
let schema:string,actor:{userId:string},core:ReturnType<typeof createCore>,finance:ReturnType<typeof createFinance>,app:ReturnType<typeof createApp>;
let mock:ReturnType<typeof vi.spyOn>,calls:{role:string;cap:number}[];
const origin='http://localhost:5178',text='给林晓转账317.25元，备注恢复核对';
const report:{boundary:string;isolation?:unknown;cases:unknown[];cleanup?:unknown}={boundary:'Actual Hono routes and planner/provider with controlled model.invalid responses and stub session; real PostgreSQL TCP faults. No real authentication/browser/cloud or external bank availability claim.',cases:[]};
const reportPath=`evals/results/${new Date().toISOString().replaceAll(':','-')}-g8j-planning-fault-evidence.json`;
const json=(value:unknown)=>new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(value)}}]}));
function rebuild(){
 const auth={api:{getSession:async()=>({user:{id:actor.userId,email:'g8j@example.test'}})}};
 const planner=createPlanner({provider:{baseURL:'https://model.invalid',model:'g8j-controlled',outputMode:'json_object',maxAttempts:2,retryDelayMs:1}});
 app=createApp({pool,core,finance,planner,auth:auth as never,origin,rpID:'localhost',sandbox:false,plannerMode:'model'});
}
const request=(path:string,body?:unknown)=>app.request(`${origin}${path}`,{method:body===undefined?'GET':'POST',headers:{Origin:origin,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
const rows=async(table:string)=>(await database.admin.query(`SELECT * FROM "${schema}".${table}`)).rows;
async function snapshot(){return{commands:await rows('bp_plan_commands'),messages:await rows('bp_chat_messages'),actions:await rows('actions'),proofs:await rows('authorization_proofs'),provider:await rows('provider_transfers'),calls:[...calls]};}
async function conversation(){const response=await request('/api/conversations',{title:'G8J 独立数据库故障'});expect(response.status).toBe(201);return(await response.json()).id as string;}
async function completed(cid:string,id:string){
 const response=await request(`/api/conversations/${cid}/commands/${id}`);expect(response.status).toBe(200);const command=await response.json();expect(command.status).toBe('complete');
 const state=await snapshot();expect(state.commands).toHaveLength(1);expect(state.commands[0]).toMatchObject({command_id:id,revision:0,status:'complete'});
 expect(state.messages.filter(m=>m.role==='user')).toHaveLength(1);expect(state.messages.filter(m=>m.kind==='result')).toHaveLength(1);
 expect(state.actions).toHaveLength(1);expect(state.actions[0]).toMatchObject({amount_minor:'31725',status:'AWAITING_CONFIRMATION',reserved:false});
 expect(state.proofs).toEqual([]);expect(state.provider).toEqual([]);expect(calls.map(c=>c.role)).toEqual(['semantic_intent','transfer','reviewer']);
 expect(state.commands[0].model_attempts).toHaveLength(3);expect(Number(state.commands[0].model_output_reserved)).toBe(calls.reduce((n,c)=>n+c.cap,0));
 expect((await core.dashboard(actor)).accounts[0]).toMatchObject({balanceMinor:'800000',reservedMinor:'0'});return state;
}
beforeAll(async()=>{database=await startG8iPostgres();report.isolation=database.evidence;});
beforeEach(async()=>{
 const id=randomUUID().replaceAll('-','').slice(0,16);schema=`g8j_${id}`;actor={userId:`g8j-${id}`};calls=[];
 await database.admin.query(`CREATE SCHEMA "${schema}"`);proxy=await startG8iPgFaultProxy(database.port,database.admin,database.database);
 const url=new URL(database.connectionString);url.port=String(proxy.port);
 pool=new Pool({connectionString:url.toString(),options:`-c search_path=${schema}`,application_name:`g8i_fault_g8j_${id}`,max:12,connectionTimeoutMillis:2000});observePoolErrors(pool);
 await migrateApi(pool);core=createCore(pool,{schema});await core.migrate();await core.seedDemo(actor);finance=createFinance(pool,{schema});await finance.seedDemo(actor);
 mock=vi.spyOn(globalThis,'fetch').mockImplementation(async(url,init)=>{
  if(!String(url).startsWith('https://model.invalid/'))throw new Error('Unexpected endpoint');
  const body=JSON.parse(String(init?.body)),task=JSON.parse(body.messages.find((m:any)=>m.role==='user').content);calls.push({role:task.role,cap:body.max_tokens});
  if(task.role==='semantic_intent')return json({tasks:[{operation:'transfer',disposition:'request',scope:{source:'whole_message'},entity:{kind:'payee',id:'payee-lin',mention:{text:'林晓'}},amount:{text:'317.25元'},memo:{text:'恢复核对'}}]});
  if(task.role==='transfer')return json({role:'transfer',planVersion:1,summary:'待本人确认',suggestion:task.data.resolved.suggestion,findings:[],evidence:[]});
  if(task.role==='reviewer')return json({approved:true,findings:[],summary:'仅同意待确认草稿'});throw new Error('Unexpected role');
 });rebuild();
});
afterEach(async()=>{try{await app?.waitForPlanning();}finally{mock?.mockRestore();await pool?.end();await proxy?.close();await database.admin.query(`DROP SCHEMA IF EXISTS "${schema}_cp" CASCADE`);await database.admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);}});
afterAll(async()=>{report.cleanup=await database?.close();await writeFile(reportPath,JSON.stringify(report,null,2)+'\n');expect(report.cleanup).toMatchObject({containerRemoved:true,volumeRemoved:true,portClosed:true,errors:[]});});
for(const mode of ['terminate_before_commit','drop_committed_response'] as const){
 it(`conversation accept ${mode}: same client message recovers one durable command`,async()=>{
  const cid=await conversation(),clientMessageId=randomUUID();
  const injection=proxy.arm(mode,'INSERT INTO bp_plan_commands',async()=>(await rows('bp_plan_commands')).length===1);
  const [response,fault]=await Promise.all([request(`/api/conversations/${cid}/messages`,{text,clientMessageId}),injection]);expect(response.status).toBe(500);
  await app.waitForPlanning();const initial=await snapshot();expect(calls).toEqual([]);expect(initial.commands).toHaveLength(mode==='drop_committed_response'?1:0);expect(initial.messages).toHaveLength(mode==='drop_committed_response'?1:0);
  rebuild();const replay=await request(`/api/conversations/${cid}/messages`,{text,clientMessageId});expect(replay.status).toBe(202);const accepted=await replay.json();
  if(mode==='drop_committed_response'){expect(accepted.replayed).toBe(true);expect(accepted.command.commandId).toBe(initial.commands[0].command_id);expect(calls).toEqual([]);expect((await request(`/api/conversations/${cid}/commands/${accepted.command.commandId}/retry`,{})).status).toBe(202);}
  await app.waitForPlanning();const final=await completed(cid,accepted.command.commandId);const before=calls.length;await request(`/api/conversations/${cid}/messages`,{text,clientMessageId});await request(`/api/conversations/${cid}/commands/${accepted.command.commandId}/retry`,{});await app.waitForPlanning();expect(calls).toHaveLength(before);await completed(cid,accepted.command.commandId);
  report.cases.push({name:`accept-${mode}`,fault,initial,final});
 });
 it(`final result ${mode}: original proposal and budget survive without duplicate assistant result`,async()=>{
  const cid=await conversation(),clientMessageId=randomUUID();
  const injection=proxy.arm(mode,"UPDATE bp_plan_commands SET status='complete'",async()=>{const command=(await rows('bp_plan_commands'))[0];return command?.status==='complete'&&(await rows('bp_chat_messages')).some(m=>m.kind==='result');});
  const response=await request(`/api/conversations/${cid}/messages`,{text,clientMessageId});expect(response.status).toBe(202);const accepted=await response.json(),id=accepted.command.commandId;
  const fault=await injection;await app.waitForPlanning();const initial=await snapshot();expect(initial.actions).toHaveLength(1);expect(initial.commands[0].proposal).not.toBeNull();expect(initial.commands[0].status).toBe(mode==='drop_committed_response'?'complete':'failed');expect(initial.messages.filter(m=>m.kind==='result')).toHaveLength(mode==='drop_committed_response'?1:0);
  const budget=initial.commands[0].model_output_reserved,attempts=initial.commands[0].model_attempts;rebuild();await request(`/api/conversations/${cid}/commands/${id}/retry`,{});await app.waitForPlanning();const final=await completed(cid,id);
  expect(final.commands[0].model_output_reserved).toBe(budget);expect(final.commands[0].model_attempts).toEqual(attempts);expect(final.actions[0].id).toBe(initial.actions[0].id);
  report.cases.push({name:`final-${mode}`,fault,initial,final});
 });
}
async function pending(){
 const service=createConversationService(pool),conversation=await service.create(actor,{title:'事务故障'});
 const accepted=await service.accept(actor,conversation.id,{text,clientMessageId:randomUUID()});
 const id=accepted.command.commandId,lease=randomUUID();
 await pool.query("UPDATE bp_plan_commands SET status='running',lease_token=$2,graph_version='g8j',graph_schema_version='g8j-state',graph_input_digest=$3 WHERE command_id=$1",[id,lease,'a'.repeat(64)]);
 return {id,lease,identity:{userId:actor.userId,commandId:id,rootCommandId:accepted.command.rootCommandId,revision:0,leaseToken:lease,graphVersion:'g8j',graphSchemaVersion:'g8j-state',inputDigest:'a'.repeat(64)}};
}
it('journal COMMIT unknown keeps charged attempt unknown and fences stale completion after lease takeover',async()=>{
 const {id,lease}=await pending(),versions={graphVersion:'g8j',schemaVersion:'g8j-state'};
 const journal=createPlanningJournal(pool,actor,id,lease,versions),event={type:'attempt_start' as const,attemptId:randomUUID(),invocationId:randomUUID(),role:'semantic_intent',attempt:1,requestMaxOutputTokens:4096,startedAtUtc:new Date().toISOString()};
 const injection=proxy.arm('drop_committed_response','UPDATE bp_plan_commands SET model_output_reserved',async()=>Number((await rows('bp_plan_commands'))[0]?.model_output_reserved)===4096);
 const [request,fault]=await Promise.allSettled([journal.observe(event),injection]);expect(request.status).toBe('rejected');expect(fault.status).toBe('fulfilled');expect(calls).toEqual([]);
 const durable=(await rows('bp_plan_commands'))[0];expect(durable.model_attempts).toHaveLength(1);expect(durable.model_attempts[0]).toMatchObject({attemptId:event.attemptId,outcome:'unknown'});
 const nextLease=randomUUID();await pool.query('UPDATE bp_plan_commands SET lease_token=$2 WHERE command_id=$1',[id,nextLease]);
 const next=createPlanningJournal(pool,actor,id,nextLease,versions);
 expect(await next.observation()).toEqual({reserved:4096,attempts:durable.model_attempts});
 await expect(journal.observe({...event,type:'attempt_end',status:'success',endedAtUtc:new Date().toISOString()})).rejects.toMatchObject({code:'PLAN_SUPERSEDED'});
 await next.observe({...event,attemptId:randomUUID(),invocationId:randomUUID()});
 const after=await next.observation();expect(after.reserved).toBe(8192);expect(after.attempts).toHaveLength(2);expect(after.attempts.every(a=>a.outcome==='unknown')).toBe(true);expect(calls).toEqual([]);
 report.cases.push({name:'journal-attempt-start-commit-unknown',fault:(fault as PromiseFulfilledResult<unknown>).value,attempts:after});
});
for(const mode of ['terminate_before_commit','drop_committed_response'] as const){
 it(`checkpoint registration ${mode} preserves current lease fencing`,async()=>{
  const {id,identity}=await pending(),options={journalSchema:schema,checkpointSchema:`${schema}_cp`};await setupCheckpointFencing(pool,options);const thread=randomUUID();
  const count=async()=>Number((await database.admin.query(`SELECT count(*)::int n FROM "${schema}_cp".bp_checkpoint_attempts WHERE thread_id=$1`,[thread])).rows[0].n);
  const injection=proxy.arm(mode,`INSERT INTO "${schema}_cp".bp_checkpoint_attempts`,async()=>(await count())===1);
  const [request,fault]=await Promise.allSettled([registerCheckpointAttempt(pool,options,thread,identity),injection]);expect(request.status).toBe('rejected');expect(fault.status).toBe('fulfilled');expect(await count()).toBe(mode==='drop_committed_response'?1:0);
  const lease=randomUUID();await pool.query('UPDATE bp_plan_commands SET lease_token=$2 WHERE command_id=$1',[id,lease]);
  await expect(registerCheckpointAttempt(pool,options,randomUUID(),identity)).rejects.toThrow('BP_CHECKPOINT_ATTEMPT_NOT_CURRENT');
  await expect(transferCheckpointAttempt(pool,options,randomUUID(),identity)).rejects.toThrow('BP_CHECKPOINT_ATTEMPT_NOT_CURRENT');
  const nextThread=randomUUID();await registerCheckpointAttempt(pool,options,nextThread,{...identity,leaseToken:lease});expect(await transferCheckpointAttempt(pool,options,nextThread,{...identity,leaseToken:lease})).toBeUndefined();
  report.cases.push({name:`checkpoint-register-${mode}`,fault:(fault as PromiseFulfilledResult<unknown>).value,originalRows:await count(),staleLeaseRejected:true});
 });
}
it('checkpoint migration session terminated while acquiring lock is discarded and a fresh setup succeeds',async()=>{
 const options={journalSchema:schema,checkpointSchema:`${schema}_cp`},lock=await database.admin.connect();const key=`bankpilot_checkpoint_setup:${schema}_cp`;
 try{
  await lock.query('SELECT pg_advisory_lock(hashtextextended($1,0))',[key]);
  const operation=setupCheckpointFencing(pool,options).then(()=>({ok:true,error:undefined as unknown}),error=>({ok:false,error}));
  let pid=0;await expect.poll(async()=>{pid=(await database.admin.query("SELECT pid FROM pg_stat_activity WHERE datname=$1 AND application_name=$2 AND wait_event='advisory'",[database.database,pool.options.application_name])).rows[0]?.pid??0;return pid;},{timeout:5000,interval:25}).toBeGreaterThan(0);
  expect((await database.admin.query('SELECT pg_terminate_backend(pid) killed FROM pg_stat_activity WHERE pid=$1 AND datname=$2 AND application_name=$3',[pid,database.database,pool.options.application_name])).rows[0].killed).toBe(true);
  const result=await operation;expect(result.ok).toBe(false);expect(result.error).toMatchObject({code:'57P01'});
  await lock.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[key]);
  await setupCheckpointFencing(pool,options);expect((await database.admin.query(`SELECT migration_version FROM "${schema}_cp".bp_checkpoint_fencing_config`)).rowCount).toBe(1);
  report.cases.push({name:'checkpoint-migration-waiting-session-terminated',backendPid:pid,errorCode:'57P01',freshSetupSucceeded:true});
 }finally{lock.release(true);}
});
