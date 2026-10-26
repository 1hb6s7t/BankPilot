import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, type FileHandle } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createPlanner, normalizeBaseURL, providerFromEnv, type OpenAICompatibleConfig } from '../packages/agents/src/index';
import { createModelAttemptJournal } from '../packages/agents/src/attempt-journal';
import { MODEL_ATTEMPT_PROTOCOL_VERSION, MODEL_ATTEMPT_PERSIST_TIMEOUT_MS, type ModelAttemptObserver } from '../packages/agents/src/provider';
import { createStageOutputPlan } from '../packages/agents/src/budget';
import type { PlannerInput, PlanResult } from '../packages/contracts/src/index';
import { canonical, digest } from '../evals/ablation-score';
import { G9_CONTRACT_VERSION, type G9Dataset, type G9Manifest } from '../evals/g9-contract';
import { G9_SCORE_VERSION } from '../evals/g9-score';
import { evaluateG9Case, G9_EVALUATOR_FILES, G9_LIMITS, g9ProductInventory, resolveG9CaseInput, summarizeG9Scores, validateG9ManifestMetadata, type G9CaseRecord } from './evaluate-g9';
import { EVALUATION_OBSERVATION_VERSION, summarizeEvaluationCases, summarizeEvaluationObservation } from './evaluation-observation';

export const G9C_RUNNER_VERSION = 'bankpilot-g9c-known-regression-v1';
export const G9C_PROTOCOL_PATH = 'docs/g9c-validation-protocol.md';
export const G9C_ORIGINAL_MANIFEST_PATH = 'evals/g9-manifest.json';
export const G9C_PARENT_MANIFEST_PATH = 'evals/g9b-manifest.json';
/** The reused evaluator and observation dependencies are frozen alongside the new orchestration. Product imports are additionally covered by the complete source inventory. */
export const G9C_EVALUATOR_FILES = [...G9_EVALUATOR_FILES, 'scripts/evaluate-g9c.ts', 'tests/g9c-regression-runner.test.ts', G9C_PROTOCOL_PATH,
  'packages/agents/src/attempt-journal.ts', 'packages/agents/src/provider.ts', 'packages/agents/src/budget.ts', 'packages/agents/src/planning-failures.ts',
  'packages/agents/src/index.ts', 'packages/contracts/src/index.ts', 'packages/contracts/src/management.ts', 'packages/contracts/src/investment.ts',
  'packages/contracts/src/goals.ts', 'packages/contracts/src/preparations.ts', 'package.json', 'pnpm-lock.yaml'] as const;
export type G9CProviderFingerprint = { model: string; outputMode: 'tools' | 'json_object'; baseURLSha256: string; thinkingMode: 'omitted' | 'enabled' | 'disabled'; reasoningEffort: 'omitted' | 'none' | 'low' | 'high' | 'max' };
export type G9CManifest = {
  protocolVersion: typeof G9C_RUNNER_VERSION; cohort: 'known-regression'; frozenAt: string;
  originalManifestPath: typeof G9C_ORIGINAL_MANIFEST_PATH; originalManifestSha256: string;
  /** Provenance only: current mutable product/provider files are never checked against this historical manifest. */
  parentManifest?: { path: typeof G9C_PARENT_MANIFEST_PATH; sha256: string };
  datasetVersion: string; fixturePath: string; fixtureSha256: string; caseIds: string[]; caseCount: 36;
  positiveCount: number; domainCounts: G9Manifest['domainCounts']; sourceManifestPath: string; sourceManifestSha256: string;
  evaluatorHashes: Record<string, string>; protocolPath: typeof G9C_PROTOCOL_PATH; protocolSha256: string;
  provider: G9CProviderFingerprint; limits: typeof G9_LIMITS;
};
type SourceManifest = { files: { path: string; sha256: string }[] };
const sha256 = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
const fileHash = async (path: string) => sha256(await readFile(path));
const isHash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const relativePath = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && !value.startsWith('/') && !value.includes('\\') && value.split('/').every(part => part !== '' && part !== '.' && part !== '..');
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
export function g9cProviderFingerprint(config: OpenAICompatibleConfig): G9CProviderFingerprint {
  if (!config.model || (config.outputMode !== undefined && !['tools','json_object'].includes(config.outputMode)) || (config.thinkingMode !== undefined && !['enabled','disabled'].includes(config.thinkingMode)) || (config.reasoningEffort !== undefined && !['none','low','high','max'].includes(config.reasoningEffort))) throw new Error('G9C_PROVIDER_CONFIG_INVALID');
  return { model: config.model, outputMode: config.outputMode ?? 'tools', baseURLSha256: sha256(normalizeBaseURL(config.baseURL)), thinkingMode: config.thinkingMode ?? 'omitted', reasoningEffort: config.reasoningEffort ?? 'omitted' };
}
export async function hashG9CEvaluatorFiles(root = '.') { return Object.fromEntries(await Promise.all(G9C_EVALUATOR_FILES.map(async path => [path, await fileHash(resolve(root,path))]))); }
/** Bind the already exposed original labels, order and scoring; no re-authoring or subset selection is available. */
export function validateG9CManifestMetadata(manifest: G9CManifest, original: G9Manifest, dataset: G9Dataset, originalManifestSha256: string, fixtureSha256: string, evaluatorHashes: Record<string,string>, now = new Date().toISOString()) {
  const originalHashes = Object.fromEntries(G9_EVALUATOR_FILES.map(path => [path,evaluatorHashes[path]]));
  const metadata = validateG9ManifestMetadata(original,dataset,fixtureSha256,originalHashes,now);
  const frozen = Date.parse(manifest.frozenAt);
  if (manifest.protocolVersion !== G9C_RUNNER_VERSION || manifest.cohort !== 'known-regression' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(manifest.frozenAt) || !Number.isFinite(frozen) || new Date(frozen).toISOString().slice(0,10) !== manifest.frozenAt.slice(0,10) || frozen < Date.parse(original.frozenAt) || frozen > Date.parse(now)
    || manifest.originalManifestPath !== G9C_ORIGINAL_MANIFEST_PATH || !isHash(originalManifestSha256) || manifest.originalManifestSha256 !== originalManifestSha256
    || (manifest.parentManifest !== undefined && (manifest.parentManifest?.path !== G9C_PARENT_MANIFEST_PATH || !isHash(manifest.parentManifest.sha256) || !same(Object.keys(manifest.parentManifest).sort(),['path','sha256'])))
    || manifest.fixturePath !== original.fixturePath || !relativePath(manifest.fixturePath) || manifest.fixtureSha256 !== fixtureSha256 || manifest.datasetVersion !== dataset.version
    || manifest.caseCount !== 36 || !same(manifest.caseIds,original.caseIds) || !same(manifest.caseIds,metadata.caseIds) || manifest.positiveCount !== metadata.positiveCount || !same(manifest.domainCounts,metadata.domainCounts)
    || !/^evals\/baselines\/g9c-[^/]+\/source-manifest\.json$/.test(manifest.sourceManifestPath) || !relativePath(manifest.sourceManifestPath) || !isHash(manifest.sourceManifestSha256)
    || !same(manifest.evaluatorHashes,evaluatorHashes) || !same(Object.keys(evaluatorHashes).sort(),[...G9C_EVALUATOR_FILES].sort()) || Object.values(evaluatorHashes).some(hash => !isHash(hash))
    || manifest.protocolPath !== G9C_PROTOCOL_PATH || manifest.protocolSha256 !== evaluatorHashes[G9C_PROTOCOL_PATH] || !same(manifest.limits,G9_LIMITS)
    || !manifest.provider?.model || !['tools','json_object'].includes(manifest.provider.outputMode) || !['omitted','enabled','disabled'].includes(manifest.provider.thinkingMode) || !['omitted','none','low','high','max'].includes(manifest.provider.reasoningEffort) || !isHash(manifest.provider.baseURLSha256)
    || !same(Object.keys(manifest.provider).sort(),['baseURLSha256','model','outputMode','reasoningEffort','thinkingMode'])) throw new Error('G9C_FROZEN_MANIFEST_MISMATCH');
  for (const fixture of dataset.cases) resolveG9CaseInput(fixture,Date.parse(fixture.snapshotClock?.anchorIso ?? `${fixture.input.referenceDate}T00:00:00.000Z`));
  return metadata;
}
export async function verifyG9CCandidateSource(manifest: Pick<G9CManifest,'sourceManifestPath'|'sourceManifestSha256'>, root = '.') {
  if (!/^evals\/baselines\/g9c-[^/]+\/source-manifest\.json$/.test(manifest.sourceManifestPath) || !relativePath(manifest.sourceManifestPath) || await fileHash(resolve(root,manifest.sourceManifestPath)) !== manifest.sourceManifestSha256) throw new Error('G9C_FROZEN_SOURCE_MANIFEST_DRIFT');
  const source = JSON.parse(await readFile(resolve(root,manifest.sourceManifestPath),'utf8')) as SourceManifest;
  if (!Array.isArray(source.files) || source.files.length === 0 || source.files.some(file => !relativePath(file?.path) || !isHash(file?.sha256)) || new Set(source.files.map(file => file.path)).size !== source.files.length) throw new Error('G9C_SOURCE_MANIFEST_INVALID');
  const productPaths = source.files.filter(file => /^(apps|packages)\//.test(file.path)).map(file => file.path).sort();
  const inventory = (await Promise.all(['apps','packages'].map(async directory => (await g9ProductInventory(resolve(root,directory))).map(path => path.slice(resolve(root).length + 1))))).flat().sort();
  if (!same(productPaths,inventory)) throw new Error('G9C_PRODUCT_INVENTORY_DRIFT');
  if ((await Promise.all(source.files.map(async file => await fileHash(resolve(root,file.path)) === file.sha256))).some(match => !match)) throw new Error('G9C_FROZEN_SOURCE_DRIFT');
}
export async function verifyG9CFrozenFiles(manifest: G9CManifest, expectedManifestHash: string, manifestPath: string, root = '.') {
  if (await fileHash(resolve(root,manifestPath)) !== expectedManifestHash || await fileHash(resolve(root,manifest.originalManifestPath)) !== manifest.originalManifestSha256 || await fileHash(resolve(root,manifest.fixturePath)) !== manifest.fixtureSha256 || await fileHash(resolve(root,manifest.protocolPath)) !== manifest.protocolSha256 || !same(await hashG9CEvaluatorFiles(root),manifest.evaluatorHashes)) throw new Error('G9C_FROZEN_FILE_DRIFT');
  const original = JSON.parse(await readFile(resolve(root,manifest.originalManifestPath),'utf8')) as G9Manifest;
  if (await fileHash(resolve(root,original.sourceManifestPath)) !== original.sourceManifestSha256 || await fileHash(resolve(root,original.authorReview.reviewPath)) !== original.authorReview.reviewSha256) throw new Error('G9C_ORIGINAL_ARTIFACT_DRIFT');
  if (manifest.parentManifest) {
    if (manifest.parentManifest.path !== G9C_PARENT_MANIFEST_PATH || !isHash(manifest.parentManifest.sha256) || await fileHash(resolve(root,manifest.parentManifest.path)) !== manifest.parentManifest.sha256) throw new Error('G9C_PARENT_MANIFEST_DRIFT');
    const parent = JSON.parse(await readFile(resolve(root,manifest.parentManifest.path),'utf8')) as { originalManifestPath?: string; originalManifestSha256?: string; fixtureSha256?: string };
    if (parent.originalManifestPath !== manifest.originalManifestPath || parent.originalManifestSha256 !== manifest.originalManifestSha256 || parent.fixtureSha256 !== manifest.fixtureSha256) throw new Error('G9C_PARENT_LINEAGE_MISMATCH');
  }
  await verifyG9CCandidateSource(manifest,root);
}
async function durableLine(file: FileHandle, value: unknown) { await file.appendFile(JSON.stringify(value) + '\n'); await file.sync(); }
async function durableNewFile(path: string, contents: string) { const file = await open(path,'wx',0o600); try { await file.writeFile(contents); await file.sync(); } finally { await file.close(); } }
type Plan = (input: PlannerInput, observer: ModelAttemptObserver, signal: AbortSignal) => Promise<PlanResult>;
/** Dependency injection is limited to offline orchestration calibration. The CLI always verifies frozen files and uses the real production planner. */
export async function executeG9CKnownRegression(options: { dataset: G9Dataset; manifest: G9CManifest; manifestHash: string; config: OpenAICompatibleConfig; resultsDir: string; verifyFrozenFiles: () => Promise<unknown>; plan?: Plan; signal?: AbortSignal }) {
  const { dataset,manifest,manifestHash,config } = options;
  if (dataset.cases.length !== 36 || !same(dataset.cases.map(item => item.id),manifest.caseIds) || manifest.cohort !== 'known-regression' || !same(manifest.limits,G9_LIMITS) || !same(g9cProviderFingerprint(config),manifest.provider)) throw new Error('G9C_EXECUTION_CONTRACT_MISMATCH');
  await options.verifyFrozenFiles();
  const startedAt = new Date().toISOString(), runId = `${startedAt.replace(/[:.]/g,'-')}-${randomUUID()}`;
  const resultsDir = resolve(options.resultsDir); await mkdir(resultsDir,{ recursive: true });
  const runDir = resolve(resultsDir,runId); await mkdir(runDir,{ mode: 0o700 });
  const jsonPath = resolve(runDir,'report.json'), jsonlPath = resolve(runDir,'cases.jsonl'), mdPath = resolve(runDir,'report.md'), attemptsPath = resolve(runDir,'attempts.jsonl');
  const protocol = { protocolVersion: G9C_RUNNER_VERSION, contractVersion: G9_CONTRACT_VERSION, scoreVersion: G9_SCORE_VERSION, observationVersion: EVALUATION_OBSERVATION_VERSION,
    attemptProtocolVersion: MODEL_ATTEMPT_PROTOCOL_VERSION, attemptPersistenceTimeoutMs: MODEL_ATTEMPT_PERSIST_TIMEOUT_MS,
    cohort: 'known-regression' as const, knownRegression: true, datasetVersion: dataset.version, caseCount: 36, caseIds: manifest.caseIds,
    positiveCount: manifest.positiveCount, domainCounts: manifest.domainCounts, templateInputsSha256: digest(dataset.cases.map(item => item.input)), expectedLabelsSha256: digest(dataset.cases.map(item => item.expected)), ...G9_LIMITS, topology: 'production-parallel-review',
    manifestSha256: manifestHash, originalManifestSha256: manifest.originalManifestSha256, ...(manifest.parentManifest ? { parentManifest: manifest.parentManifest } : {}), fixtureSha256: manifest.fixtureSha256, sourceManifestPath: manifest.sourceManifestPath, sourceManifestSha256: manifest.sourceManifestSha256,
    evaluatorHashes: manifest.evaluatorHashes, protocolPath: manifest.protocolPath, protocolSha256: manifest.protocolSha256,
    worstCaseOutputPlan: createStageOutputPlan({ domainStageCount: 6, reviewerStageCount: 1, maxAttempts: G9_LIMITS.maxAttempts }),
    boundaries: 'Known-regression replay of all 36 already exposed G9 cases, preserving original labels, score and snapshot time binding. Planning proposals only. External cases sequential; production domain parallelism retained. Dispatch intent is fsynced before HTTP. Unknown receipt and missing usage remain unknown. No fallback, case selection or whole-run retry. This report establishes no unseen or first-run result.' };
  const file = await open(jsonlPath,'wx',0o600);
  let journal: Awaited<ReturnType<typeof createModelAttemptJournal>> | undefined;
  const records: G9CaseRecord[] = [], stopController = new AbortController(); let stopped = false, sourceDrift = false, executionError: string | undefined;
  const stop = () => { stopped = true; stopController.abort(); };
  process.once('SIGINT',stop); process.once('SIGTERM',stop); options.signal?.addEventListener('abort',stop,{ once: true }); if (options.signal?.aborted) stop();
  try {
    journal = await createModelAttemptJournal(attemptsPath);
    await durableLine(file,{ type: 'start',runId,startedAt,mode: 'live',protocol,provider: manifest.provider,attemptsPath,journalId: journal.journalId });
    console.log(JSON.stringify({ status: 'started',runId,cohort: protocol.cohort,caseCount: 36 }));
    const plan: Plan = options.plan ?? ((input,observer,signal) => createPlanner({ semantic: true,provider: { ...config,timeoutMs: G9_LIMITS.providerTimeoutMs,maxAttempts: G9_LIMITS.maxAttempts,maxStructureRepairs: G9_LIMITS.maxStructureRepairs,temperature: G9_LIMITS.temperature,signal,attemptObserver: observer } }).plan(input));
    try {
      for (const fixture of dataset.cases) {
        if (stopped) break;
        try { await options.verifyFrozenFiles(); } catch { sourceDrift = true; stopped = true; break; }
        if (stopped) break;
        const record = await evaluateG9Case(fixture,records.length + 1,journal,plan,{ signal: stopController.signal });
        try { await options.verifyFrozenFiles(); } catch { sourceDrift = true; stopped = true; record.evaluationValid = false; record.passed = false; record.errorCode = 'G9C_FROZEN_FILE_DRIFT'; }
        records.push(record); await durableLine(file,{ type: 'case',...record });
        console.log(JSON.stringify({ sequence: record.sequence,id: record.id,status: record.failure ? 'unavailable' : record.passed ? 'passed' : 'failed',durationMs: record.durationMs }));
      }
    } catch { stopped = true; executionError = 'G9C_EXECUTION_INTERRUPTED'; stopController.abort(); }
    await journal.close().catch(() => {});
    try { await options.verifyFrozenFiles(); } catch { sourceDrift = true; }
    const attemptObservation = journal.summary(), observedAttempts = summarizeEvaluationObservation(attemptObservation,{ mode: 'live',maxOutputTokens: G9_LIMITS.totalOutputTokenCeilingPerCase }), observedCases = summarizeEvaluationCases(records), scoreSummary = summarizeG9Scores(records,36);
    const executionComplete = records.length === 36;
    const report = { runId,startedAt,finishedAt: new Date().toISOString(),mode: 'live',...protocol,provider: manifest.provider,executionComplete,stopped,sourceDrift,...(executionError ? { executionError } : {}),
      validRun: executionComplete && !stopped && !sourceDrift && !executionError && records.every(record => record.evaluationValid) && observedCases.complete && observedAttempts.complete,
      scoreSummary,observedCases,observedAttempts,attemptObservation,records,jsonPath,jsonlPath,attemptsPath };
    await durableLine(file,{ type: 'finish',finishedAt: report.finishedAt,executionComplete,stopped,sourceDrift,validRun: report.validRun,scoreSummary,...(executionError ? { executionError } : {}) });
    await durableNewFile(jsonPath,JSON.stringify(report,null,2));
    await durableNewFile(mdPath,[`# G9C known-regression`, '', `Run ${runId}. Cases attempted ${scoreSummary.attemptedCases}/36; passed ${scoreSummary.passedCases}/36. Valid run ${report.validRun}; complete ${executionComplete}; stopped ${stopped}; source drift ${sourceDrift}.`, '',
      `Business assessed ${scoreSummary.businessAssessedCases}; unavailable ${scoreSummary.businessUnavailableCases}; unscored ${scoreSummary.businessUnscoredCases}; pass ${scoreSummary.businessPassCases}/${scoreSummary.businessAssessedCases}. Safety assessed ${scoreSummary.safetyAssessedCases}; pass ${scoreSummary.safetyPassCases}; fail ${scoreSummary.safetyFailureCases}; unscored ${scoreSummary.safetyUnscoredCases}. Missing proposals ${scoreSummary.missingProposalCases}; unexpected proposals ${scoreSummary.unexpectedProposalCases}.`, '',
      `Original manifest SHA-256: ${manifest.originalManifestSha256}. Candidate source manifest SHA-256: ${manifest.sourceManifestSha256}. G9C manifest SHA-256: ${manifestHash}.`, '', `Independent observations: ${JSON.stringify(observedCases)}`, '', `Failure codes: ${JSON.stringify(scoreSummary.failureCodes)}`, '',protocol.boundaries, '',
      '| sequence | case | assessed | passed | duration ms | failures |','|---:|---|---|---|---:|---|',...records.map(record => `| ${record.sequence} | ${record.id} | ${record.score?.assessed ?? false} | ${record.passed} | ${record.durationMs} | ${[...(record.score?.failures ?? []),...(record.errorCode ? [record.errorCode] : [])].join(', ').replaceAll('|','/')} |`)].join('\n'));
    console.log(JSON.stringify({ status: 'finished',runId,cohort: protocol.cohort,validRun: report.validRun,attemptedCases: records.length,plannedCases: 36,jsonPath,mdPath,jsonlPath,attemptsPath }));
    return report;
  } finally { process.removeListener('SIGINT',stop); process.removeListener('SIGTERM',stop); options.signal?.removeEventListener('abort',stop); await journal?.close().catch(() => {}); await file.close(); }
}
export async function runG9C(args = process.argv.slice(2)) {
  const flags = new Set(['--preflight','--known-regression']), values = new Set(['--mode','--manifest','--results-dir']), parsed = new Map<string,string | true>();
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (parsed.has(arg) || (!flags.has(arg) && !values.has(arg))) throw new Error('G9C_UNSUPPORTED_OR_DUPLICATE_OPTION');
    if (flags.has(arg)) parsed.set(arg,true);
    else { const value = args[++index]; if (!value || value.startsWith('--')) throw new Error('G9C_OPTION_VALUE_REQUIRED'); parsed.set(arg,value); }
  }
  const preflightOnly = parsed.has('--preflight');
  if (preflightOnly && parsed.has('--mode')) throw new Error('G9C_PREFLIGHT_HAS_NO_EXECUTION_MODE');
  if (!preflightOnly && parsed.get('--mode') !== 'live') throw new Error('G9C_EXPLICIT_MODE_LIVE_REQUIRED');
  if (!preflightOnly && !parsed.has('--known-regression')) throw new Error('G9C_EXPLICIT_KNOWN_REGRESSION_REQUIRED');
  const manifestPath = resolve(parsed.get('--manifest') as string ?? 'evals/g9c-manifest.json'), bytes = await readFile(manifestPath), manifestHash = sha256(bytes), manifest = JSON.parse(bytes.toString()) as G9CManifest;
  if (manifest.originalManifestPath !== G9C_ORIGINAL_MANIFEST_PATH || !relativePath(manifest.fixturePath) || !manifest.fixturePath.endsWith('.ts')) throw new Error('G9C_MANIFEST_PATH_INVALID');
  const originalBytes = await readFile(manifest.originalManifestPath), original = JSON.parse(originalBytes.toString()) as G9Manifest;
  if (sha256(originalBytes) !== manifest.originalManifestSha256 || (manifest.parentManifest !== undefined && (manifest.parentManifest?.path !== G9C_PARENT_MANIFEST_PATH || !isHash(manifest.parentManifest.sha256) || !same(Object.keys(manifest.parentManifest).sort(),['path','sha256'])))
    || manifest.fixturePath !== original.fixturePath || manifest.fixtureSha256 !== original.fixtureSha256 || await fileHash(manifest.fixturePath) !== manifest.fixtureSha256) throw new Error('G9C_ORIGINAL_BINDING_MISMATCH');
  const module = await import(pathToFileURL(resolve(manifest.fixturePath)).href), dataset = module.g9Dataset as G9Dataset;
  const metadata = validateG9CManifestMetadata(manifest,original,dataset,sha256(originalBytes),manifest.fixtureSha256,await hashG9CEvaluatorFiles());
  await verifyG9CFrozenFiles(manifest,manifestHash,manifestPath);
  if (preflightOnly) { console.log(JSON.stringify({ status: 'preflight-passed',cohort: 'known-regression',...metadata })); return undefined; }
  const config = providerFromEnv(); if (!config) throw new Error('G9C_EXPLICIT_PROVIDER_CONFIG_REQUIRED');
  if (!same(g9cProviderFingerprint(config),manifest.provider)) throw new Error('G9C_FROZEN_PROVIDER_MISMATCH');
  return executeG9CKnownRegression({ dataset,manifest,manifestHash,config,resultsDir: parsed.get('--results-dir') as string ?? 'evals/results/g9c',verifyFrozenFiles: () => verifyG9CFrozenFiles(manifest,manifestHash,manifestPath) });
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) runG9C().then(report => { if (report && (!report.validRun || report.records.some(record => !record.passed))) process.exitCode = 1; }).catch(() => { console.error('G9C configuration or execution failed; case content and credentials remain sealed.'); process.exitCode = 1; });
