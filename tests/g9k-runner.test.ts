import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { digest } from '../evals/ablation-score';
import { g9Dataset } from '../evals/g9-holdout-fixtures';
import { g9cQualityDataset } from '../evals/g9c-quality-fixtures';
import { g9gExpected } from '../evals/g9g-score';
import { ModelProviderError, MODEL_ATTEMPT_PROTOCOL_VERSION, MODEL_REQUEST_OBSERVATION_VERSION,
  MODEL_STRUCTURED_OUTPUT_OBSERVATION_VERSION, type ModelAttemptStart } from '../packages/agents/src/provider';
import { g9cProviderFingerprint } from '../scripts/evaluate-g9c';
import { G9H_PROFILE, hashG9HEvaluatorFiles } from '../scripts/evaluate-g9h';
import { G9I_PROFILE } from '../scripts/evaluate-g9i';
import { buildG9KManifest, executeG9KStage, G9K_EVALUATOR_FILES, G9K_PROFILE, runG9K,
  validateG9KManifestMetadata, validateG9KPriorReport } from '../scripts/evaluate-g9k';
import { verifyG9IRequestPriorEvidence } from '../scripts/g9i-request-validation';

const hash=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
const config={model:'offline-g9k',baseURL:'https://offline.invalid/v1',outputMode:'json_object' as const};
const directories:string[]=[];
afterEach(async()=>{vi.restoreAllMocks();vi.unstubAllGlobals();await Promise.all(directories.splice(0).map(path=>rm(path,{recursive:true,force:true})));});
async function calibration(){
  const originalBytes=await readFile('evals/g9-manifest.json'),qualityBytes=await readFile('evals/g9c-quality-manifest.json');
  const lineage={parentManifestPath:'evals/g9i-manifest.json' as const,parentManifestSha256:hash(await readFile('evals/g9i-manifest.json')),
    g9jSnapshotPath:'docs/evidence/2026-10-25-g9j-source-snapshot.json' as const,
    g9jSnapshotSha256:hash(await readFile('docs/evidence/2026-10-25-g9j-source-snapshot.json'))};
  const inputs={original:JSON.parse(originalBytes.toString()),qualityParent:JSON.parse(qualityBytes.toString()),knownDataset:g9Dataset,qualityDataset:g9cQualityDataset,
    originalManifestSha256:hash(originalBytes),qualityParentManifestSha256:hash(qualityBytes)};
  const hashes=Object.fromEntries(await Promise.all(G9K_EVALUATOR_FILES.map(async path=>[path,hash(await readFile(path))])));
  const manifest=buildG9KManifest({...inputs,candidateLineage:lineage,frozenAt:'2026-10-25T00:00:00.000Z',
    sourceManifestPath:'evals/baselines/g9k-calibration/source-manifest.json',sourceManifestSha256:hash('source'),
    evaluatorHashes:hashes,provider:g9cProviderFingerprint(config)});
  return {inputs,hashes,lineage,manifest};
}
describe('G9K trusted shared runner profile',()=>{
  it('pins G9J snapshot metadata to the formal G9I parent without locking future product edits',async()=>{
    const {lineage}=await calibration();
    const snapshot=JSON.parse(await readFile(lineage.g9jSnapshotPath,'utf8')) as { parentManifest:string;parentSha256:string;copyDrift:string[];
      files:{path:string;sha256:string}[] };
    expect(snapshot.parentManifest).toBe(lineage.parentManifestPath);
    expect(snapshot.parentSha256).toBe(lineage.parentManifestSha256);
    expect(snapshot.copyDrift).toEqual([]);expect(snapshot.files).toHaveLength(310);
    const products=snapshot.files.filter(file=>/^(apps|packages)\//.test(file.path));
    expect(products).toHaveLength(69);
    expect(new Set(snapshot.files.map(file=>file.path)).size).toBe(snapshot.files.length);
    expect(snapshot.files.every(file=>/^[a-f0-9]{64}$/.test(file.sha256))).toBe(true);
  });
  it('binds G9I parent and G9J source snapshot while preserving three score cohorts and request capability',async()=>{
    const {inputs,hashes,lineage,manifest}=await calibration();
    expect(validateG9KManifestMetadata(manifest,inputs,hashes,'2026-10-25T01:00:00.000Z')).toMatchObject({knownCount:36,qualityCount:12});
    expect(manifest.candidateLineage).toEqual(lineage);
    expect(manifest.provider).toMatchObject({outputMode:'json_object',reasoningEffort:'omitted'});
    expect(G9H_PROFILE.requestEvidence).toBeUndefined();expect(G9I_PROFILE.requestEvidence).toBe('required');
    expect(G9K_PROFILE.requestEvidence).toBe('required');
    expect(G9K_EVALUATOR_FILES).toContain('scripts/g9i-request-validation.ts');
    const missing=structuredClone(manifest);delete missing.candidateLineage;
    expect(()=>validateG9KManifestMetadata(missing,inputs,hashes,'2026-10-25T01:00:00.000Z')).toThrow('G9K_FROZEN_MANIFEST_MISMATCH');
    const wrong=structuredClone(manifest);wrong.candidateLineage!.g9jSnapshotPath='docs/evidence/another-snapshot.json' as NonNullable<typeof wrong.candidateLineage>['g9jSnapshotPath'];
    expect(()=>validateG9KManifestMetadata(wrong,inputs,hashes,'2026-10-25T01:00:00.000Z')).toThrow('G9K_FROZEN_MANIFEST_MISMATCH');
    // Byte-level digest checking belongs to verifyFrozenFiles before dispatch.
    await expect(hashG9HEvaluatorFiles('.',{...G9K_PROFILE,requestEvidence:undefined})).rejects.toThrow('EVALUATION_PROFILE_INVALID');
  });
  it('rejects missing sidecar flags, alternate profiles and a G9I prior report before network',async()=>{
    await expect(runG9K(['--mode','live','--cohort','known-regression'])).rejects.toThrow('G9K_STRUCTURED_TRACES_REQUIRED');
    await expect(runG9K(['--mode','live','--cohort','known-regression','--semantic-jsonl','--bill-jsonl','--profile','g9i'])).rejects.toThrow('G9K_UNSUPPORTED_OR_DUPLICATE_OPTION');
    const {manifest}=await calibration();
    expect(()=>validateG9KPriorReport({protocolVersion:G9I_PROFILE.runnerVersion},{stage:'default-known',manifest,manifestHash:hash('manifest')})).toThrow('G9K_PRIOR_STAGE_INVALID');
  });
  it('retains request metadata, semantic sidecar and G9K lineage in an offline attempted case',async()=>{
    vi.stubGlobal('fetch',vi.fn(()=>{throw new Error('NETWORK_FORBIDDEN');}));vi.spyOn(console,'log').mockImplementation(()=>{});
    const {manifest}=await calibration(),fixture=g9Dataset.cases.find(item=>item.id==='g9-card-06')!;
    const short=structuredClone(manifest),dataset={...g9Dataset,cases:[fixture]};
    short.cohorts.knownRegression.caseIds=[fixture.id];short.cohorts.knownRegression.caseCount=1 as 36;
    short.cohorts.knownRegression.templateInputsSha256=digest([fixture.input]);
    short.cohorts.knownRegression.originalExpectedLabelsSha256=digest([fixture.expected]);
    short.cohorts.knownRegression.currentExpectedLabelsSha256=digest([g9gExpected(fixture)]);
    const dir=await mkdtemp(join(tmpdir(),'g9k-runner-'));directories.push(dir);
    const report=await executeG9KStage({dataset,manifest:short,manifestHash:hash(randomUUID()),cohort:'known-regression',config,resultsDir:dir,
      verifyFrozenFiles:async()=>true,semanticJsonl:true,billJsonl:true,
      plan:async(_input,observer,_signal,structuredObserver,requestObserver)=>{
        const start:ModelAttemptStart={type:'attempt_start',protocolVersion:MODEL_ATTEMPT_PROTOCOL_VERSION,invocationId:randomUUID(),attemptId:randomUUID(),
          role:'semantic_intent',attempt:1,requestMaxOutputTokens:4096,startedAtUtc:new Date().toISOString(),dispatch:'pending'};
        await observer(start);
        const component=(value:string)=>({sha256:hash(value),bytes:Buffer.byteLength(value)});
        await requestObserver?.({version:MODEL_REQUEST_OBSERVATION_VERSION,invocationId:start.invocationId,attemptId:start.attemptId,role:start.role,
          attempt:1,requestMaxOutputTokens:4096,outputMode:'json_object',body:component('body'),system:component('system'),user:component('user'),
          schema:component('schema'),schemaLocation:'system',schemaIncluded:true,repairFeedbackIncluded:false});
        const {type:_type,dispatch:_dispatch,...identity}=start;
        await observer({...identity,type:'attempt_end',endedAtUtc:new Date().toISOString(),durationMs:1,requestStarted:true,status:'failed',
          errorCode:'MODEL_HTTP_503',failureStage:'request',httpStatus:503});
        structuredObserver?.({version:MODEL_STRUCTURED_OUTPUT_OBSERVATION_VERSION,role:'semantic_intent',toolName:'interpret_banking_intent',
          attempt:1,attemptId:start.attemptId,status:'failed',errorCode:'MODEL_HTTP_503',outputOmitted:'not_text'});
        throw new ModelProviderError('MODEL_HTTP_503',true);
      }});
    expect(report.validRun).toBe(true);expect(report.records).toHaveLength(1);
    expect(report.candidateLineage).toEqual(manifest.candidateLineage);
    expect(report.requestTraceStatus).toBe('complete');expect(report.requestObservationSummary).toMatchObject({capturedAttempts:1,sentAttempts:1,schemaMissing:0});
    expect(report.semanticTraceStatus).toBe('complete');expect(report.billTraceStatus).toBe('complete');
    expect(report.scoreSummary.plannedCases).toBe(1);expect(report.previousScoreSummary.plannedCases).toBe(1);expect(report.currentScoreSummary.plannedCases).toBe(1);
    await expect(verifyG9IRequestPriorEvidence(report,report.jsonPath)).resolves.toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });
});
