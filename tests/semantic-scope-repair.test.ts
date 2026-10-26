import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPlanner } from '../packages/agents/src/index';
import { interpretSemanticIntent } from '../packages/agents/src/semantic-intent';
import type { Planner } from '../packages/contracts/src/index';
import type { OpenAICompatibleConfig } from '../packages/agents/src/provider';

type PlannerInput = Parameters<Planner['plan']>[0];
const provider: OpenAICompatibleConfig = {
  baseURL: 'https://semantic-repair.invalid/v1', model: 'mock-semantic',
  outputMode: 'json_object', maxAttempts: 2, retryDelayMs: 0, maxOutputTokens: 4096, temperature: 0,
};
const input = (message: string): PlannerInput => ({
  taskId: 'semantic-scope-repair-test', message,
  accounts: [{ id: 'acct-1', name: '合成账户', maskedNumber: '****8888', balanceMinor: '800000', reservedMinor: '0', currency: 'CNY' }],
  payees: [{ id: 'payee-1', name: '林晓', aliases: [], bank: '合成银行', maskedNumber: '****1234' }],
});
const response = (value: unknown) => new Response(JSON.stringify({
  usage: { prompt_tokens: 21, completion_tokens: 11 },
  choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value) } }],
}), { status: 200 });
const draft = (scopeText: string, message: string) => ({ tasks: [{
  operation: 'transfer', disposition: 'request', scope: { text: scopeText },
  entity: { kind: 'payee', id: 'payee-1', mention: { text: '林晓', start: message.indexOf('林晓'), end: message.indexOf('林晓') + 2 } },
  amount: { text: '120元', start: message.indexOf('120元'), end: message.indexOf('120元') + 4 },
}] });
const taskFromCall = (call: unknown[]) => JSON.parse(
  JSON.parse(String((call[1] as RequestInit).body)).messages.find((message: { role: string }) => message.role === 'user').content,
);

afterEach(() => vi.unstubAllGlobals());

describe('semantic source-copy regeneration within the provider budget', () => {
  it('retries only the missing source scope, then validates exact original entity and amount spans', async () => {
    const message = '给林晓转120元';
    const fetch = vi.fn().mockResolvedValueOnce(response(draft('给小林转120元', message))).mockResolvedValueOnce(response(draft(message, message)));
    vi.stubGlobal('fetch', fetch);
    const result = await interpretSemanticIntent(input(message), { provider });

    expect(result.status).toBe('ready');
    expect(result.tasks[0]?.slots).toEqual({ entityId: 'payee-1', amountMinor: '12000' });
    expect(fetch).toHaveBeenCalledTimes(2);
    const bodies = fetch.mock.calls.map(call => JSON.parse(String(call[1].body)));
    expect(bodies.map(body => body.max_tokens)).toEqual([4096, 4096]);
    expect(bodies.map(body => body.temperature)).toEqual([0, 0]);
    expect(taskFromCall(fetch.mock.calls[0] as unknown[])).toEqual(taskFromCall(fetch.mock.calls[1] as unknown[]));
    expect(result.modelRuns.map(run => [run.attempt, run.status, run.errorCode])).toEqual([
      [1, 'failed', 'MODEL_SCHEMA_INVALID'], [2, 'success', undefined],
    ]);
    expect(result.modelRuns[0]?.issues).toContainEqual(expect.objectContaining({ code: 'custom', path: ['tasks', '[]', 'scope', 'text'] }));
    const retrySystemMessage = bodies[1].messages[0].content;
    expect(retrySystemMessage).toContain('MODEL_SCHEMA_INVALID');
    expect(retrySystemMessage).not.toContain('给小林转120元');
  });

  it('does not let a source-copy retry switch the first eligible transfer into another operation', async () => {
    const message = '给林晓转120元';
    const changedOperation = { tasks: [{ operation: 'funds_query', disposition: 'query', scope: { text: message } }] };
    const fetch = vi.fn().mockResolvedValueOnce(response(draft('给小林转120元', message))).mockResolvedValueOnce(response(changedOperation));
    vi.stubGlobal('fetch', fetch);
    const result = await createPlanner({ provider }).plan(input(message));

    expect(result.diagnostics?.intent?.status).toBe('clarification');
    expect(result.suggestions).toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['disposition', (base: ReturnType<typeof draft>) => ({ tasks: [{ ...base.tasks[0], disposition: 'negated' }] })],
    ['catalog identity', (base: ReturnType<typeof draft>) => ({ tasks: [{ ...base.tasks[0], entity: { ...base.tasks[0].entity, id: 'payee-2' } }] })],
    ['amount text', (base: ReturnType<typeof draft>) => ({ tasks: [{ ...base.tasks[0], amount: { ...base.tasks[0].amount, text: '200元' } }] })],
    ['memo presence/content', (base: ReturnType<typeof draft>) => ({ tasks: [{ ...base.tasks[0], memo: { text: '另存备注' } }] })],
  ])('fails closed if source repair changes %s', async (_field, change) => {
    const message = '给林晓转120元';
    const first = draft('给小林转120元', message);
    const second = change(draft(message, message));
    const fetch = vi.fn().mockResolvedValueOnce(response(first)).mockResolvedValueOnce(response(second));
    vi.stubGlobal('fetch', fetch);
    const result = await createPlanner({ provider }).plan(input(message));

    expect(result.diagnostics?.intent?.status).toBe('clarification');
    expect(result.findings).toContain('SEMANTIC_SOURCE_REPAIR_DRIFT');
    expect(result.suggestions).toEqual([]);
    expect(result.modelRuns?.map(run => [run.attempt, run.status, run.errorCode])).toEqual([
      [1, 'failed', 'MODEL_SCHEMA_INVALID'], [2, 'failed', 'MODEL_SCHEMA_INVALID'],
    ]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('keeps the final grounding diagnostic and failed attempt history when scope-copy repair is exhausted', async () => {
    const message = '给林晓转120元';
    const invalid = draft('给小林转120元', message);
    const fetch = vi.fn().mockImplementation(() => response(invalid));
    vi.stubGlobal('fetch', fetch);
    const result = await interpretSemanticIntent(input(message), { provider });

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(result.status).toBe('clarification');
    expect(result.tasks).toEqual([]);
    expect(result.findings).toContain('SEMANTIC_SPAN_NOT_FOUND');
    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'SEMANTIC_SPAN_NOT_FOUND', category: 'source' }));
    expect(result.modelRuns.map(run => [run.attempt, run.status, run.errorCode])).toEqual([
      [1, 'failed', 'MODEL_SCHEMA_INVALID'], [2, 'failed', 'MODEL_SCHEMA_INVALID'],
    ]);
  });

  it('short-circuits the complete planner after exhausted scope-copy repair with no business or reviewer calls', async () => {
    const message = '给林晓转120元';
    const invalid = draft('给小林转120元', message);
    const fetch = vi.fn().mockImplementation(() => response(invalid));
    vi.stubGlobal('fetch', fetch);
    const result = await createPlanner({ provider }).plan(input(message));

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(result.suggestions).toEqual([]);
    expect(result.diagnostics?.intent).toMatchObject({ status: 'clarification' });
    expect(result.findings).toContain('SEMANTIC_SPAN_NOT_FOUND');
    expect(result.modelRuns?.map(run => [run.role, run.attempt, run.status, run.errorCode])).toEqual([
      ['semantic_intent', 1, 'failed', 'MODEL_SCHEMA_INVALID'],
      ['semantic_intent', 2, 'failed', 'MODEL_SCHEMA_INVALID'],
    ]);
    expect(result.modelRuns?.reduce((sum, run) => sum + (run.requestMaxOutputTokens ?? 0), 0)).toBe(8192);
    expect(result.modelRuns?.reduce((sum, run) => sum + (run.requestMaxOutputTokens ?? 0), 0)).toBeLessThanOrEqual(32768);
  });

  it('does not spend a repair attempt or enter business/reviewer stages on a negated request', async () => {
    const message = '不要给林晓转120元';
    const fetch = vi.fn().mockResolvedValue(response(draft('给小林转120元', message)));
    vi.stubGlobal('fetch', fetch);
    const result = await createPlanner({ provider }).plan(input(message));

    expect(result.suggestions).toEqual([]);
    expect(result.diagnostics?.intent?.status).toBe('clarification');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(taskFromCall(fetch.mock.calls[0] as unknown[]).role).toBe('semantic_intent');
  });

  it('does not let a missing transfer scope absorb an unrelated second requested operation', async () => {
    const message = '请给林晓转120元；查询2026年10月账单';
    const fetch = vi.fn().mockResolvedValueOnce(response(draft('缺失的转账范围', message))).mockResolvedValueOnce(response(draft(message, message)));
    vi.stubGlobal('fetch', fetch);
    const result = await createPlanner({ provider }).plan(input(message));

    // A second operation outside this narrow source-copy case must not be
    // silently omitted while a transfer proposal is created.
    expect(result.suggestions).toEqual([]);
    expect(result.diagnostics?.intent?.status).toBe('clarification');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('does not repair a slotless funds query when the original message also requests a transfer', async () => {
    const message = '查询扣除房租后的可安排资金；给林晓转120元';
    const fetch = vi.fn().mockResolvedValue(response({ tasks: [{
      operation: 'funds_query', disposition: 'query', scope: { text: '缺失的资金查询范围' },
    }] }));
    vi.stubGlobal('fetch', fetch);
    const result = await createPlanner({ provider }).plan(input(message));

    expect(result.diagnostics?.intent?.status).toBe('clarification');
    expect(result.suggestions).toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('does not repair one selected transfer when the original message contains two same-domain transfers', async () => {
    const message = '给林晓转120元；再给林晓转200元';
    const fetch = vi.fn().mockResolvedValue(response(draft('缺失的第一笔转账范围', message)));
    vi.stubGlobal('fetch', fetch);
    const result = await createPlanner({ provider }).plan(input(message));

    expect(result.diagnostics?.intent?.status).toBe('clarification');
    expect(result.suggestions).toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
