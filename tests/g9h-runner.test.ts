import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelProviderError, MODEL_ATTEMPT_PROTOCOL_VERSION, MODEL_STRUCTURED_OUTPUT_OBSERVATION_VERSION,
  type ModelAttemptObserver, type ModelAttemptStart, type ModelStructuredOutputObservation } from '../packages/agents/src/provider';
import { digest } from '../evals/ablation-score';
import { g9Dataset } from '../evals/g9-holdout-fixtures';
import { g9cQualityDataset } from '../evals/g9c-quality-fixtures';
import { g9gExpected } from '../evals/g9g-score';
import type { G9Manifest } from '../evals/g9-contract';
import type { G9CQualityManifest } from '../scripts/evaluate-g9c-quality';
import { g9cProviderFingerprint } from '../scripts/evaluate-g9c';
import { buildG9HManifest, executeG9HStage, G9H_EVALUATOR_FILES, G9H_PROTOCOL_PATH, runG9H,
  validateG9HManifestMetadata, type G9HManifest } from '../scripts/evaluate-g9h';
import { verifyG9HPriorEvidence } from '../scripts/g9h-prior-validation';

const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const config = { model: 'offline-g9h-calibration', baseURL: 'https://calibration.invalid/v1', outputMode: 'json_object' as const };
const directories: string[] = [];
const temp = async () => { const path = await mkdtemp(join(tmpdir(), 'g9h-runner-')); directories.push(path); return path; };
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

async function calibration() {
  const originalBytes = await readFile('evals/g9-manifest.json'), qualityBytes = await readFile('evals/g9c-quality-manifest.json');
  const original = JSON.parse(originalBytes.toString()) as G9Manifest, qualityParent = JSON.parse(qualityBytes.toString()) as G9CQualityManifest;
  const inputs = { original, qualityParent, knownDataset: g9Dataset, qualityDataset: g9cQualityDataset,
    originalManifestSha256: hash(originalBytes), qualityParentManifestSha256: hash(qualityBytes) };
  const evaluatorHashes = Object.fromEntries(G9H_EVALUATOR_FILES.map(path => [path, hash(path)]));
  const manifest = buildG9HManifest({ ...inputs, frozenAt: '2026-10-25T00:00:00.000Z',
    sourceManifestPath: 'evals/baselines/g9h-calibration/source-manifest.json', sourceManifestSha256: hash('source'),
    evaluatorHashes, provider: g9cProviderFingerprint(config) });
  return { inputs, evaluatorHashes, manifest };
}

async function failedAttempt(observer: ModelAttemptObserver, role: 'semantic_intent' | 'bills') {
  const start: ModelAttemptStart = { type: 'attempt_start', protocolVersion: MODEL_ATTEMPT_PROTOCOL_VERSION,
    invocationId: randomUUID(), attemptId: randomUUID(), role, attempt: 1, requestMaxOutputTokens: 4096,
    startedAtUtc: new Date().toISOString(), dispatch: 'pending' };
  await observer(start);
  const { type: _type, dispatch: _dispatch, ...identity } = start;
  await observer({ ...identity, type: 'attempt_end', endedAtUtc: new Date().toISOString(), durationMs: 1,
    requestStarted: true, status: 'failed', errorCode: role === 'bills' ? 'MODEL_OUTPUT_TRUNCATED' : 'MODEL_HTTP_503',
    failureStage: role === 'bills' ? 'output_json' : 'request', httpStatus: role === 'bills' ? 200 : 503 });
  return start.attemptId;
}
function trace(role: 'semantic_intent' | 'bills', attemptId: string): ModelStructuredOutputObservation {
  const outputText = '{"synthetic":true}';
  if (role === 'semantic_intent') return { version: MODEL_STRUCTURED_OUTPUT_OBSERVATION_VERSION, role,
    toolName: 'interpret_banking_intent', attempt: 1, attemptId, status: 'failed', errorCode: 'MODEL_HTTP_503', outputOmitted: 'not_text' };
  return { version: MODEL_STRUCTURED_OUTPUT_OBSERVATION_VERSION, role,
    toolName: role === 'bills' ? 'submit_domain_proposal' : 'interpret_banking_intent',
    attempt: 1, attemptId, status: 'failed', errorCode: 'MODEL_OUTPUT_TRUNCATED',
    outputText, outputLength: outputText.length, outputDigest: hash(outputText) };
}
function noNetwork() { vi.stubGlobal('fetch', vi.fn(() => { throw new Error('NETWORK_FORBIDDEN_IN_G9H_TEST'); })); vi.spyOn(console, 'log').mockImplementation(() => {}); }
async function oneBillCase(emitBill: (callback: ((event: Readonly<ModelStructuredOutputObservation>) => void) | undefined, id: string) => void) {
  const { manifest } = await calibration(), fixture = g9Dataset.cases.find(item => item.id === 'g9-card-06')!;
  const short = structuredClone(manifest) as G9HManifest, dataset = { ...g9Dataset, cases: [fixture] };
  short.cohorts.knownRegression.caseIds = [fixture.id]; short.cohorts.knownRegression.caseCount = 1 as 36;
  short.cohorts.knownRegression.templateInputsSha256 = digest([fixture.input]);
  short.cohorts.knownRegression.originalExpectedLabelsSha256 = digest([fixture.expected]);
  short.cohorts.knownRegression.currentExpectedLabelsSha256 = digest([g9gExpected(fixture)]);
  return executeG9HStage({ dataset, manifest: short, manifestHash: hash(`one-${randomUUID()}`), cohort: 'known-regression',
    config, resultsDir: await temp(), verifyFrozenFiles: async () => true, semanticJsonl: true, billJsonl: true,
    plan: async (_input, observer, _signal, structuredObserver) => {
      const semanticId = await failedAttempt(observer, 'semantic_intent'); structuredObserver?.(trace('semantic_intent', semanticId));
      const billId = await failedAttempt(observer, 'bills'); emitBill(structuredObserver, billId);
      throw new ModelProviderError('MODEL_OUTPUT_TRUNCATED');
    } });
}

describe('G9H frozen default triple-score contract', () => {
  it('binds unchanged 36+12 labels, provider defaults, prior verifier and bill trace implementation', async () => {
    const { inputs, evaluatorHashes, manifest } = await calibration();
    expect(validateG9HManifestMetadata(manifest, inputs, evaluatorHashes, '2026-10-25T01:00:00.000Z')).toMatchObject({ knownCount: 36, qualityCount: 12 });
    expect(manifest.provider).toMatchObject({ outputMode: 'json_object', reasoningEffort: 'omitted', thinkingMode: 'omitted' });
    expect(G9H_EVALUATOR_FILES).toEqual(expect.arrayContaining([
      'evals/g9g-score.ts', 'scripts/g9g-prior-validation.ts', 'scripts/g9h-prior-validation.ts',
      'packages/agents/src/bill-domain-assessment.ts', 'tests/g9h-bill-domain-assessment.test.ts',
      'playwright.g9h.config.ts', G9H_PROTOCOL_PATH,
    ]));
  });
  it('rejects drift and alternate run conditions before dispatch', async () => {
    const data = await calibration(); data.manifest.provider.reasoningEffort = 'none';
    expect(() => validateG9HManifestMetadata(data.manifest, data.inputs, data.evaluatorHashes, '2026-10-25T01:00:00.000Z')).toThrow('G9H_FROZEN_MANIFEST_MISMATCH');
    await expect(runG9H(['--mode', 'live', '--cohort', 'known-regression'])).rejects.toThrow('G9H_STRUCTURED_TRACES_REQUIRED');
    await expect(runG9H(['--mode', 'live', '--cohort', 'known-regression', '--semantic-jsonl'])).rejects.toThrow('G9H_STRUCTURED_TRACES_REQUIRED');
    await expect(runG9H(['--mode', 'live', '--cohort', 'known-regression', '--bill-jsonl', '--semantic-jsonl', '--condition', 'none'])).rejects.toThrow('G9H_UNSUPPORTED_OR_DUPLICATE_OPTION');
  });
  it('keeps a complete bill visible-output sidecar outside the report', async () => {
    noNetwork(); const report = await oneBillCase((callback, id) => callback?.(trace('bills', id)));
    expect(report.validRun).toBe(true); expect(report.semanticTraceStatus).toBe('complete'); expect(report.billTraceStatus).toBe('complete');
    expect(report.scoreSummary.plannedCases).toBe(1); expect(report.previousScoreSummary.plannedCases).toBe(1); expect(report.currentScoreSummary.plannedCases).toBe(1);
    const rows = (await readFile(report.billPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({ caseId: 'g9-card-06', role: 'bills', outputText: '{"synthetic":true}' });
    expect(JSON.stringify(report)).not.toContain('"synthetic":true'); expect(fetch).not.toHaveBeenCalled();
  });
  it('requires a complete same-manifest 36-case report before the 12-case stage', async () => {
    noNetwork(); const { manifest } = await calibration(), resultsDir = await temp(), manifestHash = hash('g9h-manifest');
    const plan = async (_input: unknown, observer: ModelAttemptObserver, _signal: AbortSignal,
      structuredObserver?: (event: Readonly<ModelStructuredOutputObservation>) => void) => {
      const id = await failedAttempt(observer, 'semantic_intent'); structuredObserver?.(trace('semantic_intent', id));
      throw new ModelProviderError('MODEL_HTTP_503', true);
    };
    const common = { manifest, manifestHash, config, resultsDir, verifyFrozenFiles: async () => true,
      semanticJsonl: true, billJsonl: true, plan };
    await expect(executeG9HStage({ ...common, dataset: g9cQualityDataset,
      cohort: 'development-supplemental' })).rejects.toThrow('G9H_PRIOR_STAGE_REQUIRED');
    const known = await executeG9HStage({ ...common, dataset: g9Dataset, cohort: 'known-regression' });
    expect(known.validRun).toBe(true); expect(known.billTraceStatus).toBe('complete');
    expect(await readFile(known.billPath, 'utf8')).toBe('');
    const quality = await executeG9HStage({ ...common, dataset: g9cQualityDataset,
      cohort: 'development-supplemental', priorReportPaths: { 'default-known': known.jsonPath } });
    expect(quality.validRun).toBe(true); expect(quality.scoreSummary.plannedCases).toBe(12);
    expect(quality.previousScoreSummary.plannedCases).toBe(12); expect(quality.currentScoreSummary.plannedCases).toBe(12);
    expect(quality.priorReportSha256['default-known']).toBe(hash(await readFile(known.jsonPath)));
    await expect(executeG9HStage({ ...common, dataset: g9Dataset, cohort: 'known-regression' })).rejects.toThrow('EEXIST');
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(['missing', 'duplicate', 'wrong-id', 'wrong-digest', 'bad-omission', 'non-string-output', 'wrong-status', 'wrong-tool', 'wrong-role'])('invalidates %s bill trace with no extra dispatch', async scenario => {
    noNetwork(); const report = await oneBillCase((callback, id) => {
      const value = trace('bills', id);
      if (scenario === 'missing') return;
      if (scenario === 'duplicate') { callback?.(value); callback?.(value); return; }
      if (scenario === 'wrong-id') { callback?.({ ...value, attemptId: randomUUID() }); return; }
      if (scenario === 'wrong-digest') { callback?.({ ...value, outputDigest: hash('wrong') }); return; }
      if (scenario === 'non-string-output') { callback?.({ ...value, outputText: null as unknown as string }); return; }
      if (scenario === 'wrong-status') { callback?.({ ...value, status: 'success', errorCode: undefined }); return; }
      if (scenario === 'wrong-tool') { callback?.({ ...value, toolName: 'unexpected_tool' }); return; }
      if (scenario === 'wrong-role') { callback?.({ ...value, role: 'card' }); return; }
      callback?.({ ...value, outputText: undefined, outputOmitted: 'not_text' });
    });
    expect(report.validRun).toBe(false); expect(report.billTraceStatus).toBe('incomplete');
    expect(report.records[0]).toMatchObject({ evaluationValid: false, errorCode: 'G9H_BILL_TRACE_INCOMPLETE' });
    expect(report.attemptObservation.confirmedStarts).toBe(2); expect(fetch).not.toHaveBeenCalled();
  });
  it('verifies the adjacent bill journal and rejects its mutation before a quality stage', async () => {
    noNetwork(); const report = await oneBillCase((callback, id) => callback?.(trace('bills', id)));
    const fixture = g9Dataset.cases.find(item => item.id === 'g9-card-06')!;
    const dataset = { ...g9Dataset, cases: [fixture] };
    await expect(verifyG9HPriorEvidence(report, dataset, report.jsonPath)).resolves.toBeUndefined();
    const row = JSON.parse(await readFile(report.billPath, 'utf8'));
    row.outputText = '{"synthetic":false}';
    await writeFile(report.billPath, JSON.stringify(row) + '\n');
    await expect(verifyG9HPriorEvidence(report, dataset, report.jsonPath)).rejects.toThrow('G9H_PRIOR_EVIDENCE_INVALID');
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([
    { omission: 'not_text', injected: null }, { omission: 'not_text', injected: { forged: true } },
    { omission: 'size_limit', injected: null }, { omission: 'size_limit', injected: { forged: true } },
  ])('rejects $omission bill output with extra non-string outputText in the prior evidence', async ({ omission, injected }) => {
    noNetwork(); const report = await oneBillCase((callback, id) => callback?.(trace('bills', id)));
    const fixture = g9Dataset.cases.find(item => item.id === 'g9-card-06')!;
    const row = JSON.parse(await readFile(report.billPath, 'utf8'));
    row.outputOmitted = omission;
    if (omission === 'not_text') { delete row.outputLength; delete row.outputDigest; }
    row.outputText = injected;
    await writeFile(report.billPath, JSON.stringify(row) + '\n');
    await expect(verifyG9HPriorEvidence(report, { ...g9Dataset, cases: [fixture] }, report.jsonPath)).rejects.toThrow('G9H_PRIOR_EVIDENCE_INVALID');
    expect(fetch).not.toHaveBeenCalled();
  });
});
