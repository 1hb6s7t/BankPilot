import { describe,expect,it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModelRun, PlanResult } from '../packages/contracts/src/index';
import { g7HoldoutFixtures, g7HoldoutVersion } from '../evals/g7-holdout-fixtures';
import { scoreSemantic, type SemanticScore } from '../evals/semantic-score';
import { applyCaseIntegrity, auditRequestedOutputBudget, caseIntegrityError, g7CohortSummary, hasPriorLiveExposure, isValidCaseRecord, preflightG7Manifest, selectG7Cases } from '../scripts/evaluate-g7';
import { createStageOutputPlan, PLANNING_OUTPUT_TOKEN_LIMIT, SEMANTIC_OUTPUT_TOKEN_LIMIT } from '../packages/agents/src/budget';
const byId=(id:string)=>g7HoldoutFixtures.find(f=>f.id===id)!;
const run=(role:string,status:'success'|'failed'='success')=>({role,model:'test-model',status,durationMs:10});
const budgetRun=(role:string,requestMaxOutputTokens?:number,attempt=1):ModelRun=>({role,model:'test-model',status:'success',durationMs:1,attempt,...(requestMaxOutputTokens===undefined?{}:{requestMaxOutputTokens})});
const sampleScore=(overrides:Partial<SemanticScore>):SemanticScore=>({passed:false,semanticApplicable:true,intentRecognition:false,scheduledRoles:[],expectedScheduledRoles:[],structureSuccess:true,businessSemanticsPass:false,modelComplete:false,firstAttemptComplete:false,successfulCalls:0,failedAttempts:0,errorCodes:[],failures:[],financialFailures:[],planningSafety:true,unexpectedActionProposal:false,...overrides});
function base(fixtureId:string,overrides:Partial<PlanResult>={}):PlanResult {
 const f=byId(fixtureId);return {taskId:f.input.taskId,planVersion:1,mode:'model',summary:'已按提供信息处理。',events:[],suggestions:[],evidence:[],findings:[],modelRuns:[],diagnostics:{intent:{status:'ready',roles:f.expected.roles,findings:[]},domains:f.expected.roles.map(role=>({role,hasSuggestion:false,hasClarification:false,status:'accepted'}))},...(f.input.fundsPreview?{fundsPreview:f.input.fundsPreview}:{}),...(f.input.billReport?{billReport:f.input.billReport}:{}),...overrides};
}
describe('G7 semantic score distinguishes routing, calls and business result',()=>{
 it('preflights frozen fixture bytes and partitions pilot/reserved/all in manifest order',()=>{
  const manifest=JSON.parse(readFileSync('evals/g7-manifest.json','utf8'));
  const sha=createHash('sha256').update(readFileSync('evals/g7-holdout-fixtures.ts')).digest('hex');
  expect(preflightG7Manifest(manifest,g7HoldoutFixtures,sha,new Date().toISOString(),g7HoldoutVersion)).toBe(true);
  const pilot=selectG7Cases('pilot',g7HoldoutFixtures,manifest),reserved=selectG7Cases('reserved',g7HoldoutFixtures,manifest),all=selectG7Cases('all',g7HoldoutFixtures,manifest);
  expect(pilot).toHaveLength(12);expect(reserved).toHaveLength(12);expect(all).toHaveLength(24);
  expect(pilot.map(x=>x.fixture.id)).toEqual(manifest.liveCaseIds);
  expect(reserved.map(x=>x.fixture.id)).toEqual(manifest.caseIds.filter((id:string)=>!manifest.liveCaseIds.includes(id)));
  expect(all.map(x=>x.fixture.id)).toEqual(manifest.caseIds);
  expect(new Set([...pilot,...reserved].map(x=>x.fixture.id)).size).toBe(24);
  expect(pilot.every(x=>x.cohort==='pilot-known')).toBe(true);expect(reserved.every(x=>x.cohort==='reserved-first-execution')).toBe(true);
  expect(selectG7Cases('reserved',g7HoldoutFixtures,manifest,true).every(x=>x.cohort==='reserved-known')).toBe(true);
  const expectedRoles=['transfer','bills','investment','card','subscription','goal'];
  for(const cohort of [pilot,reserved])for(const role of expectedRoles)expect(cohort.filter(x=>x.fixture.expected.roles.includes(role as never)).length).toBeGreaterThanOrEqual(2);
 });
 it('marks reserved cases as known after any prior live journal start but ignores pilot-only and scripted starts',async()=>{
  const manifest=JSON.parse(readFileSync('evals/g7-manifest.json','utf8'));const temp=await mkdtemp(join(tmpdir(),'g7-cohort-'));const reservedId=manifest.caseIds.find((id:string)=>!manifest.liveCaseIds.includes(id))!;
  const header=(mode:string,ids:string[])=>JSON.stringify({type:'start',mode,protocol:{fixtureVersion:g7HoldoutVersion,caseIds:ids}});
  try {
   await writeFile(join(temp,'pilot.jsonl'),header('live',manifest.liveCaseIds)+'\n');
   await writeFile(join(temp,'scripted-reserved.jsonl'),header('scripted',[reservedId])+'\n');
   expect(await hasPriorLiveExposure(temp,[reservedId],g7HoldoutVersion)).toBe(false);
   await writeFile(join(temp,'live-reserved.jsonl'),header('live',[reservedId])+'\n');
   expect(await hasPriorLiveExposure(temp,[reservedId],g7HoldoutVersion)).toBe(true);
  } finally {await rm(temp,{recursive:true,force:true});}
 });
 it('rejects a mutated manifest or fixture byte hash before evaluation',()=>{
  const manifest=JSON.parse(readFileSync('evals/g7-manifest.json','utf8'));
  const sha=createHash('sha256').update(readFileSync('evals/g7-holdout-fixtures.ts')).digest('hex');
  expect(()=>preflightG7Manifest({...manifest,fixtureSha256:'0'.repeat(64)},g7HoldoutFixtures,sha,new Date().toISOString(),manifest.version)).toThrow('Frozen G7 manifest mismatch');
  expect(()=>preflightG7Manifest({...manifest,caseIds:[...manifest.caseIds].reverse()},g7HoldoutFixtures,sha,new Date().toISOString(),manifest.version)).toThrow('Frozen G7 manifest mismatch');
  expect(()=>preflightG7Manifest({...manifest,frozenAt:'2026-10-23'},g7HoldoutFixtures,sha,new Date().toISOString(),manifest.version)).toThrow('Frozen G7 manifest mismatch');
  expect(()=>preflightG7Manifest({...manifest,liveCaseCount:11},g7HoldoutFixtures,sha,new Date().toISOString(),manifest.version)).toThrow('Frozen G7 manifest mismatch');
 });
 it('reports all-versus-stratum counts without merging known and first-run samples',()=>{
  const summary=g7CohortSummary([
   {sequence:1,id:'g701',category:'x',mode:'live',cohort:'pilot-known',startedAt:'',inputHash:'',expectedHash:'',scheduledRoles:[],durationMs:1,passed:true,score:sampleScore({passed:true,intentRecognition:true,modelComplete:true,businessSemanticsPass:true})},
   {sequence:2,id:'g702',category:'x',mode:'live',cohort:'reserved-first-execution',startedAt:'',inputHash:'',expectedHash:'',scheduledRoles:[],durationMs:1,passed:false,score:sampleScore({planningSafety:false,unexpectedActionProposal:true,financialFailures:['RESPONSE_FACT_MISSING']})},
  ]);
  expect(summary['pilot-known']).toMatchObject({cases:1,passed:1,correctIntent:1,businessSemanticsPass:1,planningSafetyFailures:0,unexpectedActionProposals:0});
  expect(summary['reserved-first-execution']).toMatchObject({cases:1,passed:0,correctIntent:0,businessSemanticsPass:0,planningSafetyFailures:1,unexpectedActionProposals:1,financialFailureCodes:{RESPONSE_FACT_MISSING:1}});
 });
 it('checks staged token budgets across every provider attempt without using expected labels',()=>{
  const oneDomain=createStageOutputPlan({domainStageCount:1,reviewerStageCount:1,maxAttempts:2,totalOutputTokens:PLANNING_OUTPUT_TOKEN_LIMIT});
  const worst=createStageOutputPlan({domainStageCount:6,reviewerStageCount:1,maxAttempts:2,totalOutputTokens:PLANNING_OUTPUT_TOKEN_LIMIT});
  expect(oneDomain.semanticMaxOutputTokens).toBe(SEMANTIC_OUTPUT_TOKEN_LIMIT);
  expect(oneDomain.semanticReserved+oneDomain.downstreamReserved+oneDomain.unallocatedTokens).toBe(PLANNING_OUTPUT_TOKEN_LIMIT);
  expect(worst.allocatedCeiling).toBeLessThanOrEqual(PLANNING_OUTPUT_TOKEN_LIMIT);
  const audit=auditRequestedOutputBudget([
   budgetRun('semantic_intent',4096,1),
   budgetRun('semantic_intent',4096,2),
   ...Array.from({length:14},(_,index)=>budgetRun(index%2?'reviewer':'transfer',worst.downstreamMaxOutputTokens,index%2+1)),
  ]);
  expect(audit.withinBudget).toBe(true);expect(audit.requestedTokenCeilingSum).toBe(worst.allocatedCeiling);expect(audit.missingRequestCaps).toBe(0);
  expect(auditRequestedOutputBudget([budgetRun('semantic_intent',20000),budgetRun('reviewer',20000)]).ceilingExceeded).toBe(true);
  expect(auditRequestedOutputBudget([budgetRun('semantic_intent')]).missingRequestCaps).toBe(1);
  const cancellingInvalidCaps=auditRequestedOutputBudget([budgetRun('transfer',40000),budgetRun('reviewer',-40000)]);
  expect(cancellingInvalidCaps.requestedTokenCeilingSum).toBe(0);expect(cancellingInvalidCaps.invalidRequestCaps).toBe(2);expect(cancellingInvalidCaps.withinBudget).toBe(false);
  const invalidCaps=[Number.NaN,1.5,-1,32769].map((cap,index)=>budgetRun(`bad-cap-${index}`,cap));
  expect(auditRequestedOutputBudget(invalidCaps).invalidRequestCaps).toBe(4);
  expect(auditRequestedOutputBudget(invalidCaps).withinBudget).toBe(false);
 });
 it('keeps a returned result and score but invalidates cases whose call exceeded its deadline',()=>{
  const score=sampleScore({passed:true});const result={events:[{role:'transfer',status:'started'}]};
  const record:{score:SemanticScore;result:typeof result;passed:boolean;errorCode?:string}={score,result,passed:true};
  const error=caseIntegrityError(true,false);const checked=applyCaseIntegrity(record,error);
  expect(error).toBe('CASE_DEADLINE_EXCEEDED');expect(checked.result).toBe(result);expect(checked.score).toBe(score);
  expect(checked.score.passed).toBe(false);expect(checked.score.failures).toContain('CASE_DEADLINE_EXCEEDED');
  expect(checked.errorCode).toBe('CASE_DEADLINE_EXCEEDED');expect(isValidCaseRecord(checked)).toBe(false);
 });
 it('keeps a returned result and score but invalidates a mutated planner input',()=>{
  const score=sampleScore({passed:true});const result={events:[]};const record:{score:SemanticScore;result:typeof result;passed:boolean;errorCode?:string}={score,result,passed:true};
  const error=caseIntegrityError(false,true);const checked=applyCaseIntegrity(record,error);
  expect(error).toBe('INPUT_MUTATED');expect(checked.result).toBe(result);expect(checked.score).toBe(score);
  expect(checked.score.passed).toBe(false);expect(checked.score.failures).toContain('INPUT_MUTATED');
  expect(checked.errorCode).toBe('INPUT_MUTATED');expect(isValidCaseRecord(checked)).toBe(false);
 });
 it('does not pass an expected action that stops at valid clarification',()=>{
  const f=byId('g701');const result=base('g701',{summary:'请补充转账信息。',clarification:'请补充收款人或金额。',events:[{role:'semantic-intent',status:'completed',at:'2026-10-23T00:00:00Z',summary:'需要澄清'}],modelRuns:[run('semantic_intent')],diagnostics:{intent:{status:'clarification',roles:['transfer'],findings:[]},domains:[]}});
  const score=scoreSemantic(f,result);expect(score.passed).toBe(false);expect(score.expectedStatus).toBe('ready');expect(score.modelComplete).toBe(false);expect(score.failures).toContain('EXPECTED_ACTION_STOPPED_BEFORE_DOMAIN');expect(score.scheduledRoles).toEqual([]);
 });
 it('does not treat an unresolved operational request as no-action',()=>{
  const f=byId('g712');const before=structuredClone(f.expected);
  const result=base('g712',{summary:'当前内容无需银行操作。',events:[{role:'semantic-intent',status:'completed',at:'2026-10-23T00:00:00Z',summary:'无操作'}],modelRuns:[run('semantic_intent')],diagnostics:{intent:{status:'no_action',roles:[],findings:[]},domains:[]}});
  const score=scoreSemantic(f,result);expect(score.expectedStatus).toBe('clarification');expect(score.intentRecognition).toBe(false);expect(score.passed).toBe(false);expect(f.expected).toEqual(before);
 });
 it('accepts a valid quoted no-action router stop without fabricated domain events',()=>{
  const f=byId('g702');const result=base('g702',{summary:'这是引用文本润色请求，不需要办理银行操作。',events:[{role:'semantic-intent',status:'completed',at:'2026-10-23T00:00:00Z',summary:'无操作'}],modelRuns:[run('semantic_intent')],diagnostics:{intent:{status:'no_action',roles:[],findings:[]},domains:[]}});
  const score=scoreSemantic(f,result);expect(score.passed).toBe(true);expect(score.expectedStatus).toBe('no_action');expect(score.modelComplete).toBe(true);expect(score.scheduledRoles).toEqual([]);
 });
 it('rejects duplicate or extra successful calls while allowing failed retries before one success',()=>{
  const f=byId('g702');
  const duplicate=base('g702',{summary:'这是引用文本润色请求，不需要办理银行操作。',events:[{role:'semantic-intent',status:'completed',at:'2026-10-23T00:00:00Z',summary:'无操作'}],modelRuns:[run('semantic_intent'),run('semantic_intent')],diagnostics:{intent:{status:'no_action',roles:[],findings:[]},domains:[]}});
  const duplicateScore=scoreSemantic(f,duplicate);expect(duplicateScore.modelComplete).toBe(false);expect(duplicateScore.passed).toBe(false);expect(duplicateScore.failures).toContain('MODEL_STAGE_SUCCESS_CARDINALITY_MISMATCH');
  const extraRole=base('g702',{summary:'这是引用文本润色请求，不需要办理银行操作。',events:[{role:'semantic-intent',status:'completed',at:'2026-10-23T00:00:00Z',summary:'无操作'}],modelRuns:[run('semantic_intent'),run('transfer')],diagnostics:{intent:{status:'no_action',roles:[],findings:[]},domains:[]}});
  expect(scoreSemantic(f,extraRole).modelComplete).toBe(false);
 });
 it('requires semantic router, domain and reviewer calls for a ready transfer',()=>{
  const f=byId('g701');const result=base('g701',{summary:'已生成待确认转账提案。',suggestions:[{payeeId:'g7-g701-payee-primary',amountMinor:'102609',memo:'设备维修'}],events:[{role:'semantic-intent',status:'completed',at:'2026-10-23T00:00:00Z',summary:'识别完成'},{role:'transfer',status:'started',at:'2026-10-23T00:00:01Z',summary:'start'},{role:'reviewer',status:'started',at:'2026-10-23T00:00:02Z',summary:'review'},{role:'reviewer',status:'completed',at:'2026-10-23T00:00:03Z',summary:'reviewed'}],modelRuns:[run('semantic_intent'),run('transfer'),run('reviewer')],diagnostics:{intent:{status:'ready',roles:['transfer'],findings:[]},domains:[{role:'transfer',hasSuggestion:true,hasClarification:false,status:'accepted'}],review:{rawApproved:true,summary:'完整',effectiveApproved:true}}});
  const score=scoreSemantic(f,result);expect(score.passed).toBe(true);expect(score.modelComplete).toBe(true);expect(score.businessSemanticsPass).toBe(true);expect(score.scheduledRoles).toEqual(['transfer','reviewer']);
 });

 it('accepts a contract-labelled clarification at the semantic router without domain calls',()=>{
  const f=byId('g723');const result=base('g723',{summary:'缺少年份，请补充完整截止日期。',clarification:'请问截止日期是哪一年？',events:[{role:'semantic-intent',status:'completed',at:'2026-10-23T00:00:00Z',summary:'日期缺失'}],modelRuns:[run('semantic_intent')],diagnostics:{intent:{status:'clarification',roles:['goal'],findings:[]},domains:[]}});
  const score=scoreSemantic(f,result);expect(score.passed).toBe(true);expect(score.expectedStatus).toBe('clarification');expect(score.observedStatus).toBe('clarification');expect(score.expectedScheduledRoles).toEqual([]);expect(score.modelComplete).toBe(true);
 });
 it('accepts clarification after grounded ready routing and real domain plus reviewer calls',()=>{
  const f=byId('g708');const result=base('g708',{summary:'当前没有2025-12账单数据，无法列出该月交通支出。',clarification:'请提供2025-12账单数据后我再查询。',events:[{role:'semantic-intent',status:'completed',at:'2026-10-23T00:00:00Z',summary:'识别账单查询'},{role:'bills',status:'started',at:'2026-10-23T00:00:01Z',summary:'开始账单查询'},{role:'reviewer',status:'started',at:'2026-10-23T00:00:02Z',summary:'复核'},{role:'reviewer',status:'completed',at:'2026-10-23T00:00:03Z',summary:'复核完成'}],modelRuns:[run('semantic_intent'),run('bills'),run('reviewer')],diagnostics:{intent:{status:'ready',roles:['bills'],findings:[]},domains:[{role:'bills',hasSuggestion:false,hasClarification:true,status:'accepted'}],review:{rawApproved:false,summary:'缺少该月数据',effectiveApproved:false}}});
  const score=scoreSemantic(f,result);expect(score.passed).toBe(true);expect(score.observedStatus).toBe('ready');expect(score.expectedScheduledRoles).toEqual(['bills','reviewer']);expect(score.modelComplete).toBe(true);expect(score.businessSemanticsPass).toBe(true);
 });
 it('keeps successful retries distinct from first-attempt completeness',()=>{
  const f=byId('g702');const result=base('g702',{summary:'引用句不执行。',events:[{role:'semantic-intent',status:'completed',at:'2026-10-23T00:00:00Z',summary:'无操作'}],modelRuns:[{...run('semantic_intent','failed'),attempt:1,errorCode:'MODEL_OUTPUT_JSON_INVALID'},{...run('semantic_intent'),attempt:2}],diagnostics:{intent:{status:'no_action',roles:[],findings:[]},domains:[]}});
  const score=scoreSemantic(f,result);expect(score.modelComplete).toBe(true);expect(score.firstAttemptComplete).toBe(false);expect(score.failedAttempts).toBe(1);expect(score.errorCodes).toEqual(['MODEL_OUTPUT_JSON_INVALID']);
 });
});
