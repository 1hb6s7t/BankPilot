import type { ActionView, GoalNode, GoalView, InvestmentAction } from '../../../packages/contracts/src';

type GoalAction = InvestmentAction | ActionView;
const actionStatusRank: Record<GoalAction['status'], number> = {
  AWAITING_CONFIRMATION: 1, AWAITING_VERIFICATION: 2, AUTHORIZED: 3, SUBMITTING: 4,
  UNKNOWN: 5, SETTLING: 6, CANCELLED: 7, EXPIRED: 8, FAILED: 9, SUCCEEDED: 10,
};

export function goalNodeStatusForAction(action: GoalAction): GoalNode['status'] {
  if (action.status === 'SUCCEEDED') return 'SUCCEEDED';
  if (action.status === 'UNKNOWN' || action.status === 'SUBMITTING') return 'UNKNOWN';
  if (['AUTHORIZED', 'SETTLING'].includes(action.status)) return 'IN_PROGRESS';
  if (['FAILED', 'CANCELLED', 'EXPIRED'].includes(action.status)) return 'FAILED';
  return 'AWAITING_AUTH';
}

function latestAction<T extends GoalAction>(current: T | undefined, incoming: T | undefined): T | undefined {
  if (!current) return incoming;
  if (!incoming) return current;
  if (incoming.updatedAt !== current.updatedAt) return incoming.updatedAt > current.updatedAt ? incoming : current;
  return actionStatusRank[incoming.status] > actionStatusRank[current.status] ? incoming : current;
}

function sameNodeSpec(current: GoalNode, incoming: GoalNode): boolean {
  return current.kind === incoming.kind && current.specVersion === incoming.specVersion
    && current.dependsOn.length === incoming.dependsOn.length
    && current.dependsOn.every((id) => incoming.dependsOn.includes(id));
}

/** Merge a server snapshot without allowing an old poll response to roll a goal plan back. */
export function mergeGoalSnapshot(current: GoalView | undefined, incoming: GoalView): GoalView {
  if (!current) return incoming;
  if (incoming.planVersion < current.planVersion) return current;
  if (incoming.planVersion > current.planVersion) return incoming;

  const base = incoming.updatedAt >= current.updatedAt ? incoming : current;
  const previousNodes = new Map(current.nodes.map((node) => [node.id, node]));
  const incomingNodes = new Map(incoming.nodes.map((node) => [node.id, node]));
  const nodes = base.nodes.map((baseNode) => {
    const previous = previousNodes.get(baseNode.id);
    const next = incomingNodes.get(baseNode.id);
    if (!previous || !next || !sameNodeSpec(previous, next)) return baseNode;
    // A replacement intent must not inherit another action's status or receipt.
    if ((previous.actionRef && next.actionRef && (previous.actionRef.service !== next.actionRef.service || previous.actionRef.actionId !== next.actionRef.actionId))
      || (previous.investmentAction && next.investmentAction && previous.investmentAction.id !== next.investmentAction.id)
      || (previous.transferAction && next.transferAction && previous.transferAction.id !== next.transferAction.id)) return baseNode;
    if (baseNode.kind === 'WAIT_SETTLEMENT') {
      // Settlement is server-confirmed evidence; an expected date or redemption status alone is insufficient.
      const confirmed = previous.status === 'SUCCEEDED' ? previous : next.status === 'SUCCEEDED' ? next : undefined;
      return confirmed ? { ...baseNode, status: 'SUCCEEDED' as const, reason: undefined, evidenceRefs: confirmed.evidenceRefs } : baseNode;
    }
    const investmentAction = latestAction(previous.investmentAction, next.investmentAction);
    const transferAction = latestAction(previous.transferAction, next.transferAction);
    const action = investmentAction ?? transferAction;
    return {
      ...baseNode,
      ...(investmentAction ? { investmentAction } : {}),
      ...(transferAction ? { transferAction } : {}),
      ...(action ? {
        status: goalNodeStatusForAction(action), reason: action.failureReason,
        evidenceRefs: [action.id, ...(action.receipt ? [action.receipt.providerRequestId, action.receipt.providerTransactionId] : [])],
      } : {}),
    };
  });
  // Apply the service's dependency rule to the merged evidence, without creating or authorizing actions.
  // Only waiting nodes explicitly confirmed by a server snapshot can satisfy settlement dependencies.
  const mergedNodes = nodes.map((node) => {
    if (node.kind === 'WAIT_SETTLEMENT' || node.actionRef || node.investmentAction || node.transferAction) return node;
    const ready = node.dependsOn.every((id) => nodes.find((dependency) => dependency.id === id)?.status === 'SUCCEEDED');
    return { ...node, status: ready ? 'READY' as const : 'BLOCKED' as const, ...(ready ? { reason: undefined } : {}) };
  });
  if (mergedNodes.some((node) => node.kind === 'TRANSFER' && node.transferAction?.status === 'SUCCEEDED')) {
    return { ...base, nodes: mergedNodes, status: 'SUCCEEDED', reasons: [] };
  }
  if (mergedNodes.some((node) => node.status === 'FAILED')) {
    return { ...base, nodes: mergedNodes, status: 'NEEDS_REPLAN', reasons: ['原动作已失败、取消或过期；不会自动重试，需明确重新规划。'] };
  }
  return { ...base, nodes: mergedNodes };
}

export function mergeGoalSnapshots(current: GoalView[], incoming: GoalView[]): GoalView[] {
  const byId = new Map(current.map((goal) => [goal.id, goal]));
  for (const goal of incoming) byId.set(goal.id, mergeGoalSnapshot(byId.get(goal.id), goal));
  return [...byId.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
