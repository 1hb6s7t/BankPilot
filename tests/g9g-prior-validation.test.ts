import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { MODEL_ATTEMPT_PROTOCOL_VERSION, MODEL_STRUCTURED_OUTPUT_OBSERVATION_VERSION, type ModelAttemptObserver, type ModelAttemptStart, type ModelStructuredOutputObservation } from '../packages/agents/src/provider';
import type { PlanResult, PlannerInput } from '../packages/contracts/src/index';
import type { G9Manifest } from '../evals/g9-contract';
import { g9Dataset } from '../evals/g9-holdout-fixtures';
import { g9cQualityDataset } from '../evals/g9c-quality-fixtures';
import type { G9CQualityManifest } from '../scripts/evaluate-g9c-quality';
import { g9cProviderFingerprint } from '../scripts/evaluate-g9c';
import { buildG9GManifest, executeG9GStage, G9G_EVALUATOR_FILES } from '../scripts/evaluate-g9g';
import { verifyG9GPriorEvidence } from '../scripts/g9g-prior-validation';

const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const output = '{"synthetic":true}';
const config = { model: 'offline-g9g-prior-test', baseURL: 'https://offline.invalid/v1', outputMode: 'json_object' as const };
const paths: string[] = [];
let originalReport: any;
let originalPath: string;

async function offlinePlan(input: PlannerInput, observer: ModelAttemptObserver, _signal: AbortSignal,
  structuredObserver?: (event: Readonly<ModelStructuredOutputObservation>) => void): Promise<PlanResult> {
  const start: ModelAttemptStart = { type: 'attempt_start', protocolVersion: MODEL_ATTEMPT_PROTOCOL_VERSION,
    invocationId: randomUUID(), attemptId: randomUUID(), role: 'semantic_intent', attempt: 1,
    requestMaxOutputTokens: 4096, startedAtUtc: new Date().toISOString(), dispatch: 'pending' };
  await observer(start);
  const { type: _type, dispatch: _dispatch, ...identity } = start;
  await observer({ ...identity, type: 'attempt_end', endedAtUtc: new Date().toISOString(), durationMs: 1,
    requestStarted: true, status: 'success', httpStatus: 200, inputTokens: 12, outputTokens: 8 });
  structuredObserver?.({ version: MODEL_STRUCTURED_OUTPUT_OBSERVATION_VERSION, role: 'semantic_intent',
    toolName: 'interpret_banking_intent', attempt: 1, attemptId: start.attemptId, status: 'success',
    outputText: output, outputLength: output.length, outputDigest: hash(output) });
  return { taskId: input.taskId, planVersion: 1, mode: 'model', summary: '合成离线结果；未执行。',
    findings: [], evidence: [], suggestions: [], managementSuggestions: [], investmentSuggestions: [],
    events: [], modelRuns: [{ role: 'semantic_intent', model: 'offline-test', status: 'success', durationMs: 1,
      inputTokens: 12, outputTokens: 8 }], diagnostics: { domains: [], intent: { status: 'ready', roles: [], findings: [] } } };
}

async function cloneEvidence(): Promise<{ report: any; reportPath: string; directory: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'g9g-prior-clone-')); paths.push(directory);
  for (const name of ['cases.jsonl', 'attempts.jsonl', 'semantic-extraction.jsonl']) {
    await copyFile(join(dirname(originalPath), name), join(directory, name));
  }
  const report = structuredClone(originalReport);
  const reportPath = join(directory, 'report.json');
  report.jsonPath = reportPath;
  report.jsonlPath = join(directory, 'cases.jsonl');
  report.attemptsPath = join(directory, 'attempts.jsonl');
  report.semanticPath = join(directory, 'semantic-extraction.jsonl');
  const events = (await readFile(report.jsonlPath, 'utf8')).trimEnd().split('\n').map(line => JSON.parse(line));
  events[0].attemptsPath = report.attemptsPath;
  events[0].semanticPath = report.semanticPath;
  await writeFile(report.jsonlPath, `${events.map(event => JSON.stringify(event)).join('\n')}\n`);
  await writeFile(reportPath, JSON.stringify(report));
  return { report, reportPath, directory };
}

async function saveReport(report: any, path: string): Promise<void> { await writeFile(path, JSON.stringify(report)); }
async function changeCases(path: string, update: (rows: any[]) => void): Promise<void> {
  const rows = (await readFile(path, 'utf8')).trimEnd().split('\n').map(line => JSON.parse(line));
  update(rows);
  await writeFile(path, `${rows.map(row => JSON.stringify(row)).join('\n')}\n`);
}

beforeAll(async () => {
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('NETWORK_FORBIDDEN'); }));
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const [originalBytes, qualityBytes] = await Promise.all([readFile('evals/g9-manifest.json'), readFile('evals/g9c-quality-manifest.json')]);
  const original = JSON.parse(originalBytes.toString()) as G9Manifest;
  const qualityParent = JSON.parse(qualityBytes.toString()) as G9CQualityManifest;
  const evaluatorHashes = Object.fromEntries(G9G_EVALUATOR_FILES.map(path => [path, hash(path)]));
  const manifest = buildG9GManifest({ original, qualityParent, knownDataset: g9Dataset, qualityDataset: g9cQualityDataset,
    originalManifestSha256: hash(originalBytes), qualityParentManifestSha256: hash(qualityBytes),
    frozenAt: '2026-10-24T08:00:00.000Z', sourceManifestPath: 'evals/baselines/g9g-prior-offline/source-manifest.json',
    sourceManifestSha256: hash('offline-source'), evaluatorHashes, provider: g9cProviderFingerprint(config) });
  const directory = await mkdtemp(join(tmpdir(), 'g9g-prior-base-')); paths.push(directory);
  originalReport = await executeG9GStage({ dataset: g9Dataset, manifest, manifestHash: hash('offline-manifest'),
    cohort: 'known-regression', config, resultsDir: directory, verifyFrozenFiles: async () => true,
    semanticJsonl: true, plan: offlinePlan });
  originalPath = originalReport.jsonPath;
  expect(originalReport.validRun).toBe(true);
  expect(fetch).not.toHaveBeenCalled();
}, 60_000);
afterAll(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); await Promise.all(paths.map(path => rm(path, { recursive: true, force: true }))); });

describe('G9G prior-stage evidence verification against a real offline journal', () => {
  it('accepts the complete 36-case report and its adjacent artifacts', async () => {
    const { report, reportPath } = await cloneEvidence();
    await expect(verifyG9GPriorEvidence(report, g9Dataset, reportPath)).resolves.toBeUndefined();
  });
  it('rejects a forged per-case expected hash even when the case JSONL is changed too', async () => {
    const { report, reportPath, directory } = await cloneEvidence();
    report.records[0].expectedHash = hash('altered-label');
    await changeCases(join(directory, 'cases.jsonl'), rows => { rows[1].expectedHash = report.records[0].expectedHash; });
    await saveReport(report, reportPath);
    await expect(verifyG9GPriorEvidence(report, g9Dataset, reportPath)).rejects.toThrow('G9G_PRIOR_EVIDENCE_INVALID');
  });
  it('rejects a forged previous or current score and preserves the original scorer', async () => {
    for (const scoreField of ['score', 'previousContractScore', 'currentContractScore']) {
      const { report, reportPath, directory } = await cloneEvidence();
      report.records[0][scoreField].passed = !report.records[0][scoreField].passed;
      await changeCases(join(directory, 'cases.jsonl'), rows => { rows[1][scoreField] = report.records[0][scoreField]; });
      await saveReport(report, reportPath);
      await expect(verifyG9GPriorEvidence(report, g9Dataset, reportPath)).rejects.toThrow('G9G_PRIOR_EVIDENCE_INVALID');
    }
  });
  it('rejects a forged summary even when the JSONL footer agrees', async () => {
    const { report, reportPath, directory } = await cloneEvidence();
    report.currentScoreSummary.passedCases++;
    await changeCases(join(directory, 'cases.jsonl'), rows => { rows.at(-1).currentScoreSummary = report.currentScoreSummary; });
    await saveReport(report, reportPath);
    await expect(verifyG9GPriorEvidence(report, g9Dataset, reportPath)).rejects.toThrow('G9G_PRIOR_EVIDENCE_INVALID');
  });
  it('rejects missing or modified semantic trace lines and attempt identity drift', async () => {
    for (const problem of ['missing-trace', 'bad-digest', 'wrong-attempt', 'extra-attempt', 'bad-usage']) {
      const { report, reportPath, directory } = await cloneEvidence();
      if (problem === 'extra-attempt') {
        await changeCases(join(directory, 'attempts.jsonl'), rows => { rows.push({ ...rows[1], attemptId: randomUUID() }); });
      } else if (problem === 'bad-usage') {
        await changeCases(join(directory, 'attempts.jsonl'), rows => { rows[2].inputTokens = -1; });
      } else {
        const path = join(directory, 'semantic-extraction.jsonl');
        const rows = (await readFile(path, 'utf8')).trimEnd().split('\n').map(line => JSON.parse(line));
        if (problem === 'missing-trace') rows.pop();
        if (problem === 'bad-digest') rows[0].outputDigest = hash('wrong');
        if (problem === 'wrong-attempt') rows[0].attemptId = randomUUID();
        await writeFile(path, `${rows.map(row => JSON.stringify(row)).join('\n')}\n`);
      }
      await expect(verifyG9GPriorEvidence(report, g9Dataset, reportPath)).rejects.toThrow('G9G_PRIOR_EVIDENCE_INVALID');
    }
  });
  it('rejects disabled trace and header or footer divergence', async () => {
    for (const problem of ['disabled', 'header', 'footer']) {
      const { report, reportPath, directory } = await cloneEvidence();
      if (problem === 'disabled') { report.semanticTraceStatus = 'disabled'; await saveReport(report, reportPath); }
      else await changeCases(join(directory, 'cases.jsonl'), rows => {
        if (problem === 'header') rows[0].protocol.manifestSha256 = hash('wrong');
        else rows.at(-1).previousScoreSummary.passedCases++;
      });
      await expect(verifyG9GPriorEvidence(report, g9Dataset, reportPath)).rejects.toThrow('G9G_PRIOR_EVIDENCE_INVALID');
    }
  });
  it('rejects a changed dynamic snapshot grant binding', async () => {
    const index = g9Dataset.cases.findIndex(item => item.snapshotClock);
    expect(index).toBeGreaterThanOrEqual(0);
    const { report, reportPath, directory } = await cloneEvidence();
    report.records[index].snapshotClockBinding.queriedAt.resolved = '2026-01-01T00:00:00.000Z';
    await changeCases(join(directory, 'cases.jsonl'), rows => { rows[index + 1].snapshotClockBinding = report.records[index].snapshotClockBinding; });
    await saveReport(report, reportPath);
    await expect(verifyG9GPriorEvidence(report, g9Dataset, reportPath)).rejects.toThrow('G9G_PRIOR_EVIDENCE_INVALID');
  });
});
