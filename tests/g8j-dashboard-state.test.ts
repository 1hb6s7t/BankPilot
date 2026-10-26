import { describe, expect, it, vi } from 'vitest';
import type { ActionView, Dashboard } from '../packages/contracts/src';
import { DashboardReadCoordinator, dashboardActionViews, dashboardRefreshKeys, dashboardRequiresPolling } from '../apps/web/src/dashboardState';

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
const action = (status: ActionView['status'], updatedAt = '2026-10-23T11:00:00.000Z'): ActionView => ({
  id: 'transfer-a', taskId: 'plan-a', accountId: 'account-a', payeeId: 'payee-a', payeeName: '合成收款人', amountMinor: '30750', currency: 'CNY',
  memo: '', status, tier: 'YELLOW', actionVersion: 1, actionHash: 'hash-a', expiresAt: '2026-10-24T00:00:00.000Z',
  createdAt: '2026-10-23T10:00:00.000Z', updatedAt,
});
const snapshot = (status: ActionView['status'], balanceMinor: string, reservedMinor = '0'): Dashboard => ({
  accounts: [{ id: 'account-a', name: '合成账户', maskedNumber: '****2026', balanceMinor, reservedMinor, currency: 'CNY' }],
  actions: [action(status)], payees: [], audit: [], dailyUsedMinor: '0',
});

describe('G8J complete dashboard snapshots', () => {
  it('does not stop canonical polling because a separate plan contains a successful receipt', () => {
    const before = snapshot('AUTHORIZED', '800000', '30750');
    const receipt = action('SUCCEEDED', '2026-10-23T11:00:01.000Z');
    expect(dashboardRefreshKeys(before, [receipt])).toHaveLength(1);
    expect(dashboardRequiresPolling(before)).toBe(true);
    expect(before.accounts[0]).toMatchObject({ balanceMinor: '800000', reservedMinor: '30750' });
    expect(before.actions[0]?.status).toBe('AUTHORIZED');
    const after = snapshot('SUCCEEDED', '769250');
    expect(dashboardRequiresPolling(after)).toBe(false);
  });
  it('continues full-snapshot recovery after a failed read even if no canonical action was pending', () => {
    expect(dashboardRequiresPolling(snapshot('AWAITING_CONFIRMATION', '800000'), true)).toBe(true);
    expect(dashboardRequiresPolling(snapshot('SUCCEEDED', '769250'), false)).toBe(false);
  });
  it('refreshes a missing terminal action once, and does not treat an old pending proposal as newer than a receipt', () => {
    expect(dashboardRefreshKeys(undefined, [action('SUCCEEDED')])).toHaveLength(1);
    expect(dashboardRefreshKeys(snapshot('SUCCEEDED', '769250'), [action('AWAITING_CONFIRMATION')])).toEqual([]);
    expect(dashboardRefreshKeys(snapshot('SUCCEEDED', '769250'), [action('SUCCEEDED')])).toEqual([]);
  });
  it('shows a fresh detail receipt while the old canonical balance still requires a full refresh', () => {
    const canonical = snapshot('AUTHORIZED', '800000', '30750');
    const receipt = { ...action('SUCCEEDED'), receipt: { providerTransactionId: 'receipt-a' } } as ActionView;
    expect(dashboardActionViews(canonical, [receipt])[0]).toBe(receipt);
    expect(canonical.actions[0]?.status).toBe('AUTHORIZED');
    expect(canonical.accounts[0]?.balanceMinor).toBe('800000');
    expect(dashboardRequiresPolling(canonical)).toBe(true);
  });
  it('retains a newer canonical authorization and never lets an old proposal replace a terminal receipt', () => {
    const authorized = snapshot('AUTHORIZED', '800000', '30750');
    expect(dashboardActionViews(authorized, [action('AWAITING_CONFIRMATION', '2026-10-23T10:00:00.000Z')])[0]).toBe(authorized.actions[0]);
    const completed = snapshot('SUCCEEDED', '769250');
    expect(dashboardActionViews(completed, [action('UNKNOWN', '2026-10-23T12:00:00.000Z')])[0]).toBe(completed.actions[0]);
  });
});

describe('G8J dashboard request ordering and account isolation', () => {
  it.each([
    { operation: 'confirm', next: { ...snapshot('AUTHORIZED', '800000', '30750'), passkeyCount: 0 } },
    { operation: 'cancel', next: { ...snapshot('CANCELLED', '800000'), passkeyCount: 0 } },
    { operation: 'reconcile', next: { ...snapshot('SUCCEEDED', '769250'), passkeyCount: 0 } },
    { operation: 'register Passkey', next: { ...snapshot('AWAITING_CONFIRMATION', '800000'), passkeyCount: 1 } },
    { operation: 'investment/management refreshAll', next: { ...snapshot('AWAITING_CONFIRMATION', '900000'), passkeyCount: 0 } },
  ])('requires a read begun after successful $operation even without a detail receipt', async ({ next }) => {
    type View = Dashboard & { passkeyCount: number };
    const reader = new DashboardReadCoordinator<View>(), old = deferred<View>(), fresh = deferred<View>();
    const load = vi.fn().mockImplementationOnce(() => old.promise).mockImplementationOnce(() => fresh.promise), apply = vi.fn();
    const beforeWrite = reader.read(load, apply);
    // The actual write has now committed; joining the older read cannot prove its outcome.
    const afterWrite = reader.read(load, apply, true);
    expect(load).toHaveBeenCalledTimes(1);
    old.resolve({ ...snapshot('AWAITING_CONFIRMATION', '800000'), passkeyCount: 0 }); await Promise.resolve();
    expect(load).toHaveBeenCalledTimes(2); expect(apply).not.toHaveBeenCalled();
    fresh.resolve(next); await Promise.all([beforeWrite, afterWrite]);
    expect(apply.mock.calls).toEqual([[next]]);
  });
  it('shares overlapping same-session reads instead of issuing concurrent requests', async () => {
    const reader = new DashboardReadCoordinator<Dashboard>(), response = deferred<Dashboard>();
    const load = vi.fn(() => response.promise), apply = vi.fn();
    const first = reader.read(load, apply), second = reader.read(load, apply);
    expect(first).toBe(second); expect(load).toHaveBeenCalledTimes(1);
    response.resolve(snapshot('SUCCEEDED', '769250'));
    await Promise.all([first, second]); expect(apply).toHaveBeenCalledTimes(1);
  });
  it('ordinary polls joining a required fresh read do not invalidate it or force an endless follow-up', async () => {
    const reader = new DashboardReadCoordinator<number>(), response = deferred<number>();
    const load = vi.fn(() => response.promise), apply = vi.fn();
    const required = reader.read(load, apply, true);
    const pollOne = reader.read(load, apply), pollTwo = reader.read(load, apply);
    response.resolve(2); await Promise.all([required, pollOne, pollTwo]);
    expect(load).toHaveBeenCalledTimes(1); expect(apply.mock.calls).toEqual([[2]]);
  });
  it('does not adopt the old view when a write barrier joins a failing read; a later normal poll can recover', async () => {
    const reader = new DashboardReadCoordinator<number>(), response = deferred<number>();
    const load = vi.fn().mockImplementationOnce(() => response.promise).mockResolvedValueOnce(2), apply = vi.fn();
    const old = reader.read(load, apply), afterWrite = reader.read(load, apply, true);
    const settled = Promise.allSettled([old, afterWrite]);
    response.reject(new Error('controlled read failure'));
    expect((await settled).every(result => result.status === 'rejected')).toBe(true);
    expect(apply).not.toHaveBeenCalled(); expect(load).toHaveBeenCalledTimes(1);
    expect(await reader.read(load, apply)).toBe(2); expect(apply.mock.calls).toEqual([[2]]);
  });
  it('discards an in-flight old balance when detail finishes first, then reads a fresh whole snapshot serially', async () => {
    const reader = new DashboardReadCoordinator<Dashboard>(), old = deferred<Dashboard>(), fresh = deferred<Dashboard>();
    const load = vi.fn().mockImplementationOnce(() => old.promise).mockImplementationOnce(() => fresh.promise);
    const visible: Dashboard[] = [];
    const first = reader.read(load, value => visible.push(value));
    reader.markStale(); const detailFollowup = reader.read(load, value => visible.push(value));
    expect(load).toHaveBeenCalledTimes(1);
    old.resolve(snapshot('AUTHORIZED', '800000', '30750')); await Promise.resolve();
    expect(load).toHaveBeenCalledTimes(2); expect(visible).toEqual([]);
    fresh.resolve(snapshot('SUCCEEDED', '769250'));
    await Promise.all([first, detailFollowup]);
    expect(visible).toHaveLength(1); expect(visible[0]?.accounts[0]).toMatchObject({ balanceMinor: '769250', reservedMinor: '0' });
  });
  it('coalesces repeated terminal observations into one follow-up read rather than parallel requests', async () => {
    const reader = new DashboardReadCoordinator<number>(), first = deferred<number>(), second = deferred<number>();
    const load = vi.fn().mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise);
    const apply = vi.fn(), pending = reader.read(load, apply);
    reader.markStale(); reader.markStale(); reader.read(load, apply);
    first.resolve(1); await Promise.resolve(); expect(load).toHaveBeenCalledTimes(2);
    second.resolve(2); await pending; expect(apply.mock.calls).toEqual([[2]]);
  });
  it('does not apply or revive the old account if a transport resolves after session invalidation', async () => {
    const reader = new DashboardReadCoordinator<string>(), old = deferred<string>(), current = deferred<string>();
    const apply = vi.fn(); const beforeLogout = reader.read(() => old.promise, apply);
    reader.invalidate(); const afterLogin = reader.read(() => current.promise, apply);
    current.resolve('owner-b'); await afterLogin;
    old.resolve('owner-a'); expect(await beforeLogout).toBeUndefined();
    expect(apply.mock.calls).toEqual([['owner-b']]);
  });
  it('surfaces a failed read, releases its flight and permits an explicit subsequent retry', async () => {
    const reader = new DashboardReadCoordinator<number>(), apply = vi.fn();
    const failure = new Error('controlled dashboard read failure');
    const load = vi.fn().mockRejectedValueOnce(failure).mockResolvedValueOnce(2);
    await expect(reader.read(load, apply)).rejects.toBe(failure);
    expect(load).toHaveBeenCalledTimes(1); expect(apply).not.toHaveBeenCalled();
    expect(await reader.read(load, apply)).toBe(2); expect(apply.mock.calls).toEqual([[2]]);
  });
});
