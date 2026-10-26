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
import { g9eExpected } from '../evals/g9e-score';
import type { G9Manifest } from '../evals/g9-contract';
import { g9cProviderFingerprint } from '../scripts/evaluate-g9c';
import type { G9CQualityManifest } from '../scripts/evaluate-g9c-quality';
import { attachG9ECurrentScore,buildG9EManifest,executeG9EStage,G9E_EVALUATOR_FILES,G9E_PROTOCOL_PATH,runG9E,validateG9EManifestMetadata,validateG9EPriorReport,type G9EManifest } from '../scripts/evaluate-g9e';
import type { G9CaseRecord } from '../scripts/evaluate-g9';

const hash=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
const config={model:'offline-g9e-calibration',baseURL:'https://calibration.invalid/v1',outputMode:'json_object' as const};
const dirs:string[]=[];
const temp=async()=>{const path=await mkdtemp(join(tmpdir(),'g9e-runner-'));dirs.push(path);return path;};
afterEach(async()=>{vi.restoreAllMocks();vi.unstubAllGlobals();await Promise.all(dirs.splice(0).map(path=>rm(path,{recursive:true,force:true})));});
async function calibration(){
  const originalBytes=await readFile('evals/g9-manifest.json'),qualityBytes=await readFile('evals/g9c-quality-manifest.json');
  const original=JSON.parse(originalBytes.toString()) as G9Manifest,qualityParent=JSON.parse(qualityBytes.toString()) as G9CQualityManifest;
  const inputs={original,qualityParent,knownDataset:g9Dataset,qualityDataset:g9cQualityDataset,originalManifestSha256:hash(originalBytes),qualityParentManifestSha256:hash(qualityBytes)};
  const evaluatorHashes=Object.fromEntries(G9E_EVALUATOR_FILES.map(path=>[path,hash(path)]));
  const manifest=buildG9EManifest({...inputs,frozenAt:'2026-10-24T08:00:00.000Z',sourceManifestPath:'evals/baselines/g9e-calibration/source-manifest.json',sourceManifestSha256:hash('source'),evaluatorHashes,provider:g9cProviderFingerprint(config)});
  return {inputs,evaluatorHashes,manifest};
}
async function failedSemanticAttempt(observer:ModelAttemptObserver){
  const start:ModelAttemptStart={type:'attempt_start',protocolVersion:MODEL_ATTEMPT_PROTOCOL_VERSION,invocationId:randomUUID(),attemptId:randomUUID(),role:'semantic_intent',attempt:1,requestMaxOutputTokens:4096,startedAtUtc:new Date().toISOString(),dispatch:'pending'};
  await observer(start);const {type:_type,dispatch:_dispatch,...identity}=start;
  await observer({...identity,type:'attempt_end',endedAtUtc:new Date().toISOString(),durationMs:1,requestStarted:true,status:'failed',errorCode:'MODEL_HTTP_503',failureStage:'request',httpStatus:503});
  return start.attemptId;
}
const trace=(attemptId:string):ModelStructuredOutputObservation=>({version:MODEL_STRUCTURED_OUTPUT_OBSERVATION_VERSION,role:'semantic_intent',toolName:'interpret_banking_intent',attempt:1,attemptId,status:'failed',errorCode:'MODEL_HTTP_503',outputText:'{"synthetic":true}',outputLength:18,outputDigest:hash('{"synthetic":true}')});
function noNetwork(){vi.stubGlobal('fetch',vi.fn(()=>{throw new Error('NETWORK_FORBIDDEN_IN_G9E_CALIBRATION');}));vi.spyOn(console,'log').mockImplementation(()=>{});}
async function oneCaseTrace(emit:(callback:((event:Readonly<ModelStructuredOutputObservation>)=>void)|undefined,id:string)=>void){
  const {manifest}=await calibration(),fixture=g9Dataset.cases[0]!,dataset={...g9Dataset,cases:[fixture]},short=structuredClone(manifest) as G9EManifest;
  short.cohorts.knownRegression.caseIds=[fixture.id];short.cohorts.knownRegression.caseCount=1 as 36;
  short.cohorts.knownRegression.templateInputsSha256=digest([fixture.input]);
  short.cohorts.knownRegression.originalExpectedLabelsSha256=digest([fixture.expected]);
  short.cohorts.knownRegression.currentExpectedLabelsSha256=digest([g9eExpected(fixture)]);
  return executeG9EStage({dataset,manifest:short,manifestHash:hash(`one-${randomUUID()}`),cohort:'known-regression',config,resultsDir:await temp(),verifyFrozenFiles:async()=>true,semanticJsonl:true,
    plan:async(_input,observer,_signal,structuredObserver)=>{const id=await failedSemanticAttempt(observer);emit(structuredObserver,id);throw new ModelProviderError('MODEL_HTTP_503',true);}});
}

describe('G9E default-only manifest and two independent score contracts',()=>{
  it('binds 36+12 original and current labels, omitted provider, scorer and protocol',async()=>{
    const {inputs,evaluatorHashes,manifest}=await calibration();
    expect(validateG9EManifestMetadata(manifest,inputs,evaluatorHashes,'2026-10-24T09:00:00.000Z')).toMatchObject({knownCount:36,qualityCount:12});
    expect(manifest.provider.reasoningEffort).toBe('omitted');
    expect(manifest.cohorts.knownRegression.caseIds).toEqual(g9Dataset.cases.map(item=>item.id));
    expect(manifest.cohorts.developmentSupplemental.caseIds).toEqual(g9cQualityDataset.cases.map(item=>item.id));
    expect(manifest.cohorts.knownRegression.currentExpectedLabelsSha256).not.toBe(manifest.cohorts.knownRegression.originalExpectedLabelsSha256);
    expect(G9E_EVALUATOR_FILES).toEqual(expect.arrayContaining(['evals/g9e-score.ts','tests/g9e-score.test.ts','tests/g9e-runner.test.ts',G9E_PROTOCOL_PATH]));
  });
  it.each(['known-order','current-labels','original-labels','budget','provider-none','evaluator','source-hash'])('rejects %s drift before dispatch',async issue=>{
    const data=await calibration(),m=data.manifest;
    if(issue==='known-order')m.cohorts.knownRegression.caseIds.reverse();
    if(issue==='current-labels')m.cohorts.developmentSupplemental.currentExpectedLabelsSha256=hash('altered');
    if(issue==='original-labels')m.cohorts.knownRegression.originalExpectedLabelsSha256=hash('altered');
    if(issue==='budget')m.limits={...m.limits,maxAttempts:3} as unknown as typeof m.limits;
    if(issue==='provider-none')m.provider={...m.provider,reasoningEffort:'none'};
    if(issue==='evaluator')m.evaluatorHashes[G9E_PROTOCOL_PATH]=hash('altered');
    if(issue==='source-hash')m.sourceManifestSha256='invalid';
    expect(()=>validateG9EManifestMetadata(m,data.inputs,data.evaluatorHashes,'2026-10-24T09:00:00.000Z')).toThrow('G9E_FROZEN_MANIFEST_MISMATCH');
  });
  it('rejects condition, scope and preflight execution switches before accessing provider',async()=>{
    await expect(runG9E([])).rejects.toThrow('G9E_EXPLICIT_STAGE_REQUIRED');
    await expect(runG9E(['--mode','live','--condition','none','--cohort','known-regression'])).rejects.toThrow('G9E_UNSUPPORTED_OR_DUPLICATE_OPTION');
    await expect(runG9E(['--mode','live','--cohort','known-regression','--limit','1'])).rejects.toThrow('G9E_UNSUPPORTED_OR_DUPLICATE_OPTION');
    await expect(runG9E(['--preflight','--mode','live'])).rejects.toThrow('G9E_PREFLIGHT_HAS_NO_EXECUTION_MODE');
  });
  it('attaches a separately versioned current score while leaving original G9 score unchanged',()=>{
    const fixture=g9Dataset.cases.find(item=>item.id==='g9-goal-03')!,expected=g9eExpected(fixture);
    const result={taskId:fixture.input.taskId,planVersion:1,mode:'model',summary:'尚未执行，仍需独立授权。',findings:[],evidence:[],suggestions:[],managementSuggestions:[],investmentSuggestions:[],goalSuggestion:{title:'合成目标',...expected.goal},
      events:expected.activatedRoles.map(role=>({role,status:'started',at:'2026-10-24T09:00:00.000Z',summary:'started'})),
      modelRuns:expected.successfulCallRoles.map(role=>({role,model:'synthetic',status:'success',durationMs:1})),diagnostics:{domains:[],intent:{status:expected.semantic.status,roles:expected.semantic.recognizedRoles,findings:[]}}} as PlanResult;
    const originalScore=scoreG9(fixture,result),original={startedAt:'2026-10-24T09:00:00.000Z',result,score:originalScore,evaluationValid:true,passed:originalScore.passed,labelsUnchanged:true} as G9CaseRecord;
    const record=attachG9ECurrentScore(fixture,original,digest(expected));
    expect(record.score).toBe(originalScore);expect(record.passed).toBe(false);expect(record.currentContractScore?.passed).toBe(true);
    expect(record.currentContractPassed).toBe(true);expect(record.currentLabelsUnchanged).toBe(true);
  });
});

describe('G9E offline durable stage orchestration and trace integrity',()=>{
  it('runs default 36 then 12 only once and reports both separate denominators without fetch',async()=>{
    noNetwork();const {manifest}=await calibration(),resultsDir=await temp(),manifestHash=hash('manifest'),verifyFrozenFiles=vi.fn(async()=>true);
    const plan=async(_input:unknown,observer:ModelAttemptObserver,_signal:AbortSignal,structuredObserver?:((event:Readonly<ModelStructuredOutputObservation>)=>void))=>{
      const id=await failedSemanticAttempt(observer);structuredObserver?.(trace(id));throw new ModelProviderError('MODEL_HTTP_503',true);
    };
    const known=await executeG9EStage({dataset:g9Dataset,manifest,manifestHash,cohort:'known-regression',config,resultsDir,verifyFrozenFiles,semanticJsonl:true,plan});
    expect(known.stage).toBe('default-known');expect(known.validRun).toBe(true);expect(known.semanticTraceStatus).toBe('complete');
    expect(known.scoreSummary.plannedCases).toBe(36);expect(known.currentScoreSummary.plannedCases).toBe(36);
    expect(known.scoreSummary.businessUnavailableCases).toBe(36);expect(known.currentScoreSummary.businessUnavailableCases).toBe(36);
    expect(known.records.every(record=>record.score===undefined&&record.currentContractScore===undefined)).toBe(true);
    const quality=await executeG9EStage({dataset:g9cQualityDataset,manifest,manifestHash,cohort:'development-supplemental',config,resultsDir,verifyFrozenFiles,semanticJsonl:true,priorReportPaths:{'default-known':known.jsonPath},plan});
    expect(quality.stage).toBe('default-quality');expect(quality.validRun).toBe(true);
    expect(quality.scoreSummary.plannedCases).toBe(12);expect(quality.currentScoreSummary.plannedCases).toBe(12);
    expect(quality.priorReportSha256['default-known']).toBe(hash(await readFile(known.jsonPath)));
    expect((await readFile(quality.jsonlPath,'utf8')).trim().split('\n')).toHaveLength(14);
    expect((await readFile(known.semanticPath!,'utf8')).trim().split('\n')).toHaveLength(36);
    await expect(executeG9EStage({dataset:g9Dataset,manifest,manifestHash,cohort:'known-regression',config,resultsDir,verifyFrozenFiles,semanticJsonl:true,plan})).rejects.toThrow('EEXIST');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('requires the complete prior stage and exact default provider before a result claim',async()=>{
    noNetwork();const {manifest}=await calibration(),resultsDir=await temp(),plan=vi.fn();
    await expect(executeG9EStage({dataset:g9cQualityDataset,manifest,manifestHash:hash('manifest'),cohort:'development-supplemental',config,resultsDir,verifyFrozenFiles:async()=>true,plan})).rejects.toThrow('G9E_PRIOR_STAGE_REQUIRED');
    await expect(executeG9EStage({dataset:g9Dataset,manifest,manifestHash:hash('manifest'),cohort:'known-regression',config:{...config,reasoningEffort:'none'},resultsDir,verifyFrozenFiles:async()=>true,plan})).rejects.toThrow('G9E_EXECUTION_CONTRACT_MISMATCH');
    expect(()=>validateG9EPriorReport({},{stage:'default-known',manifest,manifestHash:hash('manifest')})).toThrow('G9E_PRIOR_STAGE_INVALID');
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
    expect(report.records[0]).toMatchObject({evaluationValid:false,errorCode:'G9E_SEMANTIC_TRACE_INCOMPLETE'});
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
