import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCore, createManagement } from '../packages/core/src/index.js';
import type { CoreService } from '../packages/contracts/src/index.js';
import type { ManagementInput, ManagementService, SubscriptionSnapshot } from '../packages/contracts/src/management.js';

const pool=new Pool({connectionString:process.env.TEST_DATABASE_URL??'postgres://bankpilot:bankpilot-local@127.0.0.1:55432/bankpilot',max:12});
const actor={userId:'g9f-owner'},other={userId:'g9f-other'};
let schema:string,now:Date,core:CoreService,management:ManagementService;
const command=(kind:'SUBSCRIPTION_CANCEL'|'SUBSCRIPTION_BLOCK',subscriptionId:string,expectedVersion:number,queryActionId:string,commandId=randomUUID()):ManagementInput=>
  ({commandId,spec:{kind,subscriptionId,expectedVersion,queryActionId}});
const query=async(user=actor):Promise<SubscriptionSnapshot>=>{
  const action=await management.prepare(user,{commandId:randomUUID(),spec:{kind:'SUBSCRIPTION_QUERY'}});
  const confirmed=await management.authorize(user,action.id,{level:'CONFIRMATION',proofId:randomUUID(),actionHash:action.actionHash});
  return confirmed.receipt!.subscriptions!;
};
const counts=async()=>{
  const r=await pool.query(`SELECT
    (SELECT count(*)::int FROM "${schema}".management_actions) AS actions,
    (SELECT count(*)::int FROM "${schema}".management_authorization_proofs) AS proofs,
    (SELECT count(*)::int FROM "${schema}".preparation_requests) AS preparations,
    (SELECT count(*)::int FROM "${schema}".audit_events) AS audit`);
  return r.rows[0] as {actions:number;proofs:number;preparations:number;audit:number};
};
const inputs=(snapshot:SubscriptionSnapshot):[ManagementInput,ManagementInput]=>{
  const music=snapshot.items.find(item=>item.cancellationSupported)!;
  const club=snapshot.items.find(item=>!item.cancellationSupported)!;
  return [command('SUBSCRIPTION_CANCEL',music.id,music.version,snapshot.queryActionId),
    command('SUBSCRIPTION_BLOCK',club.id,club.version,snapshot.queryActionId)];
};

beforeEach(async()=>{
  schema=`g9fbatch_${randomUUID().replaceAll('-','').slice(0,12)}`;
  now=new Date('2026-10-25T08:00:00Z');
  core=createCore(pool,{schema,clock:()=>now});management=createManagement(pool,{schema,clock:()=>now});
  await core.migrate();await core.seedDemo(actor);await core.seedDemo(other);
  await management.migrate();await management.seedDemo(actor);await management.seedDemo(other);
});
afterEach(async()=>{await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);});
afterAll(async()=>{await pool.end();});

describe('G9F atomic subscription preparation',()=>{
  it('prepares both in input order without consuming proof or changing subscriptions',async()=>{
    const snapshot=await query(),batch=inputs(snapshot),before=await counts();
    const prepared=await management.prepareBatch(actor,batch);
    expect(prepared).toHaveLength(2);
    expect(prepared.map(action=>action.spec)).toEqual(batch.map(input=>input.spec));
    expect(prepared.every(action=>action.status==='AWAITING_CONFIRMATION'&&action.detailsRedacted===false)).toBe(true);
    expect(await counts()).toEqual({actions:before.actions+2,proofs:before.proofs,preparations:before.preparations+2,audit:before.audit+2});
    expect((await management.subscriptions(actor,snapshot.queryActionId)).items).toEqual(snapshot.items);
    await expect(management.getAction(other,prepared[0].id)).rejects.toMatchObject({code:'NOT_FOUND'});
    expect((await management.prepareBatch(actor,batch)).map(action=>action.id)).toEqual(prepared.map(action=>action.id));
    expect(await counts()).toEqual({actions:before.actions+2,proofs:before.proofs,preparations:before.preparations+2,audit:before.audit+2});
  });

  it.each([
    ['bad grant',(batch:[ManagementInput,ManagementInput])=>{(batch[1].spec as {queryActionId:string}).queryActionId='missing-grant';},'QUERY_AUTHORIZATION_REQUIRED'],
    ['stale version',(batch:[ManagementInput,ManagementInput])=>{(batch[1].spec as {expectedVersion:number}).expectedVersion=999;},'STALE_RESOURCE'],
  ] as const)('rolls back all new rows when the second item has %s',async(_label,change,code)=>{
    const snapshot=await query(),batch=inputs(snapshot),before=await counts();change(batch);
    await expect(management.prepareBatch(actor,batch)).rejects.toMatchObject({code});
    expect(await counts()).toEqual(before);
    for(const input of batch) await expect(management.getByCommand(actor,input.commandId)).rejects.toMatchObject({code:'COMMAND_NOT_FOUND'});
  });

  it('rolls back when only the second query grant has expired',async()=>{
    const old=await query();now=new Date(now.getTime()+4*60_000);
    const fresh=await query(),batch=inputs(fresh),before=await counts();
    (batch[1].spec as {queryActionId:string}).queryActionId=old.queryActionId;
    now=new Date(new Date(old.accessExpiresAt).getTime());
    await expect(management.prepareBatch(actor,batch)).rejects.toMatchObject({code:'QUERY_ACCESS_EXPIRED'});
    expect(await counts()).toEqual(before);
  });

  it('rejects duplicate command IDs and unsupported batch kinds before any write',async()=>{
    const snapshot=await query(),batch=inputs(snapshot),before=await counts();
    batch[1].commandId=batch[0].commandId;
    await expect(management.prepareBatch(actor,batch)).rejects.toMatchObject({code:'INVALID_INPUT'});
    await expect(management.prepareBatch(actor,[])).rejects.toMatchObject({code:'INVALID_INPUT'});
    await expect(management.prepareBatch(actor,Array.from({length:9},(_,i)=>({...batch[0],commandId:`batch-command-${i}`})))).rejects.toMatchObject({code:'INVALID_INPUT'});
    await expect(management.prepareBatch(actor,[{commandId:randomUUID(),spec:{kind:'SUBSCRIPTION_QUERY'}}])).rejects.toMatchObject({code:'INVALID_INPUT'});
    expect(await counts()).toEqual(before);
  });

  it('rejects changed payload on retry and keeps both prior mappings intact',async()=>{
    const snapshot=await query(),batch=inputs(snapshot);
    const original=await management.prepareBatch(actor,batch),before=await counts();
    const changed=structuredClone(batch);
    (changed[1].spec as {expectedVersion:number}).expectedVersion++;
    await expect(management.prepareBatch(actor,changed)).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'});
    expect(await counts()).toEqual(before);
    expect((await management.prepareBatch(actor,batch)).map(action=>action.id)).toEqual(original.map(action=>action.id));
  });

  it('keeps an existing candidate when a later new candidate fails validation',async()=>{
    const snapshot=await query(),batch=inputs(snapshot);
    const original=await management.prepareBatch(actor,[batch[0]]),before=await counts();
    (batch[1].spec as {expectedVersion:number}).expectedVersion=999;
    await expect(management.prepareBatch(actor,batch)).rejects.toMatchObject({code:'STALE_RESOURCE'});
    expect(await counts()).toEqual(before);
    expect((await management.getByCommand(actor,batch[0].commandId)).id).toBe(original[0].id);
    await expect(management.getByCommand(actor,batch[1].commandId)).rejects.toMatchObject({code:'COMMAND_NOT_FOUND'});
  });

  it('does not accept another owner’s query grant',async()=>{
    const snapshot=await query(),otherSnapshot=await query(other),batch=inputs(snapshot),before=await counts();
    (batch[1].spec as {queryActionId:string}).queryActionId=otherSnapshot.queryActionId;
    await expect(management.prepareBatch(actor,batch)).rejects.toMatchObject({code:'QUERY_AUTHORIZATION_REQUIRED'});
    expect(await counts()).toEqual(before);
  });

  it('serializes concurrent duplicate batches to the same action IDs',async()=>{
    const snapshot=await query(),batch=inputs(snapshot),before=await counts();
    const [first,second]=await Promise.all([management.prepareBatch(actor,batch),management.prepareBatch(actor,batch)]);
    expect(first.map(action=>action.id)).toEqual(second.map(action=>action.id));
    expect(await counts()).toEqual({actions:before.actions+2,proofs:before.proofs,preparations:before.preparations+2,audit:before.audit+2});
  });

  it('rolls back the first insert if the second insert fails',async()=>{
    const snapshot=await query(),batch=inputs(snapshot),before=await counts();
    batch[1].commandId='forbidden-command';
    await pool.query(`ALTER TABLE "${schema}".management_actions ADD CONSTRAINT g9f_reject_second CHECK(command_id<>'forbidden-command') NOT VALID`);
    await expect(management.prepareBatch(actor,batch)).rejects.toThrow();
    expect(await counts()).toEqual(before);
    await expect(management.getByCommand(actor,batch[0].commandId)).rejects.toMatchObject({code:'COMMAND_NOT_FOUND'});
  });
});
