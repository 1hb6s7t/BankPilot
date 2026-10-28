import type { AccountView, FundsPreview } from '../../../packages/contracts/src';

export type OverviewAllocation = {
  available: bigint;
  protected: bigint;
  payment: bigint;
  remaining: bigint;
  after: bigint;
  shortfall: bigint;
};

export type OverviewModel = {
  available?: bigint;
  state: 'missing' | 'mismatch' | 'blocked' | 'ready';
  allocation?: OverviewAllocation;
};

/** A display model only. Authorization remains governed by the server preview. */
export function workbenchOverviewModel(account?: AccountView, preview?: FundsPreview): OverviewModel {
  if (!account) return { state: 'missing' };
  let balance: bigint, reserved: bigint;
  try {
    balance = BigInt(account.balanceMinor);
    reserved = BigInt(account.reservedMinor);
  } catch { return { state: 'mismatch' }; }
  const available = balance - reserved;
  if (balance < 0n || reserved < 0n) return { available, state: 'mismatch' };
  if (!preview) return { available, state: 'missing' };
  try {
    const before = BigInt(preview.availableBeforeMinor);
    const payment = BigInt(preview.amountMinor);
    const after = BigInt(preview.availableAfterMinor);
    const protectedAmount = BigInt(preview.protectedMinor);
    const shortfall = BigInt(preview.shortfallMinor);
    const remaining = after - protectedAmount;
    const expectedShortfall = remaining < 0n ? -remaining : 0n;
    const expectedSpendable = before > protectedAmount ? before - protectedAmount : 0n;
    if (preview.accountId !== account.id || BigInt(preview.balanceMinor) !== balance
      || BigInt(preview.reservedMinor) !== reserved || before !== available
      || payment < 0n || protectedAmount < 0n || after !== before - payment
      || shortfall !== expectedShortfall || BigInt(preview.spendableMinor) !== expectedSpendable) {
      return { available, state: 'mismatch' };
    }
    const allocation = { available, protected: protectedAmount, payment, remaining, after, shortfall };
    if (!preview.allowed || available < 0n || remaining < 0n) return { available, allocation, state: 'blocked' };
    return { available, allocation, state: 'ready' };
  } catch { return { available, state: 'mismatch' }; }
}

export function overviewSegmentWidth(amount: bigint, total: bigint): string {
  if (total <= 0n || amount <= 0n) return '0%';
  return `${Number(amount * 100_000n / total) / 1_000}%`;
}

export function workbenchMoney(amount: string | bigint): string {
  const value = typeof amount === 'bigint' ? amount : BigInt(amount);
  const absolute = value < 0n ? -value : value;
  const whole = new Intl.NumberFormat('zh-CN').format(absolute / 100n);
  return `${value < 0n ? '−' : ''}¥${whole}.${(absolute % 100n).toString().padStart(2, '0')}`;
}
