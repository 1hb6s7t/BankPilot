import type { ModelRun, PlanningFailure, PlanningStageKey } from '../../contracts/src/index';
import { ModelAttemptPersistenceError, ModelProviderError } from './provider';
export class PlanningStageFailure extends Error {
  readonly code: string;
  constructor(public readonly failure: PlanningFailure) { super(failure.code); this.code = failure.code; this.name = 'PlanningStageFailure'; }
}
export function stageFailure(error: unknown, stage: PlanningStageKey, modelRuns: ModelRun[] = []): PlanningFailure {
  if (error instanceof PlanningStageFailure) return error.failure;
  const code = error instanceof ModelProviderError || error instanceof ModelAttemptPersistenceError ? error.code
    : error instanceof Error && error.name === 'ZodError' ? 'MODEL_SCHEMA_INVALID'
    : error instanceof Error && 'code' in error && /^(?:STAGE_|MODEL_OUTPUT_BUDGET_|MODEL_ATTEMPT_|PLAN_SUPERSEDED)/.test(String(error.code)) ? String(error.code) : 'MODEL_PLANNING_FAILED';
  const retryable = /^(?:MODEL_HTTP_(?:408|429|5\d{2})|MODEL_TIMEOUT|MODEL_NETWORK_ERROR|MODEL_DEADLINE_EXCEEDED)$/.test(code);
  return { phase: 'planning', stage, code, retryable, modelRuns,
    message: retryable ? '规划服务暂时不可用，已完成的部分已保留。可以重试原请求。' : '规划结果未能安全核对，当前不能重试。尚未创建新的动作，请联系服务支持。' };
}
export function stageError(error: unknown, stage: PlanningStageKey, runs: ModelRun[] = []): Error {
  // Preserve the original persistence metadata and fencing signal.
  if (error instanceof ModelAttemptPersistenceError || error instanceof PlanningStageFailure || error instanceof Error && 'code' in error && error.code === 'PLAN_SUPERSEDED') return error;
  return new PlanningStageFailure(stageFailure(error, stage, runs));
}
