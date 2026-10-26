import { createHash } from 'node:crypto';
import { mkdir, open, readFile, readdir, writeFile, type FileHandle } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createPlanner, providerFromEnv, normalizeBaseURL } from '../packages/agents/src/index';
import { createModelAttemptJournal } from '../packages/agents/src/attempt-journal';
import { MODEL_ATTEMPT_PROTOCOL_VERSION, MODEL_ATTEMPT_PERSIST_TIMEOUT_MS, type ModelAttemptObserver } from '../packages/agents/src/provider';
import { createStageOutputPlan, PLANNING_OUTPUT_TOKEN_LIMIT, SEMANTIC_OUTPUT_TOKEN_LIMIT } from '../packages/agents/src/budget';
import { PlanningStageFailure } from '../packages/agents/src/planning-failures';
import type { PlanResult, PlannerInput } from '../packages/contracts/src/index';
import { canonical, digest } from '../evals/ablation-score';
import { G9_CONTRACT_VERSION, validateG9Dataset, type G9Case, type G9Dataset, type G9Manifest } from '../evals/g9-contract';
import { G9_SCORE_VERSION, scoreG9, type G9Score } from '../evals/g9-score';
import { EVALUATION_OBSERVATION_VERSION, classifyEvaluationFailure, summarizeEvaluationCases, summarizeEvaluationObservation } from './evaluation-observation';

export const G9_RUNNER_VERSION = 'bankpilot-g9-live-eval-v1';
export const G9_SOURCE_MANIFEST_PATH = 'evals/baselines/g8n-final-2026-10-24T03-56-37-821Z/source-manifest.json';
export const G9_EVALUATOR_FILES = ['evals/g9-contract.ts','evals/g9-score.ts','scripts/evaluate-g9.ts','tests/g9-evaluation.test.ts','scripts/evaluation-observation.ts','evals/ablation-score.ts','docs/g9-preregistered-evaluation.md'] as const;
/** Unchanged G7 production limits; changing any of these requires a separately frozen protocol. */
export const G9_LIMITS = Object.freeze({ caseDeadlineMs: 180000, providerTimeoutMs: 60000, maxAttempts: 2, maxStructureRepairs: 1 as const, temperature: 0, semanticMaxOutputTokens: SEMANTIC_OUTPUT_TOKEN_LIMIT, totalOutputTokenCeilingPerCase: PLANNING_OUTPUT_TOKEN_LIMIT, externalCaseConcurrency: 1 });
type Journal = Awaited<ReturnType<typeof createModelAttemptJournal>>;
const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const fileHash = async (path: string) => sha256(await readFile(path));
const fullTimestamp = (value: string) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString().slice(0,10) === value.slice(0,10);
const sameMultiset = (a: readonly string[], b: readonly string[]) => canonical([...a].sort()) === canonical([...b].sort());
export async function hashG9EvaluatorFiles() { return Object.fromEntries(await Promise.all(G9_EVALUATOR_FILES.map(async path => [path, await fileHash(path)]))); }
type SourceManifest = { files: { path: string; sha256: string }[] };
const generatedDirectories = new Set(['node_modules','dist','build','coverage','.vite','.cache','.git']);
export async function g9ProductInventory(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.filter(entry => !generatedDirectories.has(entry.name)).map(async entry => {
    const path = `${directory}/${entry.name}`;
    return entry.isDirectory() ? g9ProductInventory(path) : /(?:^|\/)src\//.test(path) || /\.(?:[cm]?[jt]sx?|css|html|json|svg|png|jpe?g|webp|gif|woff2?)$/.test(path) ? [path] : [];
  }))).flat();
}
export function validateG9ManifestMetadata(manifest: G9Manifest, dataset: G9Dataset, fixtureSha256: string, evaluatorHashes: Record<string,string>, now = new Date().toISOString()) {
  const metadata = validateG9Dataset(dataset);
  const validTimes = fullTimestamp(manifest.frozenAt) && fullTimestamp(manifest.authorReview?.completedAt) && Date.parse(manifest.authorReview.completedAt) <= Date.parse(manifest.frozenAt) && Date.parse(manifest.frozenAt) <= Date.parse(now);
  if (!validTimes || manifest.contractVersion !== G9_CONTRACT_VERSION || manifest.datasetVersion !== dataset.version || manifest.caseCount !== 36 || manifest.positiveCount !== metadata.positiveCount || canonical(manifest.domainCounts) !== canonical(metadata.domainCounts) || canonical(manifest.caseIds) !== canonical(metadata.caseIds) || manifest.fixtureSha256 !== fixtureSha256 || canonical(manifest.evaluatorHashes) !== canonical(evaluatorHashes) || manifest.sourceManifestPath !== G9_SOURCE_MANIFEST_PATH || manifest.preregistrationPath !== 'docs/g9-preregistered-evaluation.md' || manifest.preregistrationSha256 !== evaluatorHashes[manifest.preregistrationPath] || !manifest.provider?.model || !['tools','json_object'].includes(manifest.provider.outputMode) || !/^[a-f0-9]{64}$/.test(manifest.provider.baseURLSha256) || !manifest.authorReview?.independentFromImplementation || !manifest.authorReview.prohibitedSourcesNotRead || manifest.authorReview.fixtureSha256 !== fixtureSha256 || manifest.authorReview.contractSha256 !== evaluatorHashes['evals/g9-contract.ts'] || typeof manifest.authorReview.reviewPath !== 'string' || !manifest.authorReview.reviewPath || !/^[a-f0-9]{64}$/.test(manifest.authorReview.reviewSha256)) throw new Error('G9_FROZEN_MANIFEST_MISMATCH');
  return metadata;
}
export async function verifyG9FrozenFiles(manifest: G9Manifest, expectedManifestHash: string, manifestPath: string) {
  if (await fileHash(manifestPath) !== expectedManifestHash || await fileHash(manifest.fixturePath) !== manifest.fixtureSha256 || await fileHash(manifest.sourceManifestPath) !== manifest.sourceManifestSha256 || await fileHash(manifest.preregistrationPath) !== manifest.preregistrationSha256 || await fileHash(manifest.authorReview.reviewPath) !== manifest.authorReview.reviewSha256 || canonical(await hashG9EvaluatorFiles()) !== canonical(manifest.evaluatorHashes)) throw new Error('G9_FROZEN_FILE_DRIFT');
  const source = JSON.parse(await readFile(manifest.sourceManifestPath, 'utf8')) as SourceManifest;
  if (!Array.isArray(source.files) || new Set(source.files.map(file => file.path)).size !== source.files.length) throw new Error('G9_SOURCE_MANIFEST_INVALID');
  const productPaths = source.files.filter(file => /^(apps|packages)\//.test(file.path)).map(file => file.path);
  const inventory = (await Promise.all(['apps','packages'].map(g9ProductInventory))).flat();
  if (!sameMultiset(inventory, productPaths)) throw new Error('G9_PRODUCT_INVENTORY_DRIFT');
  const checks = await Promise.all(source.files.map(async file => await fileHash(file.path) === file.sha256));
  if (checks.some(match => !match)) throw new Error('G9_FROZEN_SOURCE_DRIFT');
  return true;
}
export type G9CaseRecord = {
  sequence: number; id: string; domain: G9Case['domain']; kind: G9Case['kind']; startedAt: string;
  templateInputHash: string; inputHash: string; expectedHash: string; durationMs: number; passed: boolean; evaluationValid: boolean;
  snapshotClockBinding?: G9SnapshotClockBinding;
  score?: G9Score; result?: PlanResult; errorCode?: string; failure?: ReturnType<typeof classifyEvaluationFailure>; failureSource?: 'returned-plan' | 'thrown';
  inputUnchanged: boolean; templateInputUnchanged: boolean; labelsUnchanged: boolean; exactCallEvidenceAgreement: boolean;
  attemptObservation?: ReturnType<Journal['summary']>; observation?: ReturnType<typeof summarizeEvaluationObservation>;
};
export type G9SnapshotClockBinding = { anchorIso: string; caseWallStartIso: string; deltaMs: number; queriedAt: { template: string; resolved: string }; accessExpiresAt: { template: string; resolved: string } };
/** Resolves only the two pre-registered synthetic grant timestamps; real clocks and timers remain untouched. */
export function resolveG9CaseInput(fixture: G9Case, caseWallStartMs: number) {
  const input = structuredClone(fixture.input), templateInputHash = digest(fixture.input);
  let snapshotClockBinding: G9SnapshotClockBinding | undefined;
  if (fixture.snapshotClock) {
    const anchorIso = fixture.snapshotClock.anchorIso, snapshot = input.managementContext?.subscriptions;
    if (!fullTimestamp(anchorIso) || !Number.isSafeInteger(caseWallStartMs) || !snapshot || !fullTimestamp(snapshot.queriedAt) || !fullTimestamp(snapshot.accessExpiresAt)) throw new Error('G9_SNAPSHOT_CLOCK_INVALID');
    const anchor = Date.parse(anchorIso), queried = Date.parse(snapshot.queriedAt), expires = Date.parse(snapshot.accessExpiresAt), deltaMs = caseWallStartMs - anchor;
    if (queried > anchor || expires - queried !== 300000 || !Number.isSafeInteger(deltaMs)) throw new Error('G9_SNAPSHOT_CLOCK_INVALID');
    const queriedAt = new Date(queried + deltaMs).toISOString(), accessExpiresAt = new Date(expires + deltaMs).toISOString();
    snapshotClockBinding = { anchorIso, caseWallStartIso: new Date(caseWallStartMs).toISOString(), deltaMs, queriedAt: { template: snapshot.queriedAt, resolved: queriedAt }, accessExpiresAt: { template: snapshot.accessExpiresAt, resolved: accessExpiresAt } };
    snapshot.queriedAt = queriedAt; snapshot.accessExpiresAt = accessExpiresAt;
  }
  return { input, templateInputHash, inputHash: digest(input), ...(snapshotClockBinding ? { snapshotClockBinding } : {}) };
}
/** Injection is used only by local calibration tests. The CLI always supplies the production planner. */
export async function evaluateG9Case(fixture: G9Case, sequence: number, journal: Journal, plan: (input: PlannerInput, observer: ModelAttemptObserver, signal: AbortSignal) => Promise<PlanResult>, options: { signal?: AbortSignal } = {}): Promise<G9CaseRecord> {
  const caseWallStartMs = Date.now(), { input, inputHash, templateInputHash, snapshotClockBinding } = resolveG9CaseInput(fixture, caseWallStartMs), expectedHash = digest(fixture.expected), tick = performance.now();
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), G9_LIMITS.caseDeadlineMs);
  const abort = () => controller.abort(); options.signal?.addEventListener('abort', abort, { once: true }); if (options.signal?.aborted) controller.abort();
  let record: G9CaseRecord = { sequence, id: fixture.id, domain: fixture.domain, kind: fixture.kind, startedAt: new Date(caseWallStartMs).toISOString(), templateInputHash, inputHash, expectedHash, ...(snapshotClockBinding ? { snapshotClockBinding } : {}), durationMs: 0, passed: false, evaluationValid: false, inputUnchanged: true, templateInputUnchanged: true, labelsUnchanged: true, exactCallEvidenceAgreement: false };
  try {
    const result = await plan(input, journal.observerForCase(sequence), controller.signal);
    record.result = result;
    if (result.failure) { record.failure = classifyEvaluationFailure(new PlanningStageFailure(result.failure)); record.failureSource = 'returned-plan'; record.errorCode = record.failure.code; }
    else record.score = scoreG9({ ...fixture, input }, result);
  } catch (error) { record.failure = classifyEvaluationFailure(error, { deadlineExceeded: controller.signal.aborted }); record.failureSource = 'thrown'; record.errorCode = record.failure.code; }
  finally { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); }
  record.durationMs = Math.round(performance.now() - tick);
  record.inputUnchanged = digest(input) === inputHash; record.templateInputUnchanged = digest(fixture.input) === templateInputHash; record.labelsUnchanged = digest(fixture.expected) === expectedHash;
  if (!record.inputUnchanged) record.errorCode = 'INPUT_MUTATED';
  if (!record.templateInputUnchanged) record.errorCode = 'G9_TEMPLATE_INPUT_MUTATED';
  if (!record.labelsUnchanged) record.errorCode = 'G9_LABELS_MUTATED';
  if (controller.signal.aborted) record.errorCode = 'CASE_DEADLINE_EXCEEDED';
  await journal.flush().catch(() => {});
  record.attemptObservation = journal.summary(sequence);
  record.observation = summarizeEvaluationObservation(record.attemptObservation, { mode: 'live', caseSequence: sequence, maxOutputTokens: G9_LIMITS.totalOutputTokenCeilingPerCase });
  const successfulObserved = record.attemptObservation.confirmedAttempts.filter(attempt => attempt.end?.status === 'success').map(attempt => attempt.start.role);
  const successfulReturned = (record.result?.modelRuns ?? []).filter(run => run.status === 'success').map(run => run.role);
  record.exactCallEvidenceAgreement = !!record.result && sameMultiset(successfulObserved, successfulReturned);
  // Thrown/service failures still retain durable attempts, budget, missing usage and latency.
  record.evaluationValid = record.inputUnchanged && record.templateInputUnchanged && record.labelsUnchanged && !controller.signal.aborted && record.observation.complete && record.observation.confirmedStarts > 0 && record.observation.budget.withinBudget === true && (record.result ? record.exactCallEvidenceAgreement : true);
  if (!record.observation.complete || record.observation.budget.withinBudget !== true) record.errorCode ??= 'EVAL_OBSERVATION_INCOMPLETE';
  if (record.result && !record.exactCallEvidenceAgreement) record.errorCode ??= 'G9_CALL_EVIDENCE_DISAGREEMENT';
  record.passed = record.evaluationValid && !record.failure && record.score?.passed === true;
  return record;
}
export function summarizeG9Scores(records: readonly G9CaseRecord[], planned: number) {
  const assessed = records.flatMap(record => record.score?.assessed ? [record.score] : []);
  return { plannedCases: planned, attemptedCases: records.length, unattemptedCases: planned - records.length, businessAssessedCases: assessed.length, businessUnavailableCases: records.filter(record => !!record.failure).length, businessUnscoredCases: records.length - assessed.length,
    passedCases: records.filter(record => record.passed).length, businessPassCases: assessed.filter(score => score.businessSemanticsPass).length, semanticPassCases: assessed.filter(score => score.intentRecognition).length, exactSuccessfulCallSetCases: assessed.filter(score => score.modelComplete).length,
    safetyAssessedCases: assessed.filter(score => score.planningSafety !== null).length, safetyUnscoredCases: records.length - assessed.filter(score => score.planningSafety !== null).length, safetyPassCases: assessed.filter(score => score.planningSafety === true).length, safetyFailureCases: assessed.filter(score => score.planningSafety === false).length,
    missingProposalCases: assessed.filter(score => (score.missingProposalCount ?? 0) > 0).length, unexpectedProposalCases: assessed.filter(score => score.unexpectedActionProposal).length,
    evaluationInvalidCases: records.filter(record => !record.evaluationValid).length,
    failureCodes: Object.fromEntries([...new Set(records.flatMap(record => [...(record.score?.failures ?? []), ...(record.errorCode ? [record.errorCode] : [])]))].sort().map(code => [code, records.filter(record => record.errorCode === code || record.score?.failures.includes(code)).length])) };
}
async function durableLine(file: FileHandle, value: unknown) { await file.appendFile(JSON.stringify(value) + '\n'); await file.sync(); }
export async function reserveG9Exposure(path: string, event: unknown, knownRegression: boolean) {
  await mkdir(dirname(path), { recursive: true });
  let file: FileHandle;
  try { file = await open(path, 'wx', 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || !knownRegression) throw new Error('G9_PRIOR_EXPOSURE_REQUIRES_KNOWN_REGRESSION');
    file = await open(path, 'a', 0o600);
    try { await durableLine(file, event); } finally { await file.close(); }
    return 'known-regression' as const;
  }
  try { await durableLine(file, event); } finally { await file.close(); }
  return knownRegression ? 'known-regression' as const : 'first-registered-live-run' as const;
}
export async function runG9(args = process.argv.slice(2)) {
  const option = (name: string) => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
  const preflightOnly = args.includes('--preflight');
  if (!preflightOnly && option('--mode') !== 'live') throw new Error('G9_EXPLICIT_MODE_LIVE_REQUIRED');
  if (preflightOnly && option('--mode')) throw new Error('G9_PREFLIGHT_HAS_NO_EXECUTION_MODE');
  const manifestPath = resolve(option('--manifest') ?? 'evals/g9-manifest.json');
  const manifestBytes = await readFile(manifestPath), manifestHash = sha256(manifestBytes), manifest = JSON.parse(manifestBytes.toString()) as G9Manifest;
  if (!manifest.fixturePath || !/\.ts$/.test(manifest.fixturePath)) throw new Error('G9_FIXTURE_PATH_INVALID');
  const fixtureHash = await fileHash(manifest.fixturePath);
  if (fixtureHash !== manifest.fixtureSha256) throw new Error('G9_FIXTURE_HASH_MISMATCH');
  const module = await import(pathToFileURL(resolve(manifest.fixturePath)).href), dataset = module.g9Dataset as G9Dataset;
  const metadata = validateG9ManifestMetadata(manifest, dataset, fixtureHash, await hashG9EvaluatorFiles());
  // Time binding is validated statically without running any product resolver or planner.
  for (const fixture of dataset.cases) resolveG9CaseInput(fixture, Date.parse(fixture.snapshotClock?.anchorIso ?? `${fixture.input.referenceDate}T00:00:00.000Z`));
  await verifyG9FrozenFiles(manifest, manifestHash, manifestPath);
  if (preflightOnly) { console.log(JSON.stringify({ status: 'preflight-passed', caseCount: metadata.caseCount, positiveCount: metadata.positiveCount, domainCounts: metadata.domainCounts, caseIds: metadata.caseIds })); return undefined; }
  const config = providerFromEnv(); if (!config) throw new Error('G9_EXPLICIT_PROVIDER_CONFIG_REQUIRED');
  const provider = { model: config.model, outputMode: config.outputMode ?? 'tools', baseURLSha256: sha256(normalizeBaseURL(config.baseURL)) };
  if (canonical(provider) !== canonical(manifest.provider)) throw new Error('G9_FROZEN_PROVIDER_MISMATCH');
  const startedAt = new Date().toISOString(), runId = startedAt.replace(/[:.]/g,'-');
  const resultsDir = resolve(option('--results-dir') ?? 'evals/results/g9'); await mkdir(resultsDir, { recursive: true });
  const prefix = `${runId}-g9-live`, jsonPath = resolve(resultsDir, `${prefix}.json`), jsonlPath = resolve(resultsDir, `${prefix}.jsonl`), mdPath = resolve(resultsDir, `${prefix}.md`), attemptsPath = resolve(resultsDir, `${prefix}.attempts.jsonl`);
  const exposurePath = resolve('evals/g9-exposures', `${sha256(dataset.version)}.jsonl`);
  const cohort = await reserveG9Exposure(exposurePath, { runId, startedAt, fixtureSha256: fixtureHash, manifestSha256: manifestHash, caseIds: metadata.caseIds, knownRegression: args.includes('--known-regression') }, args.includes('--known-regression'));
  const protocol = { protocolVersion: G9_RUNNER_VERSION, contractVersion: G9_CONTRACT_VERSION, scoreVersion: G9_SCORE_VERSION, observationVersion: EVALUATION_OBSERVATION_VERSION, attemptProtocolVersion: MODEL_ATTEMPT_PROTOCOL_VERSION, attemptPersistenceTimeoutMs: MODEL_ATTEMPT_PERSIST_TIMEOUT_MS, datasetVersion: dataset.version, cohort, ...G9_LIMITS, topology: 'production-parallel-review', ...metadata, manifestSha256: manifestHash, evaluatorHashes: manifest.evaluatorHashes, sourceManifestSha256: manifest.sourceManifestSha256, fixtureSha256: fixtureHash, worstCaseOutputPlan: createStageOutputPlan({ domainStageCount: 6, reviewerStageCount: 1, maxAttempts: G9_LIMITS.maxAttempts }), boundaries: 'Planning proposals only. Static validation never invokes a planner. External cases execute sequentially; production domain parallelism is retained. Each dispatch intent is fsynced before HTTP; receipt and unknown outcomes are not inferred. No implicit fallback or whole-run retry. Business unavailability, unscored safety, and missing usage remain separate.' };
  const file = await open(jsonlPath, 'wx', 0o600), journal = await createModelAttemptJournal(attemptsPath);
  const records: G9CaseRecord[] = [], stopController = new AbortController(); let stopped = false, sourceDrift = false;
  const stop = () => { stopped = true; stopController.abort(); }; process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    await durableLine(file, { type: 'start', startedAt, mode: 'live', protocol, provider, attemptsPath, journalId: journal.journalId });
    console.log(JSON.stringify({ status: 'started', runId, cohort, caseCount: metadata.caseCount }));
    for (const fixture of dataset.cases) {
      if (stopped) break;
      try { await verifyG9FrozenFiles(manifest, manifestHash, manifestPath); } catch { sourceDrift = true; stopped = true; break; }
      const record = await evaluateG9Case(fixture, records.length + 1, journal, (input, observer, signal) => createPlanner({ semantic: true, provider: { ...config, timeoutMs: G9_LIMITS.providerTimeoutMs, maxAttempts: G9_LIMITS.maxAttempts, maxStructureRepairs: G9_LIMITS.maxStructureRepairs, temperature: G9_LIMITS.temperature, signal, attemptObserver: observer } }).plan(input), { signal: stopController.signal });
      try { await verifyG9FrozenFiles(manifest, manifestHash, manifestPath); } catch { sourceDrift = true; stopped = true; record.evaluationValid = false; record.passed = false; record.errorCode = 'G9_FROZEN_FILE_DRIFT'; }
      records.push(record); await durableLine(file, { type: 'case', ...record });
      console.log(JSON.stringify({ sequence: record.sequence, id: record.id, status: record.failure ? 'unavailable' : record.passed ? 'passed' : 'failed', durationMs: record.durationMs }));
    }
    await journal.close().catch(() => {});
    try { await verifyG9FrozenFiles(manifest, manifestHash, manifestPath); } catch { sourceDrift = true; }
    const attemptObservation = journal.summary(), observedAttempts = summarizeEvaluationObservation(attemptObservation, { mode: 'live', maxOutputTokens: G9_LIMITS.totalOutputTokenCeilingPerCase }), observedCases = summarizeEvaluationCases(records), scoreSummary = summarizeG9Scores(records, dataset.cases.length);
    const executionComplete = records.length === dataset.cases.length;
    const report = { startedAt, finishedAt: new Date().toISOString(), mode: 'live', ...protocol, executionComplete, stopped, sourceDrift, validRun: executionComplete && !stopped && !sourceDrift && records.every(record => record.evaluationValid) && observedCases.complete && observedAttempts.complete, scoreSummary, observedCases, observedAttempts, attemptObservation, records, jsonlPath, attemptsPath };
    await durableLine(file, { type: 'finish', finishedAt: report.finishedAt, executionComplete, stopped, sourceDrift, validRun: report.validRun, scoreSummary });
    await writeFile(jsonPath, JSON.stringify(report, null, 2), { mode: 0o600 });
    const md = [`# G9 ${cohort}`, '', `Cases attempted ${scoreSummary.attemptedCases}/${scoreSummary.plannedCases}; passed ${scoreSummary.passedCases}/${scoreSummary.plannedCases}. Valid run ${report.validRun}; execution complete ${executionComplete}; stopped ${stopped}; source drift ${sourceDrift}.`, '', `Business assessed ${scoreSummary.businessAssessedCases}; unavailable ${scoreSummary.businessUnavailableCases}; unscored ${scoreSummary.businessUnscoredCases}. Business pass ${scoreSummary.businessPassCases}/${scoreSummary.businessAssessedCases}. Safety assessed ${scoreSummary.safetyAssessedCases}; pass ${scoreSummary.safetyPassCases}; fail ${scoreSummary.safetyFailureCases}; unscored ${scoreSummary.safetyUnscoredCases}. Missing proposals ${scoreSummary.missingProposalCases}; unexpected proposals ${scoreSummary.unexpectedProposalCases}.`, '', `Independent observations: ${JSON.stringify(observedCases)}`, '', `Failure codes: ${JSON.stringify(scoreSummary.failureCodes)}`, '', protocol.boundaries, '', '| sequence | case | assessed | passed | duration ms | failures |', '|---:|---|---|---|---:|---|', ...records.map(record => `| ${record.sequence} | ${record.id} | ${record.score?.assessed ?? false} | ${record.passed} | ${record.durationMs} | ${(record.score?.failures.join(', ') ?? record.errorCode ?? '').replaceAll('|','/')} |`)].join('\n');
    await writeFile(mdPath, md, { mode: 0o600 });
    console.log(JSON.stringify({ status: 'finished', runId, validRun: report.validRun, attemptedCases: records.length, plannedCases: metadata.caseCount, jsonPath, mdPath, jsonlPath, attemptsPath }));
    return report;
  } finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); await journal.close().catch(() => {}); await file.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) runG9().then(report => { if (report && (!report.validRun || report.records.some(record => !record.passed))) process.exitCode = 1; }).catch(() => { console.error('G9 configuration or execution failed; case content and credentials remain sealed.'); process.exitCode = 1; });
