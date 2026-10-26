import type { PlannerInput, PlanResult, ManagementAction, ManagementSpec } from '../../../packages/contracts/src/index.js';
import { verifySubscriptionContinuation, type SubscriptionPrerequisite } from '../../../packages/agents/src/subscription-prerequisite.js';

/** All requested writes or proven no-ops must be represented before any draft is prepared. */
export function continuationProposalMatches(prerequisite: SubscriptionPrerequisite, input: PlannerInput, result: PlanResult): boolean {
  if (!input.semanticIntent || !verifySubscriptionContinuation(prerequisite, input.semanticIntent)
    || result.clarification || result.failure || result.suggestions.length || result.investmentSuggestions?.length || result.goalSuggestion
    || result.diagnostics?.review?.effectiveApproved === false) return false;
  const snapshot = input.managementContext?.subscriptions;
  if (!snapshot) return false;
  const expected: ManagementSpec[] = [];
  for (const task of input.semanticIntent.tasks) {
    const item = snapshot.items.find(item => item.id === task.slots.entityId);
    if (!item) return false;
    if (task.operation === 'subscription_cancel') {
      if (item.merchantStatus === 'CANCELLED') continue;
      if (!item.cancellationSupported) return false;
      expected.push({ kind: 'SUBSCRIPTION_CANCEL', subscriptionId: item.id, expectedVersion: item.version, queryActionId: snapshot.queryActionId });
    } else if (task.operation === 'subscription_block') {
      if (item.bankStatus === 'BLOCKED') continue;
      expected.push({ kind: 'SUBSCRIPTION_BLOCK', subscriptionId: item.id, expectedVersion: item.version, queryActionId: snapshot.queryActionId });
    } else return false;
  }
  const actual = result.managementSuggestions ?? [];
  return actual.length === expected.length && actual.every((value, index) => {
    const target = expected[index]!;
    return value.kind === target.kind && 'subscriptionId' in value && 'subscriptionId' in target
      && value.subscriptionId === target.subscriptionId && value.expectedVersion === target.expectedVersion && value.queryActionId === target.queryActionId;
  });
}

/** Persist only neutral status text: historical chat must not outlive query access. */
export function publicContinuationResult(result: PlanResult, matched: boolean): PlanResult {
  return { taskId: result.taskId, planVersion: result.planVersion, mode: result.mode,
    summary: matched ? ((result.managementSuggestions?.length ?? 0) > 0 ? '已按原请求完成订阅核对。需要变更的事项已生成独立待确认提案；查询确认没有授权取消或拦截。已满足的事项无需重复办理。' : '已按原请求完成订阅核对。所有事项均已满足，无需重复办理；本次没有生成或执行新的取消或拦截动作。')
      : '原请求已保留，但尚未完整核对所有订阅事项；未创建取消或拦截提案。请重新明确对象和操作。',
    ...(!matched ? { clarification: '未能完整核对原请求中的全部订阅事项，请完整重述；没有自动改成其他操作。' } : {}),
    events: result.events.map(event => ({ role: event.role, status: event.status, at: event.at, summary: '订阅原请求核对阶段' })), evidence: [], findings: [], suggestions: [], managementSuggestions: matched ? result.managementSuggestions : [],
    modelRuns: result.modelRuns, modelAttempts: result.modelAttempts };
}
export function redactStoredContinuationActions(actions: ManagementAction[]): ManagementAction[] {
  return actions.map(({ receipt: _receipt, failureReason: _failure, ...action }) => ({ ...action, title: '订阅事务', details: [], detailsRedacted: true }));
}
