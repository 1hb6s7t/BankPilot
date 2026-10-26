import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPlanner, type LocalContext } from '../packages/agents/src/index';
import { resolveSubscriptionBatch } from '../packages/agents/src/management-batch';
import type { ManagementContext, PlannerInput, SemanticTask } from '../packages/contracts/src/index';
const context = (): ManagementContext => ({cards:[],subscriptions:{queryActionId:'query-proof',queriedAt:'2026-10-24T00:00:00Z',accessExpiresAt:'2100-01-01T00:00:00Z',items:['星禾音乐','山川健身'].map((merchant,i)=>({id:`s${i}`,merchant,amountMinor:'3500',currency:'CNY',nextChargeDate:'2026-11-02',cardId:'c',merchantStatus:'ACTIVE',bankStatus:'ALLOWED',collectionStatus:'ENABLED',version:3+i,cancellationSupported:true,source:'SYNTHETIC_MERCHANT'}))}});
const tasks = (): SemanticTask[] => ['取消星禾音乐订阅','阻止山川健身银行扣款'].map((text,i)=>({role:'subscription',operation:i?'subscription_block':'subscription_cancel',source:{text},canonicalMessage:text,slots:{entityId:`s${i}`}}));
const input = ():PlannerInput=>({taskId:'g9c-independent-batch',message:'分别取消星禾音乐订阅、阻止山川健身银行扣款',accounts:[],payees:[],managementContext:context(),semanticIntent:{status:'ready',tasks:tasks(),findings:[],modelRuns:[]}});
const proposal=(c:LocalContext)=>({role:c.role,planVersion:c.planVersion,summary:'等待独立确认',findings:[],evidence:[],managementSuggestions:(c.data.management as any).managementSuggestions});
const expected=[{kind:'SUBSCRIPTION_CANCEL',subscriptionId:'s0',expectedVersion:3,queryActionId:'query-proof'},{kind:'SUBSCRIPTION_BLOCK',subscriptionId:'s1',expectedVersion:4,queryActionId:'query-proof'}];
afterEach(()=>vi.restoreAllMocks());
describe('G9C separately grounded subscription requests are consumed completely',()=>{
 it('keeps both exact pending specs in source order and one domain invocation',async()=>{
  const domain=vi.fn(async c=>proposal(c));const r=await createPlanner({provider:false,domainAdapter:domain}).plan(input());
  expect(r.managementSuggestions).toEqual(expected);expect(domain).toHaveBeenCalledTimes(1);expect(domain.mock.calls[0]![0].data.semanticRequests).toHaveLength(2);expect(r.suggestions).toEqual([]);expect(r.investmentSuggestions).toEqual([]);expect(r.summary).toContain('未执行');
 });
 it('requires the complete tuple at the provider schema boundary',async()=>{
  const dispatched:string[]=[];vi.spyOn(globalThis,'fetch').mockImplementation(async(_u,init)=>{const body=JSON.parse(String(init?.body)),c=JSON.parse(body.messages[1].content);dispatched.push(c.role);const value=c.role==='reviewer'?{approved:true,findings:[],summary:'提案完整，仍须分别确认'}:proposal(c);return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(value)}}]}));});
  const r=await createPlanner({provider:{baseURL:'https://synthetic.invalid/v1',model:'controlled',outputMode:'json_object',maxAttempts:1,maxStructureRepairs:0}}).plan(input());expect(r.managementSuggestions).toEqual(expected);expect(dispatched.sort()).toEqual(['reviewer','subscription']);
 });
 it.each(['omit-second','change-second','extra-third'] as const)('rejects %s rather than publishing a partial batch',async fault=>{
  const p=createPlanner({provider:false,domainAdapter:async c=>{const v=proposal(c);if(fault==='omit-second')v.managementSuggestions=v.managementSuggestions.slice(0,1);if(fault==='change-second')v.managementSuggestions=[v.managementSuggestions[0],{...v.managementSuggestions[1],subscriptionId:'unknown'}];if(fault==='extra-third')v.managementSuggestions=[...v.managementSuggestions,v.managementSuggestions[0]];return v;}});
  await expect(p.plan(input())).rejects.toMatchObject({failure:{code:'MODEL_CANDIDATE_CONTRACT_INVALID',retryable:false}});
 });
 it('keeps the independent reviewer able to refuse the entire batch',async()=>{
  const r=await createPlanner({provider:false,reviewerAdapter:async()=>({approved:false,summary:'仍有证据问题',findings:['需核对']})}).plan(input());expect(r.managementSuggestions).toEqual([]);expect(r.diagnostics?.review?.rawApproved).toBe(false);
 });
 it.each(['missing','expired'] as const)('requires one explicit query grant before %s-snapshot writes',state=>{
  const c=context();if(state==='missing')delete c.subscriptions;else c.subscriptions!.accessExpiresAt='2020-01-01T00:00:00Z';
  const r=resolveSubscriptionBatch(tasks(),c);expect(r.managementSuggestions).toEqual([{kind:'SUBSCRIPTION_QUERY'}]);expect(r.summary).toContain('再分别核对原请求');expect(r.clarification).toBeUndefined();
 });
 it('keeps an already satisfied operation explicit and prepares only the remaining request',()=>{
  const c=context();c.subscriptions!.items[0]!.merchantStatus='CANCELLED';const r=resolveSubscriptionBatch(tasks(),c);expect(r.managementSuggestions).toEqual([expected[1]]);expect(r.summary).toContain('已取消');expect(r.clarification).toBeUndefined();
 });
 it.each(['same-target','unsupported-operation','unknown-second','mixed-query'] as const)('never silently drops %s',fault=>{
  const ts=tasks();if(fault==='same-target')ts[1]!.slots.entityId='s0';if(fault==='unsupported-operation')ts[1]!.operation='card_report_lost';if(fault==='unknown-second')ts[1]!.canonicalMessage='阻止未知健身银行扣款';if(fault==='mixed-query')ts[1]!.operation='subscription_query';
  const r=resolveSubscriptionBatch(ts,context());expect(r.managementSuggestions).toEqual([]);expect(r.clarification).toBeTruthy();
 });
});
