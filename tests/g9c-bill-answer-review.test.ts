import { describe, expect, it, vi } from 'vitest';
import { MemorySaver } from '@langchain/langgraph';
import { createPlanner, type PlannerOptions } from '../packages/agents/src/index';
import { createPlanner as g9bPlanner } from '../evals/baselines/g9b-candidate-2026-10-24T05-26-36-092Z/source/packages/agents/src/index';
import type { PlannerInput } from '../packages/contracts/src/index';
import { reviewResponse } from './fixtures/review-response';
function input(coverage: 'complete'|'partial'|'missing' = 'complete', mixed = false): PlannerInput {
 const bill = '查询2026年7月合成灯塔书屋消费多少';
 return {taskId:'g9c-bill-publication',message:bill+(mixed?'，给安澜转20元':''),accounts:[],payees:[{id:'p',name:'安澜',aliases:[],bank:'合成银行',maskedNumber:'****7777'}],
 billReport:{period:'2026-07',source:'SYNTHETIC',coverage:{status:coverage},incomeMinor:'0',expenseMinor:'12345',netMinor:'-12345',previousExpenseMinor:'0',categories:[],transactions:[{id:'private-result-row',accountId:'a',bookedAt:'2026-07-04T00:00:00Z',merchant:'合成灯塔书屋',amountMinor:'12345',direction:'OUT',category:'购物',source:'SYNTHETIC_STATEMENT'}],findings:[],generatedAt:'2026-08-01T00:00:00Z'},
 semanticIntent:{status:'ready',findings:[],modelRuns:[],tasks:[{role:'bills',operation:'bills_query',source:{text:bill},canonicalMessage:'查询账单',slots:{billPeriod:{kind:'month',startPeriod:'2026-07',endPeriod:'2026-07',source:{text:'2026年7月'}}}},...(mixed?[{role:'transfer' as const,operation:'transfer',source:{text:'给安澜转20元'},canonicalMessage:'给安澜转20元',slots:{entityId:'p',amountMinor:'2000',memo:''}}]:[])]}};
}
function withheld(result: Awaited<ReturnType<ReturnType<typeof createPlanner>['plan']>>) {
 expect(result.billAnswerReview?.status).toBe('withheld');expect(result.clarification).toContain('尚未通过核对');
 expect(result.billAnalysis).toBeUndefined();expect(result.billReport).toBeUndefined();expect(result.billReports).toBeUndefined();
 const publicText=JSON.stringify(result);expect(publicText).not.toMatch(/12345|123\.45|private-result-row|合成灯塔书屋/);
 expect(result.suggestions).toEqual([]);expect(result.findings).toContain('BILL_ANSWER_REVIEW_REJECTED');
}
describe('G9C bill answers require independent request alignment before publication',()=>{
 it.each(['complete','partial'] as const)('withholds %s answer despite an approved boolean if query alignment is false',async coverage=>{
  const r=await createPlanner({provider:false,reviewerAdapter:async c=>reviewResponse(c,{approved:true,billQueryAligned:false})}).plan(input(coverage));
  withheld(r);expect(r.diagnostics?.review).toMatchObject({rawApproved:true,effectiveApproved:false});expect(r.findings).toContain('BILL_QUERY_SCOPE_MISMATCH');
  expect(r.diagnostics?.review?.summary).not.toContain('同意提案');
 });
 it('keeps an unexplained independent refusal and removes every bill answer surface',async()=>{
  const r=await createPlanner({provider:false,reviewerAdapter:async c=>reviewResponse(c,{approved:false})}).plan(input());withheld(r);expect(r.diagnostics?.review?.rawApproved).toBe(false);
 });
 it.each(['all','bills'] as const)('withholds on an explicit %s concern even when the two booleans are true',async role=>{
  const r=await createPlanner({provider:false,reviewerAdapter:async c=>reviewResponse(c,{approved:true,billQueryAligned:true,concerns:[{role,code:'evidence_mismatch'}]})}).plan(input());withheld(r);
 });
 it('allows the exact reviewed amount and source references',async()=>{
  const r=await createPlanner({provider:false,reviewerAdapter:async c=>reviewResponse(c,{approved:true})}).plan(input());expect(r.billAnalysis?.amountMinor).toBe('12345');expect(r.summary).toContain('123.45');expect(r.billAnswerReview).toBeUndefined();
 });
 it('retains aligned bill facts when only the distinct transfer is refused, and creates no transfer',async()=>{
  const r=await createPlanner({provider:false,reviewerAdapter:async c=>reviewResponse(c,{approved:false,billQueryAligned:true,concerns:[{role:'transfer',code:'funds_refused'}]})}).plan(input('complete',true));
  expect(r.billAnalysis?.amountMinor).toBe('12345');expect(r.billAnswerReview).toBeUndefined();expect(r.suggestions).toEqual([]);expect(r.diagnostics?.review?.effectiveApproved).toBe(false);
 });
 it('preserves honest missing-data diagnostics without publishing placeholder amounts',async()=>{
  const r=await createPlanner({provider:false,reviewerAdapter:async c=>reviewResponse(c,{approved:false})}).plan(input('missing'));
  expect(r.billAnalysis?.status).toBe('missing_data');expect(r.billAnalysis?.amountMinor).toBeUndefined();expect(r.billReport).toBeUndefined();expect(JSON.stringify(r)).not.toContain('12345');expect(r.summary).toContain('未将缺失月份视为零支出');
 });
 it('requires an explicit query-alignment decision in the new wire contract',async()=>{
  await expect(createPlanner({provider:false,reviewerAdapter:async c=>{const value:any=reviewResponse(c);delete value.billQueryAligned;return value;}}).plan(input())).rejects.toMatchObject({failure:{stage:'reviewer',retryable:false}});
 });
 it('rejects legacy untrusted bill prose even when the requested facts are missing',async()=>{
  const reviewer=vi.fn(async (c:any)=>reviewResponse(c,{approved:false}));
  await expect(createPlanner({provider:false,
   domainAdapter:async c=>({role:c.role,planVersion:c.planVersion,summary:'虚构商户扣了我998877.66元',evidence:[],findings:[]}),
   reviewerAdapter:reviewer}).plan(input('missing'))).rejects.toMatchObject({failure:{stage:'domain:bills',code:'MODEL_SCHEMA_INVALID',retryable:false}});
  expect(reviewer).not.toHaveBeenCalled();
 });
 it('reuses a refused completed checkpoint without republishing facts or re-running review',async()=>{
  const saver=new MemorySaver(),review=vi.fn(async (c:any)=>reviewResponse(c,{approved:false}));const p=createPlanner({provider:false,checkpointer:saver as unknown as PlannerOptions['checkpointer'],reviewerAdapter:review});
  withheld(await p.plan(input(),{checkpointAttempt:{threadId:'refused',checkpointNs:'',resume:false}}));
  withheld(await p.plan(input(),{checkpointAttempt:{threadId:'refused',checkpointNs:'',resume:true}}));expect(review).toHaveBeenCalledTimes(1);
 });
 it('does not reuse a G9B completed checkpoint that never judged query alignment',async()=>{
  const saver=new MemorySaver();
  await g9bPlanner({provider:false,checkpointer:saver as any}).plan(input(),{checkpointAttempt:{threadId:'legacy',checkpointNs:'',resume:false}});
  await expect(createPlanner({provider:false,checkpointer:saver as unknown as PlannerOptions['checkpointer']}).plan(input(),{checkpointAttempt:{threadId:'legacy',checkpointNs:'',resume:true}})).rejects.toMatchObject({failure:{code:'STAGE_DEPENDENCY_MISMATCH'}});
 });
});
