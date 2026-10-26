import { createHash, randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, openSync, writeSync } from 'node:fs';
import { mkdir, open, readFile, type FileHandle } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createPlanner, providerFromEnv, type OpenAICompatibleConfig } from '../packages/agents/src/index';
import { createModelAttemptJournal } from '../packages/agents/src/attempt-journal';
import { MODEL_ATTEMPT_PERSIST_TIMEOUT_MS, MODEL_ATTEMPT_PROTOCOL_VERSION, MODEL_REQUEST_OBSERVATION_VERSION, MODEL_STRUCTURED_OUTPUT_MAX_BYTES, MODEL_STRUCTURED_OUTPUT_OBSERVATION_VERSION, type ModelAttemptObserver, type ModelRequestObservation, type ModelRequestObserver, type ModelStructuredOutputObservation } from '../packages/agents/src/provider';
import { createStageOutputPlan } from '../packages/agents/src/budget';
import type { PlannerInput, PlanResult } from '../packages/contracts/src/index';
import { canonical, digest } from '../evals/ablation-score';
import { G9_CONTRACT_VERSION, validateG9Dataset, type G9Dataset, type G9Manifest } from '../evals/g9-contract';
import { G9_SCORE_VERSION } from '../evals/g9-score';
import { g9Dataset } from '../evals/g9-holdout-fixtures';
import { verifyG9HPriorEvidence } from './g9h-prior-validation';
import { G9E_SCORE_VERSION, scoreG9E, type G9EScore } from '../evals/g9e-score';
import { G9G_LABEL_POLICY_VERSION, G9G_SCORE_VERSION, g9gExpected, scoreG9G, type G9GScore } from '../evals/g9g-score';
import { evaluateG9Case, G9_LIMITS, g9ProductInventory, resolveG9CaseInput, summarizeG9Scores, type G9CaseRecord } from './evaluate-g9';
import { G9C_QUALITY_CONTRACT_PATH, G9C_QUALITY_FIXTURE_PATH, validateG9CQualityDataset, type G9CQualityManifest } from './evaluate-g9c-quality';
import { g9cProviderFingerprint, type G9CProviderFingerprint } from './evaluate-g9c';
import { EVALUATION_OBSERVATION_VERSION, summarizeEvaluationCases, summarizeEvaluationObservation } from './evaluation-observation';
import { G9G_EVALUATOR_FILES } from './evaluate-g9g';
import { verifyG9IRequestPriorEvidence } from './g9i-request-validation';

export const G9H_RUNNER_VERSION = 'bankpilot-g9h-default-triple-score-v1';
export const G9H_MANIFEST_PATH = 'evals/g9h-manifest.json';
export const G9H_PROTOCOL_PATH = 'docs/g9h-validation-protocol.md';
export const G9H_ORIGINAL_MANIFEST_PATH = 'evals/g9-manifest.json';
export const G9H_QUALITY_PARENT_MANIFEST_PATH = 'evals/g9c-quality-manifest.json';
export const G9H_STAGES = ['default-known', 'default-quality'] as const;
export type G9HStage = typeof G9H_STAGES[number];
export type G9HCohort = 'known-regression' | 'development-supplemental';
export const G9H_EVALUATOR_FILES = [...new Set<string>([
  ...G9G_EVALUATOR_FILES,
  'scripts/evaluate-g9h.ts', 'scripts/g9h-prior-validation.ts',
  'tests/g9h-runner.test.ts',
  'packages/agents/src/bill-domain-assessment.ts', 'tests/g9h-bill-domain-assessment.test.ts', 'tests/g9h-bill-domain-integration.test.ts',
  'tests/g9h-isolated-browser-runner.test.ts', 'tests/e2e/g9h-bill-domain.spec.ts', 'playwright.g9h.config.ts',
  G9H_PROTOCOL_PATH,
])].sort();
export type EvaluationRunnerProfile = Readonly<{
  id: 'g9h' | 'g9i' | 'g9k'; runnerVersion: string; manifestPath: string; protocolPath: string;
  resultsDir: string; sourcePrefix: 'g9h' | 'g9i' | 'g9k'; evaluatorFiles: readonly string[]; boundaries: string;
  /** Trusted profile capability; required profiles persist and validate every pre-dispatch request record. */
  requestEvidence?: 'required';
}>;
export const G9H_PROFILE: EvaluationRunnerProfile = Object.freeze({
  id: 'g9h', runnerVersion: G9H_RUNNER_VERSION, manifestPath: G9H_MANIFEST_PATH,
  protocolPath: G9H_PROTOCOL_PATH, resultsDir: 'evals/results/g9h', sourcePrefix: 'g9h',
  evaluatorFiles: G9H_EVALUATOR_FILES,
  boundaries: 'Already exposed G9 cases or implementation-informed supplemental cases, never unseen. Original G9, previous G9E and current G9G scores are reported separately. G9H changes only the typed bills domain contract; provider parameters and output budget are unchanged. Semantic and bills visible structured outputs are separately bounded and journal-bound, without reasoning text. External cases sequential; domain stages retain production parallelism. No automatic whole-run retry. Unknown receipt, missing usage and business failure remain distinct.',
});
function profileCode(profile: EvaluationRunnerProfile, code: string) { return `${profile.id.toUpperCase()}_${code}`; }
function assertProfile(profile: EvaluationRunnerProfile): void {
  const expected = profile.id === 'g9h'
    ? { version: G9H_RUNNER_VERSION, manifest: G9H_MANIFEST_PATH, protocol: G9H_PROTOCOL_PATH, results: 'evals/results/g9h' }
    : profile.id === 'g9i'
      ? { version: 'bankpilot-g9i-default-triple-score-v1', manifest: 'evals/g9i-manifest.json', protocol: 'docs/g9i-validation-protocol.md', results: 'evals/results/g9i' }
      : profile.id === 'g9k'
        ? { version: 'bankpilot-g9k-default-triple-score-v1', manifest: 'evals/g9k-manifest.json', protocol: 'docs/g9k-validation-protocol.md', results: 'evals/results/g9k' }
      : undefined;
  if (!expected || profile.runnerVersion !== expected.version || profile.manifestPath !== expected.manifest
    || profile.protocolPath !== expected.protocol || profile.resultsDir !== expected.results
    || profile.sourcePrefix !== profile.id || !profile.boundaries
    || profile.requestEvidence !== (profile.id === 'g9h' ? undefined : 'required')
    || !profile.evaluatorFiles.length || new Set(profile.evaluatorFiles).size !== profile.evaluatorFiles.length
    || !profile.evaluatorFiles.includes(profile.protocolPath)
    || !profile.evaluatorFiles.includes(`scripts/evaluate-${profile.id}.ts`)) throw new Error('EVALUATION_PROFILE_INVALID');
}
export type G9HCohortBinding = {
  datasetVersion: string; fixturePath: string; fixtureSha256: string; caseIds: string[]; caseCount: 36 | 12;
  positiveCount: number; domainCounts: G9Manifest['domainCounts']; templateInputsSha256: string;
  originalExpectedLabelsSha256: string; currentExpectedLabelsSha256: string;
  kindCounts?: G9CQualityManifest['kindCounts']; contractPath?: string; contractSha256?: string;
};
export type G9HManifest = {
  protocolVersion: string; frozenAt: string; blind: false;
  originalManifestPath: typeof G9H_ORIGINAL_MANIFEST_PATH; originalManifestSha256: string;
  qualityParentManifestPath: typeof G9H_QUALITY_PARENT_MANIFEST_PATH; qualityParentManifestSha256: string;
  sourceManifestPath: string; sourceManifestSha256: string;
  cohorts: { knownRegression: G9HCohortBinding; developmentSupplemental: G9HCohortBinding };
  provider: G9CProviderFingerprint;
  limits: typeof G9_LIMITS; protocolPath: string; protocolSha256: string;
  evaluatorHashes: Record<string,string>;
  candidateLineage?: { parentManifestPath: 'evals/g9i-manifest.json'; parentManifestSha256: string;
    g9jSnapshotPath: 'docs/evidence/2026-10-25-g9j-source-snapshot.json'; g9jSnapshotSha256: string };
};
type OriginalAndQuality = { original: G9Manifest; qualityParent: G9CQualityManifest; knownDataset: G9Dataset; qualityDataset: G9Dataset; originalManifestSha256: string; qualityParentManifestSha256: string };
export type G9HCaseRecord = G9CaseRecord & { currentExpectedHash: string; currentLabelsUnchanged: boolean; previousContractScore?: G9EScore; previousContractPassed: boolean; currentContractScore?: G9GScore; currentContractPassed: boolean };
type Plan = (input: PlannerInput, observer: ModelAttemptObserver, signal: AbortSignal, structuredObserver?: (event: Readonly<ModelStructuredOutputObservation>) => void, requestObserver?: ModelRequestObserver) => Promise<PlanResult>;
const sha256 = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
const fileHash = async (path: string) => sha256(await readFile(path));
const same = (left: unknown,right: unknown) => canonical(left) === canonical(right);
const hashLike = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const relativePath = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && !value.startsWith('/') && !value.includes('\\') && value.split('/').every(part => part && part !== '.' && part !== '..');
const timestamp = (value: string) => /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0,10) === value.slice(0,10);
const stageOf = (cohort: G9HCohort): G9HStage => cohort === 'known-regression' ? 'default-known' : 'default-quality';
const bindingOf = (manifest: G9HManifest,cohort: G9HCohort) => manifest.cohorts[cohort === 'known-regression' ? 'knownRegression' : 'developmentSupplemental'];
const requiredEarlier = (stage: G9HStage) => G9H_STAGES.slice(0,G9H_STAGES.indexOf(stage));
export async function hashG9HEvaluatorFiles(root = '.', profile: EvaluationRunnerProfile = G9H_PROFILE) {
  assertProfile(profile);
  return Object.fromEntries(await Promise.all(profile.evaluatorFiles.map(async path => [path,await fileHash(resolve(root,path))])));
}

export function buildG9HManifest(options: OriginalAndQuality & { frozenAt: string; sourceManifestPath: string; sourceManifestSha256: string; evaluatorHashes: Record<string,string>; provider: G9CProviderFingerprint; profile?: EvaluationRunnerProfile; candidateLineage?: G9HManifest['candidateLineage'] }): G9HManifest {
  const profile = options.profile ?? G9H_PROFILE;
  assertProfile(profile);
  const known = validateG9Dataset(options.knownDataset), quality = validateG9CQualityDataset(options.qualityDataset);
  const manifest: G9HManifest = { protocolVersion: profile.runnerVersion, frozenAt: options.frozenAt, blind: false,
    originalManifestPath: G9H_ORIGINAL_MANIFEST_PATH, originalManifestSha256: options.originalManifestSha256,
    qualityParentManifestPath: G9H_QUALITY_PARENT_MANIFEST_PATH, qualityParentManifestSha256: options.qualityParentManifestSha256,
    sourceManifestPath: options.sourceManifestPath, sourceManifestSha256: options.sourceManifestSha256,
    cohorts: {
      knownRegression: { datasetVersion: options.knownDataset.version, fixturePath: options.original.fixturePath, fixtureSha256: options.original.fixtureSha256,
        caseIds: known.caseIds, caseCount: 36, positiveCount: known.positiveCount, domainCounts: known.domainCounts,
        templateInputsSha256: digest(options.knownDataset.cases.map(item=>item.input)), originalExpectedLabelsSha256: digest(options.knownDataset.cases.map(item=>item.expected)),
        currentExpectedLabelsSha256: digest(options.knownDataset.cases.map(g9gExpected)) },
      developmentSupplemental: { datasetVersion: options.qualityDataset.version, fixturePath: options.qualityParent.fixturePath, fixtureSha256: options.qualityParent.fixtureSha256,
        caseIds: quality.caseIds, caseCount: 12, positiveCount: quality.positiveCount, domainCounts: quality.domainCounts, kindCounts: quality.kindCounts,
        templateInputsSha256: digest(options.qualityDataset.cases.map(item=>item.input)), originalExpectedLabelsSha256: digest(options.qualityDataset.cases.map(item=>item.expected)),
        currentExpectedLabelsSha256: digest(options.qualityDataset.cases.map(g9gExpected)),
        contractPath: G9C_QUALITY_CONTRACT_PATH, contractSha256: options.qualityParent.contractSha256 },
    }, provider: options.provider, limits: G9_LIMITS,
    protocolPath: profile.protocolPath, protocolSha256: options.evaluatorHashes[profile.protocolPath]!, evaluatorHashes: { ...options.evaluatorHashes },
    ...(profile.id === 'g9k' ? { candidateLineage: options.candidateLineage } : {}) };
  validateG9HManifestMetadata(manifest,options,options.evaluatorHashes,options.frozenAt,profile);
  return manifest;
}

export function validateG9HManifestMetadata(manifest: G9HManifest, inputs: OriginalAndQuality, evaluatorHashes: Record<string,string>, now = new Date().toISOString(), profile: EvaluationRunnerProfile = G9H_PROFILE) {
  assertProfile(profile);
  const known = validateG9Dataset(inputs.knownDataset), quality = validateG9CQualityDataset(inputs.qualityDataset);
  const expectedKnown = { datasetVersion: inputs.knownDataset.version, fixturePath: inputs.original.fixturePath, fixtureSha256: inputs.original.fixtureSha256,
    caseIds: known.caseIds,caseCount: 36,positiveCount: known.positiveCount,domainCounts: known.domainCounts,
    templateInputsSha256:digest(inputs.knownDataset.cases.map(item=>item.input)),originalExpectedLabelsSha256:digest(inputs.knownDataset.cases.map(item=>item.expected)),
    currentExpectedLabelsSha256:digest(inputs.knownDataset.cases.map(g9gExpected)) };
  const expectedQuality = { datasetVersion: inputs.qualityDataset.version,fixturePath: inputs.qualityParent.fixturePath,fixtureSha256: inputs.qualityParent.fixtureSha256,
    caseIds: quality.caseIds,caseCount: 12,positiveCount: quality.positiveCount,domainCounts: quality.domainCounts,kindCounts: quality.kindCounts,
    templateInputsSha256:digest(inputs.qualityDataset.cases.map(item=>item.input)),originalExpectedLabelsSha256:digest(inputs.qualityDataset.cases.map(item=>item.expected)),
    currentExpectedLabelsSha256:digest(inputs.qualityDataset.cases.map(g9gExpected)),
    contractPath:G9C_QUALITY_CONTRACT_PATH,contractSha256:inputs.qualityParent.contractSha256 };
  const provider = manifest.provider;
  if (manifest.protocolVersion !== profile.runnerVersion || manifest.blind !== false || !timestamp(manifest.frozenAt) || Date.parse(manifest.frozenAt) > Date.parse(now)
    || manifest.originalManifestPath !== G9H_ORIGINAL_MANIFEST_PATH || manifest.originalManifestSha256 !== inputs.originalManifestSha256 || !hashLike(manifest.originalManifestSha256)
    || manifest.qualityParentManifestPath !== G9H_QUALITY_PARENT_MANIFEST_PATH || manifest.qualityParentManifestSha256 !== inputs.qualityParentManifestSha256 || !hashLike(manifest.qualityParentManifestSha256)
    || inputs.qualityParent.parentManifestPath !== 'evals/g9c-manifest.json' || inputs.original.fixtureSha256 !== expectedKnown.fixtureSha256
    || inputs.qualityParent.fixturePath !== G9C_QUALITY_FIXTURE_PATH || !same(inputs.original.caseIds,known.caseIds) || !same(inputs.qualityParent.caseIds,quality.caseIds)
    || !same(manifest.cohorts?.knownRegression,expectedKnown) || !same(manifest.cohorts?.developmentSupplemental,expectedQuality)
    || !(new RegExp(`^evals/baselines/${profile.sourcePrefix}-[^/]+/source-manifest\\.json$`)).test(manifest.sourceManifestPath) || !relativePath(manifest.sourceManifestPath) || !hashLike(manifest.sourceManifestSha256)
    || !provider || !provider.model || !['tools','json_object'].includes(provider.outputMode)
    || !['omitted','enabled','disabled'].includes(provider.thinkingMode)
    || provider.reasoningEffort !== 'omitted'
    || !same(Object.keys(provider).sort(),['baseURLSha256','model','outputMode','reasoningEffort','thinkingMode'])
    || !hashLike(provider.baseURLSha256)
    || !same(manifest.limits,G9_LIMITS) || manifest.protocolPath !== profile.protocolPath || manifest.protocolSha256 !== evaluatorHashes[profile.protocolPath]
    || !same(manifest.evaluatorHashes,evaluatorHashes) || !same(Object.keys(evaluatorHashes).sort(),profile.evaluatorFiles)
    || Object.values(evaluatorHashes).some(value=>!hashLike(value))
    || (profile.id === 'g9k'
      ? !manifest.candidateLineage
        || !same(Object.keys(manifest.candidateLineage).sort(),['g9jSnapshotPath','g9jSnapshotSha256','parentManifestPath','parentManifestSha256'])
        || manifest.candidateLineage.parentManifestPath !== 'evals/g9i-manifest.json'
        || manifest.candidateLineage.g9jSnapshotPath !== 'docs/evidence/2026-10-25-g9j-source-snapshot.json'
        || !hashLike(manifest.candidateLineage.parentManifestSha256)||!hashLike(manifest.candidateLineage.g9jSnapshotSha256)
      : manifest.candidateLineage !== undefined)) throw new Error(profileCode(profile,'FROZEN_MANIFEST_MISMATCH'));
  for (const item of [...inputs.knownDataset.cases,...inputs.qualityDataset.cases]) resolveG9CaseInput(item,Date.parse(item.snapshotClock?.anchorIso ?? `${item.input.referenceDate}T00:00:00.000Z`));
  return { knownCount: 36,qualityCount: 12,knownCaseIds: known.caseIds,qualityCaseIds: quality.caseIds };
}

export async function verifyG9HFrozenFiles(manifest: G9HManifest, manifestHash: string, manifestPath = G9H_MANIFEST_PATH, root = '.', profile: EvaluationRunnerProfile = G9H_PROFILE) {
  assertProfile(profile);
  const at = (path: string) => resolve(root,path);
  if (await fileHash(at(manifestPath)) !== manifestHash || await fileHash(at(manifest.originalManifestPath)) !== manifest.originalManifestSha256
    || await fileHash(at(manifest.qualityParentManifestPath)) !== manifest.qualityParentManifestSha256
    || await fileHash(at(manifest.sourceManifestPath)) !== manifest.sourceManifestSha256
    || await fileHash(at(manifest.cohorts.knownRegression.fixturePath)) !== manifest.cohorts.knownRegression.fixtureSha256
    || await fileHash(at(manifest.cohorts.developmentSupplemental.fixturePath)) !== manifest.cohorts.developmentSupplemental.fixtureSha256
    || await fileHash(at(G9C_QUALITY_CONTRACT_PATH)) !== manifest.cohorts.developmentSupplemental.contractSha256
    || !same(await hashG9HEvaluatorFiles(root,profile),manifest.evaluatorHashes)) throw new Error(profileCode(profile,'FROZEN_FILE_DRIFT'));
  const parent = JSON.parse(await readFile(at(manifest.qualityParentManifestPath),'utf8')) as G9CQualityManifest;
  if (parent.parentManifestPath !== 'evals/g9c-manifest.json' || !hashLike(parent.parentManifestSha256)
    || await fileHash(at(parent.parentManifestPath)) !== parent.parentManifestSha256) throw new Error(profileCode(profile,'HISTORICAL_LINEAGE_DRIFT'));
  const historical = JSON.parse(await readFile(at(parent.parentManifestPath),'utf8')) as { originalManifestPath?:string; originalManifestSha256?:string; fixtureSha256?:string };
  if (historical.originalManifestPath !== manifest.originalManifestPath || historical.originalManifestSha256 !== manifest.originalManifestSha256
    || historical.fixtureSha256 !== manifest.cohorts.knownRegression.fixtureSha256) throw new Error(profileCode(profile,'HISTORICAL_LINEAGE_MISMATCH'));
  const source = JSON.parse(await readFile(at(manifest.sourceManifestPath),'utf8')) as { files?: { path:string; sha256:string }[] };
  if(profile.id === 'g9k') {
    const lineage=manifest.candidateLineage;
    if(!lineage||await fileHash(at(lineage.parentManifestPath))!==lineage.parentManifestSha256
      ||await fileHash(at(lineage.g9jSnapshotPath))!==lineage.g9jSnapshotSha256
      ||(source as typeof source & { previousManifest?: string }).previousManifest!==lineage.parentManifestPath)
      throw new Error(profileCode(profile,'CANDIDATE_LINEAGE_DRIFT'));
    const parent=JSON.parse(await readFile(at(lineage.parentManifestPath),'utf8')) as { protocolVersion?: string; provider?: G9CProviderFingerprint };
    const snapshot=JSON.parse(await readFile(at(lineage.g9jSnapshotPath),'utf8')) as { parentManifest?: string; parentSha256?: string;
      files?: { path:string; sha256:string }[]; copyDrift?: string[] };
    const products=(snapshot.files??[]).filter(file=>/^(apps|packages)\//.test(file.path)).sort((a,b)=>a.path.localeCompare(b.path));
    const frozenProducts=(source.files??[]).filter(file=>/^(apps|packages)\//.test(file.path)).map(file=>({path:file.path,sha256:file.sha256})).sort((a,b)=>a.path.localeCompare(b.path));
    if(parent.protocolVersion!=='bankpilot-g9i-default-triple-score-v1'||!same(parent.provider,manifest.provider)||snapshot.parentManifest!==lineage.parentManifestPath
      ||snapshot.parentSha256!==lineage.parentManifestSha256||!Array.isArray(snapshot.files)||snapshot.files.length!==310
      ||!same(snapshot.copyDrift,[])||products.length!==69||!same(products,frozenProducts))
      throw new Error(profileCode(profile,'CANDIDATE_LINEAGE_INVALID'));
  }
  if (!Array.isArray(source.files) || !source.files.length || source.files.some(file=>!relativePath(file?.path)||!hashLike(file?.sha256)) || new Set(source.files.map(file=>file.path)).size !== source.files.length) throw new Error(profileCode(profile,'SOURCE_MANIFEST_INVALID'));
  const paths = source.files.filter(file=>/^(apps|packages)\//.test(file.path)).map(file=>file.path).sort();
  const inventory = (await Promise.all(['apps','packages'].map(async directory=>(await g9ProductInventory(at(directory))).map(path=>path.slice(resolve(root).length+1))))).flat().sort();
  if (!same(paths,inventory)) throw new Error(profileCode(profile,'PRODUCT_INVENTORY_DRIFT'));
  if ((await Promise.all(source.files.map(async file=>await fileHash(at(file.path))===file.sha256))).some(match=>!match)) throw new Error(profileCode(profile,'FROZEN_SOURCE_DRIFT'));
}

export function validateG9HPriorReport(report: any, expected: { stage: G9HStage; manifest: G9HManifest; manifestHash: string; profile?: EvaluationRunnerProfile }) {
  const profile=expected.profile??G9H_PROFILE;
  assertProfile(profile);
  const cohort = expected.stage.endsWith('known') ? 'known-regression' : 'development-supplemental';
  const binding = bindingOf(expected.manifest,cohort);
  if (!report || report.protocolVersion !== profile.runnerVersion || report.stage !== expected.stage || report.condition !== 'default' || report.cohort !== cohort
    || report.manifestSha256 !== expected.manifestHash || report.sourceManifestSha256 !== expected.manifest.sourceManifestSha256
    || report.scoreVersion !== G9_SCORE_VERSION || report.previousScoreVersion !== G9E_SCORE_VERSION || report.currentScoreVersion !== G9G_SCORE_VERSION || report.currentLabelPolicyVersion !== G9G_LABEL_POLICY_VERSION
    || !same(report.provider,expected.manifest.provider) || !same(report.limits,expected.manifest.limits)
    || !same(report.caseIds,binding.caseIds) || report.fixtureSha256 !== binding.fixtureSha256
    || report.templateInputsSha256 !== binding.templateInputsSha256 || report.originalExpectedLabelsSha256 !== binding.originalExpectedLabelsSha256
    || report.currentExpectedLabelsSha256 !== binding.currentExpectedLabelsSha256
    || report.executionComplete !== true || report.validRun !== true || report.records?.length !== binding.caseCount
    || report.semanticTraceStatus !== 'complete' || report.billTraceStatus !== 'complete' || report.billTraceFailed !== false
    || (profile.id==='g9k'&&(!same(report.candidateLineage,expected.manifest.candidateLineage)
      ||report.requestTraceStatus!=='complete'||report.requestTraceFailed!==false||report.requestContractFailed!==false))
    || !report.attemptObservation || !report.observedAttempts?.complete
    || !same(report.records?.map((item: G9HCaseRecord)=>item.id),binding.caseIds)
    || report.records.some((item: G9HCaseRecord)=>item.evaluationValid!==true || item.labelsUnchanged!==true || item.currentLabelsUnchanged!==true
      || !hashLike(item.expectedHash) || !hashLike(item.currentExpectedHash) || item.score?.version !== G9_SCORE_VERSION && !!item.score
      || item.previousContractScore?.version !== G9E_SCORE_VERSION && !!item.previousContractScore
      || item.previousContractPassed !== (item.previousContractScore?.passed === true && !item.failure)
      || item.currentContractScore?.version !== G9G_SCORE_VERSION && !!item.currentContractScore
      || item.passed !== (item.score?.passed === true && !item.failure)
      || item.currentContractPassed !== (item.currentContractScore?.passed === true && !item.failure))) throw new Error(profileCode(profile,'PRIOR_STAGE_INVALID'));
}

/** Preserve the original G9 score and attach a separately versioned current contract. */
export function attachG9HCurrentScore(fixture: G9Dataset['cases'][number], original: G9CaseRecord, currentExpectedHash: string, profile: EvaluationRunnerProfile = G9H_PROFILE): G9HCaseRecord {
  const record=original as G9HCaseRecord;
  record.currentExpectedHash=currentExpectedHash;
  record.currentLabelsUnchanged=digest(g9gExpected(fixture))===currentExpectedHash;
  if(record.result && !record.failure) {
    const resolved=resolveG9CaseInput(fixture,Date.parse(record.startedAt)).input;
    record.previousContractScore=scoreG9E({...fixture,input:resolved},record.result);
    record.currentContractScore=scoreG9G({...fixture,input:resolved},record.result);
  }
  if(!record.currentLabelsUnchanged){record.evaluationValid=false;record.passed=false;record.errorCode=profileCode(profile,'CURRENT_LABELS_MUTATED');}
  record.previousContractPassed=record.evaluationValid&&!record.failure&&record.previousContractScore?.passed===true;
  record.currentContractPassed=record.evaluationValid&&!record.failure&&record.currentContractScore?.passed===true;
  return record;
}

async function durableLine(file: FileHandle,value: unknown) { await file.appendFile(JSON.stringify(value)+'\n'); await file.sync(); }
async function durableNew(path: string,contents: string) { const file=await open(path,'wx',0o600); try { await file.writeFile(contents);await file.sync(); } finally { await file.close(); } }
/** A single execution engine for both cohorts; injection is for offline calibration only. */
export async function executeG9HStage(options: { dataset:G9Dataset; manifest:G9HManifest; manifestHash:string; cohort:G9HCohort; config:OpenAICompatibleConfig; resultsDir:string; verifyFrozenFiles:()=>Promise<unknown>; priorReportPaths?:Partial<Record<G9HStage,string>>; semanticJsonl?:boolean; billJsonl?:boolean; plan?:Plan; signal?:AbortSignal; profile?:EvaluationRunnerProfile }) {
  const profile=options.profile??G9H_PROFILE;
  assertProfile(profile);
  const { dataset,manifest,manifestHash,cohort,config }=options, stage=stageOf(cohort), binding=bindingOf(manifest,cohort);
  if (!same(dataset.cases.map(item=>item.id),binding.caseIds) || dataset.version!==binding.datasetVersion || digest(dataset.cases.map(item=>item.input))!==binding.templateInputsSha256
    || digest(dataset.cases.map(item=>item.expected))!==binding.originalExpectedLabelsSha256
    || digest(dataset.cases.map(g9gExpected))!==binding.currentExpectedLabelsSha256
    || !same(g9cProviderFingerprint(config),manifest.provider)
    || !same(manifest.limits,G9_LIMITS) || manifest.protocolVersion!==profile.runnerVersion || manifest.protocolPath!==profile.protocolPath) throw new Error(profileCode(profile,'EXECUTION_CONTRACT_MISMATCH'));
  const priorHashes: Partial<Record<G9HStage,string>> = {};
  for (const earlier of requiredEarlier(stage)) {
    const path=options.priorReportPaths?.[earlier]; if (!path) throw new Error(profileCode(profile,'PRIOR_STAGE_REQUIRED'));
    const bytes=await readFile(path),priorReport=JSON.parse(bytes.toString());validateG9HPriorReport(priorReport,{ stage:earlier,manifest,manifestHash,profile });
    await verifyG9HPriorEvidence(priorReport,g9Dataset,path);
    if(profile.requestEvidence==='required') {
      try { await verifyG9IRequestPriorEvidence(priorReport,path); }
      catch(error) { if(profile.id==='g9i')throw error; throw new Error(profileCode(profile,'PRIOR_REQUEST_EVIDENCE_INVALID')); }
    }
    priorHashes[earlier]=sha256(bytes);
  }
  if(options.semanticJsonl !== true || options.billJsonl !== true) throw new Error(profileCode(profile,'STRUCTURED_TRACES_REQUIRED'));
  await options.verifyFrozenFiles();
  const startedAt=new Date().toISOString(),runId=`${startedAt.replace(/[:.]/g,'-')}-${randomUUID()}`,resultsDir=resolve(options.resultsDir);
  await mkdir(resultsDir,{ recursive:true });
  // A durable stage claim preserves its first attempt even if a process stops before report creation.
  await durableNew(resolve(resultsDir,`${manifestHash}-${stage}.first.json`),JSON.stringify({ stage,runId,startedAt,manifestSha256:manifestHash })+'\n');
  const runDir=resolve(resultsDir,`${stage}-${runId}`);await mkdir(runDir,{mode:0o700});
  const jsonPath=resolve(runDir,'report.json'),jsonlPath=resolve(runDir,'cases.jsonl'),mdPath=resolve(runDir,'report.md'),attemptsPath=resolve(runDir,'attempts.jsonl');
  const semanticPath=resolve(runDir,'semantic-extraction.jsonl');
  const billPath=resolve(runDir,'bill-domain-output.jsonl');
  const requestPath=profile.requestEvidence==='required'?resolve(runDir,'request-metadata.jsonl'):undefined;
  const file=await open(jsonlPath,'wx',0o600);
  let semanticFd: number|undefined, billFd: number|undefined, requestFd:number|undefined;
  try { semanticFd=openSync(semanticPath,'wx',0o600); billFd=openSync(billPath,'wx',0o600); if(requestPath)requestFd=openSync(requestPath,'wx',0o600); }
  catch(error) { if(semanticFd!==undefined)closeSync(semanticFd);if(billFd!==undefined)closeSync(billFd);await file.close();throw error; }
  let journal:Awaited<ReturnType<typeof createModelAttemptJournal>>|undefined;
  const records:G9HCaseRecord[]=[], stopController=new AbortController();let stopped=false,sourceDrift=false,semanticTraceFailed=false,billTraceFailed=false,requestTraceFailed=false,requestContractFailed=false,requestTraceCount=0,requestSchemaMissingCount=0,requestRepairFeedbackCount=0,executionError:string|undefined;
  const stop=()=>{stopped=true;stopController.abort();};process.once('SIGINT',stop);process.once('SIGTERM',stop);options.signal?.addEventListener('abort',stop,{once:true});if(options.signal?.aborted)stop();
  try {
    journal=await createModelAttemptJournal(attemptsPath);
    const protocol={ protocolVersion:profile.runnerVersion,contractVersion:G9_CONTRACT_VERSION,scoreVersion:G9_SCORE_VERSION,previousScoreVersion:G9E_SCORE_VERSION,currentScoreVersion:G9G_SCORE_VERSION,currentLabelPolicyVersion:G9G_LABEL_POLICY_VERSION,observationVersion:EVALUATION_OBSERVATION_VERSION,
      structuredOutputObservationVersion:MODEL_STRUCTURED_OUTPUT_OBSERVATION_VERSION,attemptProtocolVersion:MODEL_ATTEMPT_PROTOCOL_VERSION,attemptPersistenceTimeoutMs:MODEL_ATTEMPT_PERSIST_TIMEOUT_MS,
      ...(requestPath?{requestObservationVersion:MODEL_REQUEST_OBSERVATION_VERSION}:{}),
      stage,condition:'default',cohort,blind:false,knownRegression:cohort==='known-regression',implementationInformed:cohort==='development-supplemental',
      datasetVersion:dataset.version,caseIds:binding.caseIds,caseCount:binding.caseCount,positiveCount:binding.positiveCount,domainCounts:binding.domainCounts,
      templateInputsSha256:binding.templateInputsSha256,originalExpectedLabelsSha256:binding.originalExpectedLabelsSha256,currentExpectedLabelsSha256:binding.currentExpectedLabelsSha256,fixtureSha256:binding.fixtureSha256,
      limits:G9_LIMITS,topology:'production-parallel-review',manifestSha256:manifestHash,sourceManifestPath:manifest.sourceManifestPath,sourceManifestSha256:manifest.sourceManifestSha256,
      evaluatorHashes:manifest.evaluatorHashes,provider:manifest.provider,priorReportSha256:priorHashes,
      ...(profile.id==='g9k'?{candidateLineage:manifest.candidateLineage}:{}),
      worstCaseOutputPlan:createStageOutputPlan({domainStageCount:6,reviewerStageCount:1,maxAttempts:G9_LIMITS.maxAttempts}),
      boundaries:profile.boundaries };
    await durableLine(file,{type:'start',runId,startedAt,mode:'live',protocol,attemptsPath,journalId:journal.journalId,semanticPath,billPath,...(requestPath?{requestPath}:{})});
    console.log(JSON.stringify({status:'started',runId,stage,caseCount:binding.caseCount}));
    const plan:Plan=options.plan??((input,observer,signal,structuredObserver,requestObserver)=>createPlanner({semantic:true,provider:{...config,timeoutMs:G9_LIMITS.providerTimeoutMs,maxAttempts:G9_LIMITS.maxAttempts,maxStructureRepairs:G9_LIMITS.maxStructureRepairs,temperature:G9_LIMITS.temperature,signal,attemptObserver:observer,structuredOutputObserver:structuredObserver,...(requestObserver?{requestObserver}:{})}}).plan(input));
    try {
      for(const fixture of dataset.cases){
        if(stopped)break;try{await options.verifyFrozenFiles();}catch{sourceDrift=true;stopped=true;break;}
        const currentExpectedHash=digest(g9gExpected(fixture));
        let caseSemanticFailed=false,caseBillFailed=false,caseRequestFailed=false,caseRequestContractFailed=false;
        const tracedSemanticAttemptIds=new Set<string>(),tracedBillAttemptIds=new Set<string>();
        const tracedRequestAttemptIds=new Set<string>();
        const firstRequestByInvocation=new Map<string,ModelRequestObservation>();
        const requestObserver:ModelRequestObserver=async(event:ModelRequestObservation)=>{
          try {
            const observed=journal!.summary(records.length+1).confirmedAttempts.find(item=>item.start.attemptId===event.attemptId);
            const first=firstRequestByInvocation.get(event.invocationId);
            if(event.version!==MODEL_REQUEST_OBSERVATION_VERSION||!observed||tracedRequestAttemptIds.has(event.attemptId)
              ||observed.start.invocationId!==event.invocationId||observed.start.role!==event.role||observed.start.attempt!==event.attempt
              ||observed.start.requestMaxOutputTokens!==event.requestMaxOutputTokens||event.outputMode!==manifest.provider.outputMode
              ||event.schemaLocation!==(event.outputMode==='tools'?'tool':'system')
              ||typeof event.schemaIncluded!=='boolean'||typeof event.repairFeedbackIncluded!=='boolean'
              ||(event.attempt===1&&event.repairFeedbackIncluded)
              ||(first&&(first.schema.sha256!==event.schema.sha256||first.user.sha256!==event.user.sha256
                ||(event.repairFeedbackIncluded&&(first.system.sha256===event.system.sha256||first.body.sha256===event.body.sha256))))
              ||[event.body,event.system,event.user,event.schema].some(part=>!part||!hashLike(part.sha256)||!Number.isSafeInteger(part.bytes)||part.bytes<0
                ||!same(Object.keys(part).sort(),['bytes','sha256'])))
              throw new Error('G9I_REQUEST_OBSERVATION_INVALID');
            const row={type:'request_metadata',stage,caseId:fixture.id,caseSequence:records.length+1,fixtureSha256:binding.fixtureSha256,
              sourceManifestSha256:manifest.sourceManifestSha256,version:event.version,invocationId:event.invocationId,
              attemptId:event.attemptId,role:event.role,attempt:event.attempt,requestMaxOutputTokens:event.requestMaxOutputTokens,
              outputMode:event.outputMode,body:event.body,system:event.system,user:event.user,schema:event.schema,
              schemaLocation:event.schemaLocation,schemaIncluded:event.schemaIncluded,repairFeedbackIncluded:event.repairFeedbackIncluded};
            const bytes=Buffer.from(JSON.stringify(row)+'\n','utf8');
            for(let offset=0;offset<bytes.length;){const written=writeSync(requestFd!,bytes,offset,bytes.length-offset);if(written<=0)throw new Error('G9I_REQUEST_SHORT_WRITE');offset+=written;}
            fsyncSync(requestFd!);tracedRequestAttemptIds.add(event.attemptId);requestTraceCount++;
            if(!first)firstRequestByInvocation.set(event.invocationId,event);
            if(!event.schemaIncluded){requestSchemaMissingCount++;caseRequestContractFailed=true;requestContractFailed=true;}
            if(event.repairFeedbackIncluded)requestRepairFeedbackCount++;
          }catch{caseRequestFailed=true;requestTraceFailed=true;throw new Error('G9I_REQUEST_OBSERVATION_PERSIST_FAILED');}
        };
        const structuredObserver=(event:Readonly<ModelStructuredOutputObservation>)=>{
          if(event.role!=='semantic_intent'&&event.role!=='bills')return;
          const semantic=event.role==='semantic_intent';
          const traced=semantic?tracedSemanticAttemptIds:tracedBillAttemptIds;
          const fd=semantic?semanticFd!:billFd!;
          try {
            const outputText=event.outputText;
            if(outputText!==undefined&&typeof outputText!=='string')throw new Error('G9H_STRUCTURED_OUTPUT_INTEGRITY');
            const observed=journal!.summary(records.length+1).confirmedAttempts.find(item=>item.start.attemptId===event.attemptId&&item.start.role===event.role);
            if(event.version!==MODEL_STRUCTURED_OUTPUT_OBSERVATION_VERSION||event.toolName!==(semantic?'interpret_banking_intent':'submit_domain_proposal')||!event.attemptId||!observed?.end
              || traced.has(event.attemptId)||observed.start.attempt!==event.attempt||observed.end.status!==event.status
              || observed.end.errorCode!==event.errorCode)throw new Error('G9H_STRUCTURED_ATTEMPT_MISMATCH');
            if((outputText!==undefined||event.outputOmitted==='size_limit')
              && !(observed.end.httpStatus!==undefined&&observed.end.httpStatus>=200&&observed.end.httpStatus<300))throw new Error('G9H_STRUCTURED_RESPONSE_STATUS_MISMATCH');
            if(outputText!==undefined){
              if(event.outputOmitted!==undefined||Buffer.byteLength(outputText,'utf8')>MODEL_STRUCTURED_OUTPUT_MAX_BYTES
                || event.outputLength!==outputText.length||event.outputDigest!==sha256(outputText))throw new Error('G9H_STRUCTURED_OUTPUT_INTEGRITY');
            }else if(event.outputOmitted==='not_text'){
              if(event.outputLength!==undefined||event.outputDigest!==undefined)throw new Error('G9H_STRUCTURED_OUTPUT_INTEGRITY');
            }else if(event.outputOmitted==='size_limit'){
              if(!Number.isSafeInteger(event.outputLength)||event.outputLength!<0||!hashLike(event.outputDigest))throw new Error('G9H_STRUCTURED_OUTPUT_INTEGRITY');
            }else throw new Error('G9H_STRUCTURED_OUTPUT_INTEGRITY');
            const safe={type:semantic?'semantic_extraction':'bill_domain_output',version:event.version,stage,caseId:fixture.id,caseSequence:records.length+1,fixtureSha256:binding.fixtureSha256,sourceManifestSha256:manifest.sourceManifestSha256,
              role:event.role,toolName:event.toolName,attempt:event.attempt,attemptId:event.attemptId,status:event.status,
              ...(event.errorCode?{errorCode:event.errorCode}:{}),...(event.outputLength!==undefined?{outputLength:event.outputLength}:{}),
              ...(event.outputDigest?{outputDigest:event.outputDigest}:{}),...(outputText!==undefined?{outputText}:{}),...(event.outputOmitted?{outputOmitted:event.outputOmitted}:{})};
            const bytes=Buffer.from(JSON.stringify(safe)+'\n','utf8');
            for(let offset=0;offset<bytes.length;){const written=writeSync(fd,bytes,offset,bytes.length-offset);if(written<=0)throw new Error('G9H_STRUCTURED_SHORT_WRITE');offset+=written;}
            fsyncSync(fd);traced.add(event.attemptId);
          }catch{if(semantic){caseSemanticFailed=true;semanticTraceFailed=true;}else{caseBillFailed=true;billTraceFailed=true;}throw new Error('G9H_STRUCTURED_OBSERVATION_PERSIST_FAILED');}
        };
        const original=await evaluateG9Case(fixture,records.length+1,journal,(input,observer,signal)=>plan(input,observer,signal,structuredObserver,requestPath?requestObserver:undefined),{signal:stopController.signal});
        const record=attachG9HCurrentScore(fixture,original,currentExpectedHash,profile);
        try{await options.verifyFrozenFiles();}catch{sourceDrift=true;stopped=true;record.evaluationValid=false;record.passed=false;record.errorCode='G9H_FROZEN_FILE_DRIFT';}
        const caseAttempts=journal.summary(records.length+1).confirmedAttempts;
        const semanticAttempts=caseAttempts.filter(item=>item.start.role==='semantic_intent');
        const billAttempts=caseAttempts.filter(item=>item.start.role==='bills');
        if(!semanticAttempts.length||semanticAttempts.some(item=>!item.end||!tracedSemanticAttemptIds.has(item.start.attemptId))||tracedSemanticAttemptIds.size!==semanticAttempts.length){
          caseSemanticFailed=true;semanticTraceFailed=true;
        }
        if(billAttempts.some(item=>!item.end||!tracedBillAttemptIds.has(item.start.attemptId))||tracedBillAttemptIds.size!==billAttempts.length){
          caseBillFailed=true;billTraceFailed=true;
        }
        if(requestPath){
          const sent=caseAttempts.filter(item=>item.end?.requestStarted===true);
          const preparedNotSent=caseAttempts.filter(item=>item.end?.requestStarted===false
            &&['MODEL_TIMEOUT','MODEL_DEADLINE_EXCEEDED'].includes(item.end.errorCode??''));
          const allowed=new Set([...sent,...preparedNotSent].map(item=>item.start.attemptId));
          if(sent.some(item=>!tracedRequestAttemptIds.has(item.start.attemptId))
            ||[...tracedRequestAttemptIds].some(id=>!allowed.has(id))){caseRequestFailed=true;requestTraceFailed=true;}
        }
        if(caseSemanticFailed||caseBillFailed){record.evaluationValid=false;record.passed=false;record.errorCode=caseSemanticFailed?'G9H_SEMANTIC_TRACE_INCOMPLETE':'G9H_BILL_TRACE_INCOMPLETE';}
        if(caseRequestFailed){record.evaluationValid=false;record.passed=false;record.errorCode=profileCode(profile,'REQUEST_TRACE_INCOMPLETE');}
        if(caseRequestContractFailed){record.evaluationValid=false;record.passed=false;record.errorCode=profileCode(profile,'REQUEST_SCHEMA_MISSING');}
        record.previousContractPassed=record.evaluationValid&&!record.failure&&record.previousContractScore?.passed===true;
        record.currentContractPassed=record.evaluationValid&&!record.failure&&record.currentContractScore?.passed===true;
        records.push(record);await durableLine(file,{type:'case',...record});
        console.log(JSON.stringify({sequence:record.sequence,id:record.id,status:record.failure?'unavailable':record.currentContractPassed?'current-passed':'current-failed',durationMs:record.durationMs}));
        if(caseSemanticFailed||caseBillFailed||caseRequestFailed||caseRequestContractFailed) { stopped=true;break; }
      }
    }catch{stopped=true;executionError='G9H_EXECUTION_INTERRUPTED';stopController.abort();}
    await journal.close().catch(()=>{});try{await options.verifyFrozenFiles();}catch{sourceDrift=true;}
    const attemptObservation=journal.summary(),observedAttempts=summarizeEvaluationObservation(attemptObservation,{mode:'live',maxOutputTokens:G9_LIMITS.totalOutputTokenCeilingPerCase}),observedCases=summarizeEvaluationCases(records),scoreSummary=summarizeG9Scores(records,binding.caseCount);
    // The historical summarizer reads score fields but never its version;
    // keep the current score object and denominator separate in the report.
    const previousScoreSummary=summarizeG9Scores(records.map(record=>({...record,score:record.previousContractScore,passed:record.previousContractPassed}) as unknown as G9CaseRecord),binding.caseCount);
    const currentScoreSummary=summarizeG9Scores(records.map(record=>({...record,score:record.currentContractScore,passed:record.currentContractPassed}) as unknown as G9CaseRecord),binding.caseCount);
    const executionComplete=records.length===binding.caseCount;
    const semanticTraceStatus=!semanticTraceFailed&&executionComplete?'complete':'incomplete';
    const billTraceStatus=!billTraceFailed&&executionComplete?'complete':'incomplete';
    const requestTraceStatus=requestPath&&(!requestTraceFailed&&executionComplete?'complete':'incomplete');
    const requestMetadataSha256=requestPath?await fileHash(requestPath):undefined;
    const requestSentCount=attemptObservation.confirmedAttempts.filter(item=>item.end?.requestStarted===true).length;
    const requestPreparedNotSentCount=requestTraceCount-requestSentCount;
    const report={runId,startedAt,finishedAt:new Date().toISOString(),mode:'live',...protocol,executionComplete,stopped,sourceDrift,semanticTraceFailed,semanticTraceStatus,billTraceFailed,billTraceStatus,
      ...(requestPath?{requestTraceFailed,requestTraceStatus,requestContractFailed,requestPath,requestMetadataSha256,
        requestObservationSummary:{capturedAttempts:requestTraceCount,sentAttempts:requestSentCount,preparedNotSent:requestPreparedNotSentCount,
          schemaMissing:requestSchemaMissingCount,repairFeedbackIncluded:requestRepairFeedbackCount}}:{}),
      ...(executionError?{executionError}:{}),validRun:executionComplete&&!stopped&&!sourceDrift&&!semanticTraceFailed&&!billTraceFailed&&!requestTraceFailed&&!requestContractFailed&&!executionError&&records.every(record=>record.evaluationValid)&&observedCases.complete&&observedAttempts.complete,
      scoreSummary,previousScoreSummary,currentScoreSummary,observedCases,observedAttempts,attemptObservation,records,jsonPath,jsonlPath,attemptsPath,semanticPath,billPath};
    await durableLine(file,{type:'finish',finishedAt:report.finishedAt,executionComplete,stopped,sourceDrift,semanticTraceFailed,billTraceFailed,billTraceStatus,...(requestPath?{requestTraceFailed,requestTraceStatus,requestContractFailed}:{}),validRun:report.validRun,scoreSummary,previousScoreSummary,currentScoreSummary});
    await durableNew(jsonPath,JSON.stringify(report,null,2));
    await durableNew(mdPath,[`# ${profile.id.toUpperCase()} ${stage}`,'',`Attempted ${scoreSummary.attemptedCases}/${binding.caseCount}; original G9 passed ${scoreSummary.passedCases}/${binding.caseCount}; previous G9E passed ${previousScoreSummary.passedCases}/${binding.caseCount}; current contract passed ${currentScoreSummary.passedCases}/${binding.caseCount}; valid ${report.validRun}.`,
      `Manifest ${manifestHash}; source ${manifest.sourceManifestSha256}; provider ${JSON.stringify(manifest.provider)}.`,
      `Original assessed ${scoreSummary.businessAssessedCases}; unavailable ${scoreSummary.businessUnavailableCases}; unscored ${scoreSummary.businessUnscoredCases}. Current assessed ${currentScoreSummary.businessAssessedCases}; unavailable ${currentScoreSummary.businessUnavailableCases}; unscored ${currentScoreSummary.businessUnscoredCases}.`,
      protocol.boundaries,'','| # | case | original passed | previous G9E passed | current passed | original failures | current failures |','|---:|---|---|---|---|---|---|',...records.map(record=>`| ${record.sequence} | ${record.id} | ${record.passed} | ${record.previousContractPassed} | ${record.currentContractPassed} | ${(record.score?.failures??[]).join(', ').replaceAll('|','/')} | ${[...(record.currentContractScore?.failures??[]),...(record.errorCode?[record.errorCode]:[])].join(', ').replaceAll('|','/')} |`)].join('\n'));
    console.log(JSON.stringify({status:'finished',runId,stage,validRun:report.validRun,attemptedCases:records.length,plannedCases:binding.caseCount,jsonPath,jsonlPath,attemptsPath,semanticPath,billPath}));
    return report;
  }finally{process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);options.signal?.removeEventListener('abort',stop);await journal?.close().catch(()=>{});await file.close();if(semanticFd!==undefined)closeSync(semanticFd);if(billFd!==undefined)closeSync(billFd);if(requestFd!==undefined)closeSync(requestFd);}
}

export async function runEvaluationWithProfile(args: string[], profile: EvaluationRunnerProfile = G9H_PROFILE) {
  assertProfile(profile);
  const flags=new Set(['--preflight','--semantic-jsonl','--bill-jsonl']),values=new Set(['--mode','--cohort','--manifest','--prior-default-known']),parsed=new Map<string,string|true>();
  for(let i=0;i<args.length;i++){const arg=args[i]!;if(parsed.has(arg)||(!flags.has(arg)&&!values.has(arg)))throw new Error(profileCode(profile,'UNSUPPORTED_OR_DUPLICATE_OPTION'));if(flags.has(arg))parsed.set(arg,true);else{const value=args[++i];if(!value||value.startsWith('--'))throw new Error(profileCode(profile,'OPTION_VALUE_REQUIRED'));parsed.set(arg,value);}}
  const preflight=parsed.has('--preflight');if(preflight&&(parsed.has('--mode')||parsed.has('--cohort')||parsed.has('--semantic-jsonl')||parsed.has('--bill-jsonl')||parsed.has('--prior-default-known')))throw new Error(profileCode(profile,'PREFLIGHT_HAS_NO_EXECUTION_MODE'));
  if(!preflight&&(parsed.get('--mode')!=='live'||!['known-regression','development-supplemental'].includes(parsed.get('--cohort') as string)))throw new Error(profileCode(profile,'EXPLICIT_STAGE_REQUIRED'));
  if(!preflight&&(!parsed.has('--semantic-jsonl')||!parsed.has('--bill-jsonl')))throw new Error(profileCode(profile,'STRUCTURED_TRACES_REQUIRED'));
  const manifestPath=resolve(parsed.get('--manifest') as string??profile.manifestPath),bytes=await readFile(manifestPath),manifestHash=sha256(bytes),manifest=JSON.parse(bytes.toString()) as G9HManifest;
  if(manifest.originalManifestPath!==G9H_ORIGINAL_MANIFEST_PATH||manifest.qualityParentManifestPath!==G9H_QUALITY_PARENT_MANIFEST_PATH
    || manifest.cohorts?.knownRegression?.fixturePath!=='evals/g9-holdout-fixtures.ts'||manifest.cohorts?.developmentSupplemental?.fixturePath!==G9C_QUALITY_FIXTURE_PATH)throw new Error(profileCode(profile,'MANIFEST_PATH_INVALID'));
  const originalBytes=await readFile(manifest.originalManifestPath),qualityParentBytes=await readFile(manifest.qualityParentManifestPath);
  const original=JSON.parse(originalBytes.toString()) as G9Manifest,qualityParent=JSON.parse(qualityParentBytes.toString()) as G9CQualityManifest;
  if(sha256(originalBytes)!==manifest.originalManifestSha256||sha256(qualityParentBytes)!==manifest.qualityParentManifestSha256)throw new Error(profileCode(profile,'PARENT_BINDING_MISMATCH'));
  const knownDataset=(await import(pathToFileURL(resolve(manifest.cohorts.knownRegression.fixturePath)).href)).g9Dataset as G9Dataset;
  const qualityDataset=(await import(pathToFileURL(resolve(manifest.cohorts.developmentSupplemental.fixturePath)).href)).g9cQualityDataset as G9Dataset;
  const inputs={original,qualityParent,knownDataset,qualityDataset,originalManifestSha256:sha256(originalBytes),qualityParentManifestSha256:sha256(qualityParentBytes)};
  const metadata=validateG9HManifestMetadata(manifest,inputs,await hashG9HEvaluatorFiles('.',profile),new Date().toISOString(),profile);await verifyG9HFrozenFiles(manifest,manifestHash,manifestPath,'.',profile);
  if(preflight){console.log(JSON.stringify({status:'preflight-passed',manifestSha256:manifestHash,...metadata,stages:G9H_STAGES}));return undefined;}
  const cohort=parsed.get('--cohort') as G9HCohort,config=providerFromEnv();if(!config)throw new Error(profileCode(profile,'EXPLICIT_PROVIDER_REQUIRED'));
  if(!same(g9cProviderFingerprint(config),manifest.provider))throw new Error(profileCode(profile,'FROZEN_PROVIDER_MISMATCH'));
  const priorReportPaths:Partial<Record<G9HStage,string>>={};const prior=parsed.get('--prior-default-known');if(typeof prior==='string')priorReportPaths['default-known']=prior;
  return executeG9HStage({dataset:cohort==='known-regression'?knownDataset:qualityDataset,manifest,manifestHash,cohort,config,
    resultsDir:profile.resultsDir,priorReportPaths,semanticJsonl:parsed.has('--semantic-jsonl'),billJsonl:parsed.has('--bill-jsonl'),profile,
    verifyFrozenFiles:()=>verifyG9HFrozenFiles(manifest,manifestHash,manifestPath,'.',profile)});
}
export async function runG9H(args=process.argv.slice(2)) { return runEvaluationWithProfile(args,G9H_PROFILE); }
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)runG9H().then(report=>{if(report&&!report.validRun)process.exitCode=1;}).catch(()=>{console.error('G9H configuration or execution failed; case content and credentials remain sealed.');process.exitCode=1;});
