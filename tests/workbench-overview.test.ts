import { describe, expect, it } from 'vitest';
import type { AccountView, FundsPreview } from '../packages/contracts/src';
import { overviewSegmentWidth, workbenchMoney, workbenchOverviewModel } from '../apps/web/src/workbenchOverviewModel';

const account: AccountView = { id: 'daily', name: '日常账户', maskedNumber: '尾号2026', balanceMinor: '800000', reservedMinor: '0', currency: 'CNY' };
const preview: FundsPreview = {
  accountId: 'daily', amountMinor: '30025', balanceMinor: '800000', reservedMinor: '0', availableBeforeMinor: '800000',
  availableAfterMinor: '769975', protectedMinor: '500000', spendableMinor: '300000', shortfallMinor: '0', allowed: true,
  policyVersion: 1, horizonEnd: '2026-11-27', obligations: [], reasons: [],
};

describe('workbench allocation presentation', () => {
  it('keeps the 300.25 transfer distinct from protected and freely spendable funds', () => {
    const model = workbenchOverviewModel(account, preview);
    expect(model.state).toBe('ready');
    expect(model.allocation).toEqual({ available: 800000n, protected: 500000n, payment: 30025n, remaining: 269975n, after: 769975n, shortfall: 0n });
    expect(overviewSegmentWidth(30025n, 800000n)).toBe('3.753%');
  });

  it('does not reuse a preview for another account or an outdated balance/reservation snapshot', () => {
    expect(workbenchOverviewModel(account, { ...preview, accountId: 'other' }).state).toBe('mismatch');
    expect(workbenchOverviewModel({ ...account, balanceMinor: '700000' }, preview)).toEqual({ state: 'mismatch', available: 700000n });
    expect(workbenchOverviewModel({ ...account, reservedMinor: '30025' }, preview).state).toBe('mismatch');
  });

  it('never draws an allowed allocation when the transfer consumes protected funds', () => {
    const result = workbenchOverviewModel(account, { ...preview, amountMinor: '400000', availableAfterMinor: '400000', shortfallMinor: '100000', allowed: false });
    expect(result.state).toBe('blocked');
    expect(result.allocation?.remaining).toBe(-100000n);
    expect(result.allocation?.shortfall).toBe(100000n);
    expect(workbenchOverviewModel(account, { ...preview, allowed: false }).state).toBe('blocked');
  });

  it('rejects inconsistent server arithmetic instead of normalizing it into a plausible chart', () => {
    expect(workbenchOverviewModel(account, { ...preview, availableAfterMinor: '800000' }).state).toBe('mismatch');
    expect(workbenchOverviewModel(account, { ...preview, spendableMinor: '769975' }).state).toBe('mismatch');
    expect(workbenchOverviewModel(account, { ...preview, amountMinor: '-30025' }).state).toBe('mismatch');
  });

  it('keeps a missing preview empty and handles an empty account without dividing by zero', () => {
    expect(workbenchOverviewModel(account)).toEqual({ state: 'missing', available: 800000n });
    const empty = workbenchOverviewModel({ ...account, balanceMinor: '0' }, { ...preview, amountMinor: '0', balanceMinor: '0', availableBeforeMinor: '0', availableAfterMinor: '0', protectedMinor: '0', spendableMinor: '0' });
    expect(empty.state).toBe('ready');
    expect(overviewSegmentWidth(0n, 0n)).toBe('0%');
  });

  it('formats negative and large minor-unit values without floating point loss', () => {
    expect(workbenchMoney(-30025n)).toBe('−¥300.25');
    expect(workbenchMoney(900719925474099199n)).toBe('¥9,007,199,254,740,991.99');
  });
});
