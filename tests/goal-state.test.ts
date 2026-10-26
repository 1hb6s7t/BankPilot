import { describe, expect, it } from 'vitest';
import type { ActionView, GoalNode, GoalView, InvestmentAction } from '../packages/contracts/src';
import { goalNodeStatusForAction, mergeGoalSnapshot } from '../apps/web/src/goalState';

function action(status: InvestmentAction['status'], updatedAt: string): InvestmentAction {
  return {
    id: 'redeem-1', taskId: 'goal-1', positionId: 'position-1', accountId: 'account-1', productId: 'product-1', productName: '演示产品',
    amountMinor: '50025', feeMinor: '0', netAmountMinor: '50025', tier: 'RED', status,
    expectedVersion: 1, actionVersion: 1, actionHash: 'a'.repeat(64), expiresAt: '2026-10-23T00:00:00.000Z',
    expectedSettlementAt: '2026-10-23T00:00:00.000Z', calendar: 'DEMO_WEEKDAYS_V1', createdAt: '2026-10-22T00:00:00.000Z', updatedAt,
  };
}

function goal(planVersion: number, updatedAt: string, status: InvestmentAction['status'] = 'AUTHORIZED'): GoalView {
  const currentAction = action(status, updatedAt);
  return {
    id: 'goal-1', title: '生日旅行', accountId: 'account-1', payeeId: 'payee-1', amountMinor: '60075', targetDate: '2026-11-20',
    planVersion, status: 'ACTIVE', nodes: [{ id: 'redeem', kind: 'REDEEM', dependsOn: [], specVersion: planVersion, status: 'IN_PROGRESS', evidenceRefs: [], investmentAction: currentAction }],
    reasons: [], revisionDiff: [], createdAt: '2026-10-22T00:00:00.000Z', updatedAt,
  };
}

const sameTime = '2026-10-22T00:00:03.000Z';
function transfer(status: ActionView['status']): ActionView {
  return {
    id: 'transfer-1', taskId: 'goal-1', accountId: 'account-1', payeeId: 'payee-1', payeeName: '演示收款人', amountMinor: '60075',
    currency: 'CNY', memo: '生日旅行', status, tier: 'YELLOW', actionVersion: 1, actionHash: 'b'.repeat(64),
    expiresAt: '2026-11-20T00:00:00.000Z', createdAt: sameTime, updatedAt: sameTime,
    ...(status === 'SUCCEEDED' ? { receipt: { providerRequestId: 'request-1', providerTransactionId: 'transaction-1', amountMinor: '60075', currency: 'CNY' as const, payeeId: 'payee-1', settledAt: sameTime } } : {}),
  };
}
function transferGoal(status: ActionView['status']): GoalView {
  const value = goal(1, sameTime);
  value.nodes = [{ id: 'transfer', kind: 'TRANSFER', dependsOn: [], specVersion: 1, status: goalNodeStatusForAction(transfer(status)), evidenceRefs: [], actionRef: { service: 'transfer', actionId: 'transfer-1' }, transferAction: transfer(status) }];
  return value;
}
function fundedGoal(waitStatus: GoalNode['status']): GoalView {
  const value = goal(1, sameTime, 'SUCCEEDED');
  value.funding = { positionId: 'position-1', redemptionAmountMinor: '50025' };
  value.nodes[0]!.status = 'SUCCEEDED';
  value.nodes[0]!.investmentAction!.receipt = { providerRequestId: 'redemption-request', providerTransactionId: 'redemption-receipt', accountId: 'account-1', positionId: 'position-1', amountMinor: '50025', currency: 'CNY', settledAt: sameTime };
  value.nodes.push(
    { id: 'settlement', kind: 'WAIT_SETTLEMENT', dependsOn: ['redeem'], specVersion: 1, status: waitStatus, evidenceRefs: waitStatus === 'SUCCEEDED' ? ['redemption-receipt'] : [], ...(waitStatus === 'BLOCKED' ? { reason: '预计到账不能满足依赖。' } : {}) },
    { id: 'transfer', kind: 'TRANSFER', dependsOn: ['settlement'], specVersion: 1, status: waitStatus === 'SUCCEEDED' ? 'READY' : 'BLOCKED', evidenceRefs: [] },
  );
  return value;
}

describe('goal UI snapshot merging', () => {
  it('does not let an older poll roll a replanned goal back', () => {
    const latest = goal(2, '2026-10-22T00:00:03.000Z');
    const stalePoll = goal(1, '2026-10-22T00:00:02.000Z');
    expect(mergeGoalSnapshot(latest, stalePoll)).toBe(latest);
    expect(mergeGoalSnapshot(latest, stalePoll).planVersion).toBe(2);
  });

  it('keeps the newest action state and updates its node status', () => {
    const newer = goal(2, '2026-10-22T00:00:03.000Z', 'CANCELLED');
    const stale = goal(2, '2026-10-22T00:00:02.000Z', 'AUTHORIZED');
    const merged = mergeGoalSnapshot(newer, stale);
    expect(merged.nodes[0]?.investmentAction?.status).toBe('CANCELLED');
    expect(merged.nodes[0]?.status).toBe('FAILED');
    expect(goalNodeStatusForAction(action('SUCCEEDED', '2026-10-22T00:00:04.000Z'))).toBe('SUCCEEDED');
  });
  it('keeps transfer completion and clears stale goal reasons when goal timestamps tie', () => {
    const confirmed = transferGoal('SUCCEEDED');
    confirmed.status = 'SUCCEEDED';
    const stale = transferGoal('AWAITING_CONFIRMATION');
    stale.status = 'NEEDS_REPLAN'; stale.reasons = ['旧快照资金不足'];
    const merged = mergeGoalSnapshot(confirmed, stale);
    expect(merged.status).toBe('SUCCEEDED');
    expect(merged.reasons).toEqual([]);
    expect(merged.nodes[0]?.status).toBe('SUCCEEDED');
    expect(merged.nodes[0]?.transferAction?.receipt?.providerTransactionId).toBe('transaction-1');
  });

  it('projects merged successful transfer evidence even before goal status was saved', () => {
    const confirmedAction = transferGoal('SUCCEEDED');
    expect(confirmedAction.status).toBe('ACTIVE');
    const merged = mergeGoalSnapshot(transferGoal('AUTHORIZED'), confirmedAction);
    expect(merged.status).toBe('SUCCEEDED');
    expect(merged.reasons).toEqual([]);
  });

  it('retains server-confirmed settlement and dependent readiness across equal timestamp stale reads', () => {
    const confirmed = fundedGoal('SUCCEEDED');
    const stale = fundedGoal('BLOCKED');
    const merged = mergeGoalSnapshot(confirmed, stale);
    expect(merged.nodes.find((node) => node.id === 'settlement')).toMatchObject({ status: 'SUCCEEDED', evidenceRefs: ['redemption-receipt'] });
    expect(merged.nodes.find((node) => node.id === 'settlement')?.reason).toBeUndefined();
    expect(merged.nodes.find((node) => node.id === 'transfer')?.status).toBe('READY');
    expect(merged.status).toBe('ACTIVE');
  });

  it('does not infer confirmed settlement from redemption success, receipt or a past predicted date', () => {
    const unconfirmed = fundedGoal('BLOCKED');
    unconfirmed.expectedSettlementAt = '2020-01-01T00:00:00.000Z';
    const merged = mergeGoalSnapshot(unconfirmed, structuredClone(unconfirmed));
    expect(merged.nodes.find((node) => node.id === 'settlement')?.status).toBe('BLOCKED');
    expect(merged.nodes.find((node) => node.id === 'transfer')?.status).toBe('BLOCKED');
    expect(merged.status).toBe('ACTIVE');
  });

  it('does not carry confirmed settlement across a changed node specification', () => {
    const confirmed = fundedGoal('SUCCEEDED');
    const reset = fundedGoal('BLOCKED');
    reset.nodes.find((node) => node.id === 'settlement')!.specVersion = 2;
    expect(mergeGoalSnapshot(confirmed, reset).nodes.find((node) => node.id === 'settlement')?.status).toBe('BLOCKED');
  });

  it('accepts a new plan without carrying previous action completion or settlement readiness', () => {
    const completed = transferGoal('SUCCEEDED'); completed.status = 'SUCCEEDED';
    const next = transferGoal('AWAITING_CONFIRMATION'); next.planVersion = 2; next.nodes[0]!.specVersion = 2;
    next.nodes[0]!.transferAction!.id = 'replacement-transfer';
    const merged = mergeGoalSnapshot(completed, next);
    expect(merged).toBe(next);
    expect(merged.status).toBe('ACTIVE');
    expect(merged.nodes[0]?.transferAction?.status).toBe('AWAITING_CONFIRMATION');
    const settled = fundedGoal('SUCCEEDED');
    const newFunding = fundedGoal('BLOCKED'); newFunding.planVersion = 2;
    expect(mergeGoalSnapshot(settled, newFunding).nodes.find((node) => node.id === 'settlement')?.status).toBe('BLOCKED');
  });

  it('does not attach a previous receipt to a replacement transfer intent', () => {
    const completed = transferGoal('SUCCEEDED'); completed.status = 'SUCCEEDED';
    const replacement = transferGoal('AWAITING_CONFIRMATION');
    replacement.nodes[0]!.transferAction!.id = 'replacement-transfer';
    replacement.nodes[0]!.actionRef!.actionId = 'replacement-transfer';
    const merged = mergeGoalSnapshot(completed, replacement);
    expect(merged.status).toBe('ACTIVE');
    expect(merged.nodes[0]?.transferAction?.receipt).toBeUndefined();
    expect(merged.nodes[0]?.status).toBe('AWAITING_AUTH');
  });

});
