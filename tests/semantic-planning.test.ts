import { describe, expect, it, vi } from 'vitest';
import { createPlanner, validateSemanticIntent } from '../packages/agents/src/index';
import { preparePlannerInput } from '../apps/api/src/planning';
import type { PlannerInput } from '../packages/contracts/src/index';
import { CoreError } from '../packages/core/src/index';
import { evaluationFunds } from '../evals/fixtures';
import { expectPlanningFailure } from './g8f-failure-assertions';

const input: PlannerInput = { taskId: 'semantic-integration', message: '给林晓打点钱，就120元，备注午餐',
  accounts: [{ id: 'a', name: '合成账户', maskedNumber: '****8888', balanceMinor: '800000', reservedMinor: '0', currency: 'CNY' }],
  payees: [{ id: 'p', name: '林晓', aliases: [], bank: '合成银行', maskedNumber: '****1234' }],
};
const raw = { tasks: [{ operation: 'transfer', disposition: 'request', scope: { text: input.message }, entity: { kind: 'payee', id: 'p', mention: { text: '林晓' } }, amount: { text: '120元' }, memo: { text: '午餐' } }] };
const provider = { baseURL: 'https://test.invalid', model: 'fixture', outputMode: 'json_object' as const, maxAttempts: 1 };

describe('semantic interpretation enters the existing deterministic planning pipeline', () => {
  it.each([undefined, 1024])('keeps all retry request ceilings in one budget (explicit cap %s)', async maxOutputTokens => {
    const counts = new Map<string, number>();
    const calls: { role: string; limit: number; signal: AbortSignal | null | undefined }[] = [];
    const mock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init!.body));
      const task = JSON.parse(body.messages.find((m: { role: string }) => m.role === 'user').content);
      const count = (counts.get(task.role) ?? 0) + 1; counts.set(task.role, count);
      calls.push({ role: task.role, limit: body.max_tokens, signal: init?.signal });
      const result = count === 1 ? {} : task.role === 'semantic_intent' ? raw : task.role === 'reviewer'
        ? { approved: true, findings: [], summary: '一致' }
        : { role: 'transfer', planVersion: 1, summary: '待确认', suggestion: task.data.resolved.suggestion, findings: [], evidence: [] };
      return new Response(JSON.stringify({ usage: { prompt_tokens: 0, completion_tokens: 0 }, choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(result) } }] }), { status: 200 });
    });
    try {
      const planner = createPlanner({ provider: { ...provider, maxAttempts: 2, retryDelayMs: 1, maxOutputTokens } });
      // Same handoff as API: interpret once, then pass the prepared semantic plan to planning.
      const prepared = { ...input, deadlineAt: Date.now() + 180_000 };
      const semanticIntent = await planner.interpret!(prepared);
      const result = await planner.plan({ ...prepared, semanticIntent });
      expect(result.suggestions[0]?.amountMinor).toBe('12000');
      expect(calls.map(c => c.role)).toEqual(['semantic_intent', 'semantic_intent', 'transfer', 'transfer', 'reviewer', 'reviewer']);
      expect(calls.map(c => c.limit)).toEqual(maxOutputTokens ? Array(6).fill(maxOutputTokens) : [4096, 4096, 6144, 6144, 6144, 6144]);
      expect(calls.reduce((sum, c) => sum + c.limit, 0)).toBeLessThanOrEqual(32768);
      expect(calls.every(c => c.signal && !c.signal.aborted)).toBe(true);
      expect(result.modelRuns?.map(r => r.status)).toEqual(['failed', 'success', 'failed', 'success', 'failed', 'success']);
      expect(result.modelRuns?.map(r => r.requestMaxOutputTokens)).toEqual(calls.map(c => c.limit));
    } finally { mock.mockRestore(); }
  });
  it.each([
    { availableBeforeMinor: '700000', protectedMinor: '240000', spendableMinor: '460000', allowed: true, shortfallMinor: '0', expected: '4600.00' },
    { availableBeforeMinor: '240000', protectedMinor: '240000', spendableMinor: '0', allowed: true, shortfallMinor: '0', expected: '0.00' },
    { availableBeforeMinor: '170000', protectedMinor: '240000', spendableMinor: '0', allowed: false, shortfallMinor: '70000', expected: '0.00' },
  ])('answers the available-to-arrange amount from the authoritative preview: $expected', async facts => {
    const message = '查一下不影响房租时可安排的资金';
    const semanticIntent = validateSemanticIntent({ ...input, message }, { tasks: [{ operation: 'funds_query', disposition: 'query', scope: { text: message } }] });
    const fundsPreview = { ...evaluationFunds('0'), ...facts, availableAfterMinor: facts.availableBeforeMinor };
    const result = await createPlanner({ provider: false, domainAdapter: async () => ({ role: 'goal', planVersion: 1, summary: '错误模型叙述：全部余额都可用999999元', findings: [], evidence: [] }) }).plan({ ...input, message, semanticIntent, fundsPreview });
    expect(result.summary).toContain(`扣除保护金额后可安排${facts.expected}元`);
    expect(result.summary).toContain('本次仅查询'); expect(result.summary).not.toContain('999999');
    expect(result.evidence.some(e => e.detail.includes(`spendableMinor=${facts.spendableMinor};`))).toBe(true);
    expect(result.fundsPreview).toEqual(fundsPreview); expect(result.suggestions).toEqual([]);
  });
  it('rejects changing a grounded memo even when the payee and amount match', async () => {
    const review = vi.fn(async () => ({ approved: true, findings: [], summary: 'mock' }));
    const failure = await expectPlanningFailure(createPlanner({ provider: false, intentAdapter: async () => raw,
      domainAdapter: async context => ({ role: 'transfer', planVersion: 1, summary: '待确认', findings: [], evidence: [], suggestion: { ...(context.data.resolved as any).suggestion, memo: 'changed-without-source' } }),
      reviewerAdapter: review,
    }).plan(input), 'MODEL_CANDIDATE_CONTRACT_INVALID', 'domain:transfer');
    expect(failure.findings?.join()).toContain('TRANSFER_MEMO_MISMATCH');
    expect(review).not.toHaveBeenCalled();
  });
  it('production defaults to semantic routing, then exact domain schema and independent review', async () => {
    const seen: string[] = [];
    const mock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init!.body));
      const task = JSON.parse(body.messages.find((m: { role: string }) => m.role === 'user').content);
      seen.push(task.role);
      const result = task.role === 'semantic_intent' ? raw : task.role === 'reviewer'
        ? { approved: true, findings: [], summary: '一致' }
        : { role: 'transfer', planVersion: 1, summary: '待确认', suggestion: task.data.resolved.suggestion, findings: [], evidence: [] };
      if (task.role === 'reviewer') expect(task.originalRequest).toBe(input.message);
      return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(result) } }] }), { status: 200 });
    });
    try {
      const result = await createPlanner({ provider }).plan(input);
      expect(seen).toEqual(['semantic_intent', 'transfer', 'reviewer']);
      expect(result.suggestions).toEqual([{ payeeId: 'p', amountMinor: '12000', memo: '午餐' }]);
      expect(result.modelRuns?.map(r => r.role)).toEqual(seen);
      expect(result.diagnostics?.intent).toMatchObject({ status: 'ready', roles: ['transfer'] });
    } finally { mock.mockRestore(); }
  });
  it('prepared interpretation is reused once and funds are fetched for the grounded exact amount', async () => {
    const intentAdapter = vi.fn(async () => raw);
    const planner = createPlanner({ provider: false, intentAdapter });
    const preview = { amountMinor: '12000', accountId: 'a', allowed: true };
    const funds = vi.fn(async () => ({ preview }));
    const prepared = await preparePlannerInput({ planner, finance: { funds } as any }, { userId: 'u' }, input, { accounts: input.accounts, payees: input.payees } as any, new Date('2026-10-23T00:00:00Z'));
    expect(intentAdapter).toHaveBeenCalledTimes(1);
    expect(funds).toHaveBeenCalledWith({ userId: 'u' }, 'a', '12000');
    const result = await planner.plan(prepared);
    expect(intentAdapter).toHaveBeenCalledTimes(1);
    expect(result.suggestions[0]?.amountMinor).toBe('12000');
    expect(prepared.referenceDate).toBe('2026-10-23');
  });
  it('grounding failure never calls domains/reviewer or finance and keeps failure evidence', async () => {
    const broken = { tasks: [{ ...raw.tasks[0], amount: { text: '999元' } }] };
    const domain = vi.fn(), review = vi.fn(), funds = vi.fn();
    const planner = createPlanner({ provider: false, intentAdapter: async () => broken, domainAdapter: domain, reviewerAdapter: review });
    const prepared = await preparePlannerInput({ planner, finance: { funds } as any }, { userId: 'u' }, input, { accounts: input.accounts, payees: input.payees } as any);
    const result = await planner.plan(prepared);
    expect(result.suggestions).toEqual([]); expect(result.clarification).toBeTruthy();
    expect(result.diagnostics?.intent?.roles).toEqual(['transfer']);
    expect(domain).not.toHaveBeenCalled(); expect(review).not.toHaveBeenCalled(); expect(funds).not.toHaveBeenCalled();
  });
  it('expired subscription access is never included in the model catalog or bypassed', async () => {
    const subscriptions = vi.fn(async () => { throw new CoreError('QUERY_ACCESS_EXPIRED', 'expired'); });
    const planner = createPlanner({ provider: false, intentAdapter: async task => {
      expect((task as any).catalog.some((item: any) => item.kind === 'subscription')).toBe(false);
      return { tasks: [{ operation: 'subscription_query', disposition: 'query', scope: { text: '查询订阅' } }] };
    } });
    const prepared = await preparePlannerInput({ planner, management: { dashboard: async () => ({ cards: [], subscriptionQueryActionId: 'expired' }), subscriptions } as any }, { userId: 'u' }, { ...input, message: '查询订阅' }, { accounts: input.accounts, payees: input.payees } as any);
    const result = await planner.plan(prepared);
    expect(subscriptions).toHaveBeenCalledTimes(1);
    expect(result.managementSuggestions).toEqual([{ kind: 'SUBSCRIPTION_QUERY' }]);
  });
  it('missing requested bill data produces a question with no fabricated report', async () => {
    const billInput = { ...input, message: '看看2027年2月的支出' };
    const semanticIntent = validateSemanticIntent(billInput, { tasks: [{ operation: 'bills_query', disposition: 'query', scope: { text: billInput.message }, period: { text: '2027年2月' } }] });
    const result = await createPlanner({ provider: false }).plan({ ...billInput, semanticIntent });
    expect(result.clarification).toContain('2027-02'); expect(result.billReport).toBeUndefined(); expect(result.suggestions).toEqual([]);
  });
});
