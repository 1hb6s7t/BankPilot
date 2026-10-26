import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { classifyEvaluationFailure, summarizeEvaluationCases, summarizeEvaluationObservation } from '../scripts/evaluation-observation';
import { createModelAttemptJournal, type ModelAttemptJournalSummary } from '../packages/agents/src/attempt-journal';
import { MODEL_ATTEMPT_PROTOCOL_VERSION, ModelAttemptPersistenceError, ModelProviderError, type ModelAttemptStart, type ModelAttemptEnd } from '../packages/agents/src/provider';
import { PlanningStageFailure } from '../packages/agents/src/planning-failures';
import { PlanningBudgetError } from '../packages/agents/src/budget';
const directories: string[] = [], journals: Awaited<ReturnType<typeof createModelAttemptJournal>>[] = [];
async function journal() { const directory = await mkdtemp(join(tmpdir(), 'g8g-observation-')); directories.push(directory); const log = await createModelAttemptJournal(join(directory,'attempts.jsonl')); journals.push(log); return log; }
const start = (cap: number | null = 4096, role: ModelAttemptStart['role'] = 'transfer'): ModelAttemptStart => ({ protocolVersion: MODEL_ATTEMPT_PROTOCOL_VERSION, type: 'attempt_start', dispatch: 'pending', attemptId: randomUUID(), invocationId: randomUUID(), role, attempt: 1, requestMaxOutputTokens: cap, startedAtUtc: '2026-10-23T00:00:00.000Z' });
function end(event: ModelAttemptStart, extras: Partial<ModelAttemptEnd> = {}): ModelAttemptEnd { const { type: _type, dispatch: _dispatch, ...identity } = event; return { ...identity, type: 'attempt_end', endedAtUtc: '2026-10-23T00:00:00.010Z', durationMs: 10, requestStarted: true, status: 'success', ...extras }; }
async function completed(log: Awaited<ReturnType<typeof journal>>, sequence = 1, cap: number | null = 4096, extras: Partial<ModelAttemptEnd> = {}) { const event = start(cap); await log.observerForCase(sequence)(event); await log.observerForCase(sequence)(end(event,extras)); return event; }
afterEach(async () => { await Promise.all(journals.splice(0).map(log => log.close().catch(() => {}))); await Promise.all(directories.splice(0).map(path => rm(path,{recursive:true,force:true}))); });

describe('G8G sanitized typed evaluation failures', () => {
  it('keeps typed phase, stage, cause and safe findings without leaking model, payload, messages or stacks', () => {
    const failure = classifyEvaluationFailure(new PlanningStageFailure({ phase: 'planning', stage: 'domain:transfer', code: 'MODEL_CANDIDATE_CONTRACT_INVALID', retryable: false,
      message: 'SECRET_USER_TEXT', findings: ['TRANSFER_MEMO_MISMATCH：SECRET_AMOUNT', 'API_KEY_SECRET', 'GOAL_SPEC_MISMATCH SECRET_NAME'],
      modelRuns: [{ role: 'transfer', model: 'SECRET_MODEL_KEY', status: 'success', durationMs: 5, inputTokens: 0, outputTokens: 3, issues: [{ path: ['SECRET_PATH'], code: 'SECRET_CODE' }], ...{ payload: 'SECRET_PAYLOAD' } } as any] }));
    expect(failure).toMatchObject({ code: 'MODEL_CANDIDATE_CONTRACT_INVALID', kind: 'planning_stage', phase: 'planning', stage: 'domain:transfer', retryable: false, modelRunsScope: 'selected-failure-stage-only', findings: ['TRANSFER_MEMO_MISMATCH','GOAL_SPEC_MISMATCH'] });
    expect(failure.localModelRuns).toEqual([{ role: 'transfer', model: '[configured-model-redacted]', status: 'success', durationMs: 5, inputTokens: 0, outputTokens: 3 }]);
    expect(JSON.stringify(failure)).not.toContain('SECRET');
  });
  it('bounds local records and never treats them as full-case attempts', () => {
    const failure = classifyEvaluationFailure(new PlanningStageFailure({ phase: 'planning', code: 'MODEL_HTTP_502', stage: 'reviewer', retryable: true, message: '', modelRuns: Array.from({length:40}, () => ({ role: 'reviewer', model: 'local', status: 'failed', durationMs: 1 })) }));
    expect(failure.localModelRuns).toHaveLength(32); expect(failure.omittedLocalModelRuns).toBe(8); expect(failure).not.toHaveProperty('confirmedStarts');
  });
  it('does not log arbitrary error strings, objects, messages or forged codes', () => {
    for (const error of ['SECRET_TOKEN', Object.assign(new Error('SECRET_ERROR'),{code:'SECRET_CODE'}), {failure:{code:'SECRET_CODE',message:'SECRET_MESSAGE'}}]) {
      expect(classifyEvaluationFailure(error)).toMatchObject({ kind:'unknown',code:'EVAL_RUN_ERROR',retryable:false });
      expect(JSON.stringify(classifyEvaluationFailure(error))).not.toContain('SECRET');
    }
    const unknown = classifyEvaluationFailure(new PlanningStageFailure({ phase:'planning',code:'SECRET_CODE',retryable:true,message:'SECRET',modelRuns:[] }));
    expect(unknown).toMatchObject({code:'EVAL_UNCLASSIFIED_STAGE_FAILURE',retryable:false});
  });
  it('preserves attempt persistence metadata but sanitizes its underlying error code', () => {
    const value = classifyEvaluationFailure(new ModelAttemptPersistenceError('MODEL_ATTEMPT_END_PERSIST_FAILED','failed','MODEL_HTTP_502'));
    expect(value).toMatchObject({kind:'attempt_persistence',code:'MODEL_ATTEMPT_END_PERSIST_FAILED',requestOutcome:'failed',requestErrorCode:'MODEL_HTTP_502',retryable:false});
    expect(classifyEvaluationFailure(new ModelAttemptPersistenceError('MODEL_ATTEMPT_START_PERSIST_FAILED','not_sent','SECRET'))).not.toHaveProperty('requestErrorCode');
  });
  it('preserves the existing case deadline label without hiding a typed cause', () => {
    expect(classifyEvaluationFailure(new Error('private'),{deadlineExceeded:true})).toMatchObject({code:'CASE_DEADLINE_EXCEEDED',kind:'deadline',caseDeadlineExceeded:true});
    expect(classifyEvaluationFailure(new PlanningStageFailure({phase:'planning',stage:'reviewer',code:'MODEL_HTTP_401',retryable:false,message:'',modelRuns:[]}),{deadlineExceeded:true})).toMatchObject({code:'MODEL_HTTP_401',caseDeadlineExceeded:true,stage:'reviewer'});
  });
  it.each([['MODEL_HTTP_502',true],['MODEL_HTTP_429',true],['MODEL_HTTP_401',false],['MODEL_SCHEMA_INVALID',false]] as const)('classifies direct provider %s without trusting arbitrary retryable flags', (code,retryable) => { expect(classifyEvaluationFailure(new ModelProviderError(code,true))).toMatchObject({code,retryable,kind:'provider'}); });
  it('keeps budget failure distinct', () => { expect(classifyEvaluationFailure(new PlanningBudgetError('MODEL_OUTPUT_BUDGET_EXHAUSTED'))).toMatchObject({kind:'budget',code:'MODEL_OUTPUT_BUDGET_EXHAUSTED',retryable:false}); });
});

describe('G8G fsync-confirmed independent attempts and cap audit', () => {
  it('reports zero usage only when explicitly reported and counts a failed HTTP attempt without refund', async () => {
    const log=await journal(); await completed(log,1,4096,{status:'failed',errorCode:'MODEL_HTTP_502',inputTokens:0,outputTokens:0});
    const value=summarizeEvaluationObservation(log.summary(1),{mode:'live',caseSequence:1});
    expect(value).toMatchObject({complete:true,verified:true,confirmedStarts:1,confirmedEnds:1,dispatchAttempted:1,failed:1,budget:{verified:true,withinBudget:true,requestedOutputTokens:4096},usage:{inputTokensTotal:0,outputTokensTotal:0,missingInputUsage:0,missingOutputUsage:0},errorCodes:{MODEL_HTTP_502:1}});
  });
  it('keeps unknown outcome and usage unknown after a durable start without an end', async () => {
    const log=await journal(); await log.observerForCase(1)(start(3000));
    const value=summarizeEvaluationObservation(log.summary(),{mode:'live'});
    expect(value).toMatchObject({complete:false,verified:false,confirmedStarts:1,confirmedEnds:0,openCount:1,dispatchAttempted:0,budget:{requestedOutputTokens:3000,verified:false,withinBudget:null},usage:{inputTokensTotal:null,outputTokensTotal:null,inputUsageUnaccountedAttempts:1,outputUsageUnaccountedAttempts:1}});
  });
  it('does not add selected failure modelRuns to journal totals', async () => {
    const log=await journal(); await completed(log,1,1024); await completed(log,1,1024,{status:'failed',errorCode:'MODEL_HTTP_502'});
    const failure=classifyEvaluationFailure(new PlanningStageFailure({phase:'planning',stage:'reviewer',code:'MODEL_HTTP_502',retryable:true,message:'',modelRuns:[{role:'reviewer',model:'stub',status:'failed',durationMs:1}]}));
    const result=summarizeEvaluationCases([{sequence:1,durationMs:50,failure,observation:summarizeEvaluationObservation(log.summary(1),{mode:'live',caseSequence:1})}]);
    expect(result.attempts).toMatchObject({confirmedStarts:2,confirmedEnds:2,successful:1,failed:1}); expect(result).toMatchObject({scoredCases:0,unscoredCases:1,typedStageFailures:1});
    expect(result.usage.inputTokensTotal).toBeNull();
  });
  it('audits caps per case, so two valid cases may exceed one case ceiling in aggregate', async () => {
    const log=await journal(); await completed(log,2,20000); await completed(log,1,20000);
    const value=summarizeEvaluationObservation(log.summary(),{mode:'live'});
    expect(value.budget).toMatchObject({withinBudget:true,verified:true,requestedOutputTokens:40000}); expect(value.budget.caseBudgets.map(x=>x.caseSequence)).toEqual([1,2]);
    expect(summarizeEvaluationObservation(log.summary(),{mode:'live',caseSequence:1}).confirmedStarts).toBe(1);
  });
  it('rejects known per-case excess even with complete success end records', async () => {
    const log=await journal(); await completed(log,1,20000); await completed(log,1,20000);
    const observation=summarizeEvaluationObservation(log.summary(),{mode:'live'});
    expect(observation.budget).toMatchObject({withinBudget:false,verified:true,requestedOutputTokens:40000});
    expect(summarizeEvaluationCases([{sequence:1,durationMs:1,observation}]).complete).toBe(false);
  });
  it('cannot certify budget when caps are missing, even when all attempts ended', async () => {
    const log=await journal(); await completed(log,1,null);
    const observation=summarizeEvaluationObservation(log.summary(),{mode:'live'});
    expect(observation).toMatchObject({complete:true,budget:{withinBudget:null,verified:false,missingRequestCaps:1,requestedOutputTokens:0}});
    expect(summarizeEvaluationCases([{sequence:1,durationMs:1,observation}]).complete).toBe(false);
  });
  it.each([-1,0,32769,1.5])('refuses illegal cap %s in an incompatible supplied summary', async cap => {
    const log=await journal(); await completed(log);
    const original=log.summary(); const row=original.confirmedAttempts[0]!;
    const summary={...original,confirmedAttempts:[{...row,start:{...row.start,requestMaxOutputTokens:cap},end:{...row.end!,requestMaxOutputTokens:cap}}]};
    const value=summarizeEvaluationObservation(summary,{mode:'live'});
    expect(value.budget).toMatchObject({withinBudget:false,verified:false,invalidRequestCaps:1});
  });
  it('a failed journal invalidates proof even if a previous case had completed', async () => {
    const log=await journal(); await completed(log,1);
    await expect(log.observerForCase(2)({...start(),role:'SECRET_INVALID_ROLE'} as any)).rejects.toThrow('MODEL_ATTEMPT_JOURNAL_FAILED');
    const value=summarizeEvaluationObservation(log.summary(1),{mode:'live',caseSequence:1});
    expect(value).toMatchObject({confirmedStarts:1,confirmedEnds:1,persistenceFailed:true,complete:false,verified:false,budget:{verified:false,withinBudget:null}});
  });
  it('returns detached readonly confirmed details without exposing arbitrary fields', async () => {
    const log=await journal(); await completed(log); const first=log.summary();
    expect(Object.isFrozen(first.confirmedAttempts)).toBe(true); expect(Object.isFrozen(first.confirmedAttempts[0]!.start)).toBe(true);
    expect(()=>{(first.confirmedAttempts[0]!.start as any).requestMaxOutputTokens=1;}).toThrow();
    expect(log.summary().confirmedAttempts[0]!.start.requestMaxOutputTokens).toBe(4096);
  });
  it('deduplicates repeated attempt IDs and refuses the corrupted summary', async () => {
    const log=await journal(); await completed(log); const original=log.summary();
    const summary={...original,confirmedStarts:2,confirmedEnds:2,confirmedAttempts:[...original.confirmedAttempts,...original.confirmedAttempts]};
    const value=summarizeEvaluationObservation(summary,{mode:'live'});
    expect(value).toMatchObject({confirmedStarts:1,confirmedEnds:1,verified:false,complete:false,budget:{verified:false}});
  });
  it('distinguishes live missing evidence from scripted zero-call not-applicable', () => {
    expect(summarizeEvaluationObservation(undefined,{mode:'live'})).toMatchObject({applicable:true,complete:false,verified:false,reason:'journal-unavailable',budget:{withinBudget:null,verified:false}});
    const observation=summarizeEvaluationObservation(undefined,{mode:'scripted'});
    expect(observation).toMatchObject({applicable:false,complete:true,verified:null,reason:'scripted-zero-calls',budget:{withinBudget:null,verified:null}});
    expect(summarizeEvaluationCases([{sequence:1,durationMs:0,score:{},observation}])).toMatchObject({complete:true,budget:{verifiedCases:0,unverifiedCases:0}});
  });
  it('marks unexpected scripted calls invalid rather than claiming a zero-call baseline', async () => {
    const log=await journal(); await completed(log);
    expect(summarizeEvaluationObservation(log.summary(),{mode:'scripted'})).toMatchObject({applicable:true,complete:false,verified:false,reason:'unexpected-scripted-calls'});
  });
  it('keeps all-case and observed-call latency cohorts separate and empty quantiles null', async () => {
    const log=await journal(); await completed(log);
    const result=summarizeEvaluationCases([{sequence:1,durationMs:10,observation:summarizeEvaluationObservation(log.summary(),{mode:'live'})},{sequence:2,durationMs:30,errorCode:'CASE_DEADLINE_EXCEEDED'}]);
    expect(result.latency).toEqual({allCases:{count:2,medianMs:20,p95Ms:30},casesWithConfirmedStarts:{count:1,medianMs:10,p95Ms:10},casesWithConfirmedDispatch:{count:1,medianMs:10,p95Ms:10}});
    expect(result.errorCodes).toEqual({CASE_DEADLINE_EXCEEDED:1}); expect(result.complete).toBe(false);
    expect(summarizeEvaluationCases([]).latency.allCases).toEqual({count:0,medianMs:null,p95Ms:null});
  });
  it('uses the arithmetic middle pair for four latency samples, preserving the existing runner convention', () => {
    const result=summarizeEvaluationCases([10,40,20,30].map((durationMs,index)=>({sequence:index+1,durationMs})));
    expect(result.latency.allCases).toEqual({count:4,medianMs:25,p95Ms:40});
  });
  it('does not double-count a duplicated case sequence and refuses aggregate completeness', async () => {
    const log=await journal(); await completed(log); const record={sequence:1,durationMs:1,observation:summarizeEvaluationObservation(log.summary(),{mode:'live'})};
    expect(summarizeEvaluationCases([record,record])).toMatchObject({complete:false,attempts:{confirmedStarts:1},budget:{unverifiedCases:1}});
  });
});


describe('G8G scorer execution and business availability denominators', () => {
  const failure = classifyEvaluationFailure(new PlanningStageFailure({phase:'semantic_intent',code:'MODEL_HTTP_502',retryable:true,message:'',modelRuns:[]}));
  it('keeps old scored counts while separating returned system failure, business rejection and thrown failure', () => {
    const records = [
      {sequence:1,durationMs:1,score:{passed:false,planningSafety:true,observedStatus:'failed'},passed:false,failure,failureSource:'returned-plan' as const},
      {sequence:2,durationMs:2,score:{passed:false,planningSafety:true,reviewApproved:false},passed:false},
      {sequence:3,durationMs:3,score:{passed:true,planningSafety:true},passed:true},
      {sequence:4,durationMs:4,passed:false,failure,failureSource:'thrown' as const},
    ];
    const before=structuredClone(records), value=summarizeEvaluationCases(records);
    expect(value).toMatchObject({cases:4,scoredCases:3,unscoredCases:1,safetyUnscoredCases:1,scoredSystemFailureCases:1,businessResultCases:2,businessUnavailableCases:2,returnedPlanFailureCases:1,thrownFailureCases:1});
    expect(records).toEqual(before); // No removal, relabeling or repair of the original score/passed contract.
    expect(value.scoringBoundary).toContain('System failures are not business results');
    expect(value.scoringBoundary).toContain('validRun describes evaluation validity, not business success');
  });
  it('never treats scored safe empty outputs from system failures as available business results', () => {
    const value=summarizeEvaluationCases([1,2].map(sequence=>({sequence,durationMs:1,score:{passed:false,planningSafety:true,unexpectedActionProposal:false},failure,failureSource:'returned-plan' as const})));
    expect(value).toMatchObject({scoredCases:2,unscoredCases:0,scoredSystemFailureCases:2,businessResultCases:0,businessUnavailableCases:2,returnedPlanFailureCases:2,thrownFailureCases:0});
  });
  it('does not guess a missing failure source and still excludes the system failure from business results', () => {
    expect(summarizeEvaluationCases([{sequence:1,durationMs:1,score:{},failure}])).toMatchObject({scoredCases:1,scoredSystemFailureCases:1,businessResultCases:0,businessUnavailableCases:1,returnedPlanFailureCases:0,thrownFailureCases:0});
  });
});
