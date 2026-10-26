import { describe, expect, it } from 'vitest';
import type { ManagementAction, ManagementSpec, PlannerInput, PlanResult, SemanticPlan, SubscriptionView } from '../packages/contracts/src/index.js';
import type { SubscriptionPrerequisite } from '../packages/agents/src/subscription-prerequisite.js';
import { recognizeSubscriptionPrerequisite } from '../packages/agents/src/subscription-prerequisite.js';
import { continuationProposalMatches, publicContinuationResult, redactStoredContinuationActions } from '../apps/api/src/subscription-continuation-plan.js';

const message='取消星禾音乐订阅，阻止山川健身银行扣款';
const prerequisite:SubscriptionPrerequisite=recognizeSubscriptionPrerequisite(message)!;
if (!prerequisite || prerequisite.tasks.length!==2) throw new Error('fixture must be fully recognized');
const source=(index:number)=>structuredClone(prerequisite.tasks[index]!.source);
const semantic:SemanticPlan={status:'ready',tasks:[
  {operation:'subscription_cancel',role:'subscription',source:source(0),canonicalMessage:'取消星禾音乐订阅',slots:{entityId:'sub-a'}},
  {operation:'subscription_block',role:'subscription',source:source(1),canonicalMessage:'阻止山川健身银行扣款',slots:{entityId:'sub-b'}},
],findings:[],modelRuns:[]};
const item=(id:string,overrides:Partial<SubscriptionView>={}):SubscriptionView=>({
  id,merchant:id==='sub-a'?'甲商户':'乙商户',amountMinor:'19900',currency:'CNY',nextChargeDate:'2026-11-10',cardId:'card-1',
  merchantStatus:'ACTIVE',bankStatus:'ALLOWED',collectionStatus:'ENABLED',version:3,cancellationSupported:true,source:'SYNTHETIC_MERCHANT',...overrides,
});
const plannerInput=(intent:SemanticPlan=semantic,items:SubscriptionView[]=[item('sub-a'),item('sub-b')]):PlannerInput=>({
  taskId:'task-test',message,accounts:[],payees:[],semanticIntent:intent,
  managementContext:{cards:[],subscriptions:{items,queriedAt:'2026-10-25T08:00:00Z',queryActionId:'query-1',accessExpiresAt:'2026-10-25T08:05:00Z'}},
});
const cancel:ManagementSpec={kind:'SUBSCRIPTION_CANCEL',subscriptionId:'sub-a',expectedVersion:3,queryActionId:'query-1'};
const block:ManagementSpec={kind:'SUBSCRIPTION_BLOCK',subscriptionId:'sub-b',expectedVersion:3,queryActionId:'query-1'};
const plan=(managementSuggestions:ManagementSpec[]=[cancel,block]):PlanResult=>({
  taskId:'task-test',planVersion:1,mode:'model',summary:'甲商户 199 元，下月扣款',events:[],evidence:[],findings:[],suggestions:[],managementSuggestions,
});

describe('G9F continuation proposal exactness',()=>{
  it('accepts the complete ordered two action proposal',()=>{
    expect(continuationProposalMatches(prerequisite,plannerInput(),plan())).toBe(true);
  });

  it('rejects missing, extra, reordered, changed kind, version and query grant',()=>{
    const variants:ManagementSpec[][]=[
      [cancel],[cancel,block,block],[block,cancel],
      [cancel,{...block,kind:'SUBSCRIPTION_CANCEL'}],
      [cancel,{...block,expectedVersion:4}],
      [cancel,{...block,queryActionId:'query-2'}],
    ];
    for(const suggestions of variants)
      expect(continuationProposalMatches(prerequisite,plannerInput(),plan(suggestions))).toBe(false);
  });

  it('rejects missing entity binding, missing subscription, changed source, and extra semantic task',()=>{
    const withoutEntity=structuredClone(semantic);delete withoutEntity.tasks[1]!.slots.entityId;
    const changedSource=structuredClone(semantic);changedSource.tasks[1]!.source={...source(1),start:source(1).start+1};
    const extra=structuredClone(semantic);extra.tasks.push({...extra.tasks[1]!,source:source(1)});
    expect(continuationProposalMatches(prerequisite,plannerInput(withoutEntity),plan())).toBe(false);
    expect(continuationProposalMatches(prerequisite,plannerInput(semantic,[item('sub-a')]),plan())).toBe(false);
    expect(continuationProposalMatches(prerequisite,plannerInput(changedSource),plan())).toBe(false);
    expect(continuationProposalMatches(prerequisite,plannerInput(extra),plan())).toBe(false);
  });

  it('requires the original query snapshot and rejects mixed proposals or a failed review',()=>{
    const missing=plannerInput();delete missing.managementContext;
    expect(continuationProposalMatches(prerequisite,missing,plan())).toBe(false);
    expect(continuationProposalMatches(prerequisite,plannerInput(),{...plan(),suggestions:[{payeeId:'p1',amountMinor:'100',memo:''}]})).toBe(false);
    expect(continuationProposalMatches(prerequisite,plannerInput(),{...plan(),clarification:'要不要取消？'})).toBe(false);
    expect(continuationProposalMatches(prerequisite,plannerInput(),{...plan(),diagnostics:{domains:[],review:{rawApproved:false,summary:'拒绝',effectiveApproved:false}}})).toBe(false);
  });

  it('accepts only proven no-ops and does not require a proposal for already satisfied tasks',()=>{
    const satisfied=[item('sub-a',{merchantStatus:'CANCELLED',collectionStatus:'MERCHANT_CANCELLED'}),
      item('sub-b',{bankStatus:'BLOCKED',collectionStatus:'BLOCKED_BY_BANK'})];
    expect(continuationProposalMatches(prerequisite,plannerInput(semantic,satisfied),plan([]))).toBe(true);
    expect(continuationProposalMatches(prerequisite,plannerInput(semantic,satisfied),plan([cancel]))).toBe(false);
    const publicResult=publicContinuationResult(plan([]),true);
    expect(publicResult.summary).not.toContain('已生成独立待确认提案');
  });

  it('compresses only the satisfied item and preserves the remaining proposal order',()=>{
    const firstDone=[item('sub-a',{merchantStatus:'CANCELLED',collectionStatus:'MERCHANT_CANCELLED'}),item('sub-b')];
    const secondDone=[item('sub-a'),item('sub-b',{bankStatus:'BLOCKED',collectionStatus:'BLOCKED_BY_BANK'})];
    expect(continuationProposalMatches(prerequisite,plannerInput(semantic,firstDone),plan([block]))).toBe(true);
    expect(continuationProposalMatches(prerequisite,plannerInput(semantic,firstDone),plan([cancel]))).toBe(false);
    expect(continuationProposalMatches(prerequisite,plannerInput(semantic,secondDone),plan([cancel]))).toBe(true);
    expect(continuationProposalMatches(prerequisite,plannerInput(semantic,secondDone),plan([block]))).toBe(false);
  });

  it('rejects unsupported cancellation while preserving a separate block request',()=>{
    expect(continuationProposalMatches(prerequisite,plannerInput(semantic,[item('sub-a',{cancellationSupported:false}),item('sub-b')]),plan())).toBe(false);
  });
});

describe('G9F continuation public projection',()=>{
  it('removes merchant facts, model narrative, event and evidence text from both outcomes',()=>{
    const raw={...plan(),summary:'甲商户 199 元',clarification:undefined,
      events:[{role:'subscription',status:'completed' as const,at:'2026-10-25T08:00:00Z',summary:'甲商户 199 元'}],
      evidence:[{source:'model',detail:'乙商户每月 199 元'}],findings:['甲商户 199 元'],
      diagnostics:{domains:[],review:{rawApproved:true,summary:'甲商户 199 元',effectiveApproved:true}},
    } satisfies PlanResult;
    for(const matched of [true,false]) {
      const safe=publicContinuationResult(raw,matched);
      expect(JSON.stringify(safe)).not.toMatch(/甲商户|乙商户|199 元/);
      expect(safe.events).toEqual([{ role: 'subscription', status: 'completed', at: '2026-10-25T08:00:00Z', summary: '订阅原请求核对阶段' }]);expect(safe.evidence).toEqual([]);expect(safe.findings).toEqual([]);
      expect(safe.diagnostics).toBeUndefined();
      expect(safe.managementSuggestions).toEqual(matched?[cancel,block]:[]);
      expect(Boolean(safe.clarification)).toBe(!matched);
    }
  });

  it('drops stored action receipt, failure reason and original title/details',()=>{
    const action:ManagementAction={id:'action-1',taskId:'task-test',spec:cancel,title:'取消甲商户订阅',details:['甲商户每月 199 元'],
      status:'AWAITING_CONFIRMATION',tier:'YELLOW',actionVersion:1,actionHash:'hash',expiresAt:'2026-10-25T08:10:00Z',createdAt:'2026-10-25T08:00:00Z',updatedAt:'2026-10-25T08:00:00Z',
      receipt:{operationId:'op',completedAt:'2026-10-25T08:00:00Z',summary:'甲商户扣款已阻止',balanceDeltaMinor:'0'},failureReason:'甲商户失败',
    };
    const [stored]=redactStoredContinuationActions([action]);
    expect(stored.title).toBe('订阅事务');expect(stored.details).toEqual([]);expect(stored.detailsRedacted).toBe(true);
    expect(stored).not.toHaveProperty('receipt');expect(stored).not.toHaveProperty('failureReason');
    expect(action.title).toBe('取消甲商户订阅');
  });
});
