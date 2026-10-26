import { afterEach,describe,expect,it,vi } from 'vitest';
import { createHash,randomUUID } from 'node:crypto';
import { mkdtemp,readFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelProviderError,MODEL_ATTEMPT_PROTOCOL_VERSION,MODEL_STRUCTURED_OUTPUT_OBSERVATION_VERSION,type ModelAttemptObserver,type ModelAttemptStart,type ModelStructuredOutputObservation } from '../packages/agents/src/provider';
import type { PlanResult } from '../packages/contracts/src/index';
import { g9Dataset } from '../evals/g9-holdout-fixtures';
import { g9cQualityDataset } from '../evals/g9c-quality-fixtures';
import { digest } from '../evals/ablation-score';
import { scoreG9 } from '../evals/g9-score';
import { scoreG9E, G9E_SCORE_VERSION } from '../evals/g9e-score';
import { g9gExpected } from '../evals/g9g-score';
import type { G9Manifest } from '../evals/g9-contract';
import { g9cProviderFingerprint } from '../scripts/evaluate-g9c';
import type { G9CQualityManifest } from '../scripts/evaluate-g9c-quality';
import { attachG9GCurrentScore,buildG9GManifest,executeG9GStage,G9G_EVALUATOR_FILES,G9G_PROTOCOL_PATH,runG9G,validateG9GManifestMetadata,validateG9GPriorReport,type G9GManifest } from '../scripts/evaluate-g9g';
import type { G9CaseRecord } from '../scripts/evaluate-g9';

const hash=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
const config={model:'offline-g9g-calibration',baseURL:'https://calibration.invalid/v1',outputMode:'json_object' as const};
const dirs:string[]=[];
const temp=async()=>{const path=await mkdtemp(join(tmpdir(),'g9g-runner-'));dirs.push(path);return path;};
afterEach(async()=>{vi.restoreAllMocks();vi.unstubAllGlobals();await Promise.all(dirs.splice(0).map(path=>rm(path,{recursive:true,force:true})));});
async function calibration(){
  const originalBytes=await readFile('evals/g9-manifest.json'),qualityBytes=await readFile('evals/g9c-quality-manifest.json');
  const original=JSON.parse(originalBytes.toString()) as G9Manifest,qualityParent=JSON.parse(qualityBytes.toString()) as G9CQualityManifest;
  const inputs={original,qualityParent,knownDataset:g9Dataset,qualityDataset:g9cQualityDataset,originalManifestSha256:hash(originalBytes),qualityParentManifestSha256:hash(qualityBytes)};
  const evaluatorHashes=Object.fromEntries(G9G_EVALUATOR_FILES.map(path=>[path,hash(path)]));
  const manifest=buildG9GManifest({...inputs,frozenAt:'2026-10-24T08:00:00.000Z',sourceManifestPath:'evals/baselines/g9g-calibration/source-manifest.json',sourceManifestSha256:hash('source'),evaluatorHashes,provider:g9cProviderFingerprint(config)});
  return {inputs,evaluatorHashes,manifest};
}
async function failedSemanticAttempt(observer:ModelAttemptObserver){
  const start:ModelAttemptStart={type:'attempt_start',protocolVersion:MODEL_ATTEMPT_PROTOCOL_VERSION,invocationId:randomUUID(),attemptId:randomUUID(),role:'semantic_intent',attempt:1,requestMaxOutputTokens:4096,startedAtUtc:new Date().toISOString(),dispatch:'pending'};
  await observer(start);const {type:_type,dispatch:_dispatch,...identity}=start;
  await observer({...identity,type:'attempt_end',endedAtUtc:new Date().toISOString(),durationMs:1,requestStarted:true,status:'failed',errorCode:'MODEL_HTTP_503',failureStage:'request',httpStatus:503});
  return start.attemptId;
}
const trace=(attemptId:string):ModelStructuredOutputObservation=>({version:MODEL_STRUCTURED_OUTPUT_OBSERVATION_VERSION,role:'semantic_intent',toolName:'interpret_banking_intent',attempt:1,attemptId,status:'failed',errorCode:'MODEL_HTTP_503',outputText:'{"synthetic":true}',outputLength:18,outputDigest:hash('{"synthetic":true}')});
function noNetwork(){vi.stubGlobal('fetch',vi.fn(()=>{throw new Error('NETWORK_FORBIDDEN_IN_G9G_CALIBRATION');}));vi.spyOn(console,'log').mockImplementation(()=>{});}
async function oneCaseTrace(emit:(callback:((event:Readonly<ModelStructuredOutputObservation>)=>void)|undefined,id:string)=>void){
  const {manifest}=await calibration(),fixture=g9Dataset.cases[0]!,dataset={...g9Dataset,cases:[fixture]},short=structuredClone(manifest) as G9GManifest;
  short.cohorts.knownRegression.caseIds=[fixture.id];short.cohorts.knownRegression.caseCount=1 as 36;
  short.cohorts.knownRegression.templateInputsSha256=digest([fixture.input]);
  short.cohorts.knownRegression.originalExpectedLabelsSha256=digest([fixture.expected]);
  short.cohorts.knownRegression.currentExpectedLabelsSha256=digest([g9gExpected(fixture)]);
  return executeG9GStage({dataset,manifest:short,manifestHash:hash(`one-${randomUUID()}`),cohort:'known-regression',config,resultsDir:await temp(),verifyFrozenFiles:async()=>true,semanticJsonl:true,
    plan:async(_input,observer,_signal,structuredObserver)=>{const id=await failedSemanticAttempt(observer);emit(structuredObserver,id);throw new ModelProviderError('MODEL_HTTP_503',true);}});
}

describe('G9G default-only manifest and three independent score contracts',()=>{
  it('binds 36+12 original and current labels, omitted provider, scorer and protocol',async()=>{
    const {inputs,evaluatorHashes,manifest}=await calibration();
    expect(validateG9GManifestMetadata(manifest,inputs,evaluatorHashes,'2026-10-24T09:00:00.000Z')).toMatchObject({knownCount:36,qualityCount:12});
    expect(manifest.provider.reasoningEffort).toBe('omitted');
    expect(manifest.cohorts.knownRegression.caseIds).toEqual(g9Dataset.cases.map(item=>item.id));
    expect(manifest.cohorts.developmentSupplemental.caseIds).toEqual(g9cQualityDataset.cases.map(item=>item.id));
    expect(manifest.cohorts.knownRegression.currentExpectedLabelsSha256).not.toBe(manifest.cohorts.knownRegression.originalExpectedLabelsSha256);
    expect(G9G_EVALUATOR_FILES).toEqual(expect.arrayContaining(['evals/g9g-score.ts','tests/g9g-score.test.ts','tests/g9g-runner.test.ts',G9G_PROTOCOL_PATH]));
  });
  it.each(['known-order','current-labels','original-labels','budget','provider-none','evaluator','source-hash'])('rejects %s drift before dispatch',async issue=>{
    const data=await calibration(),m=data.manifest;
    if(issue==='known-order')m.cohorts.knownRegression.caseIds.reverse();
    if(issue==='current-labels')m.cohorts.developmentSupplemental.currentExpectedLabelsSha256=hash('altered');
    if(issue==='original-labels')m.cohorts.knownRegression.originalExpectedLabelsSha256=hash('altered');
    if(issue==='budget')m.limits={...m.limits,maxAttempts:3} as unknown as typeof m.limits;
    if(issue==='provider-none')m.provider={...m.provider,reasoningEffort:'none'};
    if(issue==='evaluator')m.evaluatorHashes[G9G_PROTOCOL_PATH]=hash('altered');
    if(issue==='source-hash')m.sourceManifestSha256='invalid';
    expect(()=>validateG9GManifestMetadata(m,data.inputs,data.evaluatorHashes,'2026-10-24T09:00:00.000Z')).toThrow('G9G_FROZEN_MANIFEST_MISMATCH');
  });
  it('rejects condition, scope and preflight execution switches before accessing provider',async()=>{
    await expect(runG9G(['--mode','live','--cohort','known-regression','--semantic-jsonl','--results-dir','/tmp/alternate-g9g'])).rejects.toThrow('G9G_UNSUPPORTED_OR_DUPLICATE_OPTION');
    await expect(runG9G([])).rejects.toThrow('G9G_EXPLICIT_STAGE_REQUIRED');
    await expect(runG9G(['--mode','live','--condition','none','--cohort','known-regression'])).rejects.toThrow('G9G_UNSUPPORTED_OR_DUPLICATE_OPTION');
    await expect(runG9G(['--mode','live','--cohort','known-regression','--limit','1'])).rejects.toThrow('G9G_UNSUPPORTED_OR_DUPLICATE_OPTION');
    await expect(runG9G(['--mode','live','--cohort','known-regression'])).rejects.toThrow('G9G_SEMANTIC_TRACE_REQUIRED');
    await expect(runG9G(['--preflight','--mode','live'])).rejects.toThrow('G9G_PREFLIGHT_HAS_NO_EXECUTION_MODE');
  });
  it('retains a G9E denial false positive beside the independently versioned G9G score',()=>{
    const fixture=g9cQualityDataset.cases.find(item=>item.id==='g9-quality-subscription-02')!,expected=g9gExpected(fixture);
    const result={taskId:fixture.input.taskId,planVersion:1,mode:'model',summary:'两项均为待确认提案，未声明已执行或已获得资金/扣款授权。',findings:[],evidence:[],suggestions:[],managementSuggestions:expected.management,
      events:expected.activatedRoles.map(role=>({role,status:'started',at:'2026-10-25T00:00:00.000Z',summary:'started'})),
      modelRuns:expected.successfulCallRoles.map(role=>({role,model:'synthetic',status:'success',durationMs:1})),diagnostics:{domains:[],intent:{status:expected.semantic.status,roles:expected.semantic.recognizedRoles,findings:[]}}} as PlanResult;
    const originalScore=scoreG9(fixture,result),previousScore=scoreG9E(fixture,result);
    const original={startedAt:'2026-10-25T00:00:00.000Z',result,score:originalScore,evaluationValid:true,passed:originalScore.passed,labelsUnchanged:true} as G9CaseRecord;
    const record=attachG9GCurrentScore(fixture,original,digest(expected));
    expect(record.score).toBe(originalScore);expect(record.previousContractScore).toEqual(previousScore);
    expect(record.previousContractPassed).toBe(false);expect(record.previousContractScore?.unsafeCompletionClaim).toBe(true);
    expect(record.currentContractPassed).toBe(true);expect(record.currentContractScore?.unsafeCompletionClaim).toBe(false);
    expect(record.currentContractScore?.version).not.toBe(record.previousContractScore?.version);
  });
  it('attaches a separately versioned current score while leaving original G9 score unchanged',()=>{
    const fixture=g9Dataset.cases.find(item=>item.id==='g9-goal-03')!,expected=g9gExpected(fixture);
    const result={taskId:fixture.input.taskId,planVersion:1,mode:'model',summary:'尚未执行，仍需独立授权。',findings:[],evidence:[],suggestions:[],managementSuggestions:[],investmentSuggestions:[],goalSuggestion:{title:'合成目标',...expected.goal},
      events:expected.activatedRoles.map(role=>({role,status:'started',at:'2026-10-24T09:00:00.000Z',summary:'started'})),
      modelRuns:expected.successfulCallRoles.map(role=>({role,model:'synthetic',status:'success',durationMs:1})),diagnostics:{domains:[],intent:{status:expected.semantic.status,roles:expected.semantic.recognizedRoles,findings:[]}}} as PlanResult;
    const originalScore=scoreG9(fixture,result),original={startedAt:'2026-10-24T09:00:00.000Z',result,score:originalScore,evaluationValid:true,passed:originalScore.passed,labelsUnchanged:true} as G9CaseRecord;
    const record=attachG9GCurrentScore(fixture,original,digest(expected));
    expect(record.score).toBe(originalScore);expect(record.passed).toBe(false);expect(record.currentContractScore?.passed).toBe(true);
    expect(record.previousContractScore).toEqual(scoreG9E(fixture,result));
    expect(record.previousContractScore?.version).toBe(G9E_SCORE_VERSION);expect(record.previousContractPassed).toBe(true);
    expect(record.currentContractPassed).toBe(true);expect(record.currentLabelsUnchanged).toBe(true);
  });
});

describe('G9G offline durable stage orchestration and trace integrity',()=>{
  it('runs default 36 then 12 only once and reports both separate denominators without fetch',async()=>{
    noNetwork();const {manifest}=await calibration(),resultsDir=await temp(),manifestHash=hash('manifest'),verifyFrozenFiles=vi.fn(async()=>true);
    const plan=async(_input:unknown,observer:ModelAttemptObserver,_signal:AbortSignal,structuredObserver?:((event:Readonly<ModelStructuredOutputObservation>)=>void))=>{
      const id=await failedSemanticAttempt(observer);structuredObserver?.(trace(id));throw new ModelProviderError('MODEL_HTTP_503',true);
    };
    const known=await executeG9GStage({dataset:g9Dataset,manifest,manifestHash,cohort:'known-regression',config,resultsDir,verifyFrozenFiles,semanticJsonl:true,plan});
    expect(known.stage).toBe('default-known');expect(known.validRun).toBe(true);expect(known.semanticTraceStatus).toBe('complete');
    expect(known.previousScoreSummary.plannedCases).toBe(36);expect(known.previousScoreSummary.businessUnavailableCases).toBe(36);
    expect(known.scoreSummary.plannedCases).toBe(36);expect(known.currentScoreSummary.plannedCases).toBe(36);
    expect(known.scoreSummary.businessUnavailableCases).toBe(36);expect(known.currentScoreSummary.businessUnavailableCases).toBe(36);
    expect(known.records.every(record=>record.score===undefined&&record.previousContractScore===undefined&&record.previousContractPassed===false&&record.currentContractScore===undefined)).toBe(true);
    const quality=await executeG9GStage({dataset:g9cQualityDataset,manifest,manifestHash,cohort:'development-supplemental',config,resultsDir,verifyFrozenFiles,semanticJsonl:true,priorReportPaths:{'default-known':known.jsonPath},plan});
    expect(quality.stage).toBe('default-quality');expect(quality.validRun).toBe(true);
    expect(quality.scoreSummary.plannedCases).toBe(12);expect(quality.currentScoreSummary.plannedCases).toBe(12);
    expect(quality.priorReportSha256['default-known']).toBe(hash(await readFile(known.jsonPath)));
    expect((await readFile(quality.jsonlPath,'utf8')).trim().split('\n')).toHaveLength(14);
    expect((await readFile(known.semanticPath!,'utf8')).trim().split('\n')).toHaveLength(36);
    await expect(executeG9GStage({dataset:g9Dataset,manifest,manifestHash,cohort:'known-regression',config,resultsDir,verifyFrozenFiles,semanticJsonl:true,plan})).rejects.toThrow('EEXIST');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('requires the complete prior stage and exact default provider before a result claim',async()=>{
    noNetwork();const {manifest}=await calibration(),resultsDir=await temp(),plan=vi.fn();
    await expect(executeG9GStage({dataset:g9cQualityDataset,manifest,manifestHash:hash('manifest'),cohort:'development-supplemental',config,resultsDir,verifyFrozenFiles:async()=>true,plan})).rejects.toThrow('G9G_PRIOR_STAGE_REQUIRED');
    await expect(executeG9GStage({dataset:g9Dataset,manifest,manifestHash:hash('manifest'),cohort:'known-regression',config:{...config,reasoningEffort:'none'},resultsDir,verifyFrozenFiles:async()=>true,plan})).rejects.toThrow('G9G_EXECUTION_CONTRACT_MISMATCH');
    expect(()=>validateG9GPriorReport({},{stage:'default-known',manifest,manifestHash:hash('manifest')})).toThrow('G9G_PRIOR_STAGE_INVALID');
    await expect(executeG9GStage({dataset:g9Dataset,manifest,manifestHash:hash('manifest'),cohort:'known-regression',config,resultsDir,verifyFrozenFiles:async()=>true,plan})).rejects.toThrow('G9G_SEMANTIC_TRACE_REQUIRED');
    expect(plan).not.toHaveBeenCalled();expect(fetch).not.toHaveBeenCalled();
  });
  it.each(['missing','duplicate','wrong-id','wrong-digest','bad-omission'])('invalidates %s semantic trace without retry',async scenario=>{
    noNetwork();const report=await oneCaseTrace((callback,id)=>{
      const base=trace(id);
      if(scenario==='missing')return;
      if(scenario==='duplicate'){callback?.(base);callback?.(base);return;}
      if(scenario==='wrong-id'){callback?.({...base,attemptId:randomUUID()});return;}
      if(scenario==='wrong-digest'){callback?.({...base,outputDigest:hash('wrong')});return;}
      callback?.({...base,outputText:undefined,outputOmitted:'not_text'});
    });
    expect(report.attemptObservation.confirmedStarts).toBe(1);expect(report.attemptObservation.confirmedEnds).toBe(1);
    expect(report.validRun).toBe(false);expect(report.semanticTraceStatus).toBe('incomplete');
    expect(report.records[0]).toMatchObject({evaluationValid:false,errorCode:'G9G_SEMANTIC_TRACE_INCOMPLETE'});
    expect(fetch).not.toHaveBeenCalled();
  });
  it('keeps complete short output only in the sealed semantic JSONL',async()=>{
    noNetwork();const report=await oneCaseTrace((callback,id)=>callback?.(trace(id)));
    expect(report.validRun).toBe(true);expect(report.semanticTraceStatus).toBe('complete');
    const rows=(await readFile(report.semanticPath!,'utf8')).trim().split('\n').map(line=>JSON.parse(line));
    expect(rows).toHaveLength(1);expect(rows[0]).toMatchObject({caseId:g9Dataset.cases[0]!.id,outputText:'{"synthetic":true}'});
    expect(JSON.stringify(report)).not.toContain('"synthetic":true');expect(fetch).not.toHaveBeenCalled();
  });
});
