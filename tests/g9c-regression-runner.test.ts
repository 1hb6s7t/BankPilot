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
import { executeG9CKnownRegression, G9C_EVALUATOR_FILES, G9C_ORIGINAL_MANIFEST_PATH, G9C_PARENT_MANIFEST_PATH, G9C_PROTOCOL_PATH, G9C_RUNNER_VERSION, g9cProviderFingerprint, runG9C, validateG9CManifestMetadata, verifyG9CCandidateSource, verifyG9CFrozenFiles, type G9CManifest } from '../scripts/evaluate-g9c';

// Independent calibration only: no import or read of any exposed G9 fixture, and no cloud or database calls.
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const directories: string[] = [];
async function temporaryDirectory() { const directory = await mkdtemp(join(tmpdir(),'g9c-calibration-')); directories.push(directory); return directory; }
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); await Promise.all(directories.splice(0).map(directory => rm(directory,{ recursive: true,force: true }))); });
const config = { model: 'local-calibration',baseURL: 'https://calibration.invalid/v1',outputMode: 'json_object' as const,thinkingMode: 'disabled' as const };
function calibrationDataset(): G9Dataset {
  return { version: 'g9c-calibration-only-v1',cases: G9_DOMAINS.flatMap(domain => Array.from({ length: 6 },(_,index): G9Case => ({
    id: `g9-g9c-calibration-${domain}-${index}`,domain,kind: index < 3 ? 'positive' : 'no_action',rationale: 'Offline authored calibration.',
    input: { taskId: `g9c-calibration-${domain}-${index}`,message: 'G9C独立离线运行器校准输入。',referenceDate: '2026-10-24',accounts: [],payees: [] },
    expected: { semantic: { status: index < 3 ? 'ready' : 'no_action',recognizedRoles: index < 3 ? [domain] : [] },activatedRoles: index < 3 ? [domain] : [],
      successfulCallRoles: index < 3 ? ['semantic_intent',domain,'reviewer'] : ['semantic_intent'],businessClarification: false,transfers: [],management: [],redemptions: [] },
  }))) };
}
function manifests(dataset = calibrationDataset()) {
  const metadata = validateG9Dataset(dataset), fixtureHash = hash('fixture'), originalHash = hash('original');
  const evaluatorHashes = Object.fromEntries(G9C_EVALUATOR_FILES.map(path => [path,hash(path)]));
  const original: G9Manifest = { contractVersion: G9_CONTRACT_VERSION,datasetVersion: dataset.version,frozenAt: '2026-10-24T00:00:00.000Z',
    fixturePath: 'evals/calibration.ts',fixtureSha256: fixtureHash,caseIds: metadata.caseIds,caseCount: 36,positiveCount: metadata.positiveCount,domainCounts: metadata.domainCounts,
    sourceManifestPath: G9_SOURCE_MANIFEST_PATH,sourceManifestSha256: hash('original source'),evaluatorHashes: Object.fromEntries(G9_EVALUATOR_FILES.map(path => [path,evaluatorHashes[path]!])),
    preregistrationPath: 'docs/g9-preregistered-evaluation.md',preregistrationSha256: evaluatorHashes['docs/g9-preregistered-evaluation.md']!,provider: { model: config.model,outputMode: config.outputMode,baseURLSha256: hash(config.baseURL) },
    authorReview: { completedAt: '2026-10-23T23:00:00.000Z',independentFromImplementation: true,prohibitedSourcesNotRead: true,fixtureSha256: fixtureHash,contractSha256: evaluatorHashes['evals/g9-contract.ts']!,reviewPath: 'docs/calibration-review.json',reviewSha256: hash('review') } };
  const manifest: G9CManifest = { protocolVersion: G9C_RUNNER_VERSION,cohort: 'known-regression',frozenAt: '2026-10-24T01:00:00.000Z',
    originalManifestPath: G9C_ORIGINAL_MANIFEST_PATH,originalManifestSha256: originalHash,datasetVersion: dataset.version,fixturePath: original.fixturePath,fixtureSha256: fixtureHash,
    caseIds: metadata.caseIds,caseCount: 36,positiveCount: metadata.positiveCount,domainCounts: metadata.domainCounts,sourceManifestPath: 'evals/baselines/g9c-calibration/source-manifest.json',sourceManifestSha256: hash('source'),
    evaluatorHashes,protocolPath: G9C_PROTOCOL_PATH,protocolSha256: evaluatorHashes[G9C_PROTOCOL_PATH]!,provider: g9cProviderFingerprint(config),limits: G9_LIMITS };
  return { dataset,metadata,manifest,original,originalHash,fixtureHash,evaluatorHashes };
}
async function authoredStaticFiles() {
    const root = await temporaryDirectory(), data = manifests();
    const put = async (path: string,content: string) => { await mkdir(dirname(join(root,path)),{ recursive: true }); await writeFile(join(root,path),content); return hash(content); };
    for (const path of G9C_EVALUATOR_FILES) data.evaluatorHashes[path] = await put(path,path === 'package.json' ? JSON.stringify({ type: 'module' }) : `calibration static file ${path}`);
    data.fixtureHash = await put(data.manifest.fixturePath,`export const g9Dataset = ${JSON.stringify(data.dataset)};`);
    data.original.fixtureSha256 = data.fixtureHash; data.original.authorReview.fixtureSha256 = data.fixtureHash;
    data.original.evaluatorHashes = Object.fromEntries(G9_EVALUATOR_FILES.map(path => [path,data.evaluatorHashes[path]!]));
    data.original.preregistrationSha256 = data.evaluatorHashes[data.original.preregistrationPath]!;
    data.original.authorReview.contractSha256 = data.evaluatorHashes['evals/g9-contract.ts']!;
    data.original.authorReview.reviewSha256 = await put(data.original.authorReview.reviewPath,'Independent calibration review.');
    data.original.sourceManifestSha256 = await put(data.original.sourceManifestPath,JSON.stringify({ files: [] }));
    data.manifest.originalManifestSha256 = await put(G9C_ORIGINAL_MANIFEST_PATH,JSON.stringify(data.original));
    data.manifest.fixtureSha256 = data.fixtureHash; data.manifest.evaluatorHashes = data.evaluatorHashes; data.manifest.protocolSha256 = data.evaluatorHashes[G9C_PROTOCOL_PATH]!;
    await mkdir(join(root,'apps'),{ recursive: true });
    const source = { files: G9C_EVALUATOR_FILES.filter(path => /^(apps|packages)\//.test(path)).map(path => ({ path,sha256: data.evaluatorHashes[path]! })) };
    data.manifest.sourceManifestSha256 = await put(data.manifest.sourceManifestPath,JSON.stringify(source));
    const path = join(root,'evals/g9c-manifest.json'); await writeFile(path,JSON.stringify(data.manifest));
    return { root,data,path,manifestHash: hash(await readFile(path,'utf8')) };
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

describe('G9C known-regression entry point and public provider fingerprint', () => {
  it('requires explicit live and known-regression before reading a manifest', async () => {
    await expect(runG9C([])).rejects.toThrow('G9C_EXPLICIT_MODE_LIVE_REQUIRED');
    await expect(runG9C(['--mode','scripted','--known-regression'])).rejects.toThrow('G9C_EXPLICIT_MODE_LIVE_REQUIRED');
    await expect(runG9C(['--mode','live'])).rejects.toThrow('G9C_EXPLICIT_KNOWN_REGRESSION_REQUIRED');
    await expect(runG9C(['--preflight','--mode','live'])).rejects.toThrow('G9C_PREFLIGHT_HAS_NO_EXECUTION_MODE');
  });
  it.each(['--limit','--selection','--concurrency','--unseen','--first-run'])('rejects %s instead of silently changing the protocol', async option => { await expect(runG9C(['--mode','live','--known-regression',option,'1'])).rejects.toThrow('G9C_UNSUPPORTED_OR_DUPLICATE_OPTION'); });
  it('rejects duplicate and valueless options', async () => { await expect(runG9C(['--mode','live','--mode','live'])).rejects.toThrow('G9C_UNSUPPORTED_OR_DUPLICATE_OPTION'); await expect(runG9C(['--mode'])).rejects.toThrow('G9C_OPTION_VALUE_REQUIRED'); });
  it('distinguishes omitted thinking from explicit disabled without persisting credentials', () => {
    const omitted = g9cProviderFingerprint({ ...config,thinkingMode: undefined,apiKey: 'calibration-private' });
    expect(omitted.thinkingMode).toBe('omitted'); expect(g9cProviderFingerprint(config).thinkingMode).toBe('disabled'); expect(omitted).not.toEqual(g9cProviderFingerprint(config));
    expect(g9cProviderFingerprint({ ...config,thinkingMode: 'enabled' }).thinkingMode).toBe('enabled');
    expect(JSON.stringify(omitted)).not.toContain('calibration-private'); expect(JSON.stringify(omitted)).not.toContain(config.baseURL);
    expect(g9cProviderFingerprint({ ...config,baseURL: `${config.baseURL}/` })).toEqual(g9cProviderFingerprint(config));
  });
  it.each(['none','low','high','max'] as const)('binds explicit reasoning effort %s independently of thinkingMode', reasoningEffort => {
    const fingerprint = g9cProviderFingerprint({ ...config,reasoningEffort });
    expect(fingerprint).toMatchObject({ reasoningEffort,thinkingMode: 'disabled' });
    expect(fingerprint).not.toEqual(g9cProviderFingerprint(config));
    expect(g9cProviderFingerprint({ ...config,reasoningEffort,thinkingMode: undefined })).toMatchObject({ reasoningEffort,thinkingMode: 'omitted' });
  });
  it.each(['', 'medium', 'auto', null])('rejects unsupported reasoning effort %j rather than changing the dispatch', reasoningEffort => {
    expect(() => g9cProviderFingerprint({ ...config,reasoningEffort } as any)).toThrow('G9C_PROVIDER_CONFIG_INVALID');
  });
  it('records omitted effort explicitly and stores no provider credential in the fingerprint', () => {
    const value = g9cProviderFingerprint({ ...config,apiKey: 'g9c-private-calibration-value' });
    expect(value.reasoningEffort).toBe('omitted');
    expect(JSON.stringify(value)).not.toContain('g9c-private-calibration-value');
  });
});
describe('G9C frozen manifest static calibration', () => {
  const validate = (data: ReturnType<typeof manifests>) => validateG9CManifestMetadata(data.manifest,data.original,data.dataset,data.originalHash,data.fixtureHash,data.evaluatorHashes,'2026-10-24T02:00:00.000Z');
  it('binds every original case, frozen evaluator, protocol, provider and production limit without a planner', () => { expect(validate(manifests()).caseCount).toBe(36); expect(G9C_EVALUATOR_FILES).toContain('packages/agents/src/attempt-journal.ts'); expect(G9C_EVALUATOR_FILES).toContain('scripts/evaluation-observation.ts'); });
  it.each(['cohort','original-manifest','fixture','case-order','subset','labels','evaluator','protocol','source-path','budget','thinking','reasoning-effort','parent-path','parent-hash','parent-extra-field','extra-provider-field','future-freeze'])('rejects %s drift statically', issue => {
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
    if (issue === 'reasoning-effort') (item.provider as any).reasoningEffort = undefined;
    if (issue === 'parent-path') item.parentManifest = { path: 'evals/other.json' as any,sha256: hash('parent') };
    if (issue === 'parent-hash') item.parentManifest = { path: G9C_PARENT_MANIFEST_PATH,sha256: 'bad' };
    if (issue === 'parent-extra-field') (item as any).parentManifest = { path: G9C_PARENT_MANIFEST_PATH,sha256: hash('parent'),provider: {} };
    if (issue === 'extra-provider-field') (item.provider as any).apiKey = 'forbidden';
    if (issue === 'future-freeze') item.frozenAt = '2027-01-01T00:00:00.000Z';
    expect(() => validate(data)).toThrow(/^G9/);
  });
  it('rejects an evaluator closure that omits a required dependency', () => { const data = manifests(); delete data.evaluatorHashes['packages/agents/src/attempt-journal.ts']; data.manifest.evaluatorHashes = data.evaluatorHashes; expect(() => validate(data)).toThrow('G9C_FROZEN_MANIFEST_MISMATCH'); });
  it('preflights authored static files without execution mode, provider config, model requests or database access', async () => {
    const { root,data,path } = await authoredStaticFiles();
    const { stdout,stderr } = await promisify(execFile)(process.execPath,[resolve('node_modules/tsx/dist/cli.mjs'),resolve('scripts/evaluate-g9c.ts'),'--preflight','--manifest',path],{
      cwd: root,env: { ...process.env,BANKPILOT_MODEL_BASE_URL: '',BANKPILOT_MODEL_NAME: '',BANKPILOT_MODEL_THINKING: 'intentionally-invalid-to-prove-no-provider-read',BANKPILOT_MODEL_REASONING_EFFORT: 'intentionally-invalid-to-prove-no-provider-read',DATABASE_URL: 'intentionally-invalid-to-prove-no-db-read' },timeout: 15000,
    });
    expect(stderr).toBe(''); expect(JSON.parse(stdout)).toMatchObject({ status: 'preflight-passed',cohort: 'known-regression',caseCount: 36,caseIds: data.manifest.caseIds });
  });
  it('accepts optional G9B ancestry without requiring the current provider or dependency hashes to match historical values', async () => {
    const { root,data,path } = await authoredStaticFiles();
    const parent = { originalManifestPath: G9C_ORIGINAL_MANIFEST_PATH,originalManifestSha256: data.manifest.originalManifestSha256,fixtureSha256: data.manifest.fixtureSha256,
      provider: { model: 'historical-model',thinkingMode: 'omitted' },evaluatorHashes: { 'packages/agents/src/provider.ts': hash('historical provider bytes') } };
    const parentBytes = JSON.stringify(parent);
    await writeFile(join(root,G9C_PARENT_MANIFEST_PATH),parentBytes);
    data.manifest.parentManifest = { path: G9C_PARENT_MANIFEST_PATH,sha256: hash(parentBytes) };
    const bytes = JSON.stringify(data.manifest); await writeFile(path,bytes);
    // Static original metadata is independently validated against current immutable G9 scorer files.
    validateG9CManifestMetadata(data.manifest,data.original,data.dataset,data.manifest.originalManifestSha256,data.fixtureHash,data.evaluatorHashes,'2026-10-24T02:00:00.000Z');
    await expect(verifyG9CFrozenFiles(data.manifest,hash(bytes),path,root)).resolves.toBeUndefined();
    await writeFile(join(root,G9C_PARENT_MANIFEST_PATH),parentBytes + '\n');
    await expect(verifyG9CFrozenFiles(data.manifest,hash(bytes),path,root)).rejects.toThrow('G9C_PARENT_MANIFEST_DRIFT');
  });
  it('rejects a correctly hashed parent belonging to different original labels', async () => {
    const { root,data,path } = await authoredStaticFiles();
    const parentBytes = JSON.stringify({ originalManifestPath: G9C_ORIGINAL_MANIFEST_PATH,originalManifestSha256: hash('different original'),fixtureSha256: data.manifest.fixtureSha256 });
    await writeFile(join(root,G9C_PARENT_MANIFEST_PATH),parentBytes);
    data.manifest.parentManifest = { path: G9C_PARENT_MANIFEST_PATH,sha256: hash(parentBytes) };
    const bytes = JSON.stringify(data.manifest); await writeFile(path,bytes);
    await expect(verifyG9CFrozenFiles(data.manifest,hash(bytes),path,root)).rejects.toThrow('G9C_PARENT_LINEAGE_MISMATCH');
  });
  it('detects a changed current evaluator dependency even when historical ancestry is not selected', async () => {
    const { root,data,path,manifestHash } = await authoredStaticFiles();
    await expect(verifyG9CFrozenFiles(data.manifest,manifestHash,path,root)).resolves.toBeUndefined();
    await writeFile(join(root,'packages/agents/src/provider.ts'),'changed current provider');
    await expect(verifyG9CFrozenFiles(data.manifest,manifestHash,path,root)).rejects.toThrow('G9C_FROZEN_FILE_DRIFT');
  });
  it('detects new product files and changed/deleted sources in the candidate inventory', async () => {
    const root = await temporaryDirectory(), sourceManifestPath = 'evals/baselines/g9c-calibration/source-manifest.json';
    await mkdir(join(root,'apps','web','src'),{ recursive: true }); await mkdir(join(root,'packages')); await mkdir(dirname(join(root,sourceManifestPath)),{ recursive: true });
    const productPath = 'apps/web/src/original.ts'; await writeFile(join(root,productPath),'export {};');
    const source = JSON.stringify({ files: [{ path: productPath,sha256: hash('export {};') }] }); await writeFile(join(root,sourceManifestPath),source);
    const frozen = { sourceManifestPath,sourceManifestSha256: hash(source) }; await expect(verifyG9CCandidateSource(frozen,root)).resolves.toBeUndefined();
    await writeFile(join(root,'apps/web/src/new.ts'),'export {};'); await expect(verifyG9CCandidateSource(frozen,root)).rejects.toThrow('G9C_PRODUCT_INVENTORY_DRIFT');
    await rm(join(root,'apps/web/src/new.ts')); await writeFile(join(root,productPath),'changed'); await expect(verifyG9CCandidateSource(frozen,root)).rejects.toThrow('G9C_FROZEN_SOURCE_DRIFT');
    await rm(join(root,productPath)); await expect(verifyG9CCandidateSource(frozen,root)).rejects.toThrow('G9C_PRODUCT_INVENTORY_DRIFT');
  });
  it.each(['duplicate','traversal','bad-hash'])('rejects %s source manifest entries', async issue => {
    const root = await temporaryDirectory(), sourceManifestPath = 'evals/baselines/g9c-calibration/source-manifest.json'; await mkdir(dirname(join(root,sourceManifestPath)),{ recursive: true });
    const file = { path: issue === 'traversal' ? '../outside.ts' : 'apps/src/a.ts',sha256: issue === 'bad-hash' ? 'bad' : hash('source') };
    const source = JSON.stringify({ files: issue === 'duplicate' ? [file,file] : [file] }); await writeFile(join(root,sourceManifestPath),source);
    await expect(verifyG9CCandidateSource({ sourceManifestPath,sourceManifestSha256: hash(source) },root)).rejects.toThrow('G9C_SOURCE_MANIFEST_INVALID');
  });
});
describe('G9C offline durable orchestration using the unchanged G9 scorer and observer', () => {
  it('runs all 36 in original order, checks hashes before/after every case and preserves earlier artifacts across reruns', async () => {
    quiet(); const { dataset,manifest } = manifests(), resultsDir = await temporaryDirectory(), verifyFrozenFiles = vi.fn(async () => true), callOrder: string[] = [];
    let active = 0,peak = 0;
    const plan = async (input: G9Case['input'],observer: ModelAttemptObserver) => {
      active++; peak = Math.max(peak,active); callOrder.push(input.taskId); const item = dataset.cases.find(fixture => fixture.input.taskId === input.taskId)!;
      for (const role of item.expected.successfulCallRoles) await emit(observer,role); active--; return calibrationResult(item);
    };
    const report = await executeG9CKnownRegression({ dataset,manifest,manifestHash: hash('g9c manifest'),config,resultsDir,verifyFrozenFiles,plan });
    expect(report.validRun).toBe(true); expect(report.cohort).toBe('known-regression'); expect(report.knownRegression).toBe(true); expect(report.scoreSummary.passedCases).toBe(36); expect(peak).toBe(1);
    expect(report.runId).toMatch(/^\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z-[0-9a-f-]{36}$/);
    expect(report.provider).toMatchObject({ thinkingMode: 'disabled',reasoningEffort: 'omitted' });
    expect(callOrder).toEqual(dataset.cases.map(item => item.input.taskId)); expect(verifyFrozenFiles).toHaveBeenCalledTimes(74);
    const lines = (await readFile(report.jsonlPath,'utf8')).trim().split('\n').map(line => JSON.parse(line)); expect(lines).toHaveLength(38); expect(lines[0].type).toBe('start'); expect(lines.at(-1).type).toBe('finish');
    expect(lines.filter(line => line.type === 'case').map(line => line.id)).toEqual(manifest.caseIds); expect(report.observedAttempts.usage.outputTokensTotal).toBeNull();
    const originalBytes = await readFile(report.jsonPath,'utf8');
    const rerun = await executeG9CKnownRegression({ dataset,manifest,manifestHash: hash('g9c manifest'),config,resultsDir,verifyFrozenFiles,plan });
    expect(rerun.runId).not.toBe(report.runId); expect(rerun.jsonPath).not.toBe(report.jsonPath); expect(await readFile(report.jsonPath,'utf8')).toBe(originalBytes); expect(rerun.cohort).toBe('known-regression'); expect(fetch).not.toHaveBeenCalled();
  });
  it('rejects an execution reasoning-effort mismatch before planning or creating result files', async () => {
    quiet(); const { dataset,manifest } = manifests(), plan = vi.fn();
    await expect(executeG9CKnownRegression({ dataset,manifest,manifestHash: hash('manifest'),config: { ...config,reasoningEffort: 'none' },resultsDir: await temporaryDirectory(),verifyFrozenFiles: async () => true,plan })).rejects.toThrow('G9C_EXECUTION_CONTRACT_MISMATCH');
    expect(plan).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });
  it('stops before the first model call on pre-dispatch drift', async () => {
    quiet(); const { dataset,manifest } = manifests(), plan = vi.fn(), verifyFrozenFiles = vi.fn().mockResolvedValueOnce(true).mockRejectedValue(new Error('drift'));
    const report = await executeG9CKnownRegression({ dataset,manifest,manifestHash: hash('manifest'),config,resultsDir: await temporaryDirectory(),verifyFrozenFiles,plan });
    expect(plan).not.toHaveBeenCalled(); expect(report.sourceDrift).toBe(true); expect(report.validRun).toBe(false); expect(report.scoreSummary.unattemptedCases).toBe(36);
  });
  it('invalidates an already completed case when source drifts after its execution', async () => {
    quiet(); const { dataset,manifest } = manifests(), verifyFrozenFiles = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(true).mockRejectedValue(new Error('drift'));
    const report = await executeG9CKnownRegression({ dataset,manifest,manifestHash: hash('manifest'),config,resultsDir: await temporaryDirectory(),verifyFrozenFiles,plan: async (_input,observer) => { for (const role of dataset.cases[0]!.expected.successfulCallRoles) await emit(observer,role); return calibrationResult(dataset.cases[0]!); } });
    expect(report.records).toHaveLength(1); expect(report.records[0]).toMatchObject({ passed: false,evaluationValid: false,errorCode: 'G9C_FROZEN_FILE_DRIFT' }); expect(report.sourceDrift).toBe(true); expect(report.scoreSummary.unattemptedCases).toBe(35);
  });
  it('persists the interrupted case and stops subsequent cases on cancellation', async () => {
    quiet(); const { dataset,manifest } = manifests(), controller = new AbortController();
    const report = await executeG9CKnownRegression({ dataset,manifest,manifestHash: hash('manifest'),config,resultsDir: await temporaryDirectory(),verifyFrozenFiles: async () => true,signal: controller.signal,
      plan: async (_input,observer,signal) => { await emit(observer,'semantic_intent',false); controller.abort(); expect(signal.aborted).toBe(true); throw new ModelProviderError('MODEL_DEADLINE_EXCEEDED'); } });
    expect(report.records).toHaveLength(1); expect(report.stopped).toBe(true); expect(report.validRun).toBe(false); expect(report.records[0]!.errorCode).toBe('CASE_DEADLINE_EXCEEDED'); expect(report.scoreSummary).toMatchObject({ businessUnavailableCases: 1,safetyUnscoredCases: 1,unattemptedCases: 35 });
    expect((await readFile(report.jsonlPath,'utf8')).trim().split('\n').map(line => JSON.parse(line).type)).toEqual(['start','case','finish']);
  });
  it('preserves unavailable and unscored safety denominators across a complete provider-failure run', async () => {
    quiet(); const { dataset,manifest } = manifests();
    const report = await executeG9CKnownRegression({ dataset,manifest,manifestHash: hash('manifest'),config,resultsDir: await temporaryDirectory(),verifyFrozenFiles: async () => true,
      plan: async (_input,observer) => { await emit(observer,'semantic_intent',false); throw new ModelProviderError('MODEL_HTTP_503',true); } });
    expect(report.executionComplete).toBe(true); expect(report.validRun).toBe(true); expect(report.scoreSummary).toMatchObject({ passedCases: 0,businessUnavailableCases: 36,businessAssessedCases: 0,safetyPassCases: 0,safetyUnscoredCases: 36 }); expect(report.observedAttempts.failed).toBe(36);
  });
});
