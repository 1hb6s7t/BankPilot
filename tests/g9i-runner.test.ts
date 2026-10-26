import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { digest } from '../evals/ablation-score';
import { g9Dataset } from '../evals/g9-holdout-fixtures';
import { g9cQualityDataset } from '../evals/g9c-quality-fixtures';
import { g9gExpected } from '../evals/g9g-score';
import { ModelProviderError, MODEL_ATTEMPT_PROTOCOL_VERSION, MODEL_REQUEST_OBSERVATION_VERSION,
  MODEL_STRUCTURED_OUTPUT_OBSERVATION_VERSION, type ModelAttemptStart } from '../packages/agents/src/provider';
import { g9cProviderFingerprint } from '../scripts/evaluate-g9c';
import { buildG9IManifest, executeG9IStage, G9I_EVALUATOR_FILES, G9I_PROFILE, validateG9IManifestMetadata,
  validateG9IPriorReport, runG9I } from '../scripts/evaluate-g9i';
import { G9H_RUNNER_VERSION } from '../scripts/evaluate-g9h';
import { verifyG9IRequestPriorEvidence } from '../scripts/g9i-request-validation';

const hash=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
const config={model:'offline-g9i',baseURL:'https://offline.invalid/v1',outputMode:'json_object' as const};
const dirs:string[]=[];
afterEach(async()=>{vi.restoreAllMocks();vi.unstubAllGlobals();await Promise.all(dirs.splice(0).map(path=>rm(path,{recursive:true,force:true})));});
async function calibration(){
  const originalBytes=await readFile('evals/g9-manifest.json'),qualityBytes=await readFile('evals/g9c-quality-manifest.json');
  const inputs={original:JSON.parse(originalBytes.toString()),qualityParent:JSON.parse(qualityBytes.toString()),knownDataset:g9Dataset,qualityDataset:g9cQualityDataset,
    originalManifestSha256:hash(originalBytes),qualityParentManifestSha256:hash(qualityBytes)};
  const evaluatorHashes=Object.fromEntries(G9I_EVALUATOR_FILES.map(path=>[path,hash(path)]));
  const manifest=buildG9IManifest({...inputs,frozenAt:'2026-10-25T00:00:00.000Z',sourceManifestPath:'evals/baselines/g9i-calibration/source-manifest.json',
    sourceManifestSha256:hash('source'),evaluatorHashes,provider:g9cProviderFingerprint(config)});
  return {inputs,evaluatorHashes,manifest};
}
async function oneCase(mode:'sent'|'prepared'|'missing-schema'='sent'){
  vi.stubGlobal('fetch',vi.fn(()=>{throw new Error('NETWORK_FORBIDDEN');}));vi.spyOn(console,'log').mockImplementation(()=>{});
  const {manifest}=await calibration(),fixture=g9Dataset.cases.find(item=>item.id==='g9-card-06')!;
  const short=structuredClone(manifest),dataset={...g9Dataset,cases:[fixture]};
  short.cohorts.knownRegression.caseIds=[fixture.id];short.cohorts.knownRegression.caseCount=1 as 36;
  short.cohorts.knownRegression.templateInputsSha256=digest([fixture.input]);
  short.cohorts.knownRegression.originalExpectedLabelsSha256=digest([fixture.expected]);
  short.cohorts.knownRegression.currentExpectedLabelsSha256=digest([g9gExpected(fixture)]);
  const dir=await mkdtemp(join(tmpdir(),'g9i-runner-'));dirs.push(dir);
  const report=await executeG9IStage({dataset,manifest:short,manifestHash:hash(randomUUID()),cohort:'known-regression',config,resultsDir:dir,
    verifyFrozenFiles:async()=>true,semanticJsonl:true,billJsonl:true,
    plan:async(_input,observer,_signal,structuredObserver,requestObserver)=>{
      const now=new Date().toISOString();
      const start:ModelAttemptStart={type:'attempt_start',protocolVersion:MODEL_ATTEMPT_PROTOCOL_VERSION,invocationId:randomUUID(),attemptId:randomUUID(),
        role:'semantic_intent',attempt:1,requestMaxOutputTokens:4096,startedAtUtc:now,dispatch:'pending'};
      await observer(start);
      const component=(value:string)=>({sha256:hash(value),bytes:Buffer.byteLength(value)});
      await requestObserver?.({version:MODEL_REQUEST_OBSERVATION_VERSION,invocationId:start.invocationId,attemptId:start.attemptId,role:start.role,
        attempt:1,requestMaxOutputTokens:4096,outputMode:'json_object',body:component('body'),system:component('system'),user:component('user'),
        schema:component('schema'),schemaLocation:'system',schemaIncluded:mode!=='missing-schema',repairFeedbackIncluded:false});
      const {type:_type,dispatch:_dispatch,...identity}=start;
      const errorCode=mode==='prepared'?'MODEL_TIMEOUT':'MODEL_HTTP_503';
      await observer({...identity,type:'attempt_end',endedAtUtc:new Date().toISOString(),durationMs:1,requestStarted:mode!=='prepared',status:'failed',
        errorCode,failureStage:'request',...(mode==='prepared'?{}:{httpStatus:503})});
      structuredObserver?.({version:MODEL_STRUCTURED_OUTPUT_OBSERVATION_VERSION,role:'semantic_intent',toolName:'interpret_banking_intent',
        attempt:1,attemptId:start.attemptId,status:'failed',errorCode,outputOmitted:'not_text'});
      throw new ModelProviderError(errorCode,true);
    }});
  return report;
}

describe('G9I trusted default runner profile',()=>{
  it('binds a new manifest, source prefix, provider default, and unchanged two cohorts',async()=>{
    const {inputs,evaluatorHashes,manifest}=await calibration();
    expect(validateG9IManifestMetadata(manifest,inputs,evaluatorHashes,'2026-10-25T01:00:00.000Z')).toMatchObject({knownCount:36,qualityCount:12});
    expect(manifest).toMatchObject({protocolVersion:G9I_PROFILE.runnerVersion,protocolPath:G9I_PROFILE.protocolPath,
      sourceManifestPath:'evals/baselines/g9i-calibration/source-manifest.json',provider:{reasoningEffort:'omitted'}});
    expect(G9I_EVALUATOR_FILES).toContain('scripts/g9i-request-validation.ts');
    const bad=structuredClone(manifest);bad.sourceManifestPath=bad.sourceManifestPath.replace('g9i-','g9h-');
    expect(()=>validateG9IManifestMetadata(bad,inputs,evaluatorHashes,'2026-10-25T01:00:00.000Z')).toThrow('G9I_FROZEN_MANIFEST_MISMATCH');
  });
  it('rejects alternate conditions and a G9H prior report without dispatch',async()=>{
    await expect(runG9I(['--mode','live','--cohort','known-regression'])).rejects.toThrow('G9I_STRUCTURED_TRACES_REQUIRED');
    await expect(runG9I(['--mode','live','--cohort','known-regression','--bill-jsonl','--semantic-jsonl','--profile','g9h'])).rejects.toThrow('G9I_UNSUPPORTED_OR_DUPLICATE_OPTION');
    const {manifest}=await calibration();
    expect(()=>validateG9IPriorReport({protocolVersion:G9H_RUNNER_VERSION},{stage:'default-known',manifest,manifestHash:hash('manifest')})).toThrow('G9I_PRIOR_STAGE_INVALID');
  });
  it('persists only request component hashes and validates adjacent prior evidence',async()=>{
    const report=await oneCase();
    expect(report.validRun).toBe(true);expect(report.requestTraceStatus).toBe('complete');
    expect(report.scoreSummary.plannedCases).toBe(1);expect(report.previousScoreSummary.plannedCases).toBe(1);expect(report.currentScoreSummary.plannedCases).toBe(1);
    const text=await readFile(report.requestPath!,'utf8'),rows=text.trim().split('\n').map((line:string)=>JSON.parse(line));
    expect(rows).toHaveLength(1);expect(rows[0]).toMatchObject({role:'semantic_intent',schemaIncluded:true,body:{sha256:hash('body')}});
    expect(rows[0]).not.toHaveProperty('headers');expect(rows[0]).not.toHaveProperty('apiKey');
    expect(report.requestMetadataSha256).toBe(hash(text));
    await expect(verifyG9IRequestPriorEvidence(report,report.jsonPath)).resolves.toBeUndefined();
    rows[0].body.sha256=hash('forged');await writeFile(report.requestPath!,JSON.stringify(rows[0])+'\n');
    await expect(verifyG9IRequestPriorEvidence(report,report.jsonPath)).rejects.toThrow('G9I_PRIOR_REQUEST_EVIDENCE_INVALID');
    // Recompute the local file digest so these probes reach the binding and
    // allowlist checks rather than merely rediscovering a stale file hash.
    const originalRow=JSON.parse(text.trim());
    for(const mutation of [{attemptId:randomUUID()},{role:'card'},{caseSequence:2},{requestMaxOutputTokens:1},
      {outputMode:'tools',schemaLocation:'tool'},{rawText:'PRIVATE_REQUEST_MUST_NOT_BE_PERSISTED'},
      {repairFeedbackIncluded:true}]){
      const changed=JSON.stringify({...originalRow,...mutation})+'\n';
      await writeFile(report.requestPath!,changed);
      await expect(verifyG9IRequestPriorEvidence({...report,requestMetadataSha256:hash(changed)},report.jsonPath)).rejects.toThrow('G9I_PRIOR_REQUEST_EVIDENCE_INVALID');
    }
    expect(fetch).not.toHaveBeenCalled();
  });
  it('distinguishes a persisted prepared request from an HTTP dispatch',async()=>{
    const report=await oneCase('prepared');
    expect(report.validRun).toBe(true);
    expect(report.requestObservationSummary).toMatchObject({capturedAttempts:1,sentAttempts:0,preparedNotSent:1});
    expect(report.attemptObservation.dispatchAttempted).toBe(0);
    await expect(verifyG9IRequestPriorEvidence(report,report.jsonPath)).resolves.toBeUndefined();
  });
  it('reports missing required schema as a request contract failure',async()=>{
    const report=await oneCase('missing-schema');
    expect(report.validRun).toBe(false);
    expect(report.requestContractFailed).toBe(true);
    expect(report.requestObservationSummary?.schemaMissing).toBe(1);
    expect(report.records[0]?.errorCode).toBe('G9I_REQUEST_SCHEMA_MISSING');
  });
  it('runs offline 36 then 12 through the same G9I manifest and refuses a second first run',async()=>{
    vi.stubGlobal('fetch',vi.fn(()=>{throw new Error('NETWORK_FORBIDDEN');}));vi.spyOn(console,'log').mockImplementation(()=>{});
    const {manifest}=await calibration(),resultsDir=await mkdtemp(join(tmpdir(),'g9i-two-stage-'));dirs.push(resultsDir);
    const manifestHash=hash('g9i-two-stage');
    const plan=async(_input:unknown,observer:Parameters<NonNullable<Parameters<typeof executeG9IStage>[0]['plan']>>[1],_signal:AbortSignal,
      structuredObserver?:Parameters<NonNullable<Parameters<typeof executeG9IStage>[0]['plan']>>[3],
      requestObserver?:Parameters<NonNullable<Parameters<typeof executeG9IStage>[0]['plan']>>[4])=>{
      const start:ModelAttemptStart={type:'attempt_start',protocolVersion:MODEL_ATTEMPT_PROTOCOL_VERSION,invocationId:randomUUID(),attemptId:randomUUID(),
        role:'semantic_intent',attempt:1,requestMaxOutputTokens:4096,startedAtUtc:new Date().toISOString(),dispatch:'pending'};
      await observer(start);
      const component=(value:string)=>({sha256:hash(value),bytes:Buffer.byteLength(value)});
      await requestObserver?.({version:MODEL_REQUEST_OBSERVATION_VERSION,invocationId:start.invocationId,attemptId:start.attemptId,
        role:start.role,attempt:1,requestMaxOutputTokens:4096,outputMode:'json_object',body:component('body'),system:component('system'),
        user:component('user'),schema:component('schema'),schemaLocation:'system',schemaIncluded:true,repairFeedbackIncluded:false});
      const {type:_type,dispatch:_dispatch,...identity}=start;
      await observer({...identity,type:'attempt_end',endedAtUtc:new Date().toISOString(),durationMs:1,requestStarted:true,status:'failed',
        errorCode:'MODEL_HTTP_503',failureStage:'request',httpStatus:503});
      structuredObserver?.({version:MODEL_STRUCTURED_OUTPUT_OBSERVATION_VERSION,role:'semantic_intent',toolName:'interpret_banking_intent',
        attempt:1,attemptId:start.attemptId,status:'failed',errorCode:'MODEL_HTTP_503',outputOmitted:'not_text'});
      throw new ModelProviderError('MODEL_HTTP_503',true);
    };
    const common={manifest,manifestHash,config,resultsDir,verifyFrozenFiles:async()=>true,semanticJsonl:true,billJsonl:true,plan};
    await expect(executeG9IStage({...common,dataset:g9cQualityDataset,cohort:'development-supplemental'})).rejects.toThrow('G9I_PRIOR_STAGE_REQUIRED');
    const known=await executeG9IStage({...common,dataset:g9Dataset,cohort:'known-regression'});
    expect(known.validRun).toBe(true);expect(known.records).toHaveLength(36);
    const quality=await executeG9IStage({...common,dataset:g9cQualityDataset,cohort:'development-supplemental',
      priorReportPaths:{'default-known':known.jsonPath}});
    expect(quality.validRun).toBe(true);expect(quality.records).toHaveLength(12);
    expect(quality.priorReportSha256['default-known']).toBe(hash(await readFile(known.jsonPath)));
    await expect(executeG9IStage({...common,dataset:g9Dataset,cohort:'known-regression'})).rejects.toThrow('EEXIST');
    expect(fetch).not.toHaveBeenCalled();
  });
});
