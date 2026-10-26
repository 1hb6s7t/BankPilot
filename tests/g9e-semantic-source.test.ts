import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Planner } from '../packages/contracts/src';
import { syntheticInvestmentProducts } from '../packages/contracts/src/investment';
import { interpretSemanticIntent, validateSemanticIntent, type SemanticIntentDraft } from '../packages/agents/src/semantic-intent';
import type { OpenAICompatibleConfig } from '../packages/agents/src/provider';

type Input = Parameters<Planner['plan']>[0];
type Task = SemanticIntentDraft['tasks'][number];
const base: Input = { taskId: 'g9e-independent-source', message: '', accounts: [], payees: [
  { id: 'payee', name: '邵闻川', aliases: ['合租伙伴'], bank: '合成清川银行', maskedNumber: '****4317' },
], managementContext: { cards: [{ id: 'card', accountId: 'account', name: '汀兰卡', maskedNumber: '****3708', status: 'ACTIVE', version: 2, updatedAt: '2026-10-24T00:00:00Z' }] },
investmentContext: { businessDate: '2026-10-24', calendar: 'DEMO_WEEKDAYS_V1', products: [...syntheticInvestmentProducts], positions: syntheticInvestmentProducts.map((product, index) => ({
  id: `position-${index}`, productId: product.id, productName: product.name, accountId: 'account', principalMinor: '900000', reservedMinor: '0', availableMinor: '900000', version: 3, redemptionBusinessDays: product.redemptionBusinessDays, calendar: product.calendar,
})), actions: [] } };
const provider: OpenAICompatibleConfig = { baseURL: 'https://g9e-source.invalid/v1', model: 'synthetic', outputMode: 'json_object', maxAttempts: 2, maxStructureRepairs: 1, retryDelayMs: 0, timeoutMs: 60000, maxOutputTokens: 4096 };
const envelope = (raw: unknown) => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(raw) } }], usage: { prompt_tokens: 30, completion_tokens: 40 } }));
const entity = (kind: 'payee' | 'position', id: string, text: string) => ({ kind, id, mention: { text } });
const payment = (scope: Task['scope'] = { source: 'whole_message' }): Task => ({ operation: 'transfer', disposition: 'request', scope, entity: entity('payee', 'payee', '邵闻川'), amount: { text: '418元' }, memo: { text: '设备押金' } });
function span(message: string, text: string, last = false) { const start = last ? message.lastIndexOf(text) : message.indexOf(text); return { start, end: start + text.length, text }; }
async function regenerate(message: string, first: SemanticIntentDraft, second: unknown, input = base, overrides: Partial<OpenAICompatibleConfig> = {}) {
  const fetch = vi.fn().mockResolvedValueOnce(envelope(first)).mockResolvedValueOnce(envelope(second)); vi.stubGlobal('fetch', fetch);
  const result = await interpretSemanticIntent({ ...input, message }, { provider: { ...provider, ...overrides } });
  return { result, fetch, bodies: fetch.mock.calls.map(call => JSON.parse(call[1].body)) };
}
afterEach(() => vi.unstubAllGlobals());

describe('G9E binds a uniquely proven entity occurrence without inventing an entity or value', () => {
  const repeated = (text = '合租伙伴'): SemanticIntentDraft => ({ tasks: [{ ...payment(), entity: entity('payee', 'payee', text) }] });
  it.each(['合租伙伴那边要补押金，请给合租伙伴转418元，备注“设备押金”。', '📌合租伙伴那边要补押金，请给合租伙伴转418元，备注“设备押金”。'])('binds only missing second-round coordinates, retaining exact UTF-16 source: %s', async message => {
    const first = repeated(), saved = structuredClone(first);
    expect(validateSemanticIntent({ ...base, message }, first).findings).toContain('SEMANTIC_SPAN_NOT_UNIQUE');
    const { result, fetch, bodies } = await regenerate(message, first, first);
    expect(fetch).toHaveBeenCalledTimes(2); expect(result.status).toBe('ready'); expect(result.findings).toEqual(['SEMANTIC_SOURCE_OCCURRENCE_BOUND']);
    expect(result.tasks[0]?.source.text).toBe(message); expect(result.tasks[0]?.slots).toEqual({ entityId: 'payee', amountMinor: '41800', memo: '设备押金' });
    expect(first).toEqual(saved); expect(bodies[0].messages[1]).toEqual(bodies[1].messages[1]);
    expect(result.modelRuns.map(run => [run.status, run.attempt])).toEqual([['failed', 1], ['success', 2]]);
  });
  it('does not bind the first draft or a single-pass adapter automatically', async () => {
    const message = '合租伙伴那边要补押金，请给合租伙伴转418元，备注“设备押金”。', first = repeated();
    const one = await regenerate(message, first, first, base, { maxAttempts: 1 });
    expect(one.fetch).toHaveBeenCalledTimes(1); expect(one.result.status).toBe('clarification'); expect(one.result.tasks).toEqual([]);
    const adapter = vi.fn(async () => first), fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const result = await interpretSemanticIntent({ ...base, message }, { provider, adapter });
    expect(adapter).toHaveBeenCalledTimes(1); expect(fetch).not.toHaveBeenCalled(); expect(result.status).toBe('clarification');
  });
  it.each([{ start: 0 }, { start: 0, end: 4 }, { start: 1, end: 2 }])('never overwrites explicit or partial coordinates %j', async coordinates => {
    const message = '合租伙伴那边要补押金，请给合租伙伴转418元，备注“设备押金”。', first = repeated(), second = structuredClone(first);
    second.tasks[0]!.entity!.mention = { text: '合租伙伴', ...coordinates };
    const { result, fetch } = await regenerate(message, first, second);
    expect(fetch).toHaveBeenCalledTimes(2); expect(result.status).toBe('clarification'); expect(result.tasks).toEqual([]); expect(result.findings).not.toContain('SEMANTIC_SOURCE_OCCURRENCE_BOUND');
  });
  it.each([{ start: 999, end: 1003 }, { start: 0 }, { end: 4 }])('requires the model to correct first-round explicit/partial coordinates %j', async coordinates => {
    const message = '合租伙伴那边要补押金，请给合租伙伴转418元，备注“设备押金”。', first = repeated();
    first.tasks[0]!.entity!.mention = { text: '合租伙伴', ...coordinates };
    const omitted = repeated();
    const unresolved = await regenerate(message, first, omitted);
    expect(unresolved.fetch).toHaveBeenCalledTimes(2); expect(unresolved.result.tasks).toEqual([]); expect(unresolved.result.findings).not.toContain('SEMANTIC_SOURCE_OCCURRENCE_BOUND');
    const corrected = repeated(); corrected.tasks[0]!.entity!.mention = span(message, '合租伙伴', true);
    const explicit = await regenerate(message, first, corrected);
    expect(explicit.fetch).toHaveBeenCalledTimes(2); expect(explicit.result.status).toBe('ready'); expect(explicit.result.findings).not.toContain('SEMANTIC_SOURCE_OCCURRENCE_BOUND');
  });
  it('does not default to legal[0] when two original occurrences both validate', async () => {
    const message = '收款人是邵闻川，请给邵闻川转418元，备注“设备押金”。', first = repeated('邵闻川');
    const { result, fetch } = await regenerate(message, first, first);
    expect(fetch).toHaveBeenCalledTimes(2); expect(result.status).toBe('clarification'); expect(result.findings).toContain('SEMANTIC_SPAN_NOT_UNIQUE');
    const selected = structuredClone(first); selected.tasks[0]!.entity!.mention = span(message, '邵闻川', true);
    const explicit = await regenerate(message, first, selected);
    expect(explicit.result.status).toBe('ready'); expect(explicit.result.findings).not.toContain('SEMANTIC_SOURCE_OCCURRENCE_BOUND');
  });
  it('does not claim uniqueness with unexamined occurrences beyond the 32-candidate cap', async () => {
    const message = '请给邵闻川转418元，备注“设备押金”。' + Array.from({ length: 32 }, () => '邵闻川那边仍在记录').join('。'), first = repeated('邵闻川');
    const { result, fetch } = await regenerate(message, first, first);
    expect(fetch).toHaveBeenCalledTimes(2); expect(result.status).toBe('clarification'); expect(result.findings).not.toContain('SEMANTIC_SOURCE_OCCURRENCE_BOUND');
  });
  it.each(['identity', 'amount', 'memo', 'operation', 'disposition', 'task-count'])('cannot bind an occurrence after %s drift', async field => {
    const message = '合租伙伴那边要补押金，请给合租伙伴转418元，备注“设备押金”。', first = repeated(), second = structuredClone(first);
    if (field === 'identity') second.tasks[0]!.entity!.id = 'another';
    if (field === 'amount') second.tasks[0]!.amount = { text: '18元' };
    if (field === 'memo') second.tasks[0]!.memo = undefined;
    if (field === 'operation') second.tasks[0]!.operation = 'funds_query';
    if (field === 'disposition') second.tasks[0]!.disposition = 'negated';
    if (field === 'task-count') second.tasks.push({ operation: 'card_query', disposition: 'query', scope: { source: 'whole_message' } });
    const { result, fetch } = await regenerate(message, first, second);
    expect(fetch).toHaveBeenCalledTimes(2); expect(result.tasks).toEqual([]); expect(result.findings).toContain('SEMANTIC_SOURCE_REPAIR_DRIFT');
  });
});

describe('G9E mixed source references can regenerate complete entirely read-only scopes', () => {
  const firstText = '查询两张银行卡状态', secondText = '再列一下2028年6月账单的收入和支出；这次都只看信息。', message = `${firstText}，${secondText}`;
  const bill = (): Task => ({ operation: 'bills_query', disposition: 'query', scope: { text: secondText }, period: { text: '2028年6月' } });
  const first = (): SemanticIntentDraft => ({ tasks: [{ operation: 'card_query', disposition: 'query', scope: { source: 'whole_message' } }, bill()] });
  const second = (): SemanticIntentDraft => ({ tasks: [{ operation: 'card_query', disposition: 'query', scope: { text: firstText } }, bill()] });
  it('proves complete scopes and preserves the already correct operations and period', async () => {
    const { result, fetch } = await regenerate(message, first(), second());
    expect(fetch).toHaveBeenCalledTimes(2); expect(result.status).toBe('ready'); expect(result.tasks.map(task => task.source.text)).toEqual([firstText, secondText]);
    expect(result.tasks[1]?.slots.billPeriod?.startPeriod).toBe('2028-06');
  });
  it.each(['period', 'delete', 'swap', 'operation', 'negation'])('rejects %s changes during mixed read-only scope repair', async change => {
    const repaired = second();
    if (change === 'period') repaired.tasks[1]!.period = { text: '6月' };
    if (change === 'delete') repaired.tasks.pop();
    if (change === 'swap') repaired.tasks.reverse();
    if (change === 'operation') repaired.tasks[0]!.operation = 'card_report_lost';
    if (change === 'negation') repaired.tasks[0]!.disposition = 'negated';
    const { result, fetch } = await regenerate(message, first(), repaired);
    expect(fetch).toHaveBeenCalledTimes(2); expect(result.tasks).toEqual([]); expect(result.findings).toContain('SEMANTIC_SOURCE_REPAIR_DRIFT');
  });
  it('does not extend the mixed-source exception to a write task', async () => {
    const text = '给邵闻川转418元，备注“设备押金”；查询银行卡状态';
    const raw: SemanticIntentDraft = { tasks: [payment(), { operation: 'card_query', disposition: 'query', scope: { text: '查询银行卡状态' } }] };
    const { result, fetch } = await regenerate(text, raw, raw);
    expect(fetch).toHaveBeenCalledTimes(1); expect(result.tasks).toEqual([]);
  });
  it('does not synthesize an independent omitted bill task', async () => {
    const raw: SemanticIntentDraft = { tasks: [{ operation: 'card_query', disposition: 'query', scope: { source: 'whole_message' } }] };
    const { result, fetch } = await regenerate(message, raw, second());
    expect(fetch).toHaveBeenCalledTimes(1); expect(result.findings).toContain('SEMANTIC_WHOLE_MESSAGE_EXTRA_OPERATION'); expect(result.tasks).toEqual([]);
  });
});

describe('G9E collection entity removal is an explicit bounded re-extraction contract', () => {
  const paymentText = '另外给邵闻川转418元，备注“设备押金”，从现有现金安排。';
  const first = (mention = '我的理财持仓'): SemanticIntentDraft => ({ tasks: [{ operation: 'investment_query', disposition: 'query', scope: { source: 'whole_message' }, entity: entity('position', 'position-0', mention) }, payment()] });
  const second = (queryText: string): SemanticIntentDraft => ({ tasks: [{ operation: 'investment_query', disposition: 'query', scope: { text: queryText } }, payment({ text: paymentText })] });
  it.each(['先展示一下我的理财持仓，不要赎回', '请查询我的理财持仓', '列出全部理财持仓'])('permits only model-submitted removal after proving an unfiltered collection: %s', queryText => {
    const mention = queryText.includes('我的') ? '我的理财持仓' : '全部理财持仓', message = `${queryText}；${paymentText}`;
    return regenerate(message, first(mention), second(queryText)).then(({ result, fetch }) => {
      expect(fetch).toHaveBeenCalledTimes(2); expect(result.status).toBe('ready'); expect(result.tasks[0]?.slots).toEqual({});
      expect(result.tasks[1]?.slots).toEqual({ entityId: 'payee', amountMinor: '41800', memo: '设备押金' }); expect(result.tasks[1]?.source.text).toContain('从现有现金安排');
    });
  });
  it('does not automatically remove the unsupported singular entity after an identical second response', async () => {
    const message = `查询我的理财持仓；${paymentText}`, raw = first();
    const { result, fetch } = await regenerate(message, raw, raw);
    expect(fetch).toHaveBeenCalledTimes(2); expect(result.tasks).toEqual([]); expect(result.findings).toContain('SEMANTIC_SOURCE_REPAIR_DRIFT');
  });
  it('requires actual model omission for a single complete unfiltered collection too', async () => {
    const message = '查询我的理财持仓', raw: SemanticIntentDraft = { tasks: [first().tasks[0]!] };
    const corrected: SemanticIntentDraft = { tasks: [{ operation: 'investment_query', disposition: 'query', scope: { source: 'whole_message' } }] };
    const { result, fetch } = await regenerate(message, raw, corrected);
    expect(fetch).toHaveBeenCalledTimes(2); expect(result.status).toBe('ready'); expect(result.tasks[0]?.slots).toEqual({});
  });
  it.each(['transfer-id', 'amount', 'memo', 'date', 'funding', 'query-to-redeem', 'disposition', 'task-count', 'order'])('locks all other fields while removing a generic entity: %s', change => {
    const queryText = '查询我的理财持仓', repaired = second(queryText), message = `${queryText}；${paymentText}`;
    if (change === 'transfer-id') repaired.tasks[1]!.entity!.id = 'another';
    if (change === 'amount') repaired.tasks[1]!.amount = { text: '18元' };
    if (change === 'memo') repaired.tasks[1]!.memo = undefined;
    if (change === 'date') repaired.tasks[1]!.date = { text: '2028年6月' };
    if (change === 'funding') repaired.tasks[1]!.funding = { entity: entity('position', 'position-0', '我的理财持仓'), amount: { text: '418元' } };
    if (change === 'query-to-redeem') repaired.tasks[0]!.operation = 'investment_redeem';
    if (change === 'disposition') repaired.tasks[0]!.disposition = 'negated';
    if (change === 'task-count') repaired.tasks.pop();
    if (change === 'order') repaired.tasks.reverse();
    return regenerate(message, first(), repaired).then(({ result, fetch }) => { expect(fetch).toHaveBeenCalledTimes(2); expect(result.tasks).toEqual([]); expect(result.findings).toContain('SEMANTIC_SOURCE_REPAIR_DRIFT'); });
  });
  it.each([
    '查询我的理财持仓中余额超过500元的产品', '查询我的理财持仓，只查金额100元至500元的部分',
    '查询我的理财持仓中的一部分', '查询我的理财持仓，只看T+0和T+2',
    '查询我的理财持仓，只看合成即时赎回产品 T+0', '不要查询我的理财持仓',
    '如果有需要就查询我的理财持仓', '请改写“查询我的理财持仓”',
    '查询我的理财持仓，只看收益率超过3%的', '查询我的理财持仓，按到期时间排序',
    '查询我的理财持仓，返回首条', '查询我的理财持仓，最近到期的优先', '查询我的理财持仓，只保留正常状态',
  ])('does not erase a filter, locator, condition, negation or quotation: %s', queryText => {
    return regenerate(`${queryText}；${paymentText}`, first(), second(queryText)).then(({ result, fetch }) => { expect(fetch).toHaveBeenCalledTimes(1); expect(result.tasks).toEqual([]); });
  });
  it.each(['合成即时赎回产品 T+0', 'T+0'])('never removes a grounded named product or locator %s', async mention => {
    const queryText = `查询${mention}的可赎回余额`, message = `${queryText}；${paymentText}`, raw = first(mention);
    const { result } = await regenerate(message, raw, second(queryText));
    expect(result.tasks).toEqual([]); expect(result.status).toBe('clarification');
  });
  it('never treats a catalog name resembling the generic phrase as an unjustified entity', async () => {
    const input: Input = { ...base, investmentContext: { ...base.investmentContext!, positions: base.investmentContext!.positions.map((position, index) => index ? position : { ...position, productName: '我的理财持仓' }) } };
    const queryText = '查询我的理财持仓', message = `${queryText}；${paymentText}`;
    const { result } = await regenerate(message, first(), second(queryText), input);
    expect(result.tasks).toEqual([]); expect(result.status).toBe('clarification');
  });
  it('does not displace a leading collection selector into a preceding payment task', async () => {
    const message = `${paymentText}；按到期时间排序，查询我的理财持仓`, raw = first(); raw.tasks.reverse();
    const { result, fetch } = await regenerate(message, raw, raw);
    expect(fetch).toHaveBeenCalledTimes(1); expect(result.tasks).toEqual([]);
  });
  it('keeps selection words inside a complete legal payment memo as data', async () => {
    const memo = '按到期时间排序，只看收益率超过3%的', text = `另外给邵闻川转418元，备注“${memo}”，从现有现金安排。`;
    const raw = first(); raw.tasks[1]!.memo = { text: memo };
    const corrected = second('查询我的理财持仓'); corrected.tasks[1]!.scope = { text }; corrected.tasks[1]!.memo = { text: memo };
    const { result, fetch } = await regenerate(`查询我的理财持仓；${text}`, raw, corrected);
    expect(fetch).toHaveBeenCalledTimes(2); expect(result.status).toBe('ready'); expect(result.tasks[1]?.slots.memo).toBe(memo);
  });
  it('does not erase a generic-looking phrase that is another catalog alias', async () => {
    const input: Input = { ...base, payees: [...base.payees, { ...base.payees[0]!, id: 'other-payee', name: '陆允安', aliases: ['我的理财持仓'] }] };
    const { result, fetch } = await regenerate(`查询我的理财持仓；${paymentText}`, first(), second('查询我的理财持仓'), input);
    expect(fetch).toHaveBeenCalledTimes(1); expect(result.tasks).toEqual([]);
  });
  it('does not use collection repair to discard an invented entity ID', async () => {
    const raw = first(); raw.tasks[0]!.entity!.id = 'unknown';
    const { result, fetch } = await regenerate(`查询我的理财持仓；${paymentText}`, raw, second('查询我的理财持仓'));
    expect(fetch).toHaveBeenCalledTimes(1); expect(result.tasks).toEqual([]);
  });
  it('keeps one-attempt/zero-repair and later base-schema failure behavior', async () => {
    const message = `查询我的理财持仓；${paymentText}`;
    const one = await regenerate(message, first(), second('查询我的理财持仓'), base, { maxAttempts: 1 });
    expect(one.fetch).toHaveBeenCalledTimes(1); expect(one.result.tasks).toEqual([]);
    const disabled = await regenerate(message, first(), second('查询我的理财持仓'), base, { maxStructureRepairs: 0 });
    expect(disabled.fetch).toHaveBeenCalledTimes(1); expect(disabled.result.tasks).toEqual([]);
    const malformed = await regenerate(message, first(), { tasks: [{ operation: 'invented' }] });
    expect(malformed.fetch).toHaveBeenCalledTimes(2); expect(malformed.result.status).toBe('failed'); expect(malformed.result.failure?.code).toBe('MODEL_SCHEMA_INVALID');
  });
});

describe('G9E source inventory is unchanged input context, not generated tasks or facts', () => {
  it('preserves UTF-16 spans, quoted punctuation and comma-formatted money exactly', async () => {
    const message = '📌查询银行卡状态；给邵闻川转1,418元，备注“设备，押金；仅备注”。';
    let task: any; const adapter = vi.fn(async value => { task = value; return { tasks: [] }; });
    await interpretSemanticIntent({ ...base, message }, { provider, adapter });
    expect(task.message).toBe(message); expect(task.sourceInventory.complete).toBe(true);
    expect(task.sourceInventory.units.map((unit: any) => unit.text).join('')).toBe(message);
    for (const unit of task.sourceInventory.units) { expect(message.slice(unit.start, unit.end)).toBe(unit.text); expect(Object.keys(unit).sort()).toEqual(['end', 'start', 'text']); }
    expect(task.sourceInventory.units.some((unit: any) => unit.text.includes('1,418元'))).toBe(true);
    expect(task.sourceInventory.units.some((unit: any) => unit.text.includes('“设备，押金；仅备注”'))).toBe(true);
  });
  it('omits an overlong unit list entirely while retaining the full original message', async () => {
    const message = '查询银行卡状态；'.repeat(30); let task: any;
    await interpretSemanticIntent({ ...base, message }, { provider, adapter: async value => { task = value; return { tasks: [] }; } });
    expect(task.message).toBe(message); expect(task.sourceInventory).toEqual({ complete: false, reason: 'too_many_source_units', units: [] });
  });
});

describe('G9E every investment query has an independently supported complete scope', () => {
  const query = (mention?: string): SemanticIntentDraft => ({ tasks: [{ operation: 'investment_query', disposition: 'query', scope: { source: 'whole_message' }, ...(mention ? { entity: entity('position', 'position-0', mention) } : {}) }] });
  it.each([
    '查询我的理财持仓', '列出全部理财持仓', '请展示一下我的理财持仓，不要赎回',
    '列出理财名称和可赎回余额', '列出我当前持有的理财产品与可赎回金额',
    '我想先弄清自己持有哪些合成理财、各有多少可赎回余额，先只查询，不赎回。',
    '我目前有哪几笔理财？分别列下产品名和可赎回余额',
    '请查看全部持仓的本金、预留金额和可赎回余额；现在不要赎回或转账。',
  ])('preserves an unfiltered collection and its unchanged source: %s', message => {
    const result = validateSemanticIntent({ ...base, message }, query());
    expect({ status: result.status, findings: result.findings }).toEqual({ status: 'ready', findings: [] });
    expect(result.tasks[0]?.slots).toEqual({}); expect(result.tasks[0]?.source.text).toBe(message);
  });
  it.each([
    '只看收益率超过3%的', '按到期时间排序', '返回首条', '只查最近到期的', '只保留正常状态',
    '优先展示风险较低的', '按可赎回余额从高到低排列', '只查一部分', '排除正在冻结的',
    '只看T+0和T+2', '余额超过500元时才显示', '只列出昨天购买的', '收益率是多少',
  ])('never discards an unsupported first-draft collection condition: %s', tail => {
    const message = `查询我的理财持仓，${tail}`, result = validateSemanticIntent({ ...base, message }, query());
    expect(result.status).toBe('clarification'); expect(result.tasks).toEqual([]);
  });
  it.each([
    '查询合成即时赎回产品 T+0', '查询合成即时赎回产品 T+0当前持仓',
    '合成即时赎回产品 T+0的可赎回余额是多少？',
    '请查看合成即时赎回产品 T+0持仓和预计到账规则，不赎回。',
  ])('retains the single explicitly grounded object: %s', message => {
    const result = validateSemanticIntent({ ...base, message }, query('合成即时赎回产品 T+0'));
    expect(result.status).toBe('ready'); expect(result.tasks[0]?.slots).toEqual({ entityId: 'position-0' }); expect(result.tasks[0]?.source.text).toBe(message);
  });
  it.each(['只看收益率超过3%的', '按到期时间排序', '返回首条', '只查最近到期的', '查询合成延时赎回产品 T+2的余额'])('cannot hide a condition or another product behind one grounded object: %s', tail => {
    const message = `查询合成即时赎回产品 T+0当前持仓，${tail}`, result = validateSemanticIntent({ ...base, message }, query('合成即时赎回产品 T+0'));
    expect(result.status).toBe('clarification'); expect(result.tasks).toEqual([]);
  });
  it('does not turn an omitted explicit product mention into a full collection query', () => {
    const result = validateSemanticIntent({ ...base, message: '查询合成即时赎回产品 T+0的余额' }, query());
    expect(result.status).toBe('clarification'); expect(result.tasks).toEqual([]);
  });
  it('keeps arbitrary catalog names and noun quotes bound without allowing an unknown suffix', () => {
    const input: Input = { ...base, investmentContext: { ...base.investmentContext!, positions: [{ ...base.investmentContext!.positions[0]!, productName: '云涧储蓄计划' }] } };
    const message = '云涧储蓄计划现在还有多少', result = validateSemanticIntent({ ...input, message }, query('云涧储蓄计划'));
    expect(result.status).toBe('ready'); expect(result.tasks[0]?.slots.entityId).toBe('position-0');
    expect(validateSemanticIntent({ ...input, message: '查询“云涧储蓄计划”的本金，不要赎回' }, query('云涧储蓄计划')).status).toBe('ready');
    expect(validateSemanticIntent({ ...input, message: '查询“云涧储蓄计划”的本金，按持有期限排序' }, query('云涧储蓄计划')).tasks).toEqual([]);
  });
  it('checks literal first scopes as well as whole_message and cannot drop a trailing selector', () => {
    const message = '查询我的理财持仓，返回首条', raw = query(); raw.tasks[0]!.scope = { text: message };
    const result = validateSemanticIntent({ ...base, message }, raw);
    expect(result.findings).toContain('SEMANTIC_INVESTMENT_QUERY_SCOPE_UNSUPPORTED'); expect(result.tasks).toEqual([]);
    raw.tasks[0]!.scope = { text: '查询我的理财持仓' };
    expect(validateSemanticIntent({ ...base, message }, raw).tasks).toEqual([]);
  });
  it('does not spend a repair or accept changed output to discard an unsupported collection selector', async () => {
    const { result, fetch } = await regenerate('查询我的理财持仓，按到期时间排序', query(), query());
    expect(fetch).toHaveBeenCalledTimes(1); expect(result.findings).toContain('SEMANTIC_INVESTMENT_QUERY_SCOPE_UNSUPPORTED'); expect(result.tasks).toEqual([]);
  });
  it('bounds repeated request-prefix consumption and quickly rejects long unknown residue', () => {
    const accepted = '请帮我现在先查询我的理财持仓';
    expect(validateSemanticIntent({ ...base, message: accepted }, query()).status).toBe('ready');
    const message = '我想先'.repeat(1000) + '未知查询条件', result = validateSemanticIntent({ ...base, message }, query());
    expect(result.status).toBe('clarification'); expect(result.tasks).toEqual([]);
  });
  it.each(['按到期时间排序', '返回首条', '只看收益率超过3%的', '只保留正常状态'])('cannot displace %s into a valid transfer source on the first draft', tail => {
    const read = '查询我的理财持仓', write = `给邵闻川转418元，备注“设备押金”，${tail}`, raw = query(); raw.tasks[0]!.scope = { text: read }; raw.tasks.push(payment({ text: write }));
    const result = validateSemanticIntent({ ...base, message: `${read}；${write}` }, raw);
    expect(result.status).toBe('clarification'); expect(result.findings).toContain('SEMANTIC_INVESTMENT_QUERY_SCOPE_UNSUPPORTED'); expect(result.tasks).toEqual([]);
  });
  it('preserves a selector-like legal memo in a first-draft query plus transfer', () => {
    const read = '查询我的理财持仓', memo = '按到期时间排序，返回首条', write = `给邵闻川转418元，备注“${memo}”，从现有现金安排`, raw = query(); raw.tasks[0]!.scope = { text: read };
    const action = payment({ text: write }); action.memo = { text: memo }; raw.tasks.push(action);
    const result = validateSemanticIntent({ ...base, message: `${read}；${write}` }, raw);
    expect(result.status).toBe('ready'); expect(result.tasks[1]?.slots.memo).toBe(memo);
  });
  it.each(['different', 'same', 'collection', 'declared-goal'])('preserves the complete query and funded goal scopes: %s', kind => {
    const product = '合成即时赎回产品 T+0', fundingProduct = kind === 'same' ? product : '合成延时赎回产品 T+2';
    const read = kind === 'collection' ? '查询我的理财持仓' : `查询${product}的本金`;
    const goal = kind === 'declared-goal' ? `为邵闻川建立生活目标，2028-10-19前准备532元；为此从${fundingProduct}赎回780元`
      : `给邵闻川准备532元学费，2028-10-19前到账；先从${fundingProduct}赎回780元`;
    const raw = query(kind === 'collection' ? undefined : product); raw.tasks[0]!.scope = { text: read };
    raw.tasks.push({ operation: 'goal_create', disposition: 'request', scope: { text: goal }, entity: entity('payee', 'payee', '邵闻川'), amount: { text: '532元' }, date: { text: '2028-10-19' },
      ...(kind === 'declared-goal' ? {} : { purpose: { text: '学费' } }), funding: { entity: entity('position', kind === 'same' ? 'position-0' : 'position-1', fundingProduct), amount: { text: '780元' } } });
    const result = validateSemanticIntent({ ...base, message: `${read}；${goal}` }, raw);
    expect({ status: result.status, findings: result.findings }).toEqual({ status: 'ready', findings: [] });
    expect(result.tasks.map(task => task.operation)).toEqual(['investment_query', 'goal_create']);
    expect(result.tasks[1]?.slots.funding).toEqual({ positionId: kind === 'same' ? 'position-0' : 'position-1', amountMinor: '78000' });
    expect(result.tasks.map(task => task.source.text)).toEqual([read, goal]);
  });
  it('allows bounded collection re-extraction alongside an unchanged fully grounded funded goal', async () => {
    const read = '查询我的理财持仓', goal = '给邵闻川准备532元学费，2028-10-19前到账；先从合成延时赎回产品 T+2赎回780元';
    const second: SemanticIntentDraft = { tasks: [{ operation: 'investment_query', disposition: 'query', scope: { text: read } },
      { operation: 'goal_create', disposition: 'request', scope: { text: goal }, entity: entity('payee', 'payee', '邵闻川'), amount: { text: '532元' }, purpose: { text: '学费' }, date: { text: '2028-10-19' },
        funding: { entity: entity('position', 'position-1', '合成延时赎回产品 T+2'), amount: { text: '780元' } } }] };
    const first = structuredClone(second); first.tasks[0]!.entity = entity('position', 'position-0', '我的理财持仓');
    const { result, fetch } = await regenerate(`${read}；${goal}`, first, second);
    expect(fetch).toHaveBeenCalledTimes(2); expect(result.status).toBe('ready'); expect(result.tasks[1]?.slots.funding).toEqual({ positionId: 'position-1', amountMinor: '78000' });
  });
  it('conservatively clarifies a companion operation without a complete supported source grammar', () => {
    const read = '查询我的理财持仓', other = '查询资金预算与房租保护', raw = query(); raw.tasks[0]!.scope = { text: read }; raw.tasks.push({ operation: 'funds_query', disposition: 'query', scope: { text: other } });
    const result = validateSemanticIntent({ ...base, message: `${read}；${other}` }, raw);
    expect(result.status).toBe('clarification'); expect(result.findings).toContain('SEMANTIC_INVESTMENT_QUERY_SCOPE_UNSUPPORTED'); expect(result.tasks).toEqual([]);
  });
});
