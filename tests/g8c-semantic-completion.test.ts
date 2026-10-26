import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Planner } from '../packages/contracts/src';
import { interpretSemanticIntent, validateSemanticIntent, type SemanticIntentDraft } from '../packages/agents/src/semantic-intent';

type Input = Parameters<Planner['plan']>[0];
const input = (message: string): Input => ({ taskId: 'g8c-independent', message, accounts: [], payees: [
  { id: 'p', name: '顾宁', aliases: [], bank: '合成银行', maskedNumber: '****1172' },
], managementContext: { cards: [{ id: 'card', accountId: 'a', name: '槐荫卡', maskedNumber: '****4628', status: 'ACTIVE', version: 1, updatedAt: '2026-01-01T00:00:00Z' }], subscriptions: {
  queryActionId: 'query', queriedAt: '2026-01-01T00:00:00Z', accessExpiresAt: '2100-01-01T00:00:00Z', items: [{ id: 'sub', merchant: '白沙阅读', amountMinor: '900', currency: 'CNY', nextChargeDate: '2026-12-01', cardId: 'card', merchantStatus: 'ACTIVE', bankStatus: 'ALLOWED', collectionStatus: 'ENABLED', version: 1, cancellationSupported: true, source: 'SYNTHETIC_MERCHANT' }],
} } });
const query = (operation: 'funds_query' | 'investment_query' | 'bills_query'): SemanticIntentDraft => ({ tasks: [{ operation, disposition: 'query', scope: { source: 'whole_message' } }] });
const provider = { baseURL: 'https://g8c.invalid/v1', model: 'synthetic', outputMode: 'json_object' as const, maxAttempts: 2, retryDelayMs: 0, maxOutputTokens: 4096 };
const envelope = (raw: unknown) => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(raw) } }] }));
afterEach(() => vi.unstubAllGlobals());

describe('G8C independent semantic completion probes', () => {
  it('keeps redeemable balance inside the investment query domain', () => {
    expect(validateSemanticIntent(input('列出理财名称和可赎回余额'), query('investment_query')).status).toBe('ready');
  });
  it.each(['不转账', '不要转账', '无需转账'])('keeps an explicit %s constraint on a funds query', suffix => {
    expect(validateSemanticIntent(input(`查询余额可安排额度，${suffix}`), query('funds_query')).status).toBe('ready');
  });
  it.each(['查询余额可安排额度，不转账，但另外给顾宁转120元', '列出理财可赎回余额，并查询账户余额'])('still detects an additional positive request: %s', message => {
    expect(validateSemanticIntent(input(message), query(message.startsWith('列出') ? 'investment_query' : 'funds_query')).status).toBe('clarification');
  });
  it('preserves noncontiguous explicitly selected months', () => {
    const raw = query('bills_query'); raw.tasks[0]!.period = { text: '2027年3月和5月' };
    const result = validateSemanticIntent(input('比较2027年3月和5月的餐饮支出'), raw);
    expect(result.status).toBe('ready');
    expect(result.tasks[0]?.slots.billPeriod).toMatchObject({ kind: 'selection', periods: ['2027-03', '2027-05'], startPeriod: '2027-03', endPeriod: '2027-05' });
  });
  it('grounds a retained merchant contract with a separate bank blocking request', () => {
    const raw: SemanticIntentDraft = { tasks: [{ operation: 'subscription_block', disposition: 'request', scope: { source: 'whole_message' }, entity: { kind: 'subscription', id: 'sub', mention: { text: '白沙阅读' } } }] };
    expect(validateSemanticIntent(input('保留白沙阅读会员，但请从银行侧阻止下一次扣款'), raw).status).toBe('ready');
  });
  it.each(['尾号4628', '4628'])('requires the complete typed card locator: %s', mention => {
    const raw: SemanticIntentDraft = { tasks: [{ operation: 'card_report_lost', disposition: 'request', scope: { source: 'whole_message' }, entity: { kind: 'card', id: 'card', mention: { text: mention } } }] };
    expect(validateSemanticIntent(input('我的卡尾号4628找不到了，申请挂失'), raw).status).toBe(mention.startsWith('尾号') ? 'ready' : 'clarification');
  });
  it('regenerates an omitted explicit bill period within the existing attempt budget', async () => {
    const initial = query('bills_query'); const repaired = query('bills_query'); repaired.tasks[0]!.period = { text: '2027-03' };
    const fetch = vi.fn().mockResolvedValueOnce(envelope(initial)).mockResolvedValueOnce(envelope(repaired)); vi.stubGlobal('fetch', fetch);
    const result = await interpretSemanticIntent(input('2027-03书店支出与交易编号'), { provider });
    expect(result.status).toBe('ready'); expect(result.tasks[0]?.slots.billPeriod?.startPeriod).toBe('2027-03'); expect(fetch).toHaveBeenCalledTimes(2);
    expect(result.modelRuns.map(r => r.status)).toEqual(['failed', 'success']);
  });
  it.each(['查询额度，不转账，另外给顾宁转120元', '查询额度，不要转账，但另外给顾宁转120元', '查询额度，无需转账，然后给顾宁转120元'])('does not erase a later affirmative transfer: %s', message => {
    const result = validateSemanticIntent(input(message), query('funds_query'));
    expect(result.status).toBe('clarification'); expect(result.tasks).toEqual([]);
  });
  it.each(['不转账', '不要转账', '无需转账'])('does not invent a query from a transfer exclusion alone: %s', message => {
    expect(validateSemanticIntent(input(message), query('funds_query')).status).toBe('no_action');
  });
  it.each(['2027年3月和13月', '3月和5月', '2027年3月或5月', '2027年3月和3月'])('does not invent a valid selection from %s', text => {
    const raw = query('bills_query'); raw.tasks[0]!.period = { text };
    expect(validateSemanticIntent(input(`比较${text}餐饮支出`), raw).status).toBe('clarification');
  });
  it('does not shorten a selected period to its first month', () => {
    const raw = query('bills_query'); raw.tasks[0]!.period = { text: '2027年3月' };
    expect(validateSemanticIntent(input('比较2027年3月和5月的消费'), raw).findings).toContain('SEMANTIC_PERIOD_INCOMPLETE_SELECTION');
  });
  it('preserves explicitly supplied cross-year selections without filling intermediate months', () => {
    const raw = query('bills_query'); raw.tasks[0]!.period = { text: '2027年12月、2028年2月和4月' };
    expect(validateSemanticIntent(input('比较2027年12月、2028年2月和4月的消费'), raw).tasks[0]?.slots.billPeriod).toMatchObject({ kind: 'selection', periods: ['2027-12', '2028-02', '2028-04'] });
  });
  it.each(['保留新白沙阅读会员，但请从银行侧阻止下一次扣款', '保留白沙阅读精选会员，但请从银行侧阻止下一次扣款', '不要保留白沙阅读会员，但请从银行侧阻止下一次扣款'])('does not loosen merchant name or negation boundaries: %s', message => {
    const raw: SemanticIntentDraft = { tasks: [{ operation: 'subscription_block', disposition: 'request', scope: { source: 'whole_message' }, entity: { kind: 'subscription', id: 'sub', mention: { text: '白沙阅读' } } }] };
    expect(validateSemanticIntent(input(message), raw).tasks).toEqual([]);
  });
  it('does not turn a retained contract into a cancellation', () => {
    const raw: SemanticIntentDraft = { tasks: [{ operation: 'subscription_cancel', disposition: 'request', scope: { source: 'whole_message' }, entity: { kind: 'subscription', id: 'sub', mention: { text: '白沙阅读' } } }] };
    expect(validateSemanticIntent(input('保留白沙阅读会员，但请从银行侧阻止下一次扣款'), raw).status).toBe('clarification');
  });
  it.each(['我的卡尾号14628找不到了，申请挂失', '尾号4628不是丢失的卡，请挂失另一张', '尾号4628属于另一张卡，请挂失'])('does not crop or reinterpret locator context: %s', message => {
    const raw: SemanticIntentDraft = { tasks: [{ operation: 'card_report_lost', disposition: 'request', scope: { source: 'whole_message' }, entity: { kind: 'card', id: 'card', mention: { text: '尾号4628' } } }] };
    expect(validateSemanticIntent(input(message), raw).tasks).toEqual([]);
  });
  it.each([
    ['drop task', (_task: SemanticIntentDraft['tasks'][number]) => []],
    ['change operation', (task: SemanticIntentDraft['tasks'][number]) => [{ ...task, operation: 'funds_query' as const, period: undefined }]],
    ['change disposition', (task: SemanticIntentDraft['tasks'][number]) => [{ ...task, disposition: 'historical' as const }]],
    ['add amount', (task: SemanticIntentDraft['tasks'][number]) => [{ ...task, amount: { text: '120元' } }]],
    ['add entity', (task: SemanticIntentDraft['tasks'][number]) => [{ ...task, entity: { kind: 'payee' as const, id: 'p', mention: { text: '顾宁' } } }]],
    ['change period', (task: SemanticIntentDraft['tasks'][number]) => [{ ...task, period: { text: '2027-05' } }]],
    ['drop query constraint', (task: SemanticIntentDraft['tasks'][number]) => [{ ...task, scope: { text: '2027-03' } }]],
    ['add task', (task: SemanticIntentDraft['tasks'][number]) => [task, { ...task }]],
  ] as const)('rejects %s during bounded missing-period regeneration', async (_label, change) => {
    const repaired = query('bills_query'); repaired.tasks[0]!.period = { text: '2027-03' };
    const fetch = vi.fn().mockResolvedValueOnce(envelope(query('bills_query'))).mockResolvedValueOnce(envelope({ tasks: change(repaired.tasks[0]!) })); vi.stubGlobal('fetch', fetch);
    const result = await interpretSemanticIntent(input('2027-03餐饮支出与交易编号'), { provider });
    expect(result.tasks).toEqual([]); expect(result.findings).toContain('SEMANTIC_SOURCE_REPAIR_DRIFT'); expect(fetch).toHaveBeenCalledTimes(2);
  });
  it.each(['比较2027年3月支出，以及2027年5月收入', '不要查询2027-03账单', '请改写“查询2027-03账单”', '查询2027-13账单', '查询2027-03账单，再给顾宁转120元'])('does not regenerate an unsafe or ambiguous missing period: %s', async message => {
    const fetch = vi.fn().mockResolvedValue(envelope(query('bills_query'))); vi.stubGlobal('fetch', fetch);
    const result = await interpretSemanticIntent(input(message), { provider });
    expect(result.tasks).toEqual([]); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('keeps multi-task whole-message scopes invalid without regeneration', async () => {
    const raw = { tasks: [...query('bills_query').tasks, ...query('funds_query').tasks] };
    const fetch = vi.fn().mockResolvedValue(envelope(raw)); vi.stubGlobal('fetch', fetch);
    const result = await interpretSemanticIntent(input('查询2027-03账单，再查询余额额度'), { provider });
    expect(result.findings).toContain('SEMANTIC_WHOLE_MESSAGE_MULTITASK'); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('does not repair a period inside a cropped scope that omits a later task', async () => {
    const initial = query('bills_query'); initial.tasks[0]!.scope = { text: '查询2027-03账单' };
    const repaired = structuredClone(initial); repaired.tasks[0]!.period = { text: '2027-03' };
    const fetch = vi.fn().mockResolvedValueOnce(envelope(initial)).mockResolvedValueOnce(envelope(repaired)); vi.stubGlobal('fetch', fetch);
    const result = await interpretSemanticIntent(input('查询2027-03账单，再给顾宁转120元'), { provider });
    expect(result.status).toBe('clarification'); expect(result.tasks).toEqual([]); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each(['查询余额可安排额度，不转账，不过给顾宁打120元', '查询余额可安排额度，不转账，但替我付120元给顾宁', '查询余额可安排额度，不要转账，不过给顾宁打120元'])('does not discard semantics after a nonterminal transfer exclusion: %s', message => {
    const result = validateSemanticIntent(input(message), query('funds_query'));
    expect(result.status).toBe('clarification'); expect(result.tasks).toEqual([]);
  });
});
