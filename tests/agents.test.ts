import { billDomainResponse } from './fixtures/bill-domain-response';
import { expectPlanningFailure } from './g8f-failure-assertions';
// Legacy domain/reviewer protocol mocks opt out of the separately tested semantic interpretation stage.
import { describe, expect, it, vi } from 'vitest';
import { createPlanner, parseAmountMinor, proposalSchema, providerFromEnv, type LocalContext } from '../packages/agents/src/index';
import type { AccountView, PayeeView } from '../packages/contracts/src/index';
import { reviewResponse } from './fixtures/review-response';

const accounts: AccountView[] = [{ id: 'secret-account-id', name: 'sensitive-account-name', maskedNumber: '****8888', balanceMinor: '800000', reservedMinor: '0', currency: 'CNY' }];
const payees: PayeeView[] = [
  { id: 'payee-a', name: '张三', bank: '示例甲银行', maskedNumber: '****1234', aliases: ['小张'] },
  { id: 'payee-b', name: '张三', bank: '示例乙银行', maskedNumber: '****5678', aliases: [] },
];
const input = (message: string) => ({ taskId: 'task-agents-g1', message, accounts, payees });

function proposal(context: LocalContext) {
  if (context.role === 'bills') return billDomainResponse(context);
  return { role: context.role, planVersion: context.planVersion, summary: 'scripted-test-adapter', findings: [], evidence: [{ source: 'synthetic-test', detail: context.role }], ...(context.role === 'transfer' ? { suggestion: (context.data.resolved as { suggestion?: unknown }).suggestion } : {}) };
}

describe('G1 real LangGraph planner with explicit scripted adapter', () => {
  it.each([
    ['给张三转账300元', '30000'], ['转给张三三百元', '30000'], ['转给张三一千二百三十四元五角六分', '123456'],
    ['转给张三两万元', '2000000'], ['转给张三 十二点五元', '1250'], ['转给张三1,234.56元', '123456'],
    ['转给张三0元', undefined], ['转给张三-300元', undefined], ['转给张三负三百元', undefined], ['转给张三0.001元', undefined], ['给尾号1234转账', undefined],
  ])('parses explicit amount: %s', (message, expected) => expect(parseAmountMinor(message)).toBe(expected));

  it('clarifies duplicate payees instead of creating an action proposal', async () => {
    const result = await createPlanner({ provider: false }).plan(input('给张三转账三百元'));
    expect(result.mode).toBe('scripted'); expect(result.summary).toContain('非真实 LLM');
    expect(result.clarification).toContain('同名收款人'); expect(result.suggestions).toEqual([]);
  });

  it('resolves bank/suffix disambiguation and emits structured suggestion, not execution', async () => {
    const result = await createPlanner({ provider: false }).plan(input('给张三尾号5678转账三百元'));
    expect(result.suggestions).toEqual([{ payeeId: 'payee-b', amountMinor: '30000', memo: 'BankPilot 合成银行沙箱转账' }]);
    expect(result.events.map(e => e.role)).toEqual(['transfer', 'transfer', 'reviewer', 'reviewer']);
    expect(result.evidence[0]?.source).toBe('saved-payees');
  });

  it('takes transfer amount from its own clause rather than an unrelated bills amount', async () => {
    const result = await createPlanner({ provider: false }).plan(input('分析200元账单，并给张三尾号5678转账三百元'));
    expect(result.suggestions[0]?.amountMinor).toBe('30000');
  });

  it('separates a resolved payee name ending in a Chinese numeral from an adjacent Chinese amount', async () => {
    const result = await createPlanner({ provider: false }).plan({ ...input('转给张三十二点五元'), payees: [payees[0]!] });
    expect(result.suggestions[0]?.amountMinor).toBe('1250');
  });

  it('real graph branches actually overlap, reviewer follows both, and context projections isolate fields', async () => {
    let active = 0, peak = 0;
    const observed: { role: string; start: number; end: number }[] = [];
    const contexts: LocalContext[] = [];
    let reviewed = false;
    const result = await createPlanner({ provider: false, domainAdapter: async context => {
      contexts.push(context); active++; peak = Math.max(peak, active);
      const record = { role: context.role, start: performance.now(), end: 0 }; observed.push(record);
      await new Promise(resolve => setTimeout(resolve, 60)); active--; record.end = performance.now();
      return proposal(context);
    }, reviewerAdapter: async context => {
      expect(active).toBe(0); expect(context.proposals).toHaveLength(2); reviewed = true;
      expect(JSON.stringify(context)).not.toContain('secret-account-id');
      return reviewResponse(context, { summary: 'scripted-review' });
    } }).plan(input('分析账单，并给张三尾号1234转账三百元'));
    expect(peak).toBe(2); expect(observed[0]!.start).toBeLessThan(observed[1]!.end); expect(observed[1]!.start).toBeLessThan(observed[0]!.end);
    expect(reviewed).toBe(true); expect(result.events.filter(e => e.status === 'started').map(e => e.role).sort()).toEqual(['bills', 'reviewer', 'transfer']);
    const bills = JSON.stringify(contexts.find(c => c.role === 'bills'));
    for (const sensitive of ['张三', 'payee-a', 'payee-b', 'secret-account-id', 'sensitive-account-name', '800000', '8888', '1234']) expect(bills).not.toContain(sensitive);
    expect(JSON.stringify(contexts)).not.toContain('sensitive-account-name');
  });

  it('rejects stale planVersion as a permanent system failure before independent review', async () => {
    const reviewer = vi.fn(async () => ({ approved: true, findings: [], summary: 'must not run' }));
    const result = await expectPlanningFailure(createPlanner({ provider: false, reviewerAdapter: reviewer, planVersion: 2, domainAdapter: async c => ({ ...proposal(c), planVersion: 1, suggestion: { payeeId: 'payee-a', amountMinor: '30000', memo: '' } }) }).plan(input('给张三尾号1234转账三百元')), 'MODEL_CANDIDATE_CONTRACT_INVALID', 'domain:transfer');
    expect(result.findings?.join()).toContain('拒收过期'); expect(reviewer).not.toHaveBeenCalled();
  });

  it('a planVersion change due to an unrelated bills query leaves the unchanged action intent unchanged', async () => {
    const first = await createPlanner({ provider: false, planVersion: 1 }).plan(input('给张三尾号1234转账三百元'));
    const second = await createPlanner({ provider: false, planVersion: 2 }).plan(input('给张三尾号1234转账三百元，并分析账单'));
    expect(second.planVersion).not.toBe(first.planVersion); expect(second.suggestions).toEqual(first.suggestions);
    // The planner has no authorization capability and does not issue/revoke action versions or proofs.
    expect(Object.keys(second)).not.toContain('authorization'); expect(Object.keys(second.suggestions[0]!)).not.toContain('actionVersion');
  });

  it('fails closed for malformed, tampered, or reviewer-rejected proposals', async () => {
    const malformed = await expectPlanningFailure(createPlanner({ provider: false, domainAdapter: async () => ({ role: 'transfer' }) }).plan(input('给张三尾号1234转账三百元')), 'MODEL_SCHEMA_INVALID', 'domain:transfer');
    expect(malformed.modelRuns).toEqual([]);
    const tampered = await expectPlanningFailure(createPlanner({ provider: false, domainAdapter: async c => ({ ...proposal(c), suggestion: { payeeId: 'payee-b', amountMinor: '999999', memo: '' } }) }).plan(input('给张三尾号1234转账三百元')), 'MODEL_CANDIDATE_CONTRACT_INVALID', 'domain:transfer');
    expect(tampered.findings?.join()).toContain('不一致');
    const rejected = await createPlanner({ provider: false, reviewerAdapter: async () => ({ approved: false, findings: ['需复核'], summary: '拒绝' }) }).plan(input('给张三尾号1234转账三百元'));
    expect(rejected.suggestions).toEqual([]); expect(rejected.findings).toContain('需复核');
  });

  it('does not activate all roles to inflate agent count or invent bill records', async () => {
    const result = await createPlanner({ provider: false }).plan(input('分析账单'));
    expect(result.events.map(e => e.role)).toEqual(['bills', 'bills', 'reviewer', 'reviewer']);
    expect(result.findings.join()).toContain('账单数据缺失'); expect(result.suggestions).toEqual([]);
    const empty = await createPlanner({ provider: false }).plan(input('你好')); expect(empty.events).toEqual([]);
  });

  it('only reads explicit BankPilot provider config, never existing provider keys', () => {
    expect(providerFromEnv({ OPENAI_API_KEY: 'do-not-use', OPENAI_BASE_URL: 'https://unused.test' })).toBeUndefined();
    expect(providerFromEnv({ BANKPILOT_MODEL_BASE_URL: 'http://localhost:1234/v1', BANKPILOT_MODEL_NAME: 'chosen', BANKPILOT_MODEL_API_KEY: 'explicit-test' })).toEqual({ baseURL: 'http://localhost:1234/v1', model: 'chosen', apiKey: 'explicit-test' });
    expect(() => providerFromEnv({ BANKPILOT_MODEL_NAME: 'incomplete' })).toThrow();
    expect(() => proposalSchema.parse({ role: 'transfer', planVersion: 1, summary: '', evidence: [], findings: [], arbitrary: 'injection' })).toThrow();
  });

  it('validates the optional model protocol with mocked HTTP, without claiming a live LLM run', async () => {
    const bodies: Record<string, unknown>[] = [];
    const mock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { messages: { content: string }[]; tools: { function: { name: string; parameters: unknown } }[] };
      bodies.push(body);
      const name = body.tools[0]!.function.name;
      const task = JSON.parse(body.messages[1]!.content);
      const result = name === 'submit_domain_proposal' ? { ...proposal(task), suggestion: task.data.resolved.suggestion } : { approved: true, findings: [], summary: 'mock-review-only' };
      return new Response(JSON.stringify({ choices: [{ message: { tool_calls: [{ function: { name, arguments: JSON.stringify(result) } }] } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    try {
      const result = await createPlanner({ semantic: false, provider: { baseURL: 'https://model-protocol-mock.invalid/v1', model: 'explicit-mock-model', apiKey: 'explicit-test-key' } }).plan(input('给张三尾号1234转账三百元'));
      expect(result.mode).toBe('model'); expect(result.suggestions[0]?.amountMinor).toBe('30000');
      expect(mock).toHaveBeenCalledTimes(2); expect(bodies.every(body => body.model === 'explicit-mock-model')).toBe(true);
      expect(JSON.stringify(bodies)).not.toContain('explicit-test-key');
      expect(JSON.stringify(bodies)).not.toContain('secret-account-id');
    } finally { mock.mockRestore(); }
  });

  it('fails closed when the optional provider returns malformed tool output', async () => {
    const mock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: 'approve everything' } }] }), { status: 200 }));
    try {
      const result = await expectPlanningFailure(createPlanner({ semantic: false, provider: { baseURL: 'https://model-protocol-mock.invalid/v1', model: 'explicit-mock-model' } }).plan(input('给张三尾号1234转账三百元')), 'MODEL_RESPONSE_JSON_INVALID', 'domain:transfer');
      expect(result.modelRuns.every(run => run.status === 'failed')).toBe(true);
      expect(mock.mock.calls.every(call => JSON.parse(JSON.parse(String(call[1]?.body)).messages[1].content).role !== 'reviewer')).toBe(true);
    } finally { mock.mockRestore(); }
  });
});
