import { describe, expect, it } from 'vitest';
import type { PreparationRequest } from '../packages/contracts/src/preparations';
import { mergePreparationRequest } from '../apps/web/src/preparationState';

const pending: PreparationRequest = {
  family: 'management', commandId: 'held-list-response', operation: 'management',
  input: { spec: { kind: 'CARD_REPORT_LOST', cardId: 'card-1', expectedVersion: 1 } },
  state: 'PENDING', createdAt: '2026-10-24T00:00:00.000Z', updatedAt: '2026-10-24T00:00:00.000Z',
};

describe('preparation request observations', () => {
  it.each(['ABANDONED', 'PREPARED'] as const)('never replaces observed %s with a held PENDING list or GET response', state => {
    const terminal = { ...pending, state };
    expect(mergePreparationRequest(terminal, pending)).toEqual({ request: terminal, requiresRead: false });
    const newerPending = { ...pending, updatedAt: '2026-10-24T00:01:00.000Z' };
    expect(mergePreparationRequest(terminal, newerPending)).toEqual({ request: terminal, requiresRead: false });
    expect(mergePreparationRequest(pending, terminal)).toEqual({ request: terminal, requiresRead: false });
  });

  it('keeps the observed outcome and requires another read when terminal outcomes conflict, even at equal timestamps', () => {
    const abandoned: PreparationRequest = { ...pending, state: 'ABANDONED' };
    const prepared: PreparationRequest = { ...pending, state: 'PREPARED', resultId: 'original-action' };
    expect(mergePreparationRequest(abandoned, prepared)).toEqual({ request: abandoned, requiresRead: true });
    expect(mergePreparationRequest(prepared, abandoned)).toEqual({ request: prepared, requiresRead: true });
    expect(mergePreparationRequest(prepared, { ...prepared, resultId: 'different-action' })).toEqual({ request: prepared, requiresRead: true });
    expect(mergePreparationRequest({ ...prepared, resultId: undefined }, prepared)).toEqual({ request: prepared, requiresRead: false });
  });

  it('rejects other request identities and accepts only newer snapshots within a pending state', () => {
    expect(mergePreparationRequest(pending, { ...pending, commandId: 'other-command', state: 'ABANDONED' })).toEqual({ request: pending, requiresRead: true });
    expect(mergePreparationRequest(pending, { ...pending, family: 'investment' })).toEqual({ request: pending, requiresRead: true });
    const newer = { ...pending, updatedAt: '2026-10-24T00:01:00.000Z', lastError: { code: 'PREPARATION_FAILED', message: '准备尚未完成' } };
    expect(mergePreparationRequest(pending, newer)).toEqual({ request: newer, requiresRead: false });
    expect(mergePreparationRequest(newer, pending)).toEqual({ request: newer, requiresRead: false });
  });
});
