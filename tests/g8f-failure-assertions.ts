import { expect } from 'vitest';
import type { PlanResult, PlanningStageKey } from '../packages/contracts/src/index';
import { PlanningStageFailure } from '../packages/agents/src/planning-failures';
/** A system failure cannot escape as a consumable result with any kind of draft. */
export async function expectPlanningFailure(pending: Promise<PlanResult>, code: string, stage?: PlanningStageKey) {
  let result: PlanResult | undefined;
  const outcome = await pending.then(value => { result = value; return undefined; }, error => error);
  expect(result).toBeUndefined();
  expect(outcome).toBeInstanceOf(PlanningStageFailure);
  expect(outcome.failure).toMatchObject({ phase: 'planning', code, retryable: false, ...(stage ? { stage } : {}) });
  expect(outcome).not.toHaveProperty('suggestions');
  expect(outcome).not.toHaveProperty('managementSuggestions');
  expect(outcome).not.toHaveProperty('investmentSuggestions');
  expect(outcome).not.toHaveProperty('goalSuggestion');
  return (outcome as PlanningStageFailure).failure;
}
