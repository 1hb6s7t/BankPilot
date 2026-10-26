import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ModelProviderError, MODEL_ATTEMPT_PROTOCOL_VERSION, MODEL_STRUCTURED_OUTPUT_OBSERVATION_VERSION, type ModelAttemptObserver, type ModelAttemptStart, type ModelStructuredOutputObservation } from '../packages/agents/src/provider';
import { g9Dataset } from '../evals/g9-holdout-fixtures';
import { g9cQualityDataset } from '../evals/g9c-quality-fixtures';
import type { G9Manifest } from '../evals/g9-contract';
import type { G9CQualityManifest } from '../scripts/evaluate-g9c-quality';
import { g9cProviderFingerprint } from '../scripts/evaluate-g9c';
import { buildG9DManifest, executeG9DStage, G9D_EVALUATOR_FILES, G9D_PROTOCOL_PATH, runG9D, validateG9DManifestMetadata, validateG9DPriorReport, verifyG9DFrozenFiles, type G9DManifest, type G9DStage } from '../scripts/evaluate-g9d';
import { runG9DQuality } from '../scripts/evaluate-g9d-quality';
import { digest } from '../evals/ablation-score';

const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const defaultConfig = { model:'offline-g9d-calibration',baseURL:'https://calibration.invalid/v1',outputMode:'json_object' as const };
const noneConfig = { ...defaultConfig,reasoningEffort:'none' as const };
const tempDirs: string[] = [];
async function temp() { const path=await mkdtemp(join(tmpdir(),'g9d-runner-'));tempDirs.push(path);return path; }
afterEach(async()=>{vi.restoreAllMocks();vi.unstubAllGlobals();await Promise.all(tempDirs.splice(0).map(path=>rm(path,{recursive:true,force:true})));});
async function calibration() {
  const originalBytes=await readFile('evals/g9-manifest.json'),qualityBytes=await readFile('evals/g9c-quality-manifest.json');
  const original=JSON.parse(originalBytes.toString()) as G9Manifest,qualityParent=JSON.parse(qualityBytes.toString()) as G9CQualityManifest;
  const inputs={original,qualityParent,knownDataset:g9Dataset,qualityDataset:g9cQualityDataset,
    originalManifestSha256:hash(originalBytes),qualityParentManifestSha256:hash(qualityBytes)};
  const evaluatorHashes=Object.fromEntries(G9D_EVALUATOR_FILES.map(path=>[path,hash(path)]));
  const manifest=buildG9DManifest({ ...inputs,frozenAt:'2026-10-24T08:00:00.000Z',sourceManifestPath:'evals/baselines/g9d-calibration/source-manifest.json',
    sourceManifestSha256:hash('source'),evaluatorHashes,defaultProvider:g9cProviderFingerprint(defaultConfig),noneProvider:g9cProviderFingerprint(noneConfig) });
  return {inputs,evaluatorHashes,manifest};
}
async function failedSemanticAttempt(observer: ModelAttemptObserver) {
  const start:ModelAttemptStart={type:'attempt_start',protocolVersion:MODEL_ATTEMPT_PROTOCOL_VERSION,invocationId:randomUUID(),attemptId:randomUUID(),role:'semantic_intent',attempt:1,requestMaxOutputTokens:4096,startedAtUtc:new Date().toISOString(),dispatch:'pending'};
  await observer(start);const {type:_type,dispatch:_dispatch,...identity}=start;
  await observer({...identity,type:'attempt_end',endedAtUtc:new Date().toISOString(),durationMs:1,requestStarted:true,status:'failed',errorCode:'MODEL_HTTP_503',failureStage:'request',httpStatus:503});
  return start.attemptId;
}
function noNetwork() { vi.stubGlobal('fetch',vi.fn(()=>{throw new Error('NETWORK_FORBIDDEN_IN_G9D_CALIBRATION');}));vi.spyOn(console,'log').mockImplementation(()=>{}); }
async function oneCaseTrace(emitStructured:(callback:((event:Readonly<ModelStructuredOutputObservation>)=>void)|undefined,attemptId:string)=>void) {
  const {manifest}=await calibration(),one=g9Dataset.cases[0]!,dataset={...g9Dataset,cases:[one]},shortManifest=structuredClone(manifest) as G9DManifest;
  shortManifest.cohorts.knownRegression.caseIds=[one.id];shortManifest.cohorts.knownRegression.caseCount=1 as 36;
  shortManifest.cohorts.knownRegression.templateInputsSha256=digest([one.input]);shortManifest.cohorts.knownRegression.expectedLabelsSha256=digest([one.expected]);
  return executeG9DStage({dataset,manifest:shortManifest,manifestHash:hash(`one-${randomUUID()}`),condition:'default',cohort:'known-regression',config:defaultConfig,
    resultsDir:await temp(),verifyFrozenFiles:async()=>true,semanticJsonl:true,
    plan:async(_input,observer,_signal,structuredObserver)=>{const attemptId=await failedSemanticAttempt(observer);emitStructured(structuredObserver,attemptId);throw new ModelProviderError('MODEL_HTTP_503',true);} });
}
function validTrace(attemptId:string):ModelStructuredOutputObservation {return {version:MODEL_STRUCTURED_OUTPUT_OBSERVATION_VERSION,role:'semantic_intent',toolName:'interpret_banking_intent',attempt:1,attemptId,status:'failed',errorCode:'MODEL_HTTP_503',outputText:'{"synthetic":true}',outputLength:18,outputDigest:hash('{"synthetic":true}')};}

describe('G9D paired freeze and explicit entry',()=>{
  it('binds the same endpoint and wire options except reasoning effort, with both cohorts and current observer in the hash closure',async()=>{
    const {inputs,evaluatorHashes,manifest}=await calibration();
    expect(validateG9DManifestMetadata(manifest,inputs,evaluatorHashes,'2026-10-24T09:00:00.000Z')).toMatchObject({knownCount:36,qualityCount:12});
    expect(manifest.providers.default.reasoningEffort).toBe('omitted');expect(manifest.providers.none.reasoningEffort).toBe('none');
    expect(manifest.cohorts.knownRegression.caseIds).toEqual(g9Dataset.cases.map(item=>item.id));
    expect(manifest.cohorts.developmentSupplemental.caseIds).toEqual(g9cQualityDataset.cases.map(item=>item.id));
    expect(G9D_EVALUATOR_FILES).toContain('tests/g9d-provider-observation.test.ts');
    expect(G9D_EVALUATOR_FILES).toContain(G9D_PROTOCOL_PATH);
  });
  it.each(['known-order','quality-labels','budget','default-effort','none-endpoint','evaluator','source-hash'])('rejects %s drift before dispatch',async issue=>{
    const data=await calibration(),m=data.manifest;
    if(issue==='known-order')m.cohorts.knownRegression.caseIds.reverse();
    if(issue==='quality-labels')m.cohorts.developmentSupplemental.expectedLabelsSha256=hash('altered');
    if(issue==='budget')m.limits={...m.limits,maxAttempts:3} as unknown as typeof m.limits;
    if(issue==='default-effort')m.providers.default={...m.providers.default,reasoningEffort:'none'};
    if(issue==='none-endpoint')m.providers.none={...m.providers.none,baseURLSha256:hash('different')};
    if(issue==='evaluator')m.evaluatorHashes[G9D_PROTOCOL_PATH]=hash('different');
    if(issue==='source-hash')m.sourceManifestSha256='invalid';
    expect(()=>validateG9DManifestMetadata(m,data.inputs,data.evaluatorHashes,'2026-10-24T09:00:00.000Z')).toThrow('G9D_FROZEN_MANIFEST_MISMATCH');
  });
  it('requires an explicit stage and rejects scope-changing options before manifest/provider access',async()=>{
    await expect(runG9D([])).rejects.toThrow('G9D_EXPLICIT_STAGE_REQUIRED');
    await expect(runG9D(['--mode','live','--condition','default','--cohort','known-regression','--limit','1'])).rejects.toThrow('G9D_UNSUPPORTED_OR_DUPLICATE_OPTION');
    await expect(runG9D(['--preflight','--mode','live'])).rejects.toThrow('G9D_PREFLIGHT_HAS_NO_EXECUTION_MODE');
    await expect(runG9DQuality(['--cohort','known-regression'])).rejects.toThrow('G9D_QUALITY_COHORT_IS_FIXED');
  });
  it('verifies the full frozen product inventory and historical manifest lineage without replaying old product hashes',async()=>{
    const root=await temp(),data=await calibration(),manifest=structuredClone(data.manifest),put=async(path:string,content:string|Uint8Array)=>{
      const full=join(root,path);await mkdir(dirname(full),{recursive:true});await writeFile(full,content);return hash(content);
    };
    const hashes:Record<string,string>={};
    for(const path of G9D_EVALUATOR_FILES){
      const content=[G9D_PROTOCOL_PATH,'evals/g9c-quality-fixtures.ts','docs/g9c-quality-cases.md'].includes(path)
        ? path===G9D_PROTOCOL_PATH?'G9D offline protocol calibration':await readFile(path)
        : `frozen ${path}`;
      hashes[path]=await put(path,content);
    }
    await put('evals/g9-holdout-fixtures.ts',await readFile('evals/g9-holdout-fixtures.ts'));
    await put('evals/g9-manifest.json',await readFile('evals/g9-manifest.json'));
    await put('evals/g9c-manifest.json',await readFile('evals/g9c-manifest.json'));
    await put('evals/g9c-quality-manifest.json',await readFile('evals/g9c-quality-manifest.json'));
    const appPath='apps/web/src/calibration.ts',appHash=await put(appPath,'export const synthetic=true;');
    const sourceFiles=[...G9D_EVALUATOR_FILES.filter(path=>path.startsWith('packages/')).map(path=>({path,sha256:hashes[path]!})),{path:appPath,sha256:appHash}];
    const sourceBytes=JSON.stringify({files:sourceFiles});manifest.sourceManifestSha256=await put(manifest.sourceManifestPath,sourceBytes);
    manifest.evaluatorHashes=hashes;manifest.protocolSha256=hashes[G9D_PROTOCOL_PATH]!;
    const manifestPath='evals/g9d-manifest.json',manifestBytes=JSON.stringify(manifest),manifestHash=await put(manifestPath,manifestBytes);
    await expect(verifyG9DFrozenFiles(manifest,manifestHash,manifestPath,root)).resolves.toBeUndefined();
    await put('apps/web/src/new.ts','export const unexpected=true;');
    await expect(verifyG9DFrozenFiles(manifest,manifestHash,manifestPath,root)).rejects.toThrow('G9D_PRODUCT_INVENTORY_DRIFT');
    await rm(join(root,'apps/web/src/new.ts'));
    await put('apps/web/src/calibration.ts','export const synthetic=false;');
    await expect(verifyG9DFrozenFiles(manifest,manifestHash,manifestPath,root)).rejects.toThrow('G9D_FROZEN_SOURCE_DRIFT');
    await put('apps/web/src/calibration.ts','export const synthetic=true;');
    await put('evals/g9c-manifest.json','{}');
    await expect(verifyG9DFrozenFiles(manifest,manifestHash,manifestPath,root)).rejects.toThrow('G9D_HISTORICAL_LINEAGE_DRIFT');
  });
});

describe('G9D offline durable stage orchestration',()=>{
  it('runs default 36+12 then none 36+12 once, preserving business failures as assessed evidence and never calling fetch',async()=>{
    noNetwork();const {manifest}=await calibration(),resultsDir=await temp(),manifestHash=hash('manifest'),verifyFrozenFiles=vi.fn(async()=>true),priorReportPaths:Partial<Record<G9DStage,string>>={};
    const plan=async (_input:unknown,observer:ModelAttemptObserver)=>{await failedSemanticAttempt(observer);throw new ModelProviderError('MODEL_HTTP_503',true);};
    const stages=[
      {condition:'default' as const,cohort:'known-regression' as const,dataset:g9Dataset,stage:'default-known' as const},
      {condition:'default' as const,cohort:'development-supplemental' as const,dataset:g9cQualityDataset,stage:'default-quality' as const},
      {condition:'none' as const,cohort:'known-regression' as const,dataset:g9Dataset,stage:'none-known' as const},
      {condition:'none' as const,cohort:'development-supplemental' as const,dataset:g9cQualityDataset,stage:'none-quality' as const},
    ];
    for(const item of stages){
      const report=await executeG9DStage({dataset:item.dataset,manifest,manifestHash,condition:item.condition,cohort:item.cohort,
        config:item.condition==='default'?defaultConfig:noneConfig,resultsDir,priorReportPaths,verifyFrozenFiles,plan});
      expect(report.stage).toBe(item.stage);expect(report.validRun).toBe(true);expect(report.executionComplete).toBe(true);expect(report.scoreSummary.passedCases).toBe(0);
      expect(report.scoreSummary.businessUnavailableCases).toBe(item.dataset.cases.length);expect(report.records.map(record=>record.id)).toEqual(item.dataset.cases.map(value=>value.id));
      expect(report.observedAttempts.complete).toBe(true);expect(report.attemptObservation.confirmedStarts).toBe(item.dataset.cases.length);
      expect((await readFile(report.jsonlPath,'utf8')).trim().split('\n')).toHaveLength(item.dataset.cases.length+2);
      expect(report.semanticTraceStatus).toBe('disabled');expect(report.semanticPath).toBeNull();
      priorReportPaths[item.stage]=report.jsonPath;
    }
    expect(verifyFrozenFiles).toHaveBeenCalledTimes(2*(36+12+36+12)+4*2);
    expect(fetch).not.toHaveBeenCalled();
    await expect(executeG9DStage({dataset:g9Dataset,manifest,manifestHash,condition:'default',cohort:'known-regression',config:defaultConfig,resultsDir,verifyFrozenFiles,plan})).rejects.toThrow('EEXIST');
  });
  it('requires valid completed prior stages and rejects a provider mismatch before creating results',async()=>{
    noNetwork();const {manifest}=await calibration(),resultsDir=await temp(),plan=vi.fn();
    await expect(executeG9DStage({dataset:g9Dataset,manifest,manifestHash:hash('manifest'),condition:'none',cohort:'known-regression',config:noneConfig,resultsDir,verifyFrozenFiles:async()=>true,plan})).rejects.toThrow('G9D_PRIOR_STAGE_REQUIRED');
    await expect(executeG9DStage({dataset:g9Dataset,manifest,manifestHash:hash('manifest'),condition:'default',cohort:'known-regression',config:noneConfig,resultsDir,verifyFrozenFiles:async()=>true,plan})).rejects.toThrow('G9D_EXECUTION_CONTRACT_MISMATCH');
    expect(plan).not.toHaveBeenCalled();expect(fetch).not.toHaveBeenCalled();
    expect(()=>validateG9DPriorReport({},{stage:'default-known',manifest,manifestHash:hash('manifest')})).toThrow('G9D_PRIOR_STAGE_INVALID');
  });
  it('writes only bounded semantic extraction from synthetic fixtures and invalidates a sink limit failure without retry',async()=>{
    noNetwork();const {manifest}=await calibration(),resultsDir=await temp();
    const one=g9Dataset.cases[0]!,dataset={...g9Dataset,cases:[one]},shortManifest=structuredClone(manifest) as G9DManifest;
    shortManifest.cohorts.knownRegression.caseIds=[one.id];shortManifest.cohorts.knownRegression.caseCount=36;
    shortManifest.cohorts.knownRegression.templateInputsSha256=hash('placeholder');
    const {digest}=await import('../evals/ablation-score');shortManifest.cohorts.knownRegression.templateInputsSha256=digest([one.input]);shortManifest.cohorts.knownRegression.expectedLabelsSha256=digest([one.expected]);
    const report=await executeG9DStage({dataset,manifest:shortManifest,manifestHash:hash('short-manifest'),condition:'default',cohort:'known-regression',config:defaultConfig,resultsDir,verifyFrozenFiles:async()=>true,semanticJsonl:true,
      plan:async(_input,observer,_signal,structuredObserver)=>{
        const attemptId=await failedSemanticAttempt(observer);
        structuredObserver?.({version:MODEL_STRUCTURED_OUTPUT_OBSERVATION_VERSION,role:'reviewer',toolName:'review',attempt:1,status:'success',outputText:'discard'});
        structuredObserver?.({version:MODEL_STRUCTURED_OUTPUT_OBSERVATION_VERSION,role:'semantic_intent',toolName:'interpret_banking_intent',attempt:1,attemptId,status:'failed',errorCode:'MODEL_HTTP_503',outputText:'{"synthetic":true}',outputLength:18,outputDigest:hash('{"synthetic":true}')});
        structuredObserver?.({version:MODEL_STRUCTURED_OUTPUT_OBSERVATION_VERSION,role:'semantic_intent',toolName:'interpret_banking_intent',attempt:1,attemptId,status:'failed',errorCode:'MODEL_HTTP_503',outputText:'x'.repeat(65537)});
        throw new ModelProviderError('MODEL_HTTP_503',true);
      }});
    expect(report.validRun).toBe(false);expect(report.semanticTraceFailed).toBe(true);expect(report.records).toHaveLength(1);
    expect(report.records[0]).toMatchObject({evaluationValid:false,passed:false,errorCode:'G9D_SEMANTIC_TRACE_INCOMPLETE'});
    const rows=(await readFile(report.semanticPath!,'utf8')).trim().split('\n').map(line=>JSON.parse(line));
    expect(rows).toHaveLength(1);expect(rows[0]).toMatchObject({caseId:one.id,role:'semantic_intent',outputText:'{"synthetic":true}'});
    expect(JSON.stringify(report)).not.toContain('"synthetic":true');expect(fetch).not.toHaveBeenCalled();
  });
  it.each(['missing','duplicate','wrong-id','wrong-digest','bad-omission'])('invalidates %s semantic trace even when attempt journal is complete',async scenario=>{
    noNetwork();const report=await oneCaseTrace((callback,attemptId)=>{
      const base=validTrace(attemptId);
      if(scenario==='missing')return;
      if(scenario==='duplicate'){callback?.(base);callback?.(base);return;}
      if(scenario==='wrong-id'){callback?.({...base,attemptId:randomUUID()});return;}
      if(scenario==='wrong-digest'){callback?.({...base,outputDigest:hash('wrong')});return;}
      callback?.({...base,outputText:undefined,outputOmitted:'not_text'});
    });
    expect(report.attemptObservation.confirmedStarts).toBe(1);expect(report.attemptObservation.confirmedEnds).toBe(1);
    expect(report.validRun).toBe(false);expect(report.semanticTraceStatus).toBe('incomplete');expect(report.records[0]).toMatchObject({evaluationValid:false,errorCode:'G9D_SEMANTIC_TRACE_INCOMPLETE'});
    expect(fetch).not.toHaveBeenCalled();
  });
  it('accepts a fully omitted oversized synthetic output record with matching attempt metadata, without storing text',async()=>{
    noNetwork();const report=await oneCaseTrace((callback,attemptId)=>callback?.({...validTrace(attemptId),outputText:undefined,outputOmitted:'size_limit',outputLength:50000,outputDigest:hash('opaque-synthetic-output')}));
    expect(report.validRun).toBe(true);expect(report.semanticTraceStatus).toBe('complete');expect(report.scoreSummary.businessUnavailableCases).toBe(1);
    const rows=(await readFile(report.semanticPath!,'utf8')).trim().split('\n').map(line=>JSON.parse(line));
    expect(rows).toHaveLength(1);expect(rows[0]).toMatchObject({outputOmitted:'size_limit',outputLength:50000});expect(rows[0]).not.toHaveProperty('outputText');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('keeps a complete short semantic string only in the sealed JSONL and marks the trace complete',async()=>{
    noNetwork();const report=await oneCaseTrace((callback,attemptId)=>callback?.(validTrace(attemptId)));
    expect(report.validRun).toBe(true);expect(report.semanticTraceStatus).toBe('complete');
    const rows=(await readFile(report.semanticPath!,'utf8')).trim().split('\n').map(line=>JSON.parse(line));
    expect(rows).toHaveLength(1);expect(rows[0]).toMatchObject({role:'semantic_intent',toolName:'interpret_banking_intent',outputText:'{"synthetic":true}'});
    expect(JSON.stringify(report)).not.toContain('"synthetic":true');expect(fetch).not.toHaveBeenCalled();
  });
});
