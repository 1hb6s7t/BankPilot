import { describe, expect, it } from 'vitest';
import type { ManagementAction } from '../packages/contracts/src/management';
import { mergeManagementActions, projectManagementAction } from '../apps/web/src/ManagementPages';

function action(overrides: Partial<ManagementAction> = {}): ManagementAction {
  return {
    id: 'original-action', taskId: 'task', spec: { kind: 'SUBSCRIPTION_BLOCK', subscriptionId: 'sub', queryActionId: 'grant', expectedVersion: 1 },
    title: 'Private merchant', details: ['Private merchant costs 499'], status: 'SUCCEEDED', tier: 'YELLOW', actionVersion: 1,
    actionHash: 'original-hash', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:01:00Z', expiresAt: '2026-01-01T01:00:00Z',
    detailsRedacted: false, detailsAccessExpiresAt: '2026-01-01T00:10:00Z',
    receipt: { operationId: 'op', completedAt: '2026-01-01T00:01:00Z', balanceDeltaMinor: '0', summary: 'Private merchant blocked', subscription: { id: 'sub', merchant: 'Private merchant' } as never },
    ...overrides,
  };
}

describe('management disclosure independent of business timestamps', () => {
  it('hides a cached receipt and details at the grant deadline without changing authorization metadata or bank/merchant state', () => {
    const original = action();
    const visible = projectManagementAction(original, [], Date.parse('2026-01-01T00:09:59Z'));
    expect(visible).toBe(original);
    const hidden = projectManagementAction(original, [], Date.parse(original.detailsAccessExpiresAt!));
    expect(JSON.stringify({ title: hidden.title, details: hidden.details, receipt: hidden.receipt })).not.toContain('Private merchant');
    expect(hidden.receipt?.subscription).toBeUndefined();
    expect(hidden.status).toBe(original.status);
    expect(hidden.spec).toBe(original.spec);
    expect(hidden.actionHash).toBe(original.actionHash);
    expect(original.receipt?.subscription?.merchant).toBe('Private merchant');
  });

  it.each([undefined, 'invalid', '2025-01-01T00:00:00Z'])('fails closed for unavailable disclosure deadline %s', (deadline) => {
    expect(projectManagementAction(action({ detailsAccessExpiresAt: deadline }), [], Date.parse('2026-01-01T00:02:00Z')).detailsRedacted).toBe(true);
  });

  it('makes a redacted incoming observation win even with an older business timestamp', () => {
    const cached = action();
    const redacted = action({ detailsRedacted: true, updatedAt: '2026-01-01T00:00:00Z', status: 'AWAITING_CONFIRMATION' });
    const shown = projectManagementAction(cached, [redacted], Date.parse('2026-01-01T00:02:00Z'));
    expect(shown.status).toBe('SUCCEEDED');
    expect(shown.detailsRedacted).toBe(true);
    expect(shown.receipt?.subscription).toBeUndefined();
  });

  it('preserves redaction when merging a newer business record from a cache', () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    const cached = action({ detailsAccessExpiresAt: future });
    const redacted = action({ detailsRedacted: true, updatedAt: '2026-01-01T00:00:00Z', status: 'AWAITING_CONFIRMATION' });
    for (const merged of [mergeManagementActions([cached], [redacted]), mergeManagementActions([redacted], [cached])]) {
      expect(merged[0].status).toBe('SUCCEEDED');
      expect(merged[0].detailsRedacted).toBe(true);
      expect(merged[0].receipt?.subscription).toBeUndefined();
    }
  });
});
