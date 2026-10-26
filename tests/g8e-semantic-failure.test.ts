import { afterEach, describe, expect, it, vi } from 'vitest';
import { interpretSemanticIntent } from '../packages/agents/src/semantic-intent';
import { permanentPlanningSnapshotFailure, planningFailure } from '../apps/api/src/planning-journal';
import { createStageOutputPlan } from '../packages/agents/src/budget';
const input = { taskId: 'failure', message: '查看余额', accounts: [], payees: [] };
const provider = { baseURL: 'https://model.invalid/v1', model: 'stub', maxAttempts: 2, retryDelayMs: 0 };
afterEach(() => vi.unstubAllGlobals());
describe('G8E service failures are not user clarification', () => {
  it.each([408,429,500,502,503])('marks HTTP %i as a bounded recoverable service failure', async status => {
    const fetch = vi.fn(async () => new Response('', { status })); vi.stubGlobal('fetch', fetch);
    const result = await interpretSemanticIntent(input, { provider });
    expect(result).toMatchObject({ status: 'failed', tasks: [], failure: { phase: 'semantic_intent', code: `MODEL_HTTP_${status}`, retryable: true } });
    expect(result.clarification).toBeUndefined(); expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('does not offer retry for authentication failure', async () => {
    const fetch = vi.fn(async () => new Response('', { status: 401 })); vi.stubGlobal('fetch', fetch);
    const result = await interpretSemanticIntent(input, { provider });
    expect(result).toMatchObject({ status: 'failed', failure: { code: 'MODEL_HTTP_401', retryable: false } });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each([
    ['MODEL_SCHEMA_INVALID', () => new Response(JSON.stringify({ choices: [{ message: { content: '{}' }, finish_reason: 'stop' }] })), 'json_object'],
    ['MODEL_OUTPUT_JSON_INVALID', () => new Response(JSON.stringify({ choices: [{ message: { content: '{' }, finish_reason: 'stop' }] })), 'json_object'],
    ['MODEL_OUTPUT_EMPTY', () => new Response(JSON.stringify({ choices: [{ message: { content: '' }, finish_reason: 'stop' }] })), 'json_object'],
    ['MODEL_OUTPUT_TRUNCATED', () => new Response(JSON.stringify({ choices: [{ message: { content: '{}' }, finish_reason: 'length' }] })), 'json_object'],
    ['MODEL_TOOL_OUTPUT_INVALID', () => new Response(JSON.stringify({ choices: [{ message: { content: '{}' }, finish_reason: 'stop' }] })), 'tools'],
    ['MODEL_RESPONSE_JSON_INVALID', () => new Response('{'), 'json_object'],
    ['MODEL_OUTPUT_REFUSED', () => new Response(JSON.stringify({ choices: [{ message: { refusal: 'controlled refusal' }, finish_reason: 'stop' }] })), 'json_object'],
  ] as const)('classifies exhausted raw output failure %s as a system failure, not user clarification', async (code, response, outputMode) => {
    const fetch = vi.fn(async () => response()); vi.stubGlobal('fetch', fetch);
    const result = await interpretSemanticIntent(input, { provider: { ...provider, outputMode } });
    expect(result).toMatchObject({ status: 'failed', tasks: [], failure: { phase: 'semantic_intent', code, retryable: false } });
    expect(result.clarification).toBeUndefined(); expect(result.findings).toEqual([code]);
    expect(result.modelRuns.at(-1)?.errorCode).toBe(code);
    expect(fetch.mock.calls.length).toBeLessThanOrEqual(2);
  });
  it('keeps grounded business uncertainty distinct from raw output failure', async () => {
    const draft = { tasks: [{ operation: 'transfer', disposition: 'request', scope: { source: 'whole_message' } }] };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(draft) }, finish_reason: 'stop' }] }))));
    const result = await interpretSemanticIntent({ ...input, message: '请转账' }, { provider: { ...provider, outputMode: 'json_object' } });
    expect(result.status).toBe('clarification'); expect(result.failure).toBeUndefined(); expect(result.tasks).toEqual([]);
  });
  it.each(['RECOGNITION_SNAPSHOT_INCOMPATIBLE', 'RECOGNITION_SNAPSHOT_INVALID', 'RECOGNITION_INPUT_DRIFT', 'SEMANTIC_SNAPSHOT_INVALID', 'PLANNER_SNAPSHOT_BINDING_MISMATCH', 'LEGACY_PROPOSAL_ACCOUNT_UNRECOVERABLE'])('marks permanent snapshot fault %s as non-retryable', code => {
    expect(permanentPlanningSnapshotFailure(code)).toBe(true);
    expect(planningFailure(code, [], false, 'planning')).toMatchObject({ phase: 'planning', retryable: false });
    expect(planningFailure(code).message).not.toContain('可以重试');
  });
  it('does not classify lease takeover or temporary finance availability as permanent snapshot faults', () => {
    expect(permanentPlanningSnapshotFailure('PLAN_SUPERSEDED')).toBe(false);
    expect(permanentPlanningSnapshotFailure('FINANCE_UNAVAILABLE')).toBe(false);
  });
  it('deducts accumulated command reservations before allocating downstream output', () => {
    const plan = createStageOutputPlan({ domainStageCount: 1, reviewerStageCount: 1, maxAttempts: 2, priorReservedOutputTokens: 24576 } as any);
    expect(plan.downstreamMaxOutputTokens).toBe(2048);
    expect(plan.allocatedCeiling).toBe(32768);
  });
});
