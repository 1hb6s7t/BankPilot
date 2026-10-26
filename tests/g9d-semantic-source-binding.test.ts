import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Planner } from '../packages/contracts/src';
import { interpretSemanticIntent, validateSemanticIntent, type SemanticIntentDraft } from '../packages/agents/src/semantic-intent';
import { createStageOutputPlan } from '../packages/agents/src/budget';
import type { OpenAICompatibleConfig } from '../packages/agents/src/provider';

type Input = Parameters<Planner['plan']>[0];
type Task = SemanticIntentDraft['tasks'][number];
const base: Input = { taskId: 'g9d-independent-source-binding', message: '', accounts: [], payees: [
  { id: 'payee', name: '闻清越', aliases: ['共同租客'], bank: '合成山岚银行', maskedNumber: '**** 5934' },
], managementContext: { cards: [
  { id: 'card', accountId: 'account', name: '兰汀借记卡', maskedNumber: '**** 2857', status: 'ACTIVE', version: 3, updatedAt: '2026-10-24T00:00:00Z' },
  { id: 'other-card', accountId: 'account', name: '观澜储蓄卡', maskedNumber: '**** 6491', status: 'LOST', version: 2, updatedAt: '2026-10-24T00:00:00Z' },
] } };
const provider = { baseURL: 'https://g9d-binding.invalid/v1', model: 'synthetic', outputMode: 'json_object' as const, maxAttempts: 2, maxStructureRepairs: 1 as const, retryDelayMs: 0, timeoutMs: 60000, maxOutputTokens: 4096 };
const envelope = (raw: unknown) => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(raw) } }], usage: { prompt_tokens: 20, completion_tokens: 30 } }));
const e = (kind: 'payee' | 'card', id: string, text: string) => ({ kind, id, mention: { text } });
const payment = (scope: Task['scope'] = { source: 'whole_message' }): Task => ({ operation: 'transfer', disposition: 'request', scope, entity: e('payee', 'payee', '闻清越'), amount: { text: '364元' }, memo: { text: '入户门卡分摊' } });
const query = (operation: 'card_query' | 'bills_query', scope: Task['scope'] = { source: 'whole_message' }): Task => ({ operation, disposition: 'query', scope, ...(operation === 'bills_query' ? { period: { text: '2029年2月' } } : {}) });
function span(message: string, text: string, last = false) { const start = last ? message.lastIndexOf(text) : message.indexOf(text); return { start, end: start + text.length, text }; }
async function regenerate(message: string, first: SemanticIntentDraft, second: unknown, input = base, overrides: Partial<OpenAICompatibleConfig> = {}) {
  const fetch = vi.fn().mockResolvedValueOnce(envelope(first)).mockResolvedValueOnce(envelope(second)); vi.stubGlobal('fetch', fetch);
  const result = await interpretSemanticIntent({ ...input, message }, { provider: { ...provider, ...overrides } });
  return { result, fetch, bodies: fetch.mock.calls.map(call => JSON.parse(call[1].body)) };
}
afterEach(() => vi.unstubAllGlobals());

describe('G9D source binding regeneration is separately proven and shares one provider repair', () => {
  it('requests offsets for a repeated saved alias without selecting a different identity or changing values', async () => {
    const message = '共同租客那边要补押金，请给共同租客转364元，备注“入户门卡分摊”。';
    const first: SemanticIntentDraft = { tasks: [{ ...payment(), entity: e('payee', 'payee', '共同租客') }] };
    const second = structuredClone(first); second.tasks[0]!.entity!.mention = span(message, '共同租客', true);
    const { result, fetch, bodies } = await regenerate(message, first, second);
    expect(fetch).toHaveBeenCalledTimes(2); expect(result.status).toBe('ready'); expect(result.tasks[0]?.slots).toEqual({ entityId: 'payee', amountMinor: '36400', memo: '入户门卡分摊' });
    expect(result.tasks[0]?.source.text).toBe(message); expect(result.modelRuns.map(run => [run.status, run.attempt])).toEqual([['failed', 1], ['success', 2]]);
    expect(bodies[0].messages[1]).toEqual(bodies[1].messages[1]); expect(bodies[0].max_tokens).toBe(4096); expect(bodies[1].max_tokens).toBe(4096);
    expect(bodies[1].messages[0].content).toContain('"path":["tasks","[]","entity","mention"]');
    expect(bodies[1].messages[0].content).not.toContain('共同租客');
    expect(JSON.stringify(bodies[1])).not.toContain(JSON.stringify(second));
  });
  it.each(['2857', '尾号2857是否挂失'])('re-extracts complete typed card field from %s while retaining ID and read-only operation', async mention => {
    const message = '我只想核实尾号2857是否挂失了，不要改它。';
    const first: SemanticIntentDraft = { tasks: [{ operation: 'card_query', disposition: 'query', scope: { source: 'whole_message' }, entity: e('card', 'card', mention) }] };
    const second = structuredClone(first); second.tasks[0]!.entity!.mention = { text: '尾号2857' };
    const { result, fetch } = await regenerate(message, first, second);
    expect(fetch).toHaveBeenCalledTimes(2); expect(result.status).toBe('ready'); expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]).toMatchObject({ operation: 'card_query', slots: { entityId: 'card' }, source: { text: message } });
  });
  it('can re-extract a complete original catalog name without erasing unknown qualifiers', async () => {
    const message = '查询兰汀借记卡当前状态';
    const first: SemanticIntentDraft = { tasks: [{ operation: 'card_query', disposition: 'query', scope: { source: 'whole_message' }, entity: e('card', 'card', '兰汀') }] };
    const second = structuredClone(first); second.tasks[0]!.entity!.mention = { text: '兰汀借记卡' };
    const { result, fetch } = await regenerate(message, first, second);
    expect(fetch).toHaveBeenCalledTimes(2); expect(result.status).toBe('ready');
    const unknown = await regenerate('查询新兰汀借记卡当前状态', first, second);
    expect(unknown.fetch).toHaveBeenCalledTimes(1); expect(unknown.result.status).toBe('clarification');
  });
  it('re-extracts all-whole two-domain read scopes without changing either query or its period', async () => {
    const firstText = '查询我的银行卡现有状态', secondText = '再列2029年2月账单的收入和支出；本次都只查看信息。';
    const message = `${firstText}，${secondText}`;
    const first = { tasks: [query('card_query'), query('bills_query')] };
    const second = { tasks: [query('card_query', { text: firstText }), query('bills_query', { text: secondText })] };
    const { result, fetch } = await regenerate(message, first, second);
    expect(fetch).toHaveBeenCalledTimes(2); expect(result.status).toBe('ready'); expect(result.tasks.map(task => task.operation)).toEqual(['card_query', 'bills_query']);
    expect(result.tasks.map(task => task.source.text)).toEqual([firstText, secondText]);
  });
  it('recovers a multi-task cropped scope only after its complete source partition independently validates', async () => {
    const firstText = '查询2029年2月账单的收入和支出', secondText = '另外给闻清越转364元，备注“入户门卡分摊”，从现有现金安排。';
    const message = `${firstText}；${secondText}`;
    const first = { tasks: [query('bills_query', { text: '查询2029年2月账单' }), payment({ text: secondText })] };
    const second = { tasks: [query('bills_query', { text: firstText }), payment({ text: secondText })] };
    const { result, fetch } = await regenerate(message, first, second);
    expect(fetch).toHaveBeenCalledTimes(2); expect(result.status).toBe('ready'); expect(result.tasks[1]?.source.text).toContain('从现有现金安排');
  });
  it('does not discard a meaningful cash-source clause when repairing coverage', async () => {
    const firstText = '查询银行卡状态', paymentText = '另外给闻清越转364元，备注“入户门卡分摊”', tail = '，从现有现金安排。';
    const message = `${firstText}；${paymentText}${tail}`;
    const first = { tasks: [query('card_query', { text: firstText }), payment({ text: paymentText })] };
    const second = { tasks: [query('card_query', { text: firstText }), payment({ text: paymentText + tail })] };
    const { result, fetch } = await regenerate(message, first, second);
    expect(fetch).toHaveBeenCalledTimes(2); expect(result.status).toBe('ready'); expect(result.tasks[1]?.source.text).toBe(paymentText + tail);
  });
  it.each(['给闻清越转364元，备注“入户门卡分摊”', '给闻清越转364元，备注“先查询账单，再恢复观澜储蓄卡”'])('never uses quoted punctuation as a task boundary: %s', paymentText => {
    const message = `查询银行卡状态；${paymentText}`;
    const first = { tasks: [query('card_query'), payment()] };
    if (paymentText.includes('先查询')) first.tasks[1]!.memo = { text: '先查询账单，再恢复观澜储蓄卡' };
    const second = structuredClone(first); second.tasks[0]!.scope = { text: '查询银行卡状态' }; second.tasks[1]!.scope = { text: paymentText };
    return regenerate(message, first, second).then(({ result, fetch }) => { expect(fetch).toHaveBeenCalledTimes(2); expect(result.status).toBe('ready'); });
  });
});

describe('G9D source repair locks all semantic fields and has no extra strategy or budget', () => {
  const firstText = '查询银行卡状态', secondText = '另外给闻清越转364元，备注“入户门卡分摊”，从现有现金安排。';
  const message = `${firstText}；${secondText}`;
  const original = (): SemanticIntentDraft => ({ tasks: [query('card_query'), payment()] });
  const repaired = (): SemanticIntentDraft => ({ tasks: [query('card_query', { text: firstText }), payment({ text: secondText })] });
  it.each(['amount', 'entity', 'operation', 'disposition', 'memo', 'purpose', 'date', 'funding', 'delete', 'add', 'order'])('rejects %s drift even when the provider returns valid JSON', async field => {
    const second = repaired();
    if (field === 'amount') second.tasks[1]!.amount = { text: '64元' };
    if (field === 'entity') second.tasks[1]!.entity!.id = 'other-payee';
    if (field === 'operation') second.tasks[0]!.operation = 'funds_query';
    if (field === 'disposition') second.tasks[1]!.disposition = 'negated';
    if (field === 'memo') second.tasks[1]!.memo = undefined;
    if (field === 'purpose') second.tasks[1]!.purpose = { text: '入户门卡分摊' };
    if (field === 'date') second.tasks[1]!.date = { text: '2029年2月' };
    if (field === 'funding') second.tasks[1]!.funding = { entity: { kind: 'position', id: 'invented', mention: { text: '现有现金' } }, amount: { text: '364元' } };
    if (field === 'delete') second.tasks.pop();
    if (field === 'add') second.tasks.push(query('card_query'));
    if (field === 'order') second.tasks.reverse();
    const { result, fetch } = await regenerate(message, original(), second);
    expect(fetch).toHaveBeenCalledTimes(2); expect(result.status).toBe('clarification'); expect(result.tasks).toEqual([]); expect(result.findings).toContain('SEMANTIC_SOURCE_REPAIR_DRIFT');
  });
  it('does not allow an entity boundary repair to change its identity or operation', async () => {
    const text = '我只想核实尾号2857是否挂失了';
    const first: SemanticIntentDraft = { tasks: [{ operation: 'card_query', disposition: 'query', scope: { source: 'whole_message' }, entity: e('card', 'card', '2857') }] };
    for (const change of ['id', 'kind', 'operation', 'disposition']) {
      const second = structuredClone(first); second.tasks[0]!.entity!.mention = { text: '尾号2857' };
      if (change === 'id') second.tasks[0]!.entity!.id = 'other-card';
      if (change === 'kind') second.tasks[0]!.entity!.kind = 'payee';
      if (change === 'operation') second.tasks[0]!.operation = 'card_report_lost';
      if (change === 'disposition') second.tasks[0]!.disposition = 'negated';
      const { result, fetch } = await regenerate(text, first, second);
      expect(fetch).toHaveBeenCalledTimes(2); expect(result.findings).toContain('SEMANTIC_SOURCE_REPAIR_DRIFT'); expect(result.tasks).toEqual([]);
    }
  });
  it.each([1, 2, 3])('uses at most one structural repair with %i configured attempts', async maxAttempts => {
    const fetch = vi.fn().mockImplementation(async () => envelope(original())); vi.stubGlobal('fetch', fetch);
    const result = await interpretSemanticIntent({ ...base, message }, { provider: { ...provider, maxAttempts } });
    expect(fetch).toHaveBeenCalledTimes(Math.min(maxAttempts, 2)); expect(result.status).toBe('clarification'); expect(result.findings).toContain('SEMANTIC_WHOLE_MESSAGE_MULTITASK');
    expect(result.modelRuns.reduce((sum, run) => sum + (run.requestMaxOutputTokens ?? 0), 0)).toBe(4096 * Math.min(maxAttempts, 2));
  });
  it('does not retry when structural repair is explicitly disabled', async () => {
    const { result, fetch } = await regenerate(message, original(), repaired(), base, { maxStructureRepairs: 0 });
    expect(fetch).toHaveBeenCalledTimes(1); expect(result.tasks).toEqual([]);
  });
  it.each(['schema', 'http'])('preserves a second-attempt %s failure as a system outcome', async kind => {
    const fetch = vi.fn().mockResolvedValueOnce(envelope(original())).mockResolvedValueOnce(kind === 'schema' ? envelope({ tasks: [{ operation: 'invented' }] }) : new Response('{}', { status: 503 })); vi.stubGlobal('fetch', fetch);
    const result = await interpretSemanticIntent({ ...base, message }, { provider });
    expect(fetch).toHaveBeenCalledTimes(2); expect(result.status).toBe('failed'); expect(result.failure?.code).toBe(kind === 'schema' ? 'MODEL_SCHEMA_INVALID' : 'MODEL_HTTP_503'); expect(result.tasks).toEqual([]);
  });
  it('does not restart a third attempt when a previous JSON repair has consumed the only repair', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '{' } }] }))).mockResolvedValueOnce(envelope(original())); vi.stubGlobal('fetch', fetch);
    const result = await interpretSemanticIntent({ ...base, message }, { provider: { ...provider, maxAttempts: 3 } });
    expect(fetch).toHaveBeenCalledTimes(2); expect(result.tasks).toEqual([]); expect(result.status).toBe('clarification');
  });
  it('keeps the original shared planning ceiling when both semantic attempts are reserved', () => {
    const plan = createStageOutputPlan({ domainStageCount: 6, reviewerStageCount: 1, maxAttempts: 2 });
    expect(plan.semanticReserved).toBe(8192); expect(plan.allocatedCeiling).toBeLessThanOrEqual(32768); expect(plan.semanticMaxOutputTokens).toBe(4096);
  });
  it('does not dispatch an attempt after shared cancellation', async () => {
    const controller = new AbortController(); controller.abort(); const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const result = await interpretSemanticIntent({ ...base, message }, { provider: { ...provider, signal: controller.signal } });
    expect(fetch).not.toHaveBeenCalled(); expect(result.status).toBe('failed'); expect(result.failure?.code).toBe('MODEL_DEADLINE_EXCEEDED');
  });
  it('does not apply source repair to scripted adapters or silently return the eligibility candidate', async () => {
    const adapter = vi.fn(async () => original()), fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const result = await interpretSemanticIntent({ ...base, message }, { provider, adapter });
    expect(adapter).toHaveBeenCalledTimes(1); expect(fetch).not.toHaveBeenCalled(); expect(result.status).toBe('clarification'); expect(result.tasks).toEqual([]);
  });
});

describe('G9D repair eligibility never suppresses original safety or missing-input contracts', () => {
  it.each([
    '查询银行卡状态；不要给闻清越转364元，备注“入户门卡分摊”。',
    '查询银行卡状态；如果余额充足就给闻清越转364元，备注“入户门卡分摊”。',
    '查询银行卡状态；等到账后再给闻清越转364元，备注“入户门卡分摊”。',
    '查询银行卡状态；明天给闻清越转364元，备注“入户门卡分摊”。',
    '查询银行卡状态；当我确认时再给闻清越转364元，备注“入户门卡分摊”。',
    '查询银行卡状态；给闻清越或者另一位转364元，备注“入户门卡分摊”。',
    '查询银行卡状态；给闻清越转364元，备注“入户门卡分摊”；再查询2029年2月账单。',
  ])('keeps unsafe or omitted relationships single-pass: %s', async message => {
    const first = { tasks: [query('card_query'), payment()] };
    const { result, fetch } = await regenerate(message, first, first);
    expect(fetch).toHaveBeenCalledTimes(1); expect(result.status).toBe('clarification'); expect(result.tasks).toEqual([]);
  });
  it.each(['unknown-id', 'missing-period', 'partial-amount'])('does not combine source repair with %s', async change => {
    const message = '查询2029年2月账单；给闻清越转364元，备注“入户门卡分摊”。';
    const first = { tasks: [query('bills_query'), payment()] };
    if (change === 'unknown-id') first.tasks[1]!.entity!.id = 'unknown';
    if (change === 'missing-period') first.tasks[0]!.period = undefined;
    if (change === 'partial-amount') first.tasks[1]!.amount = { text: '64元' };
    const { result, fetch } = await regenerate(message, first, first);
    expect(fetch).toHaveBeenCalledTimes(1); expect(result.tasks).toEqual([]);
  });
  it.each(['我只想核实陌生银行卡尾号2857是否挂失', '请改写“我只想核实尾号2857是否挂失”', '不要查询尾号2857是否挂失'])('cannot use a complete locator candidate to activate %s', async message => {
    const first: SemanticIntentDraft = { tasks: [{ operation: 'card_query', disposition: 'query', scope: { source: 'whole_message' }, entity: e('card', 'card', '2857') }] };
    const second = structuredClone(first); second.tasks[0]!.entity!.mention = { text: '尾号2857' };
    const { result, fetch } = await regenerate(message, first, second);
    expect(fetch).toHaveBeenCalledTimes(1); expect(result.tasks).toEqual([]);
  });
  it('does not let selected ID disambiguate duplicate card tails', async () => {
    const input: Input = { ...base, managementContext: { cards: base.managementContext!.cards.map(card => ({ ...card, maskedNumber: '****2857' })) } };
    const message = '我只想核实尾号2857是否挂失';
    const first: SemanticIntentDraft = { tasks: [{ operation: 'card_query', disposition: 'query', scope: { source: 'whole_message' }, entity: e('card', 'card', '2857') }] };
    const { result, fetch } = await regenerate(message, first, first, input);
    expect(fetch).toHaveBeenCalledTimes(1); expect(result.tasks).toEqual([]);
  });
  it('caps partition eligibility rather than enumerating a long punctuation-heavy request', async () => {
    const message = `${'查询银行卡状态；'.repeat(12)}给闻清越转364元，备注“入户门卡分摊”`;
    const first = { tasks: [query('card_query'), payment()] };
    const { result, fetch } = await regenerate(message, first, first);
    expect(fetch).toHaveBeenCalledTimes(1); expect(result.status).toBe('clarification');
  });
  it('leaves pure unknown quoted arguments and genuine missing year to their existing clarification paths', async () => {
    const first: SemanticIntentDraft = { tasks: [{ operation: 'card_query', disposition: 'query', scope: { source: 'whole_message' } }] };
    const { result, fetch } = await regenerate('查询“未知卡片甲”的状态', first, first);
    expect(fetch).toHaveBeenCalledTimes(1); expect(result.findings).toContain('SEMANTIC_QUOTED_ARGUMENT_UNRESOLVED');
    const goal: SemanticIntentDraft = { tasks: [{ operation: 'goal_create', disposition: 'request', scope: { source: 'whole_message' }, entity: e('payee', 'payee', '闻清越'), amount: { text: '364元' }, date: { text: '11月8日' } }] };
    const raw = validateSemanticIntent({ ...base, message: '为闻清越建立生活目标，11月8日前准备364元' }, goal);
    expect(raw.findings).toContain('SEMANTIC_TARGET_DATE_YEAR_REQUIRED');
  });
});
