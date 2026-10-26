import { billDomainResponse } from './fixtures/bill-domain-response';
import { expectPlanningFailure } from './g8f-failure-assertions';
// Legacy domain/reviewer protocol mocks opt out of the separately tested semantic interpretation stage.
import { describe, expect, it, vi } from 'vitest';
import { createEvaluationPlanner, createPlanner, evaluationRoles, type EvaluationOrchestrationMode, type LocalContext, type ReviewContext } from '../packages/agents/src/index';
import type { BillReport, FundsPreview, Planner } from '../packages/contracts/src/index';
import { reviewResponse } from './fixtures/review-response';

const modes: EvaluationOrchestrationMode[] = ['single', 'parallel', 'parallel-review'];
const config = { baseURL: 'https://ablation-mock.invalid', model: 'mocked-equal-model', outputMode: 'json_object' as const, maxAttempts: 1 };
const bill: BillReport = {
  period: '2026-10', source: 'SYNTHETIC', incomeMinor: '0', expenseMinor: '1000', netMinor: '-1000', previousExpenseMinor: '0', generatedAt: '2026-10-22T08:00:00Z', findings: [],
  categories: [{ category: '餐饮', amountMinor: '1000', count: 1, transactionIds: ['ablation-meal'] }],
  transactions: [{ id: 'ablation-meal', accountId: 'PRIVATE_BILL_ACCOUNT', bookedAt: '2026-10-01', merchant: '合成餐饮', amountMinor: '1000', direction: 'OUT', category: '餐饮', source: 'SYNTHETIC_STATEMENT' }],
};
const funds = (extra: Partial<FundsPreview> = {}): FundsPreview => ({ accountId: 'account-a', amountMinor: '30000', balanceMinor: '800000', reservedMinor: '0', availableBeforeMinor: '800000', availableAfterMinor: '770000', protectedMinor: '350000', spendableMinor: '450000', shortfallMinor: '0', allowed: true, policyVersion: 1, horizonEnd: '2026-11-22', obligations: [], reasons: ['确定性合成预演'], ...extra });
const input = (message = '分析账单，给林晓转账300元，不影响房租预算'): Parameters<Planner['plan']>[0] => ({
  taskId: 'ablation-task', message,
  accounts: [{ id: 'account-a', name: 'PRIVATE_ACCOUNT_NAME', maskedNumber: '****8888', balanceMinor: '800000', reservedMinor: '0', currency: 'CNY' }],
  payees: [{ id: 'payee-lin', name: '林晓', bank: '合成银行', maskedNumber: '****1208', aliases: ['小林'] }],
  billReport: structuredClone(bill), fundsPreview: funds(),
});
const domain = (task: LocalContext) => task.role === 'bills' ? billDomainResponse(task) : ({ role: task.role, planVersion: task.planVersion, summary: 'mock model domain explanation, never authorization', findings: [], evidence: [],
  ...(task.role === 'transfer' ? task.data.resolved as object : {}),
  ...(task.role === 'card' || task.role === 'subscription' ? task.data.management as object : {}),
  ...(task.role === 'investment' ? task.data.investment as object : {}),
  ...(task.role === 'goal' && task.data.lifeGoal ? task.data.lifeGoal as object : {}),
});
const answer = (task: any): any => task.role === 'single' ? { proposals: task.contexts.map(domain) } : task.role === 'reviewer' ? reviewResponse(task, { summary: 'valid pending proposals, not financial authority' }) : domain(task);
function mockHTTP(transform: (task: any, body: any) => unknown = task => answer(task)) {
  const tasks: any[] = [], bodies: any[] = [];
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    const body = JSON.parse(String(init?.body)), task = JSON.parse(body.messages[1].content); tasks.push(task); bodies.push(body);
    const value = transform(task, body);
    if (value instanceof Response) return value;
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(value) } }], usage: { prompt_tokens: 17, completion_tokens: 11 } }), { status: 200 });
  });
  return { fetch, tasks, bodies };
}

describe('fair orchestration ablation with a shared deterministic gate', () => {
  it.each(modes)('%s uses the expected number of real transport calls and does not invent a reviewer', async mode => {
    const mock = mockHTTP();
    try {
      const result = await createEvaluationPlanner(mode, { provider: config }).plan(input());
      const expected = mode === 'single' ? 1 : mode === 'parallel' ? 3 : 4;
      expect(mock.fetch).toHaveBeenCalledTimes(expected); expect(result.modelRuns).toHaveLength(expected);
      expect(result.mode).toBe('model'); expect(result.suggestions[0]).toMatchObject({ payeeId: 'payee-lin', amountMinor: '30000' });
      expect(result.billReport).toEqual(bill);
      expect(result.events.filter(e => e.status === 'started' && e.role !== 'reviewer').map(e => e.role).sort()).toEqual(['transfer', 'bills', 'goal'].sort());
      expect(result.events.some(e => e.role === 'reviewer')).toBe(mode === 'parallel-review');
      expect(result.diagnostics?.review !== undefined).toBe(mode === 'parallel-review');
      if (mode === 'single') { expect(mock.tasks[0].role).toBe('single'); expect(result.modelRuns?.[0]?.role).toBe('single'); }
      else expect(result.modelRuns?.filter(r => r.role !== 'reviewer').map(r => r.role).sort()).toEqual(['transfer', 'bills', 'goal'].sort());
    } finally { mock.fetch.mockRestore(); }
  });

  it('gives the single model exactly the same minimal context collection used by the domain models', async () => {
    let singleContexts: unknown[] = [], parallelContexts: unknown[] = [];
    const joint = mockHTTP(task => { if (task.role === 'single') singleContexts = structuredClone(task.contexts); return answer(task); });
    try {
      await createEvaluationPlanner('single', { provider: config }).plan(input());
      const schema = JSON.parse(joint.bodies[0].messages[0].content.split('Required JSON schema: ')[1]);
      expect(schema.required).toEqual(['proposals']); expect(schema.additionalProperties).toBe(false);
      expect(schema.properties.proposals.prefixItems).toHaveLength(3);
      expect(schema.properties.proposals.prefixItems.map((s: any) => s.properties.role.const)).toEqual(['transfer', 'bills', 'goal']);
      expect(schema.properties.proposals.prefixItems[0].required).toContain('suggestion');
      expect(schema.properties.proposals.prefixItems[0].properties.suggestion.properties.amountMinor.const).toBe('30000');
      expect(schema.properties.proposals.minItems).toBe(3); expect(schema.properties.proposals.maxItems).toBe(3);
    } finally { joint.fetch.mockRestore(); }
    const distributed = mockHTTP(task => { parallelContexts.push(structuredClone(task)); return answer(task); });
    try { await createEvaluationPlanner('parallel', { provider: config }).plan(input()); } finally { distributed.fetch.mockRestore(); }
    const byRole = (a: any, b: any) => a.role.localeCompare(b.role);
    expect([...singleContexts].sort(byRole)).toEqual([...parallelContexts].sort(byRole));
    expect(JSON.stringify(singleContexts)).not.toContain('PRIVATE_ACCOUNT_NAME');
    expect(JSON.stringify(singleContexts)).not.toContain('PRIVATE_BILL_ACCOUNT');
    expect((singleContexts as any[]).find(c => c.role === 'bills').data.resolved).toBeUndefined();
    expect((singleContexts as any[]).find(c => c.role === 'transfer').data.report).toBeUndefined();
  });

  it.each(['missing', 'duplicate', 'extra', 'reordered', 'wrong-version', 'wrong-amount', 'extra-envelope-field'] as const)('single rejects an incomplete or invalid joint response: %s', mutation => {
    const mock = mockHTTP(task => {
      const output = answer(task);
      if (mutation === 'missing') output.proposals.pop();
      if (mutation === 'duplicate') output.proposals[1] = output.proposals[0];
      if (mutation === 'extra') output.proposals.push(output.proposals[0]);
      if (mutation === 'reordered') output.proposals.reverse();
      if (mutation === 'wrong-version') output.proposals[0].planVersion++;
      if (mutation === 'wrong-amount') output.proposals[0].suggestion.amountMinor = '99900';
      if (mutation === 'extra-envelope-field') output.approved = true;
      return output;
    });
    return expectPlanningFailure(createEvaluationPlanner('single', { provider: config }).plan(input()), 'MODEL_SCHEMA_INVALID', 'single').then(failure => {
      expect(mock.fetch).toHaveBeenCalledTimes(1);
      expect(failure.modelRuns).toHaveLength(1);
      expect(failure.modelRuns[0]).toMatchObject({ role: 'single', status: 'failed', errorCode: 'MODEL_SCHEMA_INVALID' });
      expect(mock.tasks.map(task => task.role)).toEqual(['single']);
    }).finally(() => mock.fetch.mockRestore());
  });

  it.each(modes)('%s refuses transport/model failure instead of using scripted proposals', async mode => {
    const mock = mockHTTP(() => new Response('', { status: 401 }));
    try {
      const failure = await expectPlanningFailure(createEvaluationPlanner(mode, { provider: config }).plan(input()), 'MODEL_HTTP_401');
      expect(failure.modelRuns.every(run => run.status === 'failed' && run.errorCode === 'MODEL_HTTP_401')).toBe(true);
      expect(mock.tasks.some(task => task.role === 'reviewer')).toBe(false);
      expect(mock.fetch).toHaveBeenCalledTimes(mode === 'single' ? 1 : 3);
    } finally { mock.fetch.mockRestore(); }
  });

  it('parallel still refuses every action when just one sibling domain fails', async () => {
    const mock = mockHTTP(task => task.role === 'bills' ? new Response('', { status: 401 }) : answer(task));
    try {
      const failure = await expectPlanningFailure(createEvaluationPlanner('parallel', { provider: config }).plan(input()), 'MODEL_HTTP_401', 'domain:bills');
      expect(failure.modelRuns[0]).toMatchObject({ role: 'bills', status: 'failed', errorCode: 'MODEL_HTTP_401' });
      expect(mock.tasks.map(task => task.role).sort()).toEqual(['bills','goal','transfer']);
      expect(mock.fetch).toHaveBeenCalledTimes(3);
    } finally { mock.fetch.mockRestore(); }
  });

  it.each(modes.flatMap(mode => (['denied', 'mismatched', 'missing'] as const).map(fault => ({ mode, fault }))))('$mode retains the $fault funds gate without relying on reviewer judgment', async ({ mode, fault }) => {
    const data = input();
    if (fault === 'denied') data.fundsPreview = funds({ allowed: false, shortfallMinor: '10000' });
    if (fault === 'mismatched') data.fundsPreview = funds({ amountMinor: '50000' });
    if (fault === 'missing') delete data.fundsPreview;
    const mock = mockHTTP();
    try {
      const result = await createEvaluationPlanner(mode, { provider: config }).plan(data);
      expect(result.suggestions).toEqual([]); expect(result.findings.join()).toContain(fault === 'denied' ? 'FUNDS_NOT_ALLOWED' : fault === 'mismatched' ? 'FUNDS_PREVIEW_MISMATCH' : 'FUNDS_PREVIEW_MISSING');
      if (mode !== 'parallel-review') expect(result.diagnostics?.review).toBeUndefined();
    } finally { mock.fetch.mockRestore(); }
  });

  it.each(modes)('%s preserves deterministic clarification and never selects one ambiguous amount', async mode => {
    const data = input('给林晓转账300或500元'); delete data.fundsPreview;
    const mock = mockHTTP();
    try {
      const result = await createEvaluationPlanner(mode, { provider: config }).plan(data);
      expect(result.suggestions).toEqual([]); expect(result.clarification).toContain('金额');
    } finally { mock.fetch.mockRestore(); }
  });

  it('production createPlanner always invokes its independent reviewer even if an untyped caller supplies a mode', async () => {
    const mock = mockHTTP(task => task.role === 'reviewer' ? reviewResponse(task, { approved: false, concerns: [{ role: 'all', code: 'additional_review_required' }], findings: ['independent refusal'], summary: 'not approved' }) : answer(task));
    try {
      const result = await createPlanner({ semantic: false, provider: config, mode: 'parallel', orchestration: 'single' } as any).plan(input());
      expect(mock.fetch).toHaveBeenCalledTimes(4); expect(result.suggestions).toEqual([]);
      expect(result.diagnostics?.review?.rawApproved).toBe(false); expect(result.findings).toContain('all: 独立复核要求进一步核对');
    } finally { mock.fetch.mockRestore(); }
  });

  it.each(['single', 'parallel'] as const)('%s does not invoke or impersonate an injected reviewer adapter', async mode => {
    const reviewer = vi.fn(async (_context: ReviewContext) => ({ approved: false, findings: ['should not run'], summary: 'not run' })), mock = mockHTTP();
    try {
      const result = await createEvaluationPlanner(mode, { provider: config, reviewerAdapter: reviewer }).plan(input());
      expect(reviewer).not.toHaveBeenCalled(); expect(result.diagnostics?.review).toBeUndefined(); expect(result.events.some(e => e.role === 'reviewer')).toBe(false);
      expect(result.suggestions).toHaveLength(1);
    } finally { mock.fetch.mockRestore(); }
  });

  it('keeps parallel model domains genuinely overlapping', async () => {
    let concurrent = 0, peak = 0;
    const mock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body)), task = JSON.parse(body.messages[1].content);
      concurrent++; peak = Math.max(peak, concurrent); await new Promise(resolve => setTimeout(resolve, 20)); concurrent--;
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(answer(task)) } }] }), { status: 200 });
    });
    try { await createEvaluationPlanner('parallel', { provider: config }).plan(input()); expect(peak).toBe(3); } finally { mock.mockRestore(); }
  });

  it.each(modes)('%s labels explicit scripted baselines and performs no model HTTP calls', async mode => {
    const mock = vi.spyOn(globalThis, 'fetch');
    try {
      const result = await createEvaluationPlanner(mode, { provider: false }).plan(input());
      expect(mock).not.toHaveBeenCalled(); expect(result.mode).toBe('scripted'); expect(result.summary).toContain('非真实 LLM'); expect(result.modelRuns).toEqual([]);
      expect(result.suggestions).toHaveLength(1);
    } finally { mock.mockRestore(); }
  });

  it('shares the actual planned role list, including granted merchant-only activation, without fixture labels', () => {
    const data = input('取消星海视频');
    data.managementContext = { cards: [], subscriptions: { queryActionId: 'synthetic-confirmed-query', queriedAt: '2026-10-22T08:00:00Z', accessExpiresAt: '2100-01-01T00:00:00Z', items: [{ id: 'sub-a', merchant: '星海视频', amountMinor: '1000', currency: 'CNY', nextChargeDate: '2026-11-01', cardId: 'card-a', merchantStatus: 'ACTIVE', bankStatus: 'ALLOWED', collectionStatus: 'ENABLED', version: 1, cancellationSupported: true, source: 'SYNTHETIC_MERCHANT' }] } };
    expect(evaluationRoles(data)).toEqual(['subscription']); expect(evaluationRoles(input('完全未知任务'))).toEqual([]);
  });

  it('single refuses a per-domain adapter instead of silently making N adapter calls', () => {
    const adapter = vi.fn(async (local: LocalContext) => domain(local));
    expect(() => createEvaluationPlanner('single', { provider: config, domainAdapter: adapter })).toThrow('per-domain adapter'); expect(adapter).not.toHaveBeenCalled();
  });
});
