import { describe, expect, it } from 'vitest';
import { createStageOutputPlan, PLANNING_OUTPUT_TOKEN_LIMIT, SEMANTIC_OUTPUT_TOKEN_LIMIT } from '../packages/agents/src/budget';

describe('one shared requested-output envelope for the actual planning stages', () => {
  it('gives semantic interpretation 4096 per attempt and divides the remaining ceiling', () => {
    const plan = createStageOutputPlan({ domainStageCount: 2, reviewerStageCount: 1, maxAttempts: 2 });
    expect(plan).toEqual({ totalOutputTokens: 32768, maxAttempts: 2, domainStageCount: 2, reviewerStageCount: 1,
      semanticMaxOutputTokens: 4096, semanticReserved: 8192, downstreamMaxOutputTokens: 4096,
      downstreamReserved: 24576, allocatedCeiling: 32768, unallocatedTokens: 0 });
  });
  it('allocates larger downstream calls for a single actual domain without raising the total', () => {
    const plan = createStageOutputPlan({ domainStageCount: 1, reviewerStageCount: 1, maxAttempts: 2 });
    expect(plan.downstreamMaxOutputTokens).toBe(6144);
    expect(plan.semanticReserved + 2 * 2 * plan.downstreamMaxOutputTokens).toBe(PLANNING_OUTPUT_TOKEN_LIMIT);
  });
  it('counts a joint-domain request as one network stage rather than its declared domains', () => {
    const plan = createStageOutputPlan({ domainStageCount: 1, reviewerStageCount: 0, maxAttempts: 2 });
    expect(plan.downstreamMaxOutputTokens).toBe(12288);
    expect(plan.allocatedCeiling).toBe(32768);
  });
  it('does not allocate nonexistent downstream calls after semantic stop', () => {
    expect(createStageOutputPlan({ domainStageCount: 0, reviewerStageCount: 0, maxAttempts: 2 })).toMatchObject({ semanticReserved: 8192, downstreamMaxOutputTokens: 0, downstreamReserved: 0, allocatedCeiling: 8192, unallocatedTokens: 24576 });
  });
  it('is stateless across interpret/API preparation/plan reconstruction and never refunds usage', () => {
    const first = createStageOutputPlan({ domainStageCount: 6, reviewerStageCount: 1, maxAttempts: 2 });
    const second = createStageOutputPlan({ domainStageCount: 6, reviewerStageCount: 1, maxAttempts: 2 });
    expect(first).toEqual(second);
    expect(first.downstreamMaxOutputTokens).toBe(1755);
    expect(first.allocatedCeiling).toBe(32762);
    expect(first.unallocatedTokens).toBe(6);
    expect(Object.isFrozen(first)).toBe(true);
  });
  it('bounds every supported stage/attempt combination including uneven division', () => {
    for (let domains = 0; domains <= 6; domains++) for (let reviewer = 0; reviewer <= 1; reviewer++) for (let attempts = 1; attempts <= 3; attempts++) {
      const plan = createStageOutputPlan({ domainStageCount: domains, reviewerStageCount: reviewer, maxAttempts: attempts });
      expect(plan.semanticReserved).toBe(SEMANTIC_OUTPUT_TOKEN_LIMIT * attempts);
      expect(plan.allocatedCeiling).toBeLessThanOrEqual(PLANNING_OUTPUT_TOKEN_LIMIT);
      expect(plan.allocatedCeiling + plan.unallocatedTokens).toBe(PLANNING_OUTPUT_TOKEN_LIMIT);
      if (domains + reviewer) expect(plan.downstreamMaxOutputTokens).toBeGreaterThan(0);
    }
  });
  it('allows a smaller explicit envelope, but fails closed if it cannot fit every stage', () => {
    const small = createStageOutputPlan({ domainStageCount: 6, reviewerStageCount: 1, maxAttempts: 2, totalOutputTokens: 9000 });
    expect(small.downstreamMaxOutputTokens).toBe(57);
    expect(small.allocatedCeiling).toBe(8990);
    expect(() => createStageOutputPlan({ domainStageCount: 1, reviewerStageCount: 1, maxAttempts: 2, totalOutputTokens: 8192 })).toThrow('MODEL_OUTPUT_BUDGET_EXHAUSTED');
    expect(() => createStageOutputPlan({ domainStageCount: 0, reviewerStageCount: 0, maxAttempts: 2, totalOutputTokens: 8191 })).toThrow('MODEL_OUTPUT_BUDGET_EXHAUSTED');
  });
  it.each([
    { domainStageCount: -1 }, { domainStageCount: 7 }, { domainStageCount: 1.5 },
    { reviewerStageCount: -1 }, { reviewerStageCount: 2 }, { reviewerStageCount: 0.5 },
    { maxAttempts: 0 }, { maxAttempts: 4 }, { maxAttempts: NaN },
    { totalOutputTokens: 32769 }, { totalOutputTokens: 0 }, { totalOutputTokens: Infinity },
  ])('rejects invalid/uncapped requested allocation: %j', override => {
    expect(() => createStageOutputPlan({ domainStageCount: 1, reviewerStageCount: 1, maxAttempts: 2, ...override })).toThrow('MODEL_OUTPUT_BUDGET_INVALID');
  });
});
