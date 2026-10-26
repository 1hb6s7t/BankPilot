import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runEvaluation } from '../scripts/evaluate-model';
import { hasPriorLiveExposureAcross, runG7 } from '../scripts/evaluate-g7';
import { runAblation } from '../scripts/evaluate-ablation';
import { EVALUATION_OBSERVATION_VERSION } from '../scripts/evaluation-observation';

const directories: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function output() { const directory = await mkdtemp(join(tmpdir(), 'bankpilot-g8g-entry-')); directories.push(directory); return directory; }
async function artifacts(directory: string) {
  const files = await readdir(directory);
  const casesPath = files.find(file => file.endsWith('.jsonl') && !file.endsWith('.attempts.jsonl'))!;
  const attemptsPath = files.find(file => file.endsWith('.attempts.jsonl'))!;
  expect(casesPath).toBeDefined(); expect(attemptsPath).toBeDefined();
  const parse = async (file: string) => (await readFile(join(directory, file), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  return { files, cases: await parse(casesPath), attempts: await parse(attemptsPath) };
}
function prohibitNetwork() {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { throw new Error('Unexpected network in scripted evaluation'); });
}
const dependencyFiles = ['scripts/evaluation-observation.ts', 'packages/agents/src/planning-failures.ts', 'packages/agents/src/stage-recovery.ts',
  'packages/agents/src/card-locator.ts', 'packages/agents/src/budget.ts', 'packages/agents/src/bills.ts', 'packages/agents/src/semantic-intent.ts', 'packages/agents/src/attempt-journal.ts'];

describe('G8G actual evaluation entry artifacts without a provider or database', () => {
  it.each([
    { label: 'canonical history has exposure and output is empty', canonicalExposed: true, outputExposed: false, expected: true },
    { label: 'output has exposure and canonical history is empty', canonicalExposed: false, outputExposed: true, expected: true },
    { label: 'neither directory has exposure', canonicalExposed: false, outputExposed: false, expected: false },
  ])('retains reserved exposure when $label', async ({ canonicalExposed, outputExposed, expected }) => {
    const canonical = await output(), alternate = await output();
    const event = JSON.stringify({ type: 'start', mode: 'live', protocol: { fixtureVersion: 'independent-exposure-v1', caseIds: ['reserved-case'] } }) + '\n';
    if (canonicalExposed) await writeFile(join(canonical, 'prior.jsonl'), event);
    if (outputExposed) await writeFile(join(alternate, 'prior.jsonl'), event);
    expect(await hasPriorLiveExposureAcross([canonical, alternate, join(canonical, '.')], ['reserved-case'], 'independent-exposure-v1')).toBe(expected);
  });

  it.each(['finance', 'management', 'phase4'])('journals claimed case identities and unchanged returned-plan statistics for %s', async suite => {
    const fetch = prohibitNetwork(), directory = await output();
    const report = await runEvaluation(['--mode', 'scripted', '--suite', suite, '--limit', '2', '--concurrency', '2'], { resultsDir: directory });
    expect(fetch).not.toHaveBeenCalled();
    expect(report.complete).toBe(true); expect(report.records).toHaveLength(2);
    expect(report.records.map(record => [record.sequence, record.id])).toEqual(report.caseIds.map((id, i) => [i + 1, id]));
    expect(report.modelCallsSource).toBe('returned-plan-model-runs');
    expect(report).toMatchObject({ maxAttempts: 2, maxStructureRepairs: 1, providerTimeoutMs: 60000,
      temperature: null, temperatureMeaning: 'provider-default; temperature omitted from HTTP body' });
    expect(report.modelCalls.total).toBe(report.records.reduce((sum, record) => sum + (record.result?.modelRuns?.length ?? 0), 0));
    expect(report.observedAttempts).toMatchObject({ applicable: false, complete: true, verified: null, reason: 'scripted-zero-calls', confirmedStarts: 0, confirmedEnds: 0 });
    expect(report.observedCases.cases).toBe(2);
    expect(report.observedCases.scoredCases + report.observedCases.unscoredCases).toBe(2);
    expect(report.passed + report.failed).toBe(2);
    expect(report.sourceDrift).toEqual([]);
    for (const file of dependencyFiles) expect(report.sourceHashes[file]).toBe(report.endSourceHashes[file]);
    const saved = await artifacts(directory);
    expect(saved.cases[0]).toMatchObject({ type: 'start', protocol: { evaluationObservationVersion: EVALUATION_OBSERVATION_VERSION } });
    expect(saved.cases.slice(1).map(record => record.sequence).sort()).toEqual([1, 2]);
    expect(saved.attempts).toHaveLength(1); expect(saved.attempts[0].type).toBe('journal_start');
    expect(JSON.parse(await readFile(join(directory, saved.files.find(file => file.endsWith('.json'))!), 'utf8')).records).toEqual(report.records);
  });

  it('preserves G7 scoring protocol while recording a separate observation protocol and hash coverage', async () => {
    const fetch = prohibitNetwork(), directory = await output();
    const report = await runG7(['--mode', 'scripted', '--selection', 'pilot'], { resultsDir: directory });
    expect(fetch).not.toHaveBeenCalled(); expect(report.complete).toBe(true); expect(report.records).toHaveLength(12);
    expect(report.protocolVersion).toBe('g7-semantic-eval-v3-success-cardinality-budget-caps');
    expect(report.maxStructureRepairs).toBe(1);
    expect(report.evaluationObservationVersion).toBe(EVALUATION_OBSERVATION_VERSION);
    expect(report.semanticEvaluation).toBe(false); expect(report.observedAttempts.applicable).toBe(false);
    expect(report.observedCases.complete).toBe(true); expect(report.sourceDrift).toEqual([]);
    for (const file of dependencyFiles) expect(report.sourceHashes[file]).toBe(report.endSourceHashes[file]);
    const saved = await artifacts(directory);
    expect(saved.cases.slice(1).map(record => record.id)).toEqual(report.caseIds);
    expect(saved.attempts).toHaveLength(1);
  });

  it('keeps every ablation variant/repeat separate without creating model attempts', async () => {
    const fetch = prohibitNetwork(), directory = await output();
    const report = await runAblation(['--mode', 'scripted', '--selection', 'pilot', '--topology', 'comparison', '--repeats', '2'], undefined, { resultsDir: directory });
    expect(fetch).not.toHaveBeenCalled(); expect(report.complete).toBe(true);
    expect(report.records).toHaveLength(report.caseIds.length * 3 * 2);
    expect(report.maxStructureRepairs).toBe(1);
    expect(report.budgetAllocation).toContain('at most 1 structural regeneration');
    expect(new Set(report.records.map(record => record.sequence)).size).toBe(report.records.length);
    expect(new Set(report.records.map(record => `${record.id}:${record.repeat}:${record.variant}`)).size).toBe(report.records.length);
    expect(report.observedCases.attempts.confirmedStarts).toBe(0);
    expect(report.observedAttempts).toMatchObject({ applicable: false, complete: true, verified: null });
    expect(report.sourceDrift).toEqual([]);
    for (const file of dependencyFiles) expect(report.sourceHashes[file]).toBe(report.endSourceHashes[file]);
    for (const variant of Object.values(report.byVariant)) { expect(variant.modelCallsSource).toBe('returned-plan-model-runs'); expect(variant.modelAttempts).toBe(0); }
    const saved = await artifacts(directory);
    expect(saved.cases.slice(1).map(record => record.sequence)).toEqual(report.records.map(record => record.sequence));
    expect(saved.attempts).toHaveLength(1);
  });
});
