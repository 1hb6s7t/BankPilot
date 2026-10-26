/** Requested output ceilings, not reported usage or a claim about provider billing. */
export const PLANNING_OUTPUT_TOKEN_LIMIT = 32768;
export const SEMANTIC_OUTPUT_TOKEN_LIMIT = 4096;
export type StageOutputPlan = Readonly<{
  totalOutputTokens: number; maxAttempts: number; domainStageCount: number; reviewerStageCount: number;
  semanticMaxOutputTokens: number; semanticReserved: number;
  downstreamMaxOutputTokens: number; downstreamReserved: number;
  allocatedCeiling: number; unallocatedTokens: number;
}>;
export class PlanningBudgetError extends Error {
  constructor(public readonly code: 'MODEL_OUTPUT_BUDGET_EXHAUSTED' | 'MODEL_OUTPUT_BUDGET_INVALID') {
    super(code); this.name = 'PlanningBudgetError';
  }
}
const integer = (value: number, minimum: number, maximum: number) => Number.isSafeInteger(value) && value >= minimum && value <= maximum;

/**
 * Reconstruct the same fixed envelope after semantic interpretation discovers
 * the actual stages. A durable caller can include all prior command reservations;
 * absent that value, the existing allocation is unchanged. No reported-usage
 * refund is involved. The caller journals each actual dispatch and its deadline.
 */
export function createStageOutputPlan(options: {
  domainStageCount: number; reviewerStageCount: number; maxAttempts: number; totalOutputTokens?: number; priorReservedOutputTokens?: number;
}): StageOutputPlan {
  const totalOutputTokens = options.totalOutputTokens ?? PLANNING_OUTPUT_TOKEN_LIMIT;
  const { domainStageCount, reviewerStageCount, maxAttempts } = options;
  if (!integer(totalOutputTokens, 1, PLANNING_OUTPUT_TOKEN_LIMIT) || !integer(domainStageCount, 0, 6) || !integer(reviewerStageCount, 0, 1) || !integer(maxAttempts, 1, 3)) throw new PlanningBudgetError('MODEL_OUTPUT_BUDGET_INVALID');
  if (options.priorReservedOutputTokens !== undefined && !integer(options.priorReservedOutputTokens, 0, PLANNING_OUTPUT_TOKEN_LIMIT)) throw new PlanningBudgetError('MODEL_OUTPUT_BUDGET_INVALID');
  const semanticReserved = Math.max(SEMANTIC_OUTPUT_TOKEN_LIMIT * maxAttempts, options.priorReservedOutputTokens ?? 0);
  if (semanticReserved > totalOutputTokens) throw new PlanningBudgetError('MODEL_OUTPUT_BUDGET_EXHAUSTED');
  const downstreamStageCount = domainStageCount + reviewerStageCount;
  const remaining = totalOutputTokens - semanticReserved;
  const downstreamMaxOutputTokens = downstreamStageCount ? Math.floor(remaining / (downstreamStageCount * maxAttempts)) : 0;
  if (downstreamStageCount && downstreamMaxOutputTokens < 1) throw new PlanningBudgetError('MODEL_OUTPUT_BUDGET_EXHAUSTED');
  const downstreamReserved = downstreamStageCount * maxAttempts * downstreamMaxOutputTokens;
  const allocatedCeiling = semanticReserved + downstreamReserved;
  return Object.freeze({ totalOutputTokens, maxAttempts, domainStageCount, reviewerStageCount,
    semanticMaxOutputTokens: SEMANTIC_OUTPUT_TOKEN_LIMIT, semanticReserved,
    downstreamMaxOutputTokens, downstreamReserved, allocatedCeiling,
    unallocatedTokens: totalOutputTokens - allocatedCeiling,
  });
}
