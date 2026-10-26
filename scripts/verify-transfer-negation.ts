import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { createEvaluationPlanner, evaluationRoles, normalizeBaseURL, providerFromEnv } from '../packages/agents/src';
import { ablationModes, digest, outputBudget, scoreAblation } from '../evals/ablation-score';
import { holdoutFixtures } from '../evals/holdout-fixtures';

// A narrowly scoped, explicitly post-fix regression. Never replaces the first blind results.
const provider = providerFromEnv();
if (!provider) throw new Error('Explicit BankPilot cloud configuration required');
const fixture = holdoutFixtures.find(item => item.id === 'h07-transfer-negation')!;
const sourceFiles = ['packages/agents/src/index.ts', 'packages/agents/src/intent.ts', 'packages/agents/src/provider.ts', 'packages/contracts/src/index.ts', 'evals/holdout-fixtures.ts', 'evals/holdout-manifest.json', 'evals/ablation-score.ts', 'scripts/verify-transfer-negation.ts'];
const hashes = async () => Object.fromEntries(await Promise.all(sourceFiles.map(async file => [file, createHash('sha256').update(await readFile(file)).digest('hex')])));
const sourceHashes = await hashes();
const startedAt = new Date().toISOString();
const records = [];
for (const variant of ablationModes) {
  const input = structuredClone(fixture.input), controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120000);
  const budget = outputBudget(variant === 'single' ? 1 : evaluationRoles(input).length + (variant === 'parallel-review' ? 1 : 0));
  const start = performance.now();
  try {
    const result = await createEvaluationPlanner(variant, { provider: { ...provider, maxAttempts: 2, timeoutMs: 60000, maxOutputTokens: budget.maxOutputTokens, temperature: 0, signal: controller.signal } }).plan(input);
    const score = scoreAblation(fixture, result, variant, true);
    if (controller.signal.aborted) { score.passed = false; score.failures.push('CASE_DEADLINE_EXCEEDED'); }
    records.push({ variant, inputHash: digest(input), budget, durationMs: Math.round(performance.now() - start), score, result });
    console.log(JSON.stringify({ variant, passed: score.passed, failures: score.failures }));
  } catch {
    records.push({ variant, inputHash: digest(input), budget, durationMs: Math.round(performance.now() - start), errorCode: controller.signal.aborted ? 'CASE_DEADLINE_EXCEEDED' : 'REGRESSION_ERROR' });
  } finally { clearTimeout(timeout); }
}
const endHashes = await hashes();
const sourceDrift = sourceFiles.filter(file => sourceHashes[file] !== endHashes[file]);
const report = {
  startedAt, finishedAt: new Date().toISOString(), phase: 'G5 post-fix regression', caseId: fixture.id,
  provider: { baseURL: normalizeBaseURL(provider.baseURL), model: provider.model, outputMode: provider.outputMode ?? 'tools' },
  syntheticInputs: true, liveCalls: true, independentHoldout: false,
  note: 'Known h07 regression after the negation fix. One scheduled pass of each condition; no success-only reruns. This does not overwrite or improve the first frozen holdout score.',
  sourceHashes, endSourceHashes: endHashes, sourceDrift, passed: records.filter(record => record.score?.passed).length, records,
};
await mkdir('evals/results', { recursive: true });
const jsonPath = resolve('evals/results', `${startedAt.replace(/[:.]/g, '-')}-g5-negation-postfix-live.json`);
await writeFile(jsonPath, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ jsonPath, passed: report.passed, total: records.length, sourceDrift }));
if (sourceDrift.length || report.passed !== records.length) process.exitCode = 1;
