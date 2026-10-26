import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { g6HoldoutFixtures, g6HoldoutVersion, g6HoldoutLiveCaseIds } from '../evals/g6-holdout-fixtures';

// Dataset preflight only: never invoke planner or derive labels from implementation.
describe('G6 frozen manually labelled dataset integrity', () => {
  it('binds 24 unique cases and a preselected 12-case live subset to exact fixture bytes', async () => {
    const manifest = JSON.parse(await readFile('evals/g6-holdout-manifest.json', 'utf8'));
    expect(manifest.version).toBe(g6HoldoutVersion);
    expect(manifest.fixtureSha256).toBe(createHash('sha256').update(await readFile('evals/g6-holdout-fixtures.ts')).digest('hex'));
    expect(manifest.caseIds).toEqual(g6HoldoutFixtures.map(f => f.id));
    expect(new Set(manifest.caseIds).size).toBe(24);
    expect(new Set(manifest.liveCaseIds).size).toBe(12);
    expect(manifest.liveCaseIds).toEqual([...g6HoldoutLiveCaseIds]);
    expect(manifest.liveCaseIds.every((id: string) => manifest.caseIds.includes(id))).toBe(true);
    expect(new Set(g6HoldoutFixtures.filter(f => manifest.liveCaseIds.includes(f.id)).flatMap(f => f.expected.roles)).size).toBe(6);
  });
  it('keeps amount labels, account references and synthetic snapshots internally consistent', () => {
    for (const { input, expected } of g6HoldoutFixtures) {
      for (const transfer of expected.suggestions) {
        expect(input.payees.some(p => p.id === transfer.payeeId)).toBe(true);
        expect(input.fundsPreview?.amountMinor).toBe(transfer.amountMinor);
        expect(input.fundsPreview?.allowed).toBe(true);
      }
      for (const redemption of expected.investmentSuggestions) {
        const position = input.investmentContext?.positions.find(p => p.id === redemption.positionId);
        expect(position).toBeDefined();
        expect(redemption.expectedVersion).toBe(position!.version);
        expect(BigInt(redemption.amountMinor)).toBeLessThanOrEqual(BigInt(position!.availableMinor));
      }
      if (expected.goalSuggestion) {
        expect(input.payees.some(p => p.id === expected.goalSuggestion!.payeeId)).toBe(true);
        expect(input.accounts.some(a => a.id === expected.goalSuggestion!.accountId)).toBe(true);
        expect(expected.suggestions).toEqual([]); expect(expected.investmentSuggestions).toEqual([]);
        if (expected.goalSuggestion.funding) {
          const funding = expected.goalSuggestion.funding;
          const position = input.investmentContext?.positions.find(p => p.id === funding.positionId);
          expect(position).toBeDefined();
          expect(position!.accountId).toBe(expected.goalSuggestion.accountId);
          expect(BigInt(funding.redemptionAmountMinor)).toBeLessThanOrEqual(BigInt(position!.availableMinor));
        }
      }
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
        expect(sum('IN')).toBe(BigInt(bill.incomeMinor)); expect(sum('OUT')).toBe(BigInt(bill.expenseMinor));
        expect(sum('IN') - sum('OUT')).toBe(BigInt(bill.netMinor));
        const allIds = [...bill.transactions, ...(bill.evidenceTransactions ?? [])].map(tx => tx.id);
        expect(bill.findings.flatMap(f => f.transactionIds).every(id => allIds.includes(id))).toBe(true);
      }
    }
  });
});
