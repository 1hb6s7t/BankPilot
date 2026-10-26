import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPlanner } from '../packages/agents/src/index';
import type { PlannerInput } from '../packages/contracts/src/index';
import { syntheticInvestmentProducts } from '../packages/contracts/src/investment';
import { evaluationAccounts,evaluationPayees,evaluationBillReport,evaluationFunds } from '../evals/fixtures';
import { createG8hControlledModel,g8hScenarios,defaultG8hSemantic,type G8hSemanticRequest } from './fixtures/g8h-controlled-model';
import { validateSemanticIntent } from '../packages/agents/src/semantic-intent';
const scenarios=g8hScenarios(new Date('2026-10-23T00:00:00Z'));
const base:PlannerInput={taskId:'g8h-unit',message:'',referenceDate:'2026-10-23',accounts:structuredClone(evaluationAccounts),payees:structuredClone(evaluationPayees),billReport:structuredClone(evaluationBillReport),fundsPreview:evaluationFunds('0'),
 investmentContext:{businessDate:'2026-10-23',calendar:'DEMO_WEEKDAYS_V1',actions:[],products:[...syntheticInvestmentProducts],positions:syntheticInvestmentProducts.map(product=>({id:`pos-${product.id}`,accountId:'eval-account-1',productId:product.id,productName:product.name,principalMinor:'500000',availableMinor:'500000',reservedMinor:'0',version:1,redemptionBusinessDays:product.redemptionBusinessDays,calendar:product.calendar}))},
 managementContext:{cards:[{id:'card',accountId:'eval-account-1',name:'主账户借记卡',maskedNumber:'****2026',status:'ACTIVE',version:1,updatedAt:'2026-10-23T00:00:00Z'}],subscriptions:{queriedAt:'2026-10-23T00:00:00Z',accessExpiresAt:'2099-01-01T00:00:00Z',queryActionId:'query-action',items:['云音乐','城市健身合约'].map((merchant,n)=>({id:`sub-${n}`,merchant,amountMinor:'1800',currency:'CNY' as const,nextChargeDate:'2026-11-01',cardId:'card',merchantStatus:'ACTIVE' as const,bankStatus:'ALLOWED' as const,collectionStatus:'ENABLED' as const,version:1,cancellationSupported:n===0,source:'SYNTHETIC_MERCHANT' as const}))}}
};
function task(message:string):G8hSemanticRequest{return{role:'semantic_intent',taskId:base.taskId,message,referenceDate:base.referenceDate!,catalog:[...base.payees.map(p=>({kind:'payee' as const,id:p.id,names:[p.name,...p.aliases],suffix:p.maskedNumber.slice(-4)})),...base.investmentContext!.positions.map(p=>({kind:'position' as const,id:p.id,names:[p.productName],suffix:''})),...base.managementContext!.cards.map(p=>({kind:'card' as const,id:p.id,names:[p.name],suffix:p.maskedNumber.slice(-4)})),...base.managementContext!.subscriptions!.items.map(p=>({kind:'subscription' as const,id:p.id,names:[p.merchant],suffix:''}))]};}
afterEach(()=>vi.unstubAllGlobals());
const readyKeys=['transferExact','transferUnknown','billsCurrent','billsMissing','billsProtectedTransfer','redeemT0','redeemT2','cardQuery','cardLost','cardRestore','subscriptionQuery','subscriptionCancel','subscriptionBlock','tuitionGoal'] as const;
describe('G8H finite controlled vocabulary with production grounding',()=>{
 it.each(readyKeys)('%s preserves actual source and catalog binding',key=>{const message=scenarios[key];const result=validateSemanticIntent({...base,message},defaultG8hSemantic(task(message),scenarios),{referenceDate:base.referenceDate});expect(result.status,JSON.stringify(result)).toBe('ready');expect(result.tasks.length).toBeGreaterThan(0);});
 it.each(['redeemUnknown','cardAmbiguous'] as const)('%s lets deterministic missing-object clarification run',key=>{const message=scenarios[key];expect(validateSemanticIntent({...base,message},defaultG8hSemantic(task(message),scenarios)).status).toBe('clarification');});
 it('does not fabricate unavailable subscription grant targets',()=>{const t=task(scenarios.subscriptionCancel);t.catalog=t.catalog.filter(p=>p.kind!=='subscription');const input=structuredClone(base);delete input.managementContext!.subscriptions;expect(validateSemanticIntent({...input,message:t.message},defaultG8hSemantic(t,scenarios)).status).toBe('clarification');});
 it('preserves separate goal/funding amounts and future date',()=>{const message=scenarios.tuitionGoal;const result=validateSemanticIntent({...base,message},defaultG8hSemantic(task(message),scenarios),{referenceDate:base.referenceDate});expect(result.tasks[0]!.slots).toMatchObject({amountMinor:'60075',targetDate:scenarios.targetDate,funding:{positionId:'pos-synthetic-t0',amountMinor:'100000'}});expect(scenarios.targetDate>'2026-10-23').toBe(true);});
 it('fails closed for an unregistered command',()=>expect(()=>defaultG8hSemantic(task('转账给未知用户100元'),scenarios)).toThrow('G8H_SCENARIO_NOT_CONFIGURED'));
});
describe('G8H actual provider and six domain contracts without database',()=>{
 it.each(readyKeys)('%s passes schema, request binding and independent review',async key=>{
  const model=createG8hControlledModel(scenarios);vi.stubGlobal('fetch',async(_input:unknown,init:RequestInit)=>model.respond(JSON.parse(String(init.body))));
  const input=structuredClone(base);input.message=scenarios[key];
  if(key==='transferExact')input.fundsPreview=evaluationFunds('30750');
  if(key==='transferUnknown')input.fundsPreview=evaluationFunds('60000');
  if(key==='cardRestore')input.managementContext!.cards[0]!.status='LOST';
  if(key==='billsProtectedTransfer')input.fundsPreview=evaluationFunds('400000');
  if(key==='billsMissing'){input.billReport={...input.billReport!,period:'2020-01',coverage:{status:'missing'}};}
  const result=await createPlanner({provider:{baseURL:'https://g8h-model.invalid',model:'g8h-unit',outputMode:'json_object',maxAttempts:2,retryDelayMs:1}}).plan(input);
  expect(result.failure).toBeUndefined();expect(result.diagnostics?.domains.every(d=>d.status==='accepted'),JSON.stringify(result.diagnostics)).toBe(true);
  expect(model.calls.some(c=>c.role==='semantic_intent')).toBe(true);
  expect(result.diagnostics?.domains.length).toBeGreaterThan(0);
  if(key==='billsMissing'){expect(result.clarification).toBeTruthy();expect(result.suggestions).toEqual([]);expect(result.diagnostics?.review?.effectiveApproved).toBe(false);}
  else {expect(result.clarification).toBeUndefined();expect(result.diagnostics?.review?.effectiveApproved).toBe(true);}
  if(key==='tuitionGoal'){expect(result.goalSuggestion).toMatchObject({amountMinor:'60075',funding:{redemptionAmountMinor:'100000'}});expect(model.calls.map(c=>c.role).sort()).toEqual(['semantic_intent','investment','goal','reviewer'].sort());expect(result.suggestions).toEqual([]);expect(result.investmentSuggestions).toEqual([]);}
  if(key==='redeemT0')expect(result.investmentSuggestions![0]!.amountMinor).toBe('42735');
  if(key==='redeemT2')expect(result.investmentSuggestions![0]!.amountMinor).toBe('10050');
 });
 it('injects exactly a bounded pair for the selected role and records no payload',async()=>{
  const model=createG8hControlledModel(scenarios);model.failNextRolePair('semantic_intent');const body={max_tokens:4096,messages:[{role:'user',content:JSON.stringify(task(scenarios.transferExact))}]};
  expect((await model.respond(body)).status).toBe(502);expect((await model.respond(body)).status).toBe(502);expect((await model.respond(body)).status).toBe(200);
  expect(model.calls.map(c=>c.sequence)).toEqual([1,2,3]);expect(JSON.stringify(model.calls)).not.toContain(scenarios.transferExact);expect(model.calls.map(c=>c.responseKind)).toEqual(['unavailable','unavailable','valid']);
 });
 it('clones registered drafts rather than retaining mutable caller ownership',async()=>{const model=createG8hControlledModel(scenarios),draft=defaultG8hSemantic(task(scenarios.transferExact),scenarios);model.configureScenario({message:scenarios.transferExact,semanticDraft:draft});draft.tasks=[];const response=await model.respond({max_tokens:4096,messages:[{role:'user',content:JSON.stringify(task(scenarios.transferExact))}]});const raw=await response.json() as any;expect(JSON.parse(raw.choices[0].message.content).tasks).toHaveLength(1);});
});
