import { createHash, randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, openSync, writeSync } from 'node:fs';
import { mkdir, open, readFile, type FileHandle } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createPlanner, providerFromEnv, type OpenAICompatibleConfig } from '../packages/agents/src/index';
import { createModelAttemptJournal } from '../packages/agents/src/attempt-journal';
import { MODEL_ATTEMPT_PERSIST_TIMEOUT_MS, MODEL_ATTEMPT_PROTOCOL_VERSION, MODEL_STRUCTURED_OUTPUT_MAX_BYTES, MODEL_STRUCTURED_OUTPUT_OBSERVATION_VERSION, type ModelAttemptObserver, type ModelStructuredOutputObservation } from '../packages/agents/src/provider';
import { createStageOutputPlan } from '../packages/agents/src/budget';
import type { PlannerInput, PlanResult } from '../packages/contracts/src/index';
import { canonical, digest } from '../evals/ablation-score';
import { G9_CONTRACT_VERSION, validateG9Dataset, type G9Dataset, type G9Manifest } from '../evals/g9-contract';
import { G9_SCORE_VERSION } from '../evals/g9-score';
import { evaluateG9Case, G9_EVALUATOR_FILES, G9_LIMITS, g9ProductInventory, resolveG9CaseInput, summarizeG9Scores, type G9CaseRecord } from './evaluate-g9';
import { G9C_QUALITY_CASE_IDS, G9C_QUALITY_CONTRACT_PATH, G9C_QUALITY_FIXTURE_PATH, validateG9CQualityDataset, type G9CQualityManifest } from './evaluate-g9c-quality';
import { g9cProviderFingerprint, type G9CProviderFingerprint } from './evaluate-g9c';
import { EVALUATION_OBSERVATION_VERSION, summarizeEvaluationCases, summarizeEvaluationObservation } from './evaluation-observation';

export const G9D_RUNNER_VERSION = 'bankpilot-g9d-paired-known-replay-v1';
export const G9D_MANIFEST_PATH = 'evals/g9d-manifest.json';
export const G9D_PROTOCOL_PATH = 'docs/g9d-validation-protocol.md';
export const G9D_ORIGINAL_MANIFEST_PATH = 'evals/g9-manifest.json';
export const G9D_QUALITY_PARENT_MANIFEST_PATH = 'evals/g9c-quality-manifest.json';
export const G9D_STAGES = ['default-known', 'default-quality', 'none-known', 'none-quality'] as const;
export type G9DStage = typeof G9D_STAGES[number];
export type G9DCondition = 'default' | 'none';
export type G9DCohort = 'known-regression' | 'development-supplemental';
export const G9D_EVALUATOR_FILES = [...new Set<string>([
  ...G9_EVALUATOR_FILES, 'scripts/evaluate-g9c.ts', 'scripts/evaluate-g9c-quality.ts',
  'scripts/evaluate-g9d.ts', 'scripts/evaluate-g9d-quality.ts', 'tests/g9d-paired-runner.test.ts', 'tests/g9d-provider-observation.test.ts',
  'packages/agents/src/attempt-journal.ts', 'packages/agents/src/provider.ts', 'packages/agents/src/budget.ts',
  'packages/agents/src/planning-failures.ts', 'packages/agents/src/index.ts',
  'packages/contracts/src/index.ts', 'packages/contracts/src/management.ts', 'packages/contracts/src/investment.ts',
  'packages/contracts/src/goals.ts', 'packages/contracts/src/preparations.ts',
  G9C_QUALITY_FIXTURE_PATH, G9C_QUALITY_CONTRACT_PATH, G9D_PROTOCOL_PATH, 'package.json', 'pnpm-lock.yaml',
])].sort();
export type G9DCohortBinding = {
  datasetVersion: string; fixturePath: string; fixtureSha256: string; caseIds: string[]; caseCount: 36 | 12;
  positiveCount: number; domainCounts: G9Manifest['domainCounts']; templateInputsSha256: string; expectedLabelsSha256: string;
  kindCounts?: G9CQualityManifest['kindCounts']; contractPath?: string; contractSha256?: string;
};
export type G9DManifest = {
  protocolVersion: typeof G9D_RUNNER_VERSION; frozenAt: string; blind: false;
  originalManifestPath: typeof G9D_ORIGINAL_MANIFEST_PATH; originalManifestSha256: string;
  qualityParentManifestPath: typeof G9D_QUALITY_PARENT_MANIFEST_PATH; qualityParentManifestSha256: string;
  sourceManifestPath: string; sourceManifestSha256: string;
  cohorts: { knownRegression: G9DCohortBinding; developmentSupplemental: G9DCohortBinding };
  providers: { default: G9CProviderFingerprint; none: G9CProviderFingerprint };
  limits: typeof G9_LIMITS; protocolPath: typeof G9D_PROTOCOL_PATH; protocolSha256: string;
  evaluatorHashes: Record<string,string>;
};
type OriginalAndQuality = { original: G9Manifest; qualityParent: G9CQualityManifest; knownDataset: G9Dataset; qualityDataset: G9Dataset; originalManifestSha256: string; qualityParentManifestSha256: string };
type Plan = (input: PlannerInput, observer: ModelAttemptObserver, signal: AbortSignal, structuredObserver?: (event: Readonly<ModelStructuredOutputObservation>) => void) => Promise<PlanResult>;
const sha256 = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
const fileHash = async (path: string) => sha256(await readFile(path));
const same = (left: unknown,right: unknown) => canonical(left) === canonical(right);
const hashLike = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const relativePath = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && !value.startsWith('/') && !value.includes('\\') && value.split('/').every(part => part && part !== '.' && part !== '..');
const timestamp = (value: string) => /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0,10) === value.slice(0,10);
const stageOf = (condition: G9DCondition,cohort: G9DCohort): G9DStage => `${condition}-${cohort === 'known-regression' ? 'known' : 'quality'}` as G9DStage;
const bindingOf = (manifest: G9DManifest,cohort: G9DCohort) => manifest.cohorts[cohort === 'known-regression' ? 'knownRegression' : 'developmentSupplemental'];
const requiredEarlier = (stage: G9DStage) => G9D_STAGES.slice(0,G9D_STAGES.indexOf(stage));
export async function hashG9DEvaluatorFiles(root = '.') { return Object.fromEntries(await Promise.all(G9D_EVALUATOR_FILES.map(async path => [path,await fileHash(resolve(root,path))]))); }

export function buildG9DManifest(options: OriginalAndQuality & { frozenAt: string; sourceManifestPath: string; sourceManifestSha256: string; evaluatorHashes: Record<string,string>; defaultProvider: G9CProviderFingerprint; noneProvider: G9CProviderFingerprint }): G9DManifest {
  const known = validateG9Dataset(options.knownDataset), quality = validateG9CQualityDataset(options.qualityDataset);
  const manifest: G9DManifest = { protocolVersion: G9D_RUNNER_VERSION, frozenAt: options.frozenAt, blind: false,
    originalManifestPath: G9D_ORIGINAL_MANIFEST_PATH, originalManifestSha256: options.originalManifestSha256,
    qualityParentManifestPath: G9D_QUALITY_PARENT_MANIFEST_PATH, qualityParentManifestSha256: options.qualityParentManifestSha256,
    sourceManifestPath: options.sourceManifestPath, sourceManifestSha256: options.sourceManifestSha256,
    cohorts: {
      knownRegression: { datasetVersion: options.knownDataset.version, fixturePath: options.original.fixturePath, fixtureSha256: options.original.fixtureSha256,
        caseIds: known.caseIds, caseCount: 36, positiveCount: known.positiveCount, domainCounts: known.domainCounts,
        templateInputsSha256: digest(options.knownDataset.cases.map(item=>item.input)), expectedLabelsSha256: digest(options.knownDataset.cases.map(item=>item.expected)) },
      developmentSupplemental: { datasetVersion: options.qualityDataset.version, fixturePath: options.qualityParent.fixturePath, fixtureSha256: options.qualityParent.fixtureSha256,
        caseIds: quality.caseIds, caseCount: 12, positiveCount: quality.positiveCount, domainCounts: quality.domainCounts, kindCounts: quality.kindCounts,
        templateInputsSha256: digest(options.qualityDataset.cases.map(item=>item.input)), expectedLabelsSha256: digest(options.qualityDataset.cases.map(item=>item.expected)),
        contractPath: G9C_QUALITY_CONTRACT_PATH, contractSha256: options.qualityParent.contractSha256 },
    }, providers: { default: options.defaultProvider, none: options.noneProvider }, limits: G9_LIMITS,
    protocolPath: G9D_PROTOCOL_PATH, protocolSha256: options.evaluatorHashes[G9D_PROTOCOL_PATH]!, evaluatorHashes: { ...options.evaluatorHashes } };
  validateG9DManifestMetadata(manifest,options,options.evaluatorHashes,options.frozenAt);
  return manifest;
}

export function validateG9DManifestMetadata(manifest: G9DManifest, inputs: OriginalAndQuality, evaluatorHashes: Record<string,string>, now = new Date().toISOString()) {
  const known = validateG9Dataset(inputs.knownDataset), quality = validateG9CQualityDataset(inputs.qualityDataset);
  const expectedKnown = { datasetVersion: inputs.knownDataset.version, fixturePath: inputs.original.fixturePath, fixtureSha256: inputs.original.fixtureSha256,
    caseIds: known.caseIds,caseCount: 36,positiveCount: known.positiveCount,domainCounts: known.domainCounts,
    templateInputsSha256:digest(inputs.knownDataset.cases.map(item=>item.input)),expectedLabelsSha256:digest(inputs.knownDataset.cases.map(item=>item.expected)) };
  const expectedQuality = { datasetVersion: inputs.qualityDataset.version,fixturePath: inputs.qualityParent.fixturePath,fixtureSha256: inputs.qualityParent.fixtureSha256,
    caseIds: quality.caseIds,caseCount: 12,positiveCount: quality.positiveCount,domainCounts: quality.domainCounts,kindCounts: quality.kindCounts,
    templateInputsSha256:digest(inputs.qualityDataset.cases.map(item=>item.input)),expectedLabelsSha256:digest(inputs.qualityDataset.cases.map(item=>item.expected)),
    contractPath:G9C_QUALITY_CONTRACT_PATH,contractSha256:inputs.qualityParent.contractSha256 };
  const defaultProvider = manifest.providers?.default, noneProvider = manifest.providers?.none;
  if (manifest.protocolVersion !== G9D_RUNNER_VERSION || manifest.blind !== false || !timestamp(manifest.frozenAt) || Date.parse(manifest.frozenAt) > Date.parse(now)
    || manifest.originalManifestPath !== G9D_ORIGINAL_MANIFEST_PATH || manifest.originalManifestSha256 !== inputs.originalManifestSha256 || !hashLike(manifest.originalManifestSha256)
    || manifest.qualityParentManifestPath !== G9D_QUALITY_PARENT_MANIFEST_PATH || manifest.qualityParentManifestSha256 !== inputs.qualityParentManifestSha256 || !hashLike(manifest.qualityParentManifestSha256)
    || inputs.qualityParent.parentManifestPath !== 'evals/g9c-manifest.json' || inputs.original.fixtureSha256 !== expectedKnown.fixtureSha256
    || inputs.qualityParent.fixturePath !== G9C_QUALITY_FIXTURE_PATH || !same(inputs.original.caseIds,known.caseIds) || !same(inputs.qualityParent.caseIds,quality.caseIds)
    || !same(manifest.cohorts?.knownRegression,expectedKnown) || !same(manifest.cohorts?.developmentSupplemental,expectedQuality)
    || !/^evals\/baselines\/g9d-[^/]+\/source-manifest\.json$/.test(manifest.sourceManifestPath) || !relativePath(manifest.sourceManifestPath) || !hashLike(manifest.sourceManifestSha256)
    || !defaultProvider || !noneProvider || !defaultProvider.model || !['tools','json_object'].includes(defaultProvider.outputMode)
    || !['omitted','enabled','disabled'].includes(defaultProvider.thinkingMode)
    || defaultProvider.reasoningEffort !== 'omitted' || noneProvider.reasoningEffort !== 'none'
    || !same(Object.keys(defaultProvider).sort(),['baseURLSha256','model','outputMode','reasoningEffort','thinkingMode'])
    || !same(Object.keys(noneProvider).sort(),['baseURLSha256','model','outputMode','reasoningEffort','thinkingMode'])
    || !hashLike(defaultProvider.baseURLSha256) || !same({ ...defaultProvider,reasoningEffort:'none' },noneProvider)
    || !same(manifest.limits,G9_LIMITS) || manifest.protocolPath !== G9D_PROTOCOL_PATH || manifest.protocolSha256 !== evaluatorHashes[G9D_PROTOCOL_PATH]
    || !same(manifest.evaluatorHashes,evaluatorHashes) || !same(Object.keys(evaluatorHashes).sort(),G9D_EVALUATOR_FILES)
    || Object.values(evaluatorHashes).some(value=>!hashLike(value))) throw new Error('G9D_FROZEN_MANIFEST_MISMATCH');
  for (const item of [...inputs.knownDataset.cases,...inputs.qualityDataset.cases]) resolveG9CaseInput(item,Date.parse(item.snapshotClock?.anchorIso ?? `${item.input.referenceDate}T00:00:00.000Z`));
  return { knownCount: 36,qualityCount: 12,knownCaseIds: known.caseIds,qualityCaseIds: quality.caseIds };
}

export async function verifyG9DFrozenFiles(manifest: G9DManifest, manifestHash: string, manifestPath = G9D_MANIFEST_PATH, root = '.') {
  const at = (path: string) => resolve(root,path);
  if (await fileHash(at(manifestPath)) !== manifestHash || await fileHash(at(manifest.originalManifestPath)) !== manifest.originalManifestSha256
    || await fileHash(at(manifest.qualityParentManifestPath)) !== manifest.qualityParentManifestSha256
    || await fileHash(at(manifest.sourceManifestPath)) !== manifest.sourceManifestSha256
    || await fileHash(at(manifest.cohorts.knownRegression.fixturePath)) !== manifest.cohorts.knownRegression.fixtureSha256
    || await fileHash(at(manifest.cohorts.developmentSupplemental.fixturePath)) !== manifest.cohorts.developmentSupplemental.fixtureSha256
    || await fileHash(at(G9C_QUALITY_CONTRACT_PATH)) !== manifest.cohorts.developmentSupplemental.contractSha256
    || !same(await hashG9DEvaluatorFiles(root),manifest.evaluatorHashes)) throw new Error('G9D_FROZEN_FILE_DRIFT');
  const parent = JSON.parse(await readFile(at(manifest.qualityParentManifestPath),'utf8')) as G9CQualityManifest;
  if (parent.parentManifestPath !== 'evals/g9c-manifest.json' || !hashLike(parent.parentManifestSha256)
    || await fileHash(at(parent.parentManifestPath)) !== parent.parentManifestSha256) throw new Error('G9D_HISTORICAL_LINEAGE_DRIFT');
  const historical = JSON.parse(await readFile(at(parent.parentManifestPath),'utf8')) as { originalManifestPath?:string; originalManifestSha256?:string; fixtureSha256?:string };
  if (historical.originalManifestPath !== manifest.originalManifestPath || historical.originalManifestSha256 !== manifest.originalManifestSha256
    || historical.fixtureSha256 !== manifest.cohorts.knownRegression.fixtureSha256) throw new Error('G9D_HISTORICAL_LINEAGE_MISMATCH');
  const source = JSON.parse(await readFile(at(manifest.sourceManifestPath),'utf8')) as { files?: { path:string; sha256:string }[] };
  if (!Array.isArray(source.files) || !source.files.length || source.files.some(file=>!relativePath(file?.path)||!hashLike(file?.sha256)) || new Set(source.files.map(file=>file.path)).size !== source.files.length) throw new Error('G9D_SOURCE_MANIFEST_INVALID');
  const paths = source.files.filter(file=>/^(apps|packages)\//.test(file.path)).map(file=>file.path).sort();
  const inventory = (await Promise.all(['apps','packages'].map(async directory=>(await g9ProductInventory(at(directory))).map(path=>path.slice(resolve(root).length+1))))).flat().sort();
  if (!same(paths,inventory)) throw new Error('G9D_PRODUCT_INVENTORY_DRIFT');
  if ((await Promise.all(source.files.map(async file=>await fileHash(at(file.path))===file.sha256))).some(match=>!match)) throw new Error('G9D_FROZEN_SOURCE_DRIFT');
}

export function validateG9DPriorReport(report: any, expected: { stage: G9DStage; manifest: G9DManifest; manifestHash: string }) {
  const condition = expected.stage.startsWith('default') ? 'default' : 'none';
  const cohort = expected.stage.endsWith('known') ? 'known-regression' : 'development-supplemental';
  const binding = bindingOf(expected.manifest,cohort);
  if (!report || report.protocolVersion !== G9D_RUNNER_VERSION || report.stage !== expected.stage || report.condition !== condition || report.cohort !== cohort
    || report.manifestSha256 !== expected.manifestHash || report.sourceManifestSha256 !== expected.manifest.sourceManifestSha256
    || !same(report.provider,expected.manifest.providers[condition]) || !same(report.limits,expected.manifest.limits)
    || !same(report.caseIds,binding.caseIds) || report.fixtureSha256 !== binding.fixtureSha256
    || report.templateInputsSha256 !== binding.templateInputsSha256 || report.expectedLabelsSha256 !== binding.expectedLabelsSha256
    || report.executionComplete !== true || report.validRun !== true || report.records?.length !== binding.caseCount
    || !same(report.records?.map((item: G9CaseRecord)=>item.id),binding.caseIds)) throw new Error('G9D_PRIOR_STAGE_INVALID');
}

async function durableLine(file: FileHandle,value: unknown) { await file.appendFile(JSON.stringify(value)+'\n'); await file.sync(); }
async function durableNew(path: string,contents: string) { const file=await open(path,'wx',0o600); try { await file.writeFile(contents);await file.sync(); } finally { await file.close(); } }
/** A single execution engine for both cohorts; injection is for offline calibration only. */
export async function executeG9DStage(options: { dataset:G9Dataset; manifest:G9DManifest; manifestHash:string; condition:G9DCondition; cohort:G9DCohort; config:OpenAICompatibleConfig; resultsDir:string; verifyFrozenFiles:()=>Promise<unknown>; priorReportPaths?:Partial<Record<G9DStage,string>>; semanticJsonl?:boolean; plan?:Plan; signal?:AbortSignal }) {
  const { dataset,manifest,manifestHash,condition,cohort,config }=options, stage=stageOf(condition,cohort), binding=bindingOf(manifest,cohort);
  if (!same(dataset.cases.map(item=>item.id),binding.caseIds) || dataset.version!==binding.datasetVersion || digest(dataset.cases.map(item=>item.input))!==binding.templateInputsSha256
    || digest(dataset.cases.map(item=>item.expected))!==binding.expectedLabelsSha256 || !same(g9cProviderFingerprint(config),manifest.providers[condition])
    || !same(manifest.limits,G9_LIMITS) || manifest.protocolVersion!==G9D_RUNNER_VERSION) throw new Error('G9D_EXECUTION_CONTRACT_MISMATCH');
  const priorHashes: Partial<Record<G9DStage,string>> = {};
  for (const earlier of requiredEarlier(stage)) {
    const path=options.priorReportPaths?.[earlier]; if (!path) throw new Error('G9D_PRIOR_STAGE_REQUIRED');
    const bytes=await readFile(path);validateG9DPriorReport(JSON.parse(bytes.toString()),{ stage:earlier,manifest,manifestHash });priorHashes[earlier]=sha256(bytes);
  }
  await options.verifyFrozenFiles();
  const startedAt=new Date().toISOString(),runId=`${startedAt.replace(/[:.]/g,'-')}-${randomUUID()}`,resultsDir=resolve(options.resultsDir);
  await mkdir(resultsDir,{ recursive:true });
  // A durable stage claim preserves its first attempt even if a process stops before report creation.
  await durableNew(resolve(resultsDir,`${manifestHash}-${stage}.first.json`),JSON.stringify({ stage,runId,startedAt,manifestSha256:manifestHash })+'\n');
  const runDir=resolve(resultsDir,`${stage}-${runId}`);await mkdir(runDir,{mode:0o700});
  const jsonPath=resolve(runDir,'report.json'),jsonlPath=resolve(runDir,'cases.jsonl'),mdPath=resolve(runDir,'report.md'),attemptsPath=resolve(runDir,'attempts.jsonl');
  const semanticPath=options.semanticJsonl?resolve(runDir,'semantic-extraction.jsonl'):undefined;
  const file=await open(jsonlPath,'wx',0o600);
  let semanticFd: number|undefined;
  try { if(semanticPath)semanticFd=openSync(semanticPath,'wx',0o600); }
  catch(error) { await file.close(); throw error; }
  let journal:Awaited<ReturnType<typeof createModelAttemptJournal>>|undefined;
  const records:G9CaseRecord[]=[], stopController=new AbortController();let stopped=false,sourceDrift=false,semanticTraceFailed=false,executionError:string|undefined;
  const stop=()=>{stopped=true;stopController.abort();};process.once('SIGINT',stop);process.once('SIGTERM',stop);options.signal?.addEventListener('abort',stop,{once:true});if(options.signal?.aborted)stop();
  try {
    journal=await createModelAttemptJournal(attemptsPath);
    const protocol={ protocolVersion:G9D_RUNNER_VERSION,contractVersion:G9_CONTRACT_VERSION,scoreVersion:G9_SCORE_VERSION,observationVersion:EVALUATION_OBSERVATION_VERSION,
      structuredOutputObservationVersion:MODEL_STRUCTURED_OUTPUT_OBSERVATION_VERSION,attemptProtocolVersion:MODEL_ATTEMPT_PROTOCOL_VERSION,attemptPersistenceTimeoutMs:MODEL_ATTEMPT_PERSIST_TIMEOUT_MS,
      stage,condition,cohort,blind:false,knownRegression:cohort==='known-regression',implementationInformed:cohort==='development-supplemental',
      datasetVersion:dataset.version,caseIds:binding.caseIds,caseCount:binding.caseCount,positiveCount:binding.positiveCount,domainCounts:binding.domainCounts,
      templateInputsSha256:binding.templateInputsSha256,expectedLabelsSha256:binding.expectedLabelsSha256,fixtureSha256:binding.fixtureSha256,
      limits:G9_LIMITS,topology:'production-parallel-review',manifestSha256:manifestHash,sourceManifestPath:manifest.sourceManifestPath,sourceManifestSha256:manifest.sourceManifestSha256,
      evaluatorHashes:manifest.evaluatorHashes,provider:manifest.providers[condition],priorReportSha256:priorHashes,
      worstCaseOutputPlan:createStageOutputPlan({domainStageCount:6,reviewerStageCount:1,maxAttempts:G9_LIMITS.maxAttempts}),
      boundaries:'Already exposed G9 cases or implementation-informed supplemental cases, never unseen. Same frozen candidate and labels for both parameter conditions. External cases sequential; domain stages retain production parallelism. Dispatch intent is fsynced before HTTP; no automatic whole-run retry. Unknown receipt, missing usage and business failure remain distinct.' };
    await durableLine(file,{type:'start',runId,startedAt,mode:'live',protocol,attemptsPath,journalId:journal.journalId,semanticPath:semanticPath??null});
    console.log(JSON.stringify({status:'started',runId,stage,caseCount:binding.caseCount}));
    const plan:Plan=options.plan??((input,observer,signal,structuredObserver)=>createPlanner({semantic:true,provider:{...config,timeoutMs:G9_LIMITS.providerTimeoutMs,maxAttempts:G9_LIMITS.maxAttempts,maxStructureRepairs:G9_LIMITS.maxStructureRepairs,temperature:G9_LIMITS.temperature,signal,attemptObserver:observer,structuredOutputObserver:structuredObserver}}).plan(input));
    try {
      for(const fixture of dataset.cases){
        if(stopped)break;try{await options.verifyFrozenFiles();}catch{sourceDrift=true;stopped=true;break;}
        let caseSemanticFailed=false;
        const tracedSemanticAttemptIds=new Set<string>();
        const structuredObserver=semanticFd===undefined?undefined:(event:Readonly<ModelStructuredOutputObservation>)=>{
          if(event.role!=='semantic_intent')return;
          try {
            const outputText=event.outputText;
            const observed=journal!.summary(records.length+1).confirmedAttempts.find(item=>item.start.attemptId===event.attemptId&&item.start.role==='semantic_intent');
            if(event.version!==MODEL_STRUCTURED_OUTPUT_OBSERVATION_VERSION||event.toolName!=='interpret_banking_intent'||!event.attemptId||!observed?.end
              || tracedSemanticAttemptIds.has(event.attemptId)||observed.start.attempt!==event.attempt||observed.end.status!==event.status
              || observed.end.errorCode!==event.errorCode)throw new Error('G9D_SEMANTIC_ATTEMPT_MISMATCH');
            if(outputText!==undefined){
              if(event.outputOmitted!==undefined||Buffer.byteLength(outputText,'utf8')>MODEL_STRUCTURED_OUTPUT_MAX_BYTES
                || event.outputLength!==outputText.length||event.outputDigest!==sha256(outputText))throw new Error('G9D_SEMANTIC_OUTPUT_INTEGRITY');
            }else if(event.outputOmitted==='not_text'){
              if(event.outputLength!==undefined||event.outputDigest!==undefined)throw new Error('G9D_SEMANTIC_OUTPUT_INTEGRITY');
            }else if(event.outputOmitted==='size_limit'){
              if(!Number.isSafeInteger(event.outputLength)||event.outputLength!<0||!hashLike(event.outputDigest))throw new Error('G9D_SEMANTIC_OUTPUT_INTEGRITY');
            }else throw new Error('G9D_SEMANTIC_OUTPUT_INTEGRITY');
            const safe={type:'semantic_extraction',version:event.version,stage,caseId:fixture.id,caseSequence:records.length+1,fixtureSha256:binding.fixtureSha256,sourceManifestSha256:manifest.sourceManifestSha256,
              role:'semantic_intent',toolName:event.toolName,attempt:event.attempt,...(event.attemptId?{attemptId:event.attemptId}:{}),status:event.status,
              ...(event.errorCode?{errorCode:event.errorCode}:{}),...(event.outputLength!==undefined?{outputLength:event.outputLength}:{}),
              ...(event.outputDigest?{outputDigest:event.outputDigest}:{}),...(outputText!==undefined?{outputText}:{}),...(event.outputOmitted?{outputOmitted:event.outputOmitted}:{})};
            const bytes=Buffer.from(JSON.stringify(safe)+'\n','utf8');
            for(let offset=0;offset<bytes.length;){const written=writeSync(semanticFd,bytes,offset,bytes.length-offset);if(written<=0)throw new Error('G9D_SEMANTIC_SHORT_WRITE');offset+=written;}
            fsyncSync(semanticFd);tracedSemanticAttemptIds.add(event.attemptId);
          }catch{caseSemanticFailed=true;semanticTraceFailed=true;throw new Error('G9D_SEMANTIC_OBSERVATION_PERSIST_FAILED');}
        };
        const record=await evaluateG9Case(fixture,records.length+1,journal,(input,observer,signal)=>plan(input,observer,signal,structuredObserver),{signal:stopController.signal});
        try{await options.verifyFrozenFiles();}catch{sourceDrift=true;stopped=true;record.evaluationValid=false;record.passed=false;record.errorCode='G9D_FROZEN_FILE_DRIFT';}
        if(semanticFd!==undefined){
          const semanticAttempts=journal.summary(records.length+1).confirmedAttempts.filter(item=>item.start.role==='semantic_intent');
          if(!semanticAttempts.length||semanticAttempts.some(item=>!item.end||!tracedSemanticAttemptIds.has(item.start.attemptId))||tracedSemanticAttemptIds.size!==semanticAttempts.length){
            caseSemanticFailed=true;semanticTraceFailed=true;
          }
        }
        if(caseSemanticFailed){record.evaluationValid=false;record.passed=false;record.errorCode='G9D_SEMANTIC_TRACE_INCOMPLETE';}
        records.push(record);await durableLine(file,{type:'case',...record});
        console.log(JSON.stringify({sequence:record.sequence,id:record.id,status:record.failure?'unavailable':record.passed?'passed':'failed',durationMs:record.durationMs}));
        if(caseSemanticFailed) { stopped=true;break; }
      }
    }catch{stopped=true;executionError='G9D_EXECUTION_INTERRUPTED';stopController.abort();}
    await journal.close().catch(()=>{});try{await options.verifyFrozenFiles();}catch{sourceDrift=true;}
    const attemptObservation=journal.summary(),observedAttempts=summarizeEvaluationObservation(attemptObservation,{mode:'live',maxOutputTokens:G9_LIMITS.totalOutputTokenCeilingPerCase}),observedCases=summarizeEvaluationCases(records),scoreSummary=summarizeG9Scores(records,binding.caseCount);
    const executionComplete=records.length===binding.caseCount;
    const semanticTraceStatus=semanticFd===undefined?'disabled':!semanticTraceFailed&&executionComplete?'complete':'incomplete';
    const report={runId,startedAt,finishedAt:new Date().toISOString(),mode:'live',...protocol,executionComplete,stopped,sourceDrift,semanticTraceFailed,semanticTraceStatus,
      ...(executionError?{executionError}:{}),validRun:executionComplete&&!stopped&&!sourceDrift&&!semanticTraceFailed&&!executionError&&records.every(record=>record.evaluationValid)&&observedCases.complete&&observedAttempts.complete,
      scoreSummary,observedCases,observedAttempts,attemptObservation,records,jsonPath,jsonlPath,attemptsPath,semanticPath:semanticPath??null};
    await durableLine(file,{type:'finish',finishedAt:report.finishedAt,executionComplete,stopped,sourceDrift,semanticTraceFailed,validRun:report.validRun,scoreSummary});
    await durableNew(jsonPath,JSON.stringify(report,null,2));
    await durableNew(mdPath,[`# G9D ${stage}`,'',`Attempted ${scoreSummary.attemptedCases}/${binding.caseCount}; passed ${scoreSummary.passedCases}/${binding.caseCount}; valid ${report.validRun}.`,
      `Manifest ${manifestHash}; source ${manifest.sourceManifestSha256}; provider ${JSON.stringify(manifest.providers[condition])}.`,
      `Business assessed ${scoreSummary.businessAssessedCases}; unavailable ${scoreSummary.businessUnavailableCases}; unscored ${scoreSummary.businessUnscoredCases}. Safety pass ${scoreSummary.safetyPassCases}; fail ${scoreSummary.safetyFailureCases}; unscored ${scoreSummary.safetyUnscoredCases}.`,
      protocol.boundaries,'','| # | case | assessed | passed | failures |','|---:|---|---|---|---|',...records.map(record=>`| ${record.sequence} | ${record.id} | ${record.score?.assessed??false} | ${record.passed} | ${[...(record.score?.failures??[]),...(record.errorCode?[record.errorCode]:[])].join(', ').replaceAll('|','/')} |`)].join('\n'));
    console.log(JSON.stringify({status:'finished',runId,stage,validRun:report.validRun,attemptedCases:records.length,plannedCases:binding.caseCount,jsonPath,jsonlPath,attemptsPath,semanticPath}));
    return report;
  }finally{process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);options.signal?.removeEventListener('abort',stop);await journal?.close().catch(()=>{});await file.close();if(semanticFd!==undefined)closeSync(semanticFd);}
}

export async function runG9D(args=process.argv.slice(2)) {
  const flags=new Set(['--preflight','--semantic-jsonl']),values=new Set(['--mode','--condition','--cohort','--manifest','--results-dir','--prior-default-known','--prior-default-quality','--prior-none-known']),parsed=new Map<string,string|true>();
  for(let i=0;i<args.length;i++){const arg=args[i]!;if(parsed.has(arg)||(!flags.has(arg)&&!values.has(arg)))throw new Error('G9D_UNSUPPORTED_OR_DUPLICATE_OPTION');if(flags.has(arg))parsed.set(arg,true);else{const value=args[++i];if(!value||value.startsWith('--'))throw new Error('G9D_OPTION_VALUE_REQUIRED');parsed.set(arg,value);}}
  const preflight=parsed.has('--preflight');if(preflight&&(parsed.has('--mode')||parsed.has('--condition')||parsed.has('--cohort')||parsed.has('--semantic-jsonl')))throw new Error('G9D_PREFLIGHT_HAS_NO_EXECUTION_MODE');
  if(!preflight&&(parsed.get('--mode')!=='live'||!['default','none'].includes(parsed.get('--condition') as string)||!['known-regression','development-supplemental'].includes(parsed.get('--cohort') as string)))throw new Error('G9D_EXPLICIT_STAGE_REQUIRED');
  const manifestPath=resolve(parsed.get('--manifest') as string??G9D_MANIFEST_PATH),bytes=await readFile(manifestPath),manifestHash=sha256(bytes),manifest=JSON.parse(bytes.toString()) as G9DManifest;
  if(manifest.originalManifestPath!==G9D_ORIGINAL_MANIFEST_PATH||manifest.qualityParentManifestPath!==G9D_QUALITY_PARENT_MANIFEST_PATH
    || manifest.cohorts?.knownRegression?.fixturePath!=='evals/g9-holdout-fixtures.ts'||manifest.cohorts?.developmentSupplemental?.fixturePath!==G9C_QUALITY_FIXTURE_PATH)throw new Error('G9D_MANIFEST_PATH_INVALID');
  const originalBytes=await readFile(manifest.originalManifestPath),qualityParentBytes=await readFile(manifest.qualityParentManifestPath);
  const original=JSON.parse(originalBytes.toString()) as G9Manifest,qualityParent=JSON.parse(qualityParentBytes.toString()) as G9CQualityManifest;
  if(sha256(originalBytes)!==manifest.originalManifestSha256||sha256(qualityParentBytes)!==manifest.qualityParentManifestSha256)throw new Error('G9D_PARENT_BINDING_MISMATCH');
  const knownDataset=(await import(pathToFileURL(resolve(manifest.cohorts.knownRegression.fixturePath)).href)).g9Dataset as G9Dataset;
  const qualityDataset=(await import(pathToFileURL(resolve(manifest.cohorts.developmentSupplemental.fixturePath)).href)).g9cQualityDataset as G9Dataset;
  const inputs={original,qualityParent,knownDataset,qualityDataset,originalManifestSha256:sha256(originalBytes),qualityParentManifestSha256:sha256(qualityParentBytes)};
  const metadata=validateG9DManifestMetadata(manifest,inputs,await hashG9DEvaluatorFiles());await verifyG9DFrozenFiles(manifest,manifestHash,manifestPath);
  if(preflight){console.log(JSON.stringify({status:'preflight-passed',manifestSha256:manifestHash,...metadata,stages:G9D_STAGES}));return undefined;}
  const condition=parsed.get('--condition') as G9DCondition,cohort=parsed.get('--cohort') as G9DCohort,config=providerFromEnv();if(!config)throw new Error('G9D_EXPLICIT_PROVIDER_REQUIRED');
  if(!same(g9cProviderFingerprint(config),manifest.providers[condition]))throw new Error('G9D_FROZEN_PROVIDER_MISMATCH');
  const priorReportPaths:Partial<Record<G9DStage,string>>={};for(const [flag,stage] of [['--prior-default-known','default-known'],['--prior-default-quality','default-quality'],['--prior-none-known','none-known']] as const){const path=parsed.get(flag);if(typeof path==='string')priorReportPaths[stage]=path;}
  return executeG9DStage({dataset:cohort==='known-regression'?knownDataset:qualityDataset,manifest,manifestHash,condition,cohort,config,
    resultsDir:parsed.get('--results-dir') as string??'evals/results/g9d',priorReportPaths,semanticJsonl:parsed.has('--semantic-jsonl'),verifyFrozenFiles:()=>verifyG9DFrozenFiles(manifest,manifestHash,manifestPath)});
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)runG9D().then(report=>{if(report&&!report.validRun)process.exitCode=1;}).catch(()=>{console.error('G9D configuration or execution failed; case content and credentials remain sealed.');process.exitCode=1;});
