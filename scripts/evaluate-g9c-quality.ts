import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, type FileHandle } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createPlanner, providerFromEnv, type OpenAICompatibleConfig } from '../packages/agents/src/index';
import { createModelAttemptJournal } from '../packages/agents/src/attempt-journal';
import { MODEL_ATTEMPT_PROTOCOL_VERSION, MODEL_ATTEMPT_PERSIST_TIMEOUT_MS, type ModelAttemptObserver } from '../packages/agents/src/provider';
import { createStageOutputPlan } from '../packages/agents/src/budget';
import type { PlannerInput, PlanResult } from '../packages/contracts/src/index';
import { canonical, digest } from '../evals/ablation-score';
import { G9_CONTRACT_VERSION, G9_DOMAINS, type G9Dataset, type G9Manifest } from '../evals/g9-contract';
import { G9_SCORE_VERSION } from '../evals/g9-score';
import { evaluateG9Case, G9_LIMITS, resolveG9CaseInput, summarizeG9Scores, type G9CaseRecord } from './evaluate-g9';
import { G9C_EVALUATOR_FILES, G9C_RUNNER_VERSION, g9cProviderFingerprint, verifyG9CFrozenFiles, type G9CManifest, type G9CProviderFingerprint } from './evaluate-g9c';
import { EVALUATION_OBSERVATION_VERSION, summarizeEvaluationCases, summarizeEvaluationObservation } from './evaluation-observation';

export const G9C_QUALITY_RUNNER_VERSION = 'bankpilot-g9c-development-supplemental-v1';
export const G9C_QUALITY_DATASET_VERSION = 'bankpilot-g9c-supplemental-designed-2026-10-24-v1';
export const G9C_QUALITY_PARENT_MANIFEST_PATH = 'evals/g9c-manifest.json';
export const G9C_QUALITY_MANIFEST_PATH = 'evals/g9c-quality-manifest.json';
export const G9C_QUALITY_FIXTURE_PATH = 'evals/g9c-quality-fixtures.ts';
export const G9C_QUALITY_CONTRACT_PATH = 'docs/g9c-quality-cases.md';
export const G9C_QUALITY_EVALUATOR_FILES = [...G9C_EVALUATOR_FILES, 'scripts/evaluate-g9c-quality.ts', 'tests/g9c-quality-runner.test.ts', G9C_QUALITY_FIXTURE_PATH, G9C_QUALITY_CONTRACT_PATH] as const;
export const G9C_QUALITY_CASE_IDS = G9_DOMAINS.flatMap(domain => [`g9-quality-${domain}-01`,`g9-quality-${domain}-02`]);
export type G9CQualityManifest = {
  protocolVersion: typeof G9C_QUALITY_RUNNER_VERSION; cohort: 'development-supplemental'; implementationInformed: true; blind: false; frozenAt: string;
  parentManifestPath: typeof G9C_QUALITY_PARENT_MANIFEST_PATH; parentManifestSha256: string;
  datasetVersion: typeof G9C_QUALITY_DATASET_VERSION; fixturePath: typeof G9C_QUALITY_FIXTURE_PATH; fixtureSha256: string;
  caseIds: string[]; caseCount: 12; positiveCount: 9; domainCounts: G9Manifest['domainCounts']; kindCounts: { positive: 9; no_action: 2; clarification: 1 };
  templateInputsSha256: string; expectedLabelsSha256: string;
  contractPath: typeof G9C_QUALITY_CONTRACT_PATH; contractSha256: string; evaluatorHashes: Record<string,string>;
  provider: G9CProviderFingerprint; limits: typeof G9_LIMITS;
};
const sha256 = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
const fileHash = async (path: string) => sha256(await readFile(path));
const isHash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const same = (a: unknown,b: unknown) => canonical(a) === canonical(b);
const fullTimestamp = (value: string) => /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0,10) === value.slice(0,10);
export async function hashG9CQualityEvaluatorFiles(root = '.') { return Object.fromEntries(await Promise.all(G9C_QUALITY_EVALUATOR_FILES.map(async path => [path,await fileHash(resolve(root,path))]))); }

/** The original validator's 36-case cardinality remains untouched. This validates
 * only supplemental metadata/labels; scoring is exclusively evaluateG9Case. */
export function validateG9CQualityDataset(dataset: G9Dataset) {
  if (!dataset || dataset.version !== G9C_QUALITY_DATASET_VERSION || !Array.isArray(dataset.cases) || dataset.cases.length !== 12 || !same(dataset.cases.map(item => item.id),G9C_QUALITY_CASE_IDS)) throw new Error('G9C_QUALITY_DATASET_INVALID');
  const domainCounts = Object.fromEntries(G9_DOMAINS.map(domain => [domain,dataset.cases.filter(item => item.domain === domain).length])) as G9Manifest['domainCounts'];
  const kindCounts = { positive: dataset.cases.filter(item => item.kind === 'positive').length,no_action: dataset.cases.filter(item => item.kind === 'no_action').length,clarification: dataset.cases.filter(item => item.kind === 'clarification').length };
  if (G9_DOMAINS.some(domain => domainCounts[domain] !== 2) || !same(kindCounts,{positive:9,no_action:2,clarification:1}) || new Set(dataset.cases.map(item => item.input?.taskId)).size !== 12) throw new Error('G9C_QUALITY_DATASET_INVALID');
  for (const item of dataset.cases) {
    const expected = item.expected;
    if (!item.id.startsWith(`g9-quality-${item.domain}-`) || !item.input || typeof item.input.taskId !== 'string' || !item.input.taskId || typeof item.input.message !== 'string' || !item.input.message.trim() || typeof item.input.referenceDate !== 'string' || !/^\d{4}-\d\d-\d\d$/.test(item.input.referenceDate) || 'semanticIntent' in item.input || 'deadlineAt' in item.input || !Array.isArray(item.input.accounts) || !Array.isArray(item.input.payees)
      || !item.rationale || !expected || !['ready','clarification','no_action'].includes(expected.semantic?.status) || !Array.isArray(expected.semantic.recognizedRoles) || !Array.isArray(expected.activatedRoles) || !Array.isArray(expected.successfulCallRoles) || !Array.isArray(expected.transfers) || !Array.isArray(expected.management) || !Array.isArray(expected.redemptions)) throw new Error('G9C_QUALITY_CASE_INVALID');
    if ((item.kind === 'positive' && (expected.semantic.status !== 'ready' || !expected.semantic.recognizedRoles.includes(item.domain))) || (item.kind === 'no_action' && expected.semantic.status !== 'no_action') || (item.kind === 'clarification' && expected.semantic.status !== 'clarification')
      || expected.semantic.recognizedRoles.some(role => !G9_DOMAINS.includes(role)) || new Set(expected.semantic.recognizedRoles).size !== expected.semantic.recognizedRoles.length
      || !same([...expected.activatedRoles].sort(),expected.semantic.status === 'ready' ? [...expected.semantic.recognizedRoles].sort() : [])
      || !same([...expected.successfulCallRoles].sort(),(expected.semantic.status === 'ready' ? ['semantic_intent',...expected.activatedRoles,'reviewer'] : ['semantic_intent']).sort())
      || (expected.semantic.status !== 'ready' && (expected.transfers.length || expected.management.length || expected.redemptions.length || expected.goal))
      || (expected.semantic.status === 'no_action' && (expected.semantic.recognizedRoles.length || expected.businessClarification === true)) || (expected.semantic.status === 'clarification' && expected.businessClarification === false)) throw new Error('G9C_QUALITY_LABEL_INVALID');
    resolveG9CaseInput(item,Date.parse(item.snapshotClock?.anchorIso ?? `${item.input.referenceDate}T00:00:00.000Z`));
  }
  return { caseIds: [...G9C_QUALITY_CASE_IDS],caseCount: 12 as const,positiveCount: 9 as const,domainCounts,kindCounts: kindCounts as G9CQualityManifest['kindCounts'] };
}
export function validateG9CQualityManifestMetadata(manifest: G9CQualityManifest,parent: G9CManifest,dataset: G9Dataset,parentManifestSha256: string,fixtureSha256: string,evaluatorHashes: Record<string,string>,now = new Date().toISOString()) {
  const metadata = validateG9CQualityDataset(dataset);
  if (manifest.protocolVersion !== G9C_QUALITY_RUNNER_VERSION || manifest.cohort !== 'development-supplemental' || manifest.implementationInformed !== true || manifest.blind !== false || !fullTimestamp(manifest.frozenAt) || Date.parse(manifest.frozenAt) > Date.parse(now) || Date.parse(manifest.frozenAt) < Date.parse(parent.frozenAt)
    || !fullTimestamp(parent.frozenAt) || parent.protocolVersion !== G9C_RUNNER_VERSION || parent.cohort !== 'known-regression' || manifest.parentManifestPath !== G9C_QUALITY_PARENT_MANIFEST_PATH || !isHash(parentManifestSha256) || manifest.parentManifestSha256 !== parentManifestSha256
    || manifest.datasetVersion !== dataset.version || manifest.fixturePath !== G9C_QUALITY_FIXTURE_PATH || manifest.fixtureSha256 !== fixtureSha256 || manifest.fixtureSha256 !== evaluatorHashes[G9C_QUALITY_FIXTURE_PATH]
    || !same(manifest.caseIds,metadata.caseIds) || manifest.caseCount !== 12 || manifest.positiveCount !== metadata.positiveCount || !same(manifest.domainCounts,metadata.domainCounts) || !same(manifest.kindCounts,metadata.kindCounts)
    || manifest.templateInputsSha256 !== digest(dataset.cases.map(item => item.input)) || manifest.expectedLabelsSha256 !== digest(dataset.cases.map(item => item.expected))
    || manifest.contractPath !== G9C_QUALITY_CONTRACT_PATH || manifest.contractSha256 !== evaluatorHashes[G9C_QUALITY_CONTRACT_PATH]
    || !same(manifest.evaluatorHashes,evaluatorHashes) || !same(Object.keys(evaluatorHashes).sort(),[...G9C_QUALITY_EVALUATOR_FILES].sort()) || Object.values(evaluatorHashes).some(value => !isHash(value))
    || !same(Object.fromEntries(G9C_EVALUATOR_FILES.map(path => [path,evaluatorHashes[path]])),parent.evaluatorHashes)
    || !same(manifest.provider,parent.provider) || !same(manifest.limits,G9_LIMITS) || !same(parent.limits,G9_LIMITS)) throw new Error('G9C_QUALITY_FROZEN_MANIFEST_MISMATCH');
  return metadata;
}
/** Freeze caller-supplied static bytes only; this never reads provider config,
 * evaluates a case, creates a planner, or accesses a database. */
export function buildG9CQualityManifest(options: { parent: G9CManifest; parentManifestSha256: string; dataset: G9Dataset; fixtureSha256: string; evaluatorHashes: Record<string,string>; frozenAt: string }): G9CQualityManifest {
  const { parent,parentManifestSha256,dataset,fixtureSha256,evaluatorHashes,frozenAt } = options;
  const metadata = validateG9CQualityDataset(dataset);
  const manifest: G9CQualityManifest = { protocolVersion:G9C_QUALITY_RUNNER_VERSION,cohort:'development-supplemental',implementationInformed:true,blind:false,frozenAt,
    parentManifestPath:G9C_QUALITY_PARENT_MANIFEST_PATH,parentManifestSha256,datasetVersion:G9C_QUALITY_DATASET_VERSION,fixturePath:G9C_QUALITY_FIXTURE_PATH,fixtureSha256,...metadata,
    templateInputsSha256:digest(dataset.cases.map(item=>item.input)),expectedLabelsSha256:digest(dataset.cases.map(item=>item.expected)),contractPath:G9C_QUALITY_CONTRACT_PATH,contractSha256:evaluatorHashes[G9C_QUALITY_CONTRACT_PATH]!,
    evaluatorHashes:{...evaluatorHashes},provider:structuredClone(parent.provider),limits:G9_LIMITS };
  validateG9CQualityManifestMetadata(manifest,parent,dataset,parentManifestSha256,fixtureSha256,evaluatorHashes,frozenAt);
  return manifest;
}

export async function verifyG9CQualityFrozenFiles(manifest: G9CQualityManifest,expectedManifestHash: string,manifestPath: string,parent: G9CManifest,root = '.') {
  if (manifest.parentManifestPath !== G9C_QUALITY_PARENT_MANIFEST_PATH || manifest.fixturePath !== G9C_QUALITY_FIXTURE_PATH || manifest.contractPath !== G9C_QUALITY_CONTRACT_PATH
    || await fileHash(resolve(root,manifestPath)) !== expectedManifestHash || await fileHash(resolve(root,manifest.fixturePath)) !== manifest.fixtureSha256 || await fileHash(resolve(root,manifest.contractPath)) !== manifest.contractSha256 || !same(await hashG9CQualityEvaluatorFiles(root),manifest.evaluatorHashes)) throw new Error('G9C_QUALITY_FROZEN_FILE_DRIFT');
  await verifyG9CFrozenFiles(parent,manifest.parentManifestSha256,manifest.parentManifestPath,root);
}
async function durableLine(file: FileHandle, value: unknown) { await file.appendFile(JSON.stringify(value) + '\n'); await file.sync(); }
async function durableNewFile(path: string, contents: string) { const file = await open(path,'wx',0o600); try { await file.writeFile(contents); await file.sync(); } finally { await file.close(); } }
type Plan = (input: PlannerInput, observer: ModelAttemptObserver, signal: AbortSignal) => Promise<PlanResult>;
/** Dependency injection is limited to offline orchestration calibration. The CLI always verifies frozen files and uses the real production planner. */
export async function executeG9CQuality(options: { dataset: G9Dataset; manifest: G9CQualityManifest; manifestHash: string; config: OpenAICompatibleConfig; resultsDir: string; verifyFrozenFiles: () => Promise<unknown>; plan?: Plan; signal?: AbortSignal }) {
  const { dataset,manifest,manifestHash,config } = options;
  if (dataset.cases.length !== 12 || !same(dataset.cases.map(item => item.id),manifest.caseIds) || manifest.cohort !== 'development-supplemental' || !same(manifest.limits,G9_LIMITS) || !same(g9cProviderFingerprint(config),manifest.provider)) throw new Error('G9C_QUALITY_EXECUTION_CONTRACT_MISMATCH');
  validateG9CQualityDataset(dataset);
  if (digest(dataset.cases.map(item => item.input)) !== manifest.templateInputsSha256 || digest(dataset.cases.map(item => item.expected)) !== manifest.expectedLabelsSha256) throw new Error('G9C_QUALITY_EXECUTION_CONTRACT_MISMATCH');
  await options.verifyFrozenFiles();
  const startedAt = new Date().toISOString(), runId = `${startedAt.replace(/[:.]/g,'-')}-${randomUUID()}`;
  const resultsDir = resolve(options.resultsDir); await mkdir(resultsDir,{ recursive: true });
  const runDir = resolve(resultsDir,runId); await mkdir(runDir,{ mode: 0o700 });
  const jsonPath = resolve(runDir,'report.json'), jsonlPath = resolve(runDir,'cases.jsonl'), mdPath = resolve(runDir,'report.md'), attemptsPath = resolve(runDir,'attempts.jsonl');
  const protocol = { protocolVersion: G9C_QUALITY_RUNNER_VERSION, contractVersion: G9_CONTRACT_VERSION, scoreVersion: G9_SCORE_VERSION, observationVersion: EVALUATION_OBSERVATION_VERSION,
    attemptProtocolVersion: MODEL_ATTEMPT_PROTOCOL_VERSION, attemptPersistenceTimeoutMs: MODEL_ATTEMPT_PERSIST_TIMEOUT_MS,
    cohort: 'development-supplemental' as const, implementationInformed: true, blind: false, knownRegression: false, datasetVersion: dataset.version, caseCount: 12, caseIds: manifest.caseIds,
    positiveCount: manifest.positiveCount, domainCounts: manifest.domainCounts, templateInputsSha256: digest(dataset.cases.map(item => item.input)), expectedLabelsSha256: digest(dataset.cases.map(item => item.expected)), ...G9_LIMITS, topology: 'production-parallel-review',
    manifestSha256: manifestHash, parentManifestPath: manifest.parentManifestPath, parentManifestSha256: manifest.parentManifestSha256, fixtureSha256: manifest.fixtureSha256,
    evaluatorHashes: manifest.evaluatorHashes, contractPath: manifest.contractPath, contractSha256: manifest.contractSha256, kindCounts: manifest.kindCounts,
    worstCaseOutputPlan: createStageOutputPlan({ domainStageCount: 6, reviewerStageCount: 1, maxAttempts: G9_LIMITS.maxAttempts }),
    boundaries: 'Development supplemental replay of 12 implementation-informed, non-blind synthetic cases, with separately frozen inputs and labels and the existing G9 scorer and snapshot time binding. Planning proposals only. External cases sequential; production domain parallelism retained. Dispatch intent is fsynced before HTTP. Unknown receipt and missing usage remain unknown. No fallback, case selection or whole-run retry. This is not an unseen or first-run result and must not be pooled with G9/G9B/G9C known-regression scores.' };
  const file = await open(jsonlPath,'wx',0o600);
  let journal: Awaited<ReturnType<typeof createModelAttemptJournal>> | undefined;
  const records: G9CaseRecord[] = [], stopController = new AbortController(); let stopped = false, sourceDrift = false, executionError: string | undefined;
  const stop = () => { stopped = true; stopController.abort(); };
  process.once('SIGINT',stop); process.once('SIGTERM',stop); options.signal?.addEventListener('abort',stop,{ once: true }); if (options.signal?.aborted) stop();
  try {
    journal = await createModelAttemptJournal(attemptsPath);
    await durableLine(file,{ type: 'start',runId,startedAt,mode: 'live',protocol,provider: manifest.provider,attemptsPath,journalId: journal.journalId });
    console.log(JSON.stringify({ status: 'started',runId,cohort: protocol.cohort,caseCount: 12 }));
    const plan: Plan = options.plan ?? ((input,observer,signal) => createPlanner({ semantic: true,provider: { ...config,timeoutMs: G9_LIMITS.providerTimeoutMs,maxAttempts: G9_LIMITS.maxAttempts,maxStructureRepairs: G9_LIMITS.maxStructureRepairs,temperature: G9_LIMITS.temperature,signal,attemptObserver: observer } }).plan(input));
    try {
      for (const fixture of dataset.cases) {
        if (stopped) break;
        try { await options.verifyFrozenFiles(); } catch { sourceDrift = true; stopped = true; break; }
        if (stopped) break;
        const record = await evaluateG9Case(fixture,records.length + 1,journal,plan,{ signal: stopController.signal });
        try { await options.verifyFrozenFiles(); } catch { sourceDrift = true; stopped = true; record.evaluationValid = false; record.passed = false; record.errorCode = 'G9C_QUALITY_FROZEN_FILE_DRIFT'; }
        records.push(record); await durableLine(file,{ type: 'case',...record });
        console.log(JSON.stringify({ sequence: record.sequence,id: record.id,status: record.failure ? 'unavailable' : record.passed ? 'passed' : 'failed',durationMs: record.durationMs }));
      }
    } catch { stopped = true; executionError = 'G9C_QUALITY_EXECUTION_INTERRUPTED'; stopController.abort(); }
    await journal.close().catch(() => {});
    try { await options.verifyFrozenFiles(); } catch { sourceDrift = true; }
    const attemptObservation = journal.summary(), observedAttempts = summarizeEvaluationObservation(attemptObservation,{ mode: 'live',maxOutputTokens: G9_LIMITS.totalOutputTokenCeilingPerCase }), observedCases = summarizeEvaluationCases(records), scoreSummary = summarizeG9Scores(records,12);
    const executionComplete = records.length === 12;
    const report = { runId,startedAt,finishedAt: new Date().toISOString(),mode: 'live',...protocol,provider: manifest.provider,executionComplete,stopped,sourceDrift,...(executionError ? { executionError } : {}),
      validRun: executionComplete && !stopped && !sourceDrift && !executionError && records.every(record => record.evaluationValid) && observedCases.complete && observedAttempts.complete,
      scoreSummary,observedCases,observedAttempts,attemptObservation,records,jsonPath,jsonlPath,attemptsPath };
    await durableLine(file,{ type: 'finish',finishedAt: report.finishedAt,executionComplete,stopped,sourceDrift,validRun: report.validRun,scoreSummary,...(executionError ? { executionError } : {}) });
    await durableNewFile(jsonPath,JSON.stringify(report,null,2));
    await durableNewFile(mdPath,[`# G9C development supplemental (implementation-informed, non-blind)`, '', `Run ${runId}. Cases attempted ${scoreSummary.attemptedCases}/12; passed ${scoreSummary.passedCases}/12. Valid run ${report.validRun}; complete ${executionComplete}; stopped ${stopped}; source drift ${sourceDrift}.`, '',
      `Business assessed ${scoreSummary.businessAssessedCases}; unavailable ${scoreSummary.businessUnavailableCases}; unscored ${scoreSummary.businessUnscoredCases}; pass ${scoreSummary.businessPassCases}/${scoreSummary.businessAssessedCases}. Safety assessed ${scoreSummary.safetyAssessedCases}; pass ${scoreSummary.safetyPassCases}; fail ${scoreSummary.safetyFailureCases}; unscored ${scoreSummary.safetyUnscoredCases}. Missing proposals ${scoreSummary.missingProposalCases}; unexpected proposals ${scoreSummary.unexpectedProposalCases}.`, '',
      `Parent G9C manifest SHA-256: ${manifest.parentManifestSha256}. Supplemental fixture SHA-256: ${manifest.fixtureSha256}. Supplemental manifest SHA-256: ${manifestHash}.`, '', `Independent observations: ${JSON.stringify(observedCases)}`, '', `Failure codes: ${JSON.stringify(scoreSummary.failureCodes)}`, '',protocol.boundaries, '',
      '| sequence | case | assessed | passed | duration ms | failures |','|---:|---|---|---|---:|---|',...records.map(record => `| ${record.sequence} | ${record.id} | ${record.score?.assessed ?? false} | ${record.passed} | ${record.durationMs} | ${[...(record.score?.failures ?? []),...(record.errorCode ? [record.errorCode] : [])].join(', ').replaceAll('|','/')} |`)].join('\n'));
    console.log(JSON.stringify({ status: 'finished',runId,cohort: protocol.cohort,validRun: report.validRun,attemptedCases: records.length,plannedCases: 12,jsonPath,mdPath,jsonlPath,attemptsPath }));
    return report;
  } finally { process.removeListener('SIGINT',stop); process.removeListener('SIGTERM',stop); options.signal?.removeEventListener('abort',stop); await journal?.close().catch(() => {}); await file.close(); }
}
export async function runG9CQuality(args = process.argv.slice(2)) {
  const flags = new Set(['--preflight','--development-supplemental']),values = new Set(['--mode','--manifest','--results-dir']),parsed = new Map<string,string | true>();
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (parsed.has(arg) || (!flags.has(arg) && !values.has(arg))) throw new Error('G9C_QUALITY_UNSUPPORTED_OR_DUPLICATE_OPTION');
    if (flags.has(arg)) parsed.set(arg,true);
    else { const value = args[++index]; if (!value || value.startsWith('--')) throw new Error('G9C_QUALITY_OPTION_VALUE_REQUIRED'); parsed.set(arg,value); }
  }
  const preflight = parsed.has('--preflight');
  if (preflight && parsed.has('--mode')) throw new Error('G9C_QUALITY_PREFLIGHT_HAS_NO_EXECUTION_MODE');
  if (!preflight && parsed.get('--mode') !== 'live') throw new Error('G9C_QUALITY_EXPLICIT_MODE_LIVE_REQUIRED');
  if (!preflight && !parsed.has('--development-supplemental')) throw new Error('G9C_QUALITY_EXPLICIT_DEVELOPMENT_SUPPLEMENTAL_REQUIRED');
  const manifestPath = resolve(parsed.get('--manifest') as string ?? G9C_QUALITY_MANIFEST_PATH),bytes = await readFile(manifestPath),manifestHash = sha256(bytes),manifest = JSON.parse(bytes.toString()) as G9CQualityManifest;
  if (manifest.parentManifestPath !== G9C_QUALITY_PARENT_MANIFEST_PATH || manifest.fixturePath !== G9C_QUALITY_FIXTURE_PATH) throw new Error('G9C_QUALITY_MANIFEST_PATH_INVALID');
  const parentBytes = await readFile(manifest.parentManifestPath),parent = JSON.parse(parentBytes.toString()) as G9CManifest;
  if (sha256(parentBytes) !== manifest.parentManifestSha256 || await fileHash(manifest.fixturePath) !== manifest.fixtureSha256) throw new Error('G9C_QUALITY_PARENT_BINDING_MISMATCH');
  const module = await import(pathToFileURL(resolve(manifest.fixturePath)).href),dataset = module.g9cQualityDataset as G9Dataset;
  const metadata = validateG9CQualityManifestMetadata(manifest,parent,dataset,sha256(parentBytes),manifest.fixtureSha256,await hashG9CQualityEvaluatorFiles());
  await verifyG9CQualityFrozenFiles(manifest,manifestHash,manifestPath,parent);
  if (preflight) { console.log(JSON.stringify({ status:'preflight-passed',cohort:manifest.cohort,implementationInformed:true,blind:false,...metadata })); return undefined; }
  const config = providerFromEnv(); if (!config) throw new Error('G9C_QUALITY_EXPLICIT_PROVIDER_CONFIG_REQUIRED');
  if (!same(g9cProviderFingerprint(config),manifest.provider)) throw new Error('G9C_QUALITY_FROZEN_PROVIDER_MISMATCH');
  return executeG9CQuality({ dataset,manifest,manifestHash,config,resultsDir:parsed.get('--results-dir') as string ?? 'evals/results/g9c-quality',verifyFrozenFiles:()=>verifyG9CQualityFrozenFiles(manifest,manifestHash,manifestPath,parent) });
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) runG9CQuality().then(report=>{ if (report && (!report.validRun || report.records.some(record=>!record.passed))) process.exitCode=1; }).catch(()=>{ console.error('G9C supplemental configuration or execution failed; case content and credentials remain sealed.');process.exitCode=1; });
