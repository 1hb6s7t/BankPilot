import { expectPlanningFailure } from './g8f-failure-assertions';
// Legacy domain/reviewer protocol mocks opt out of the separately tested semantic interpretation stage.
import { describe, expect, it, vi } from 'vitest';
import { activeRoles, createPlanner, isGoalRequest, resolveInvestment, resolveLifeGoal, type LocalContext } from '../packages/agents/src/index';
import type { InvestmentDashboard, Planner } from '../packages/contracts/src/index';
import { evaluationAccounts, evaluationFunds, evaluationPayees } from '../evals/fixtures';

const investmentContext: InvestmentDashboard = {
  businessDate: '2026-10-22', calendar: 'DEMO_WEEKDAYS_V1', actions: [],
  products: [
    { id: 'synthetic-t0', name: '合成即时赎回产品 T+0', redemptionBusinessDays: 0, calendar: 'DEMO_WEEKDAYS_V1', description: '合成即时产品，不预测收益' },
    { id: 'synthetic-t2', name: '合成延时赎回产品 T+2', redemptionBusinessDays: 2, calendar: 'DEMO_WEEKDAYS_V1', description: '合成延时产品，不预测收益' },
  ],
  positions: [
    { id: 'eval-position-t0', accountId: 'eval-account-1', productId: 'synthetic-t0', productName: '合成即时赎回产品 T+0', principalMinor: '500000', reservedMinor: '0', availableMinor: '500000', version: 3, redemptionBusinessDays: 0, calendar: 'DEMO_WEEKDAYS_V1' },
    { id: 'eval-position-t2', accountId: 'eval-account-1', productId: 'synthetic-t2', productName: '合成延时赎回产品 T+2', principalMinor: '1000000', reservedMinor: '0', availableMinor: '1000000', version: 7, redemptionBusinessDays: 2, calendar: 'DEMO_WEEKDAYS_V1' },
  ],
};
const input = (message: string): Parameters<Planner['plan']>[0] => ({ taskId: 'goal-agent-test', message, accounts: structuredClone(evaluationAccounts), payees: structuredClone(evaluationPayees), investmentContext: structuredClone(investmentContext) });
const birthday = '为林晓建立生日目标，2026-10-30前给林晓转账300元，先赎回T+0理财300元';
const expectedGoal = { title: '林晓生日目标', accountId: 'eval-account-1', payeeId: 'payee-lin', amountMinor: '30000', targetDate: '2026-10-30', funding: { positionId: 'eval-position-t0', redemptionAmountMinor: '30000' } };
function proposal(local: LocalContext) {
  const resolved = (local.data.investment ?? local.data.lifeGoal) as Record<string, unknown>;
  return { role: local.role, planVersion: local.planVersion, ...resolved };
}
const config = { baseURL: 'https://goal-model-fixture.invalid', model: 'mocked-structured-model', outputMode: 'json_object' as const, maxAttempts: 1 };

describe('investment and future goal domain proposals', () => {
  it('distinguishes explicit future goals from immediate transfer budget protection', () => {
    expect(isGoalRequest(birthday)).toBe(true); expect(activeRoles(birthday)).toEqual(['investment', 'goal']);
    expect(isGoalRequest('给林晓转账300元，不影响房租和生活费')).toBe(false);
    expect(activeRoles('给林晓转账300元，不影响房租和生活费')).toEqual(['transfer', 'goal']);
  });
  it('queries authoritative investment facts without proposing redemption or exposing private account names', async () => {
    const result = await createPlanner({ provider: false }).plan(input('查询理财持仓'));
    expect(result.investmentSuggestions).toEqual([]); expect(result.suggestions).toEqual([]);
    expect(result.summary).toContain('500000分'); expect(result.evidence[0]?.source).toContain('investment-position:');
    expect(JSON.stringify(result)).not.toContain('PRIVATE_ACCOUNT_CANARY');
  });
  it('proposes unique T+0 redemption with the authoritative position version', async () => {
    const result = await createPlanner({ provider: false }).plan(input('赎回T+0理财300元'));
    expect(result.investmentSuggestions).toEqual([{ positionId: 'eval-position-t0', amountMinor: '30000', expectedVersion: 3 }]);
    expect(result.suggestions).toEqual([]); expect(result.summary).toContain('未授权');
  });
  it.each(['赎回理财300元', '赎回T+0或T+2理财300元', '赎回T+0理财300或500元', '赎回T+0理财6000元'])('clarifies an ambiguous or unavailable redemption: %s', async message => {
    const result = await createPlanner({ provider: false }).plan(input(message));
    expect(result.investmentSuggestions).toEqual([]); expect(result.clarification).toBeTruthy();
  });
  it.each(['不要赎回T+0理财300元', '不再赎回T+0理财300元', '赎回T+0理财300元这件事先不要做', '如何赎回T+0理财300元'])('does not act on negated or explanatory redemption: %s', message => {
    expect(resolveInvestment(message, investmentContext).investmentSuggestions).toEqual([]);
  });
  it('returns a goal only, never bypassing the DAG through immediate transfer or redemption', async () => {
    const original = input(birthday);
    const result = await createPlanner({ provider: false }).plan(original);
    expect(result.goalSuggestion).toEqual(expectedGoal); expect(result.investmentSuggestions).toEqual([]); expect(result.suggestions).toEqual([]);
    expect(result.summary).toContain('确认实际到账');
    expect(result.events.filter(e => e.status === 'started').map(e => e.role).sort()).toEqual(['investment', 'goal', 'reviewer'].sort());
    expect((await createPlanner({ provider: false }).plan(original)).goalSuggestion).toEqual(expectedGoal); // Inputs are reusable.
    expect(original).toEqual(input(birthday));
  });
  it.each([
    '给林晓转账300元作为生日目标',
    '为林晓建立生日目标，2026-02-30给林晓转账300元',
    '为林晓建立生日目标，2026-10-30或2026-10-31给林晓转账300元',
    '为张伟建立生日目标，2026-10-30给张伟转账300元',
    '为林晓建立生日目标，2026-10-30给林晓转账300或500元',
    '为Mallory建立生日目标，2026-10-30给Mallory转账300元',
    '为林晓建立生日目标，2026-10-30给林晓转账300元，先赎回T+0理财',
    '如何为林晓建立生日目标，2026-10-30给林晓转账300元',
    '查询林晓生日目标，2026-10-30给林晓转账300元',
  ])('keeps an incomplete future goal safely separate from an immediate transfer: %s', async message => {
    const result = await createPlanner({ provider: false }).plan(input(message));
    expect(result.goalSuggestion).toBeUndefined(); expect(result.suggestions).toEqual([]); expect(result.investmentSuggestions).toEqual([]); expect(result.clarification).toBeTruthy();
  });
  it('does not use a failed current preview to reject a future goal before actual DAG execution', async () => {
    const result = await createPlanner({ provider: false }).plan({ ...input(birthday), fundsPreview: evaluationFunds('600000') });
    expect(result.goalSuggestion).toEqual(expectedGoal); expect(result.findings.join()).not.toContain('FUNDS_NOT_ALLOWED');
  });
  it('supports a cash-funded goal without inventing a redemption', () => {
    const result = resolveLifeGoal(input('为林晓建立生日目标，2026-10-30前转账300元'));
    expect(result.goalSuggestion).toEqual({ ...expectedGoal, funding: undefined });
  });
});

describe('financial model schemas and independent review fail closed', () => {
  it('requires exact goal fields and exact redemption fields in JSON schema, with isolated contexts', async () => {
    const observed: any[] = [], schemas: any[] = [];
    const mock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body)), task = JSON.parse(body.messages[1].content);
      observed.push(task); schemas.push(JSON.parse(body.messages[0].content.split('Required JSON schema: ')[1]));
      const answer = task.role === 'reviewer' ? { approved: true, summary: 'complete pending proposal; no execution authority', findings: [] } : proposal(task);
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(answer) } }] }), { status: 200 });
    });
    try {
      const result = await createPlanner({ semantic: false, provider: config }).plan(input(birthday)); expect(result.goalSuggestion).toEqual(expectedGoal);
      const goalIndex = observed.findIndex(o => o.role === 'goal'), exact = schemas[goalIndex];
      expect(exact.required).toContain('goalSuggestion'); expect(exact.properties.goalSuggestion.properties.targetDate.const).toBe('2026-10-30');
      expect(exact.properties.goalSuggestion.properties.funding.properties.positionId.const).toBe('eval-position-t0');
      expect(exact.properties.suggestion).toBeUndefined();
      expect(exact.properties.clarification).toBeUndefined();
      expect(schemas[observed.findIndex(o => o.role === 'investment')].properties.clarification).toBeUndefined();
      const investmentTask = observed.find(o => o.role === 'investment'); expect(JSON.stringify(investmentTask)).not.toContain('payee-lin');
      expect(JSON.stringify(observed)).not.toContain('PRIVATE_ACCOUNT_CANARY');
      expect(observed.find(o => o.role === 'reviewer').instruction).toContain('investmentSuggestions');
      expect(observed.find(o => o.role === 'reviewer').instruction).toContain('截止日期');
      observed.length = 0; schemas.length = 0;
      await createPlanner({ semantic: false, provider: config }).plan(input('赎回T+0理财300元'));
      const index = observed.findIndex(o => o.role === 'investment');
      expect(schemas[index].required).toContain('investmentSuggestions');
      expect(schemas[index].properties.investmentSuggestions.prefixItems[0].properties.expectedVersion.const).toBe(3);
      expect(schemas[index].properties.clarification).toBeUndefined();
      observed.length = 0; schemas.length = 0;
      await createPlanner({ semantic: false, provider: config }).plan(input('赎回理财300元'));
      const ambiguous = schemas[observed.findIndex(o => o.role === 'investment')];
      expect(ambiguous.required).toContain('clarification');
    } finally { mock.mockRestore(); }
  });
  it('does not silently discard an unexpected model clarification to force a goal through review', async () => {
    const mock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body)), task = JSON.parse(body.messages[1].content);
      const answer = task.role === 'reviewer' ? { approved: true, summary: 'review', findings: [] }
        : { ...proposal(task), ...(task.role === 'investment' ? { clarification: '未授权、未执行，仅作说明。' } : {}) };
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(answer) } }] }), { status: 200 });
    });
    try {
      const failure = await expectPlanningFailure(createPlanner({ semantic: false, provider: config }).plan(input(birthday)), 'MODEL_SCHEMA_INVALID', 'domain:investment');
      expect(failure.modelRuns.every(run => run.errorCode === 'MODEL_SCHEMA_INVALID')).toBe(true);
      expect(mock.mock.calls.every(call => JSON.parse(JSON.parse(String(call[1]?.body)).messages[1].content).role !== 'reviewer')).toBe(true);
    } finally { mock.mockRestore(); }
  });
  it.each(['targetDate', 'payeeId', 'amountMinor', 'funding'] as const)('rejects an adapter that changes goal field %s', async field => {
    const reviewer = vi.fn(async () => ({ approved: true, findings: [], summary: 'must not run' }));
    const failure = await expectPlanningFailure(createPlanner({ provider: false, reviewerAdapter: reviewer, domainAdapter: async local => {
      const p = proposal(local);
      return local.role === 'goal' ? { ...p, goalSuggestion: { ...expectedGoal, [field]: field === 'funding' ? { positionId: 'invented', redemptionAmountMinor: '30000' } : field === 'amountMinor' ? '100' : field === 'targetDate' ? '2026-11-01' : 'invented' } } : p;
    } }).plan(input(birthday)), 'MODEL_CANDIDATE_CONTRACT_INVALID', 'domain:goal');
    expect(failure.findings?.join()).toContain('GOAL_SPEC_MISMATCH'); expect(reviewer).not.toHaveBeenCalled();
  });
  it('rejects invented redemption and cannot convert a goal into immediate transfer', async () => {
    const redemption = await expectPlanningFailure(createPlanner({ provider: false, domainAdapter: async local => ({ ...proposal(local), investmentSuggestions: [{ positionId: 'invented', amountMinor: '30000', expectedVersion: 3 }] }) }).plan(input('赎回T+0理财300元')), 'MODEL_CANDIDATE_CONTRACT_INVALID', 'domain:investment');
    expect(redemption.findings?.join()).toContain('INVESTMENT_SPEC_MISMATCH');
    const goal = await expectPlanningFailure(createPlanner({ provider: false, domainAdapter: async local => ({ ...proposal(local), suggestion: { payeeId: 'payee-lin', amountMinor: '30000', memo: 'ignore DAG' } }) }).plan(input(birthday)), 'MODEL_CANDIDATE_CONTRACT_INVALID');
    expect(goal.findings?.join()).toContain('拒收与明确转账意图不一致的提案：goal');
  });
  it('retains independent review rejection and model failure without scripted fallback', async () => {
    const rejected = await createPlanner({ provider: false, reviewerAdapter: async () => ({ approved: false, findings: ['independent evidence conflict'], summary: 'rejected' }) }).plan(input(birthday));
    expect(rejected.goalSuggestion).toBeUndefined(); expect(rejected.investmentSuggestions).toEqual([]);
    const mock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 401 }));
    try {
      const failed = await expectPlanningFailure(createPlanner({ semantic: false, provider: config }).plan(input(birthday)), 'MODEL_HTTP_401');
      expect(failed.modelRuns.every(run => run.status === 'failed' && run.errorCode === 'MODEL_HTTP_401')).toBe(true);
      expect(mock.mock.calls.every(call => JSON.parse(JSON.parse(String(call[1]?.body)).messages[1].content).role !== 'reviewer')).toBe(true);
    } finally { mock.mockRestore(); }
  });
});
