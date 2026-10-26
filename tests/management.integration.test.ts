import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { beforeEach,afterEach,afterAll,describe,it,expect } from 'vitest';
import { createCore,createManagement } from '../packages/core/src/index.js';
import type { CoreService } from '../packages/contracts/src/index.js';
import type { ManagementAction,ManagementService,ManagementSpec } from '../packages/contracts/src/management.js';

const pool=new Pool({connectionString:process.env.TEST_DATABASE_URL??'postgres://bankpilot:bankpilot-local@127.0.0.1:55432/bankpilot',max:12});
const actor={userId:'management-owner'},other={userId:'management-other'};
let schema:string,now:Date,core:CoreService,management:ManagementService;
const prepare=(spec:ManagementSpec,commandId=randomUUID())=>management.prepare(actor,{commandId,spec});
const approve=(action:ManagementAction,level:'CONFIRMATION'|'STRONG'='CONFIRMATION',proofId=randomUUID())=>management.authorize(actor,action.id,{level,proofId,actionHash:action.actionHash});
const query=async()=>{const action=await prepare({kind:'SUBSCRIPTION_QUERY'});const completed=await approve(action);return completed.receipt!.subscriptions!;};
const counts=async()=>{
  const r=await pool.query(`SELECT (SELECT count(*) FROM "${schema}".management_authorization_proofs)::int AS proofs,(SELECT count(*) FROM "${schema}".management_contact_aliases)::int AS aliases,(SELECT count(*) FROM "${schema}".audit_events)::int AS audit`);return r.rows[0];
};
beforeEach(async()=>{
  schema=`mgmttest_${randomUUID().replaceAll('-','').slice(0,12)}`;now=new Date('2026-10-22T08:00:00Z');
  core=createCore(pool,{schema,clock:()=>now});management=createManagement(pool,{schema,clock:()=>now});
  await core.migrate();await core.seedDemo(actor);await core.seedDemo(other);
  await management.migrate();await management.seedDemo(actor);await management.seedDemo(other);
});
afterEach(async()=>{await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);});
afterAll(async()=>{await pool.end();});

describe('explicit local management authorization and isolated subscription access',()=>{
  it('prepares normalized alias without saving it; confirms once and exposes only to its owner',async()=>{
    const commandId=randomUUID();
    const action=await prepare({kind:'CONTACT_ALIAS_SAVE',payeeId:'payee-lin',alias:'  Ａｌｉｃｅ  '},commandId);
    expect(action.id.startsWith('mgmt-')).toBe(true);expect(action.tier).toBe('YELLOW');
    expect(action.spec).toMatchObject({alias:'Alice'});
    expect((await management.contacts(actor)).find(p=>p.id==='payee-lin')!.aliases).not.toContain('Alice');
    const same=await prepare({kind:'CONTACT_ALIAS_SAVE',payeeId:'payee-lin',alias:'Alice'},commandId);
    expect(same.id).toBe(action.id);expect(same.actionHash).toBe(action.actionHash);
    const completed=await approve(action);expect(completed.status).toBe('SUCCEEDED');
    expect(completed.receipt?.payee?.aliases).toContain('Alice');
    expect((await management.contacts(actor)).find(p=>p.id==='payee-lin')!.aliases).toContain('Alice');
    expect((await management.contacts(other)).find(p=>p.id==='payee-lin')!.aliases).not.toContain('Alice');
    const originalCounts=await counts();
    expect((await approve(action)).receipt).toEqual(completed.receipt);
    expect(await counts()).toEqual(originalCounts);
    expect((await prepare({kind:'CONTACT_ALIAS_SAVE',payeeId:'payee-lin',alias:'Alice'},commandId)).id).toBe(action.id);
    await expect(prepare({kind:'CONTACT_ALIAS_SAVE',payeeId:'payee-chen',alias:'Alice'},commandId)).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'});
  });

  it('rejects names, built-in aliases, normalized collisions and concurrent alias claims without partial writes',async()=>{
    for(const alias of [' 林晓 ','小陈','　张伟　']) {
      await expect(prepare({kind:'CONTACT_ALIAS_SAVE',payeeId:'payee-chen',alias})).rejects.toMatchObject({code:'ALIAS_CONFLICT'});
    }
    const [a,b]=await Promise.all([
      prepare({kind:'CONTACT_ALIAS_SAVE',payeeId:'payee-lin',alias:'同一个朋友'}),
      prepare({kind:'CONTACT_ALIAS_SAVE',payeeId:'payee-chen',alias:'同一个朋友'}),
    ]);
    const results=await Promise.allSettled([approve(a),approve(b)]);
    expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
    expect((results.find(r=>r.status==='rejected') as PromiseRejectedResult).reason).toMatchObject({code:'ALIAS_CONFLICT'});
    expect((await counts()).aliases).toBe(1);expect((await counts()).proofs).toBe(1);
    const alias=await prepare({kind:'CONTACT_ALIAS_SAVE',payeeId:'payee-lin',alias:'ＡＢＣ'});await approve(alias);
    await expect(prepare({kind:'CONTACT_ALIAS_SAVE',payeeId:'payee-chen',alias:'abc'})).rejects.toMatchObject({code:'ALIAS_CONFLICT'});
    expect((await pool.query(`SELECT aliases FROM "${schema}".payees WHERE id='payee-lin'`)).rows[0].aliases).not.toContain('ABC');
  });

  it('serializes duplicate commands and rejects changed spec while maintaining owner isolation',async()=>{
    const commandId=randomUUID(),spec:ManagementSpec={kind:'SUBSCRIPTION_QUERY'};
    const [a,b]=await Promise.all([prepare(spec,commandId),prepare(spec,commandId)]);
    expect(a.id).toBe(b.id);
    await expect(prepare({kind:'CONTACT_ALIAS_SAVE',payeeId:'payee-lin',alias:'新别名'},commandId)).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'});
    await expect(management.getAction(other,a.id)).rejects.toMatchObject({code:'NOT_FOUND'});
    await expect(management.cancel(other,a.id)).rejects.toMatchObject({code:'NOT_FOUND'});
    await expect(management.authorize(other,a.id,{level:'STRONG',proofId:randomUUID(),actionHash:a.actionHash})).rejects.toMatchObject({code:'NOT_FOUND'});
    expect((await management.dashboard(other)).actions).toHaveLength(0);
  });

  it('concurrent duplicate approvals return one receipt, while duplicate alias candidates save only once',async()=>{
    const once=await prepare({kind:'CONTACT_ALIAS_SAVE',payeeId:'payee-lin',alias:'唯一称呼'});
    const completed=await Promise.all([approve(once),approve(once)]);
    expect(completed[0].receipt).toEqual(completed[1].receipt);
    expect((await counts()).proofs).toBe(1);expect((await counts()).aliases).toBe(1);
    const [a,b]=await Promise.all([
      prepare({kind:'CONTACT_ALIAS_SAVE',payeeId:'payee-lin',alias:'另一个称呼'}),
      prepare({kind:'CONTACT_ALIAS_SAVE',payeeId:'payee-lin',alias:'另一个称呼'}),
    ]);
    const results=await Promise.allSettled([approve(a),approve(b)]);
    expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
    expect((results.find(r=>r.status==='rejected') as PromiseRejectedResult).reason).toMatchObject({code:'ALIAS_CONFLICT'});
    expect((await counts()).proofs).toBe(2);expect((await counts()).aliases).toBe(2);
  });

  it('card status is green-readable but mutations require strong verification and reject stale versions',async()=>{
    const card=(await management.dashboard(actor)).cards[0];
    expect(card.status).toBe('ACTIVE');
    const [first,stale]=await Promise.all([
      prepare({kind:'CARD_REPORT_LOST',cardId:card.id,expectedVersion:card.version}),
      prepare({kind:'CARD_REPORT_LOST',cardId:card.id,expectedVersion:card.version}),
    ]);
    const before=await counts();
    expect((await approve(first)).status).toBe('AWAITING_VERIFICATION');
    expect(await counts()).toEqual(before);expect((await management.dashboard(actor)).cards[0].status).toBe('ACTIVE');
    await expect(management.authorize(actor,first.id,{level:'STRONG',proofId:randomUUID(),actionHash:'changed'})).rejects.toMatchObject({code:'STALE_ACTION'});
    const completed=await approve(first,'STRONG');expect(completed.receipt?.card).toMatchObject({status:'LOST',version:2});
    const after=await counts();
    await expect(approve(stale,'STRONG')).rejects.toMatchObject({code:'STALE_RESOURCE'});
    expect(await counts()).toEqual(after);
    await expect(management.prepare(other,{commandId:randomUUID(),spec:{kind:'CARD_UNREPORT_LOST',cardId:card.id,expectedVersion:2}})).rejects.toMatchObject({code:'NOT_FOUND'});
    const restore=await prepare({kind:'CARD_UNREPORT_LOST',cardId:card.id,expectedVersion:2});
    expect((await approve(restore,'STRONG')).receipt?.card).toMatchObject({status:'ACTIVE',version:3});
  });

  it('expired/cancelled actions cannot change resources and reusable proofs cannot authorize another action',async()=>{
    const card=(await management.dashboard(actor)).cards[0];
    const expired=await prepare({kind:'CARD_REPORT_LOST',cardId:card.id,expectedVersion:card.version});
    now=new Date(now.getTime()+10*60_000);
    const before=await counts();
    await expect(approve(expired,'STRONG')).rejects.toMatchObject({code:'ACTION_EXPIRED'});
    expect((await management.getAction(actor,expired.id)).status).toBe('EXPIRED');
    expect(await counts()).toEqual(before);
    const cancelled=await prepare({kind:'CONTACT_ALIAS_SAVE',payeeId:'payee-lin',alias:'不得保存'});
    await management.cancel(actor,cancelled.id);
    await expect(approve(cancelled)).rejects.toMatchObject({code:'INVALID_STATE'});
    const first=await prepare({kind:'CONTACT_ALIAS_SAVE',payeeId:'payee-lin',alias:'第一称呼'}),proofId=randomUUID();await approve(first,'CONFIRMATION',proofId);
    const second=await prepare({kind:'CONTACT_ALIAS_SAVE',payeeId:'payee-lin',alias:'第二称呼'});
    const prior=await counts();
    await expect(approve(second,'CONFIRMATION',proofId)).rejects.toMatchObject({code:'PROOF_REPLAY'});
    expect(await counts()).toEqual(prior);
    await expect(management.cancel(actor,first.id)).rejects.toMatchObject({code:'INVALID_STATE'});
  });

  it('subscription query is yellow, has no prepare/dashboard leak, expires and never renews on replay',async()=>{
    const action=await prepare({kind:'SUBSCRIPTION_QUERY'});
    expect(action.tier).toBe('YELLOW');expect(action.status).toBe('AWAITING_CONFIRMATION');
    expect(JSON.stringify(action)).not.toContain('云音乐');
    expect(JSON.stringify(await management.dashboard(actor))).not.toContain('云音乐');
    await expect(management.subscriptions(actor,action.id)).rejects.toMatchObject({code:'QUERY_AUTHORIZATION_REQUIRED'});
    await expect(management.subscriptions(actor,'missing')).rejects.toMatchObject({code:'QUERY_AUTHORIZATION_REQUIRED'});
    const approved=await approve(action);const snapshot=approved.receipt!.subscriptions!;
    expect(snapshot.items).toHaveLength(2);expect(snapshot.items[0].source).toBe('SYNTHETIC_MERCHANT');
    expect((await management.subscriptions(actor,action.id)).items).toHaveLength(2);
    expect((await management.dashboard(actor)).subscriptionQueryActionId).toBe(action.id);
    expect(JSON.stringify(await management.dashboard(actor))).not.toContain('云音乐');
    expect((await management.getAction(actor,action.id)).receipt?.subscriptions).toBeUndefined();
    await expect(management.subscriptions(other,action.id)).rejects.toMatchObject({code:'QUERY_AUTHORIZATION_REQUIRED'});
    now=new Date(snapshot.accessExpiresAt);
    await expect(management.subscriptions(actor,action.id)).rejects.toMatchObject({code:'QUERY_ACCESS_EXPIRED'});
    expect((await management.dashboard(actor)).subscriptionQueryActionId).toBeUndefined();
    const count=await counts();
    expect((await approve(action)).receipt).toEqual(approved.receipt);
    expect(await counts()).toEqual(count);
    await expect(management.subscriptions(actor,action.id)).rejects.toMatchObject({code:'QUERY_ACCESS_EXPIRED'});
  });

  it('cancellation/blocking recheck query grant at preparation and authorization and require separate confirmation',async()=>{
    const subscriptionId=`sub-music-${actor.userId}`;
    await expect(prepare({kind:'SUBSCRIPTION_CANCEL',subscriptionId,expectedVersion:1,queryActionId:'not-authorized'})).rejects.toMatchObject({code:'QUERY_AUTHORIZATION_REQUIRED'});
    const snapshot=await query(),music=snapshot.items.find(s=>s.cancellationSupported)!;
    const cancel=await prepare({kind:'SUBSCRIPTION_CANCEL',subscriptionId:music.id,expectedVersion:music.version,queryActionId:snapshot.queryActionId});
    expect(cancel.tier).toBe('YELLOW');
    expect((await management.subscriptions(actor,snapshot.queryActionId)).items.find(s=>s.id===music.id)!.merchantStatus).toBe('ACTIVE');
    now=new Date(snapshot.accessExpiresAt);
    const before=await counts();
    await expect(approve(cancel)).rejects.toMatchObject({code:'QUERY_ACCESS_EXPIRED'});
    expect(await counts()).toEqual(before);
    const renewed=await query();
    expect(renewed.items.find(s=>s.id===music.id)!.merchantStatus).toBe('ACTIVE');
    const next=await prepare({kind:'SUBSCRIPTION_CANCEL',subscriptionId:music.id,expectedVersion:music.version,queryActionId:renewed.queryActionId});
    expect((await approve(next)).receipt?.subscription).toMatchObject({merchantStatus:'CANCELLED',bankStatus:'ALLOWED',collectionStatus:'MERCHANT_CANCELLED',version:2});
    expect((await core.dashboard(actor)).accounts[0].balanceMinor).toBe('800000');
  });

  it('preserves mutation confirmation details across refresh only while its original owner grant is valid',async()=>{
    const snapshot=await query(),music=snapshot.items.find(s=>s.cancellationSupported)!,club=snapshot.items.find(s=>!s.cancellationSupported)!;
    const cancel=await prepare({kind:'SUBSCRIPTION_CANCEL',subscriptionId:music.id,expectedVersion:music.version,queryActionId:snapshot.queryActionId});
    const block=await prepare({kind:'SUBSCRIPTION_BLOCK',subscriptionId:club.id,expectedVersion:club.version,queryActionId:snapshot.queryActionId});
    await approve(block);
    const refreshed=await management.dashboard(actor);
    for(const [action,item] of [[cancel,music],[block,club]] as const) {
      for(const view of [await management.getAction(actor,action.id),refreshed.actions.find(a=>a.id===action.id)!]) {
        expect(view.details).toEqual(action.details);
        expect(view.details.join(' ')).toContain(item.merchant);
        expect(view.details.join(' ')).toContain(`${item.amountMinor}分`);
      }
      await expect(management.getAction(other,action.id)).rejects.toMatchObject({code:'NOT_FOUND'});
    }
    expect(refreshed.actions.find(a=>a.id===block.id)!.receipt?.subscription).toMatchObject({merchant:club.merchant,bankStatus:'BLOCKED'});
    expect(refreshed.actions.find(a=>a.id===snapshot.queryActionId)!.receipt?.subscriptions).toBeUndefined();
    now=new Date(snapshot.accessExpiresAt);
    // A newly confirmed query must not revive the old action's expired grant.
    await query();
    const expiredDashboard=await management.dashboard(actor);
    for(const action of [cancel,block]) {
      for(const view of [await management.getAction(actor,action.id),expiredDashboard.actions.find(a=>a.id===action.id)!]) {
        expect(view.details).toEqual(['订阅明细需在有效的查询授权内查看；此为本地合成商户操作。']);
        expect(view.receipt?.subscription).toBeUndefined();
      }
    }
    await expect(approve(cancel)).rejects.toMatchObject({code:'QUERY_ACCESS_EXPIRED'});
  });

  it('card loss changes collection status but not merchant contract; stale subscription actions are rejected',async()=>{
    const initial=await query(),music=initial.items.find(s=>s.cancellationSupported)!;
    const stale=await prepare({kind:'SUBSCRIPTION_CANCEL',subscriptionId:music.id,expectedVersion:music.version,queryActionId:initial.queryActionId});
    const card=(await management.dashboard(actor)).cards[0];
    const lost=await prepare({kind:'CARD_REPORT_LOST',cardId:card.id,expectedVersion:card.version});await approve(lost,'STRONG');
    const after=(await management.subscriptions(actor,initial.queryActionId)).items;
    expect(after.every(s=>s.merchantStatus==='ACTIVE'&&s.bankStatus==='ALLOWED'&&s.collectionStatus==='BLOCKED_BY_CARD'&&s.version===2)).toBe(true);
    const before=await counts();await expect(approve(stale)).rejects.toMatchObject({code:'STALE_RESOURCE'});expect(await counts()).toEqual(before);
    const restore=await prepare({kind:'CARD_UNREPORT_LOST',cardId:card.id,expectedVersion:2});await approve(restore,'STRONG');
    expect((await management.subscriptions(actor,initial.queryActionId)).items.every(s=>s.collectionStatus==='ENABLED'&&s.version===3)).toBe(true);
  });

  it('unsupported merchant cancellation still allows independent bank restriction; no refund or contract cancellation',async()=>{
    const initial=await query(),club=initial.items.find(s=>!s.cancellationSupported)!;
    const before=await counts();
    await expect(prepare({kind:'SUBSCRIPTION_CANCEL',subscriptionId:club.id,expectedVersion:club.version,queryActionId:initial.queryActionId})).rejects.toMatchObject({code:'CANCELLATION_UNSUPPORTED'});
    expect(await counts()).toEqual(before);
    const block=await prepare({kind:'SUBSCRIPTION_BLOCK',subscriptionId:club.id,expectedVersion:club.version,queryActionId:initial.queryActionId});
    const completed=await approve(block);
    expect(completed.receipt?.subscription).toMatchObject({merchantStatus:'ACTIVE',bankStatus:'BLOCKED',collectionStatus:'BLOCKED_BY_BANK'});
    const card=(await management.dashboard(actor)).cards[0];
    await approve(await prepare({kind:'CARD_REPORT_LOST',cardId:card.id,expectedVersion:card.version}),'STRONG');
    await approve(await prepare({kind:'CARD_UNREPORT_LOST',cardId:card.id,expectedVersion:card.version+1}),'STRONG');
    expect((await management.subscriptions(actor,initial.queryActionId)).items.find(s=>s.id===club.id)!).toMatchObject({merchantStatus:'ACTIVE',bankStatus:'BLOCKED',collectionStatus:'BLOCKED_BY_BANK'});
    expect((await core.dashboard(actor)).accounts[0].balanceMinor).toBe('800000');
    expect((await pool.query(`SELECT count(*)::int AS n FROM "${schema}".provider_entries`)).rows[0].n).toBe(0);
  });

  it('bank restriction and merchant cancellation remain independent in either order',async()=>{
    const initial=await query(),music=initial.items.find(s=>s.cancellationSupported)!;
    await approve(await prepare({kind:'SUBSCRIPTION_BLOCK',subscriptionId:music.id,expectedVersion:1,queryActionId:initial.queryActionId}));
    const cancelled=await approve(await prepare({kind:'SUBSCRIPTION_CANCEL',subscriptionId:music.id,expectedVersion:2,queryActionId:initial.queryActionId}));
    expect(cancelled.receipt?.subscription).toMatchObject({merchantStatus:'CANCELLED',bankStatus:'BLOCKED',collectionStatus:'MERCHANT_CANCELLED',version:3});
    const otherQueryAction=await management.prepare(other,{commandId:randomUUID(),spec:{kind:'SUBSCRIPTION_QUERY'}});
    await management.authorize(other,otherQueryAction.id,{level:'CONFIRMATION',proofId:randomUUID(),actionHash:otherQueryAction.actionHash});
    await expect(management.prepare(other,{commandId:randomUUID(),spec:{kind:'SUBSCRIPTION_CANCEL',subscriptionId:music.id,expectedVersion:3,queryActionId:otherQueryAction.id}})).rejects.toMatchObject({code:'NOT_FOUND'});
  });

  it('audit failure rolls back local provider mutation, receipt and proof consumption',async()=>{
    const initial=await query(),music=initial.items.find(s=>s.cancellationSupported)!;
    const action=await prepare({kind:'SUBSCRIPTION_CANCEL',subscriptionId:music.id,expectedVersion:music.version,queryActionId:initial.queryActionId});
    // NOT VALID preserves the earlier query's audit while enforcing the failure on new writes.
    await pool.query(`ALTER TABLE "${schema}".audit_events ADD CONSTRAINT fail_management CHECK(type<>'MANAGEMENT_SUCCEEDED') NOT VALID`);
    const before=await counts();await expect(approve(action)).rejects.toThrow();expect(await counts()).toEqual(before);
    expect((await management.getAction(actor,action.id)).status).toBe('AWAITING_CONFIRMATION');
    expect((await management.subscriptions(actor,initial.queryActionId)).items.find(s=>s.id===music.id)!).toMatchObject({merchantStatus:'ACTIVE',version:1});
  });
});
