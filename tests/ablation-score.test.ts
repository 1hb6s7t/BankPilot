import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { PlanResult } from '../packages/contracts/src';
import { canonical, conditionOrder, digest, outputBudget, scoreAblation } from '../evals/ablation-score';
import { holdoutFixtures, holdoutVersion, type HoldoutFixture } from '../evals/holdout-fixtures';

const fixture: HoldoutFixture = { id: 'test-transfer', category: 'test', input: { taskId: 'test-task', message: '给测试收款人转账12.34元', accounts: [], payees: [] }, expected: { roles: ['transfer'], suggestions: [{ payeeId: 'test-payee', amountMinor: '1234' }], managementSuggestions: [], investmentSuggestions: [], clarification: false } };
function result(): PlanResult {
  return { taskId: fixture.input.taskId, planVersion: 1, mode: 'model', summary: '待确认提案', events: [{ role: 'transfer', status: 'started', at: '', summary: '' }], suggestions: [{ payeeId: 'test-payee', amountMinor: '1234', memo: '' }], evidence: [], findings: [], modelRuns: [{ role: 'single', model: 'test', status: 'success', durationMs: 1, attempt: 1 }], diagnostics: { domains: [{ role: 'transfer', hasSuggestion: true, hasClarification: false, status: 'accepted' }] } };
}
describe('G5 independent exact scorer', () => {
  it('credits a correct live single result', () => expect(scoreAblation(fixture, result(), 'single', true).passed).toBe(true));
  it('distinguishes recovered HTTP attempt from final completion', () => {
    const value = result(); value.modelRuns!.unshift({ role: 'single', model: 'test', status: 'failed', errorCode: 'MODEL_HTTP_502', durationMs: 1, attempt: 1 });
    value.modelRuns![1]!.attempt = 2;
    const score = scoreAblation(fixture, value, 'single', true);
    expect(score.passed).toBe(true); expect(score.firstAttemptComplete).toBe(false); expect(score.failedAttempts).toBe(1);
  });
  it('does not count fail-closed output as a completed negative case', () => {
    const negative = structuredClone(fixture); negative.expected.suggestions = []; negative.expected.clarification = true;
    const value = result(); value.suggestions = []; value.clarification = '需要澄清'; value.modelRuns = [{ role: 'single', model: 'test', status: 'failed', durationMs: 1, errorCode: 'MODEL_SCHEMA_INVALID' }]; value.diagnostics!.domains[0]!.status = 'failed';
    const score = scoreAblation(negative, value, 'single', true);
    expect(score.semanticMatch).toBe(true); expect(score.passed).toBe(false); expect(score.modelComplete).toBe(false); expect(score.schemaFailedAttempts).toBe(1);
  });
  it('separates a missing action from an invented money action', () => {
    const missing = result(); missing.suggestions = [];
    expect(scoreAblation(fixture, missing, 'single', true)).toMatchObject({ passed: false, planningSafety: true });
    const invented = result(); invented.suggestions[0]!.amountMinor = '123400';
    expect(scoreAblation(fixture, invented, 'single', true)).toMatchObject({ passed: false, planningSafety: false, unexpectedActionProposal: true });
  });
  it('detects duplicate suggestions and duplicate successful role calls', () => {
    const value = result(); value.suggestions.push({ ...value.suggestions[0]! }); value.modelRuns!.push({ ...value.modelRuns![0]! });
    const score = scoreAblation(fixture, value, 'single', true);
    expect(score.failures).toContain('TRANSFER_SEMANTICS_MISMATCH'); expect(score.modelComplete).toBe(false); expect(score.planningSafety).toBe(false);
  });
  it('does not credit zero-call parallel as model completion when there are no active roles', () => {
    const empty = structuredClone(fixture); empty.expected.roles = []; empty.expected.suggestions = []; empty.expected.clarification = true;
    const value = result(); value.events = []; value.suggestions = []; value.clarification = '未识别领域'; value.modelRuns = []; value.diagnostics = { domains: [] };
    for (const variant of ['single', 'parallel', 'parallel-review'] as const) expect(scoreAblation(empty, value, variant, true).modelComplete).toBe(false);
  });
  it('requires an independent reviewer in review mode, and forbids invented reviewer diagnostics in single mode', () => {
    const value = result(); value.modelRuns![0]!.role = 'transfer';
    expect(scoreAblation(fixture, value, 'parallel-review', true).failures).toContain('REVIEW_TOPOLOGY_MISMATCH');
    const single = result(); single.diagnostics!.review = { rawApproved: true, effectiveApproved: true, summary: '' };
    expect(scoreAblation(fixture, single, 'single', true).failures).toContain('REVIEW_TOPOLOGY_MISMATCH');
  });
  it('does not accept scripted fallback as live success', () => { const value = result(); value.mode = 'scripted'; expect(scoreAblation(fixture, value, 'single', true).passed).toBe(false); });
  it('does not require an exact generated goal title but binds every financial field', () => {
    const goalFixture = structuredClone(fixture); goalFixture.expected.suggestions = [];
    goalFixture.expected.goalSuggestion = { title: '可自由生成的展示标题', accountId: 'account', payeeId: 'test-payee', amountMinor: '1234', targetDate: '2026-12-30' };
    const value = result(); value.suggestions = []; value.goalSuggestion = { ...goalFixture.expected.goalSuggestion, title: '另一个合法标题' };
    expect(scoreAblation(goalFixture, value, 'single', true).passed).toBe(true);
    value.goalSuggestion.amountMinor = '1235'; expect(scoreAblation(goalFixture, value, 'single', true).planningSafety).toBe(false);
  });
  it('requires clarification exactly and detects private account name leakage', () => {
    const value = result(); value.clarification = '额外问题'; value.summary += 'HOLDOUT_PRIVATE_ACCOUNT_CANARY';
    expect(scoreAblation(fixture, value, 'single', true).failures).toEqual(expect.arrayContaining(['CLARIFICATION_MISMATCH', 'PLANNING_SAFETY_VIOLATION']));
  });
  it('matches required facts anywhere in the user-visible response and evidence', () => {
    const withFact = structuredClone(fixture); withFact.expected.requiredSummaryFragments = ['tx-evidence'];
    const value = result(); value.evidence = [{ source: 'tx-evidence', detail: '合成证据' }];
    expect(scoreAblation(withFact, value, 'single', true).passed).toBe(true);
  });
});

describe('G5 protocol and frozen synthetic data integrity (no planner execution)', () => {
  it('budgets at most 12288 requested output tokens including both attempts for all valid topologies', () => {
    for (let n = 1; n <= 7; n++) { const budget = outputBudget(n); expect(budget.allocatedCeiling).toBeLessThanOrEqual(12288); expect(budget.maxOutputTokens).toBeGreaterThan(800); }
    expect(() => outputBudget(0)).toThrow(); expect(() => outputBudget(8)).toThrow(); expect(() => outputBudget(1, 3)).toThrow();
  });
  it('counterbalances each group of three cases and shifts repeat order', () => {
    const orders = [0, 1, 2].map(index => conditionOrder(index, 0));
    for (let slot = 0; slot < 3; slot++) expect(new Set(orders.map(order => order[slot])).size).toBe(3);
    expect(conditionOrder(0, 1)).toEqual(conditionOrder(1, 0));
  });
  it('canonical input hashes ignore object key order but preserve amounts and duplicate arrays', () => {
    expect(digest({ a: 1, b: 2 })).toBe(digest({ b: 2, a: 1 }));
    expect(canonical(['1', '1'])).not.toBe(canonical(['1'])); expect(digest('123')).not.toBe(digest(123));
  });
  it('validates the frozen manifest, unique 40 cases and preselected 12 cases', async () => {
    const manifest = JSON.parse(await readFile('evals/holdout-manifest.json', 'utf8'));
    expect(manifest.version).toBe(holdoutVersion);
    expect(manifest.fixtureSha256).toBe(createHash('sha256').update(await readFile(manifest.fixtureFile)).digest('hex'));
    expect(manifest.caseIds).toEqual(holdoutFixtures.map(f => f.id)); expect(new Set(manifest.caseIds).size).toBe(40);
    expect(new Set(manifest.liveCaseIds).size).toBe(12);
    const selected = holdoutFixtures.filter(f => manifest.liveCaseIds.includes(f.id));
    expect(selected).toHaveLength(12); expect(new Set(selected.flatMap(f => f.expected.roles)).size).toBe(6);
    expect(selected.some(f => f.input.fundsPreview?.allowed === false && f.expected.roles.includes('transfer'))).toBe(true);
  });
  it('checks account identities and every frozen money snapshot without using implementation resolvers', () => {
    for (const { input } of holdoutFixtures) {
      expect(input.accounts.every(account => /^\*{4}\d{4}$/.test(account.maskedNumber))).toBe(true);
      if (input.fundsPreview) {
        const p = input.fundsPreview;
        expect(BigInt(p.availableBeforeMinor)).toBe(BigInt(p.balanceMinor) - BigInt(p.reservedMinor));
        expect(BigInt(p.availableAfterMinor)).toBe(BigInt(p.availableBeforeMinor) - BigInt(p.amountMinor));
        expect(p.allowed).toBe(BigInt(p.amountMinor) <= BigInt(p.spendableMinor));
        expect(input.accounts.some(a => a.id === p.accountId && a.balanceMinor === p.balanceMinor && a.reservedMinor === p.reservedMinor)).toBe(true);
      }
      for (const p of input.investmentContext?.positions ?? []) expect(BigInt(p.availableMinor)).toBe(BigInt(p.principalMinor) - BigInt(p.reservedMinor));
      if (input.billReport) {
        const bill = input.billReport;
        const sum = (direction: string) => bill.transactions.filter(tx => tx.direction === direction).reduce((n, tx) => n + BigInt(tx.amountMinor), 0n);
        expect(sum('IN')).toBe(BigInt(bill.incomeMinor)); expect(sum('OUT')).toBe(BigInt(bill.expenseMinor)); expect(sum('IN') - sum('OUT')).toBe(BigInt(bill.netMinor));
        const allIds = [...bill.transactions, ...(bill.evidenceTransactions ?? [])].map(tx => tx.id);
        expect(bill.findings.flatMap(f => f.transactionIds).every(id => allIds.includes(id))).toBe(true);
      }
    }
  });
});
