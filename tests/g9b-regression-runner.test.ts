import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { PlanResult } from '../packages/contracts/src/index';
import { MODEL_ATTEMPT_PROTOCOL_VERSION, ModelProviderError, type ModelAttemptObserver, type ModelAttemptStart } from '../packages/agents/src/provider';
import { G9_CONTRACT_VERSION, G9_DOMAINS, validateG9Dataset, type G9Case, type G9Dataset, type G9Manifest } from '../evals/g9-contract';
import { G9_EVALUATOR_FILES, G9_LIMITS, G9_SOURCE_MANIFEST_PATH } from '../scripts/evaluate-g9';
import { executeG9BKnownRegression, G9B_EVALUATOR_FILES, G9B_ORIGINAL_MANIFEST_PATH, G9B_PROTOCOL_PATH, G9B_RUNNER_VERSION, g9bProviderFingerprint, runG9B, validateG9BManifestMetadata, verifyG9BCandidateSource, type G9BManifest } from '../scripts/evaluate-g9b';

// Independent calibration only: no import or read of any exposed G9 fixture, and no cloud or database calls.
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const directories: string[] = [];
async function temporaryDirectory() { const directory = await mkdtemp(join(tmpdir(),'g9b-calibration-')); directories.push(directory); return directory; }
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); await Promise.all(directories.splice(0).map(directory => rm(directory,{ recursive: true,force: true }))); });
const config = { model: 'local-calibration',baseURL: 'https://calibration.invalid/v1',outputMode: 'json_object' as const,thinkingMode: 'disabled' as const };
function calibrationDataset(): G9Dataset {
  return { version: 'g9b-calibration-only-v1',cases: G9_DOMAINS.flatMap(domain => Array.from({ length: 6 },(_,index): G9Case => ({
    id: `g9-calibration-${domain}-${index}`,domain,kind: index < 3 ? 'positive' : 'no_action',rationale: 'Offline authored calibration.',
    input: { taskId: `calibration-${domain}-${index}`,message: '独立测试输入。',referenceDate: '2026-10-24',accounts: [],payees: [] },
    expected: { semantic: { status: index < 3 ? 'ready' : 'no_action',recognizedRoles: index < 3 ? [domain] : [] },activatedRoles: index < 3 ? [domain] : [],
      successfulCallRoles: index < 3 ? ['semantic_intent',domain,'reviewer'] : ['semantic_intent'],businessClarification: false,transfers: [],management: [],redemptions: [] },
  }))) };
}
function manifests(dataset = calibrationDataset()) {
  const metadata = validateG9Dataset(dataset), fixtureHash = hash('fixture'), originalHash = hash('original');
  const evaluatorHashes = Object.fromEntries(G9B_EVALUATOR_FILES.map(path => [path,hash(path)]));
  const original: G9Manifest = { contractVersion: G9_CONTRACT_VERSION,datasetVersion: dataset.version,frozenAt: '2026-10-24T00:00:00.000Z',
    fixturePath: 'evals/calibration.ts',fixtureSha256: fixtureHash,caseIds: metadata.caseIds,caseCount: 36,positiveCount: metadata.positiveCount,domainCounts: metadata.domainCounts,
    sourceManifestPath: G9_SOURCE_MANIFEST_PATH,sourceManifestSha256: hash('original source'),evaluatorHashes: Object.fromEntries(G9_EVALUATOR_FILES.map(path => [path,evaluatorHashes[path]!])),
    preregistrationPath: 'docs/g9-preregistered-evaluation.md',preregistrationSha256: evaluatorHashes['docs/g9-preregistered-evaluation.md']!,provider: { model: config.model,outputMode: config.outputMode,baseURLSha256: hash(config.baseURL) },
    authorReview: { completedAt: '2026-10-23T23:00:00.000Z',independentFromImplementation: true,prohibitedSourcesNotRead: true,fixtureSha256: fixtureHash,contractSha256: evaluatorHashes['evals/g9-contract.ts']!,reviewPath: 'docs/calibration-review.json',reviewSha256: hash('review') } };
  const manifest: G9BManifest = { protocolVersion: G9B_RUNNER_VERSION,cohort: 'known-regression',frozenAt: '2026-10-24T01:00:00.000Z',
    originalManifestPath: G9B_ORIGINAL_MANIFEST_PATH,originalManifestSha256: originalHash,datasetVersion: dataset.version,fixturePath: original.fixturePath,fixtureSha256: fixtureHash,
    caseIds: metadata.caseIds,caseCount: 36,positiveCount: metadata.positiveCount,domainCounts: metadata.domainCounts,sourceManifestPath: 'evals/baselines/g9b-calibration/source-manifest.json',sourceManifestSha256: hash('source'),
    evaluatorHashes,protocolPath: G9B_PROTOCOL_PATH,protocolSha256: evaluatorHashes[G9B_PROTOCOL_PATH]!,provider: g9bProviderFingerprint(config),limits: G9_LIMITS };
  return { dataset,metadata,manifest,original,originalHash,fixtureHash,evaluatorHashes };
}
function calibrationResult(item: G9Case): PlanResult {
  return { taskId: item.input.taskId,planVersion: 1,mode: 'model',summary: '校准结果。',findings: [],evidence: [],suggestions: [],managementSuggestions: [],investmentSuggestions: [],
    events: item.expected.activatedRoles.map(role => ({ role,status: 'started',at: '2026-10-24T00:00:00.000Z',summary: '' })),
    modelRuns: item.expected.successfulCallRoles.map(role => ({ role,model: config.model,status: 'success',durationMs: 1,attempt: 1,requestMaxOutputTokens: role === 'semantic_intent' ? 4096 : 2048 })),
    diagnostics: { intent: { status: item.expected.semantic.status,roles: [...item.expected.semantic.recognizedRoles],findings: [] },domains: [] } };
}
async function emit(observer: ModelAttemptObserver, role: ModelAttemptStart['role'], success = true) {
  const start: ModelAttemptStart = { type: 'attempt_start',protocolVersion: MODEL_ATTEMPT_PROTOCOL_VERSION,invocationId: randomUUID(),attemptId: randomUUID(),role,attempt: 1,requestMaxOutputTokens: role === 'semantic_intent' ? 4096 : 2048,startedAtUtc: new Date().toISOString(),dispatch: 'pending' };
  await observer(start); const { dispatch: _dispatch,...identity } = start;
  await observer({ ...identity,type: 'attempt_end',endedAtUtc: new Date().toISOString(),durationMs: 1,requestStarted: true,status: success ? 'success' : 'failed',...(success ? {} : { errorCode: 'MODEL_HTTP_503',httpStatus: 503,failureStage: 'request' }) });
}
function quiet() { vi.spyOn(console,'log').mockImplementation(() => {}); vi.stubGlobal('fetch',vi.fn(() => { throw new Error('NETWORK_FORBIDDEN_IN_CALIBRATION'); })); }

describe('G9B known-regression entry point and public provider fingerprint', () => {
  it('requires explicit live and known-regression before reading a manifest', async () => {
    await expect(runG9B([])).rejects.toThrow('G9B_EXPLICIT_MODE_LIVE_REQUIRED');
    await expect(runG9B(['--mode','scripted','--known-regression'])).rejects.toThrow('G9B_EXPLICIT_MODE_LIVE_REQUIRED');
    await expect(runG9B(['--mode','live'])).rejects.toThrow('G9B_EXPLICIT_KNOWN_REGRESSION_REQUIRED');
    await expect(runG9B(['--preflight','--mode','live'])).rejects.toThrow('G9B_PREFLIGHT_HAS_NO_EXECUTION_MODE');
  });
  it.each(['--limit','--selection','--concurrency','--unseen','--first-run'])('rejects %s instead of silently changing the protocol', async option => { await expect(runG9B(['--mode','live','--known-regression',option,'1'])).rejects.toThrow('G9B_UNSUPPORTED_OR_DUPLICATE_OPTION'); });
  it('rejects duplicate and valueless options', async () => { await expect(runG9B(['--mode','live','--mode','live'])).rejects.toThrow('G9B_UNSUPPORTED_OR_DUPLICATE_OPTION'); await expect(runG9B(['--mode'])).rejects.toThrow('G9B_OPTION_VALUE_REQUIRED'); });
  it('distinguishes omitted thinking from explicit disabled without persisting credentials', () => {
    const omitted = g9bProviderFingerprint({ ...config,thinkingMode: undefined,apiKey: 'calibration-private' });
    expect(omitted.thinkingMode).toBe('omitted'); expect(g9bProviderFingerprint(config).thinkingMode).toBe('disabled'); expect(omitted).not.toEqual(g9bProviderFingerprint(config));
    expect(g9bProviderFingerprint({ ...config,thinkingMode: 'enabled' }).thinkingMode).toBe('enabled');
    expect(JSON.stringify(omitted)).not.toContain('calibration-private'); expect(JSON.stringify(omitted)).not.toContain(config.baseURL);
    expect(g9bProviderFingerprint({ ...config,baseURL: `${config.baseURL}/` })).toEqual(g9bProviderFingerprint(config));
  });
});
describe('G9B frozen manifest static calibration', () => {
  const validate = (data: ReturnType<typeof manifests>) => validateG9BManifestMetadata(data.manifest,data.original,data.dataset,data.originalHash,data.fixtureHash,data.evaluatorHashes,'2026-10-24T02:00:00.000Z');
  it('binds every original case, frozen evaluator, protocol, provider and production limit without a planner', () => { expect(validate(manifests()).caseCount).toBe(36); expect(G9B_EVALUATOR_FILES).toContain('packages/agents/src/attempt-journal.ts'); expect(G9B_EVALUATOR_FILES).toContain('scripts/evaluation-observation.ts'); });
  it.each(['cohort','original-manifest','fixture','case-order','subset','labels','evaluator','protocol','source-path','budget','thinking','extra-provider-field','future-freeze'])('rejects %s drift statically', issue => {
    const data = manifests(), item = data.manifest;
    if (issue === 'cohort') (item as any).cohort = 'first-run';
    if (issue === 'original-manifest') item.originalManifestSha256 = hash('changed');
    if (issue === 'fixture') item.fixtureSha256 = hash('changed');
    if (issue === 'case-order') item.caseIds = [...item.caseIds].reverse();
    if (issue === 'subset') item.caseIds = item.caseIds.slice(1);
    if (issue === 'labels') data.dataset.cases[0]!.expected.semantic.status = 'no_action';
    if (issue === 'evaluator') item.evaluatorHashes = { ...item.evaluatorHashes,'evals/g9-score.ts': hash('changed') };
    if (issue === 'protocol') item.protocolSha256 = hash('changed');
    if (issue === 'source-path') item.sourceManifestPath = G9_SOURCE_MANIFEST_PATH;
    if (issue === 'budget') item.limits = { ...G9_LIMITS,maxAttempts: 3 } as unknown as typeof G9_LIMITS;
    if (issue === 'thinking') (item.provider as any).thinkingMode = undefined;
    if (issue === 'extra-provider-field') (item.provider as any).apiKey = 'forbidden';
    if (issue === 'future-freeze') item.frozenAt = '2027-01-01T00:00:00.000Z';
    expect(() => validate(data)).toThrow(/^G9/);
  });
  it('rejects an evaluator closure that omits a required dependency', () => { const data = manifests(); delete data.evaluatorHashes['packages/agents/src/attempt-journal.ts']; data.manifest.evaluatorHashes = data.evaluatorHashes; expect(() => validate(data)).toThrow('G9B_FROZEN_MANIFEST_MISMATCH'); });
  it('preflights authored static files without execution mode, provider config, model requests or database access', async () => {
    const root = await temporaryDirectory(), data = manifests();
    const put = async (path: string,content: string) => { await mkdir(dirname(join(root,path)),{ recursive: true }); await writeFile(join(root,path),content); return hash(content); };
    for (const path of G9B_EVALUATOR_FILES) data.evaluatorHashes[path] = await put(path,path === 'package.json' ? JSON.stringify({ type: 'module' }) : `calibration static file ${path}`);
    data.fixtureHash = await put(data.manifest.fixturePath,`export const g9Dataset = ${JSON.stringify(data.dataset)};`);
    data.original.fixtureSha256 = data.fixtureHash; data.original.authorReview.fixtureSha256 = data.fixtureHash;
    data.original.evaluatorHashes = Object.fromEntries(G9_EVALUATOR_FILES.map(path => [path,data.evaluatorHashes[path]!]));
    data.original.preregistrationSha256 = data.evaluatorHashes[data.original.preregistrationPath]!;
    data.original.authorReview.contractSha256 = data.evaluatorHashes['evals/g9-contract.ts']!;
    data.original.authorReview.reviewSha256 = await put(data.original.authorReview.reviewPath,'Independent calibration review.');
    data.original.sourceManifestSha256 = await put(data.original.sourceManifestPath,JSON.stringify({ files: [] }));
    data.manifest.originalManifestSha256 = await put(G9B_ORIGINAL_MANIFEST_PATH,JSON.stringify(data.original));
    data.manifest.fixtureSha256 = data.fixtureHash; data.manifest.evaluatorHashes = data.evaluatorHashes; data.manifest.protocolSha256 = data.evaluatorHashes[G9B_PROTOCOL_PATH]!;
    await mkdir(join(root,'apps'),{ recursive: true });
    const source = { files: G9B_EVALUATOR_FILES.filter(path => /^(apps|packages)\//.test(path)).map(path => ({ path,sha256: data.evaluatorHashes[path]! })) };
    data.manifest.sourceManifestSha256 = await put(data.manifest.sourceManifestPath,JSON.stringify(source));
    const path = join(root,'evals/g9b-manifest.json'); await writeFile(path,JSON.stringify(data.manifest));
    const { stdout,stderr } = await promisify(execFile)(process.execPath,[resolve('node_modules/tsx/dist/cli.mjs'),resolve('scripts/evaluate-g9b.ts'),'--preflight','--manifest',path],{
      cwd: root,env: { ...process.env,BANKPILOT_MODEL_BASE_URL: '',BANKPILOT_MODEL_NAME: '',BANKPILOT_MODEL_THINKING: 'intentionally-invalid-to-prove-no-provider-read',DATABASE_URL: 'intentionally-invalid-to-prove-no-db-read' },timeout: 15000,
    });
    expect(stderr).toBe(''); expect(JSON.parse(stdout)).toMatchObject({ status: 'preflight-passed',cohort: 'known-regression',caseCount: 36,caseIds: data.manifest.caseIds });
  });
  it('detects new product files and changed/deleted sources in the candidate inventory', async () => {
    const root = await temporaryDirectory(), sourceManifestPath = 'evals/baselines/g9b-calibration/source-manifest.json';
    await mkdir(join(root,'apps','web','src'),{ recursive: true }); await mkdir(join(root,'packages')); await mkdir(dirname(join(root,sourceManifestPath)),{ recursive: true });
    const productPath = 'apps/web/src/original.ts'; await writeFile(join(root,productPath),'export {};');
    const source = JSON.stringify({ files: [{ path: productPath,sha256: hash('export {};') }] }); await writeFile(join(root,sourceManifestPath),source);
    const frozen = { sourceManifestPath,sourceManifestSha256: hash(source) }; await expect(verifyG9BCandidateSource(frozen,root)).resolves.toBeUndefined();
    await writeFile(join(root,'apps/web/src/new.ts'),'export {};'); await expect(verifyG9BCandidateSource(frozen,root)).rejects.toThrow('G9B_PRODUCT_INVENTORY_DRIFT');
    await rm(join(root,'apps/web/src/new.ts')); await writeFile(join(root,productPath),'changed'); await expect(verifyG9BCandidateSource(frozen,root)).rejects.toThrow('G9B_FROZEN_SOURCE_DRIFT');
    await rm(join(root,productPath)); await expect(verifyG9BCandidateSource(frozen,root)).rejects.toThrow('G9B_PRODUCT_INVENTORY_DRIFT');
  });
  it.each(['duplicate','traversal','bad-hash'])('rejects %s source manifest entries', async issue => {
    const root = await temporaryDirectory(), sourceManifestPath = 'evals/baselines/g9b-calibration/source-manifest.json'; await mkdir(dirname(join(root,sourceManifestPath)),{ recursive: true });
    const file = { path: issue === 'traversal' ? '../outside.ts' : 'apps/src/a.ts',sha256: issue === 'bad-hash' ? 'bad' : hash('source') };
    const source = JSON.stringify({ files: issue === 'duplicate' ? [file,file] : [file] }); await writeFile(join(root,sourceManifestPath),source);
    await expect(verifyG9BCandidateSource({ sourceManifestPath,sourceManifestSha256: hash(source) },root)).rejects.toThrow('G9B_SOURCE_MANIFEST_INVALID');
  });
});
describe('G9B offline durable orchestration using the unchanged G9 scorer and observer', () => {
  it('runs all 36 in original order, checks hashes before/after every case and preserves earlier artifacts across reruns', async () => {
    quiet(); const { dataset,manifest } = manifests(), resultsDir = await temporaryDirectory(), verifyFrozenFiles = vi.fn(async () => true), callOrder: string[] = [];
    let active = 0,peak = 0;
    const plan = async (input: G9Case['input'],observer: ModelAttemptObserver) => {
      active++; peak = Math.max(peak,active); callOrder.push(input.taskId); const item = dataset.cases.find(fixture => fixture.input.taskId === input.taskId)!;
      for (const role of item.expected.successfulCallRoles) await emit(observer,role); active--; return calibrationResult(item);
    };
    const report = await executeG9BKnownRegression({ dataset,manifest,manifestHash: hash('g9b manifest'),config,resultsDir,verifyFrozenFiles,plan });
    expect(report.validRun).toBe(true); expect(report.cohort).toBe('known-regression'); expect(report.knownRegression).toBe(true); expect(report.scoreSummary.passedCases).toBe(36); expect(peak).toBe(1);
    expect(callOrder).toEqual(dataset.cases.map(item => item.input.taskId)); expect(verifyFrozenFiles).toHaveBeenCalledTimes(74);
    const lines = (await readFile(report.jsonlPath,'utf8')).trim().split('\n').map(line => JSON.parse(line)); expect(lines).toHaveLength(38); expect(lines[0].type).toBe('start'); expect(lines.at(-1).type).toBe('finish');
    expect(lines.filter(line => line.type === 'case').map(line => line.id)).toEqual(manifest.caseIds); expect(report.observedAttempts.usage.outputTokensTotal).toBeNull();
    const originalBytes = await readFile(report.jsonPath,'utf8');
    const rerun = await executeG9BKnownRegression({ dataset,manifest,manifestHash: hash('g9b manifest'),config,resultsDir,verifyFrozenFiles,plan });
    expect(rerun.runId).not.toBe(report.runId); expect(rerun.jsonPath).not.toBe(report.jsonPath); expect(await readFile(report.jsonPath,'utf8')).toBe(originalBytes); expect(rerun.cohort).toBe('known-regression'); expect(fetch).not.toHaveBeenCalled();
  });
  it('stops before the first model call on pre-dispatch drift', async () => {
    quiet(); const { dataset,manifest } = manifests(), plan = vi.fn(), verifyFrozenFiles = vi.fn().mockResolvedValueOnce(true).mockRejectedValue(new Error('drift'));
    const report = await executeG9BKnownRegression({ dataset,manifest,manifestHash: hash('manifest'),config,resultsDir: await temporaryDirectory(),verifyFrozenFiles,plan });
    expect(plan).not.toHaveBeenCalled(); expect(report.sourceDrift).toBe(true); expect(report.validRun).toBe(false); expect(report.scoreSummary.unattemptedCases).toBe(36);
  });
  it('invalidates an already completed case when source drifts after its execution', async () => {
    quiet(); const { dataset,manifest } = manifests(), verifyFrozenFiles = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(true).mockRejectedValue(new Error('drift'));
    const report = await executeG9BKnownRegression({ dataset,manifest,manifestHash: hash('manifest'),config,resultsDir: await temporaryDirectory(),verifyFrozenFiles,plan: async (_input,observer) => { for (const role of dataset.cases[0]!.expected.successfulCallRoles) await emit(observer,role); return calibrationResult(dataset.cases[0]!); } });
    expect(report.records).toHaveLength(1); expect(report.records[0]).toMatchObject({ passed: false,evaluationValid: false,errorCode: 'G9B_FROZEN_FILE_DRIFT' }); expect(report.sourceDrift).toBe(true); expect(report.scoreSummary.unattemptedCases).toBe(35);
  });
  it('persists the interrupted case and stops subsequent cases on cancellation', async () => {
    quiet(); const { dataset,manifest } = manifests(), controller = new AbortController();
    const report = await executeG9BKnownRegression({ dataset,manifest,manifestHash: hash('manifest'),config,resultsDir: await temporaryDirectory(),verifyFrozenFiles: async () => true,signal: controller.signal,
      plan: async (_input,observer,signal) => { await emit(observer,'semantic_intent',false); controller.abort(); expect(signal.aborted).toBe(true); throw new ModelProviderError('MODEL_DEADLINE_EXCEEDED'); } });
    expect(report.records).toHaveLength(1); expect(report.stopped).toBe(true); expect(report.validRun).toBe(false); expect(report.records[0]!.errorCode).toBe('CASE_DEADLINE_EXCEEDED'); expect(report.scoreSummary).toMatchObject({ businessUnavailableCases: 1,safetyUnscoredCases: 1,unattemptedCases: 35 });
    expect((await readFile(report.jsonlPath,'utf8')).trim().split('\n').map(line => JSON.parse(line).type)).toEqual(['start','case','finish']);
  });
  it('preserves unavailable and unscored safety denominators across a complete provider-failure run', async () => {
    quiet(); const { dataset,manifest } = manifests();
    const report = await executeG9BKnownRegression({ dataset,manifest,manifestHash: hash('manifest'),config,resultsDir: await temporaryDirectory(),verifyFrozenFiles: async () => true,
      plan: async (_input,observer) => { await emit(observer,'semantic_intent',false); throw new ModelProviderError('MODEL_HTTP_503',true); } });
    expect(report.executionComplete).toBe(true); expect(report.validRun).toBe(true); expect(report.scoreSummary).toMatchObject({ passedCases: 0,businessUnavailableCases: 36,businessAssessedCases: 0,safetyPassCases: 0,safetyUnscoredCases: 36 }); expect(report.observedAttempts.failed).toBe(36);
  });
});
