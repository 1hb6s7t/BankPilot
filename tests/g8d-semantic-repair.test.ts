import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Planner } from '../packages/contracts/src';
import { interpretSemanticIntent, validateSemanticIntent, type SemanticIntentDraft } from '../packages/agents/src/semantic-intent';

type Input = Parameters<Planner['plan']>[0];
const input = (message: string): Input => ({ taskId: 'g8d-independent', message, accounts: [], payees: [
  { id: 'p', name: '顾宁', aliases: [], bank: '合成银行', maskedNumber: '****1172' },
] });
const provider = { baseURL: 'https://g8d.invalid/v1', model: 'synthetic', outputMode: 'json_object' as const, maxAttempts: 2, retryDelayMs: 0, maxOutputTokens: 4096 };
const envelope = (raw: unknown) => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(raw) } }] }));
const query = (operation: 'bills_query' | 'funds_query', period?: string): SemanticIntentDraft => ({ tasks: [{ operation, disposition: 'query', scope: { source: 'whole_message' }, ...(period ? { period: { text: period } } : {}) }] });
const multi = (): SemanticIntentDraft => ({ tasks: [query('bills_query', '2027年3月').tasks[0]!, {
  operation: 'transfer', disposition: 'request', scope: { source: 'whole_message' }, entity: { kind: 'payee', id: 'p', mention: { text: '顾宁' } }, amount: { text: '128.40 元' },
}] });
const message = '先列出2027年3月账单中金额最大的消费，再给顾宁汇 128.40 元';
const repairedMulti = () => { const draft = multi(); draft.tasks[0]!.scope = { text: message.split('，')[0]! }; draft.tasks[1]!.scope = { text: message.split('，')[1]! }; return draft; };
async function regenerate(text: string, first: SemanticIntentDraft, second: SemanticIntentDraft, maxAttempts = 2) {
  const fetch = vi.fn().mockResolvedValueOnce(envelope(first)).mockResolvedValueOnce(envelope(second)); vi.stubGlobal('fetch', fetch);
  return { result: await interpretSemanticIntent(input(text), { provider: { ...provider, maxAttempts } }), fetch };
}
afterEach(() => vi.unstubAllGlobals());

describe('G8D bounded semantic repair contracts', () => {
  it('regenerates two complete scopes without changing either task or its arguments', async () => {
    const { result, fetch } = await regenerate(message, multi(), repairedMulti());
    expect(result.status).toBe('ready'); expect(result.tasks.map(task => task.operation)).toEqual(['bills_query', 'transfer']);
    expect(result.tasks[1]!.slots).toEqual({ entityId: 'p', amountMinor: '12840' });
    expect(result.tasks.map(task => task.source.text)).toEqual(message.split('，'));
    expect(fetch).toHaveBeenCalledTimes(2); expect(result.modelRuns.map(run => run.status)).toEqual(['failed', 'success']);
    expect(result.modelRuns.reduce((sum, run) => sum + (run.requestMaxOutputTokens ?? 0), 0)).toBe(8192);
  });
  it.each(['delete', 'swap', 'amount', 'entity', 'period', 'disposition', 'memo', 'crop'])('rejects %s drift in two-task scope repair', async change => {
    const repaired = repairedMulti();
    if (change === 'delete') repaired.tasks.pop();
    if (change === 'swap') repaired.tasks.reverse();
    if (change === 'amount') repaired.tasks[1]!.amount = { text: '28.40 元' };
    if (change === 'entity') repaired.tasks[1]!.entity!.id = 'other';
    if (change === 'period') repaired.tasks[0]!.period = { text: '3月' };
    if (change === 'disposition') repaired.tasks[1]!.disposition = 'negated';
    if (change === 'memo') repaired.tasks[1]!.memo = { text: '消费' };
    if (change === 'crop') repaired.tasks[0]!.scope = { text: '2027年3月' };
    const { result, fetch } = await regenerate(message, multi(), repaired);
    expect(result.status).toBe('clarification'); expect(result.tasks).toEqual([]);
    expect(result.findings).toContain('SEMANTIC_SOURCE_REPAIR_DRIFT'); expect(fetch).toHaveBeenCalledTimes(2);
  });
  it.each([
    message.replace('再给', '如果支出超过预算再给'), message.replace('再给', '不要给'),
    `${message}，再查询银行卡`, message.replace('顾宁', '顾宁或者另一个人'),
  ])('does not offer scope repair for ambiguous or omitted source content: %s', text => {
    return regenerate(text, multi(), repairedMulti()).then(({ result, fetch }) => {
      expect(result.status).toBe('clarification'); expect(fetch).toHaveBeenCalledTimes(1);
    });
  });
  it.each([undefined, '2027-03书店消费'])('copies the unique explicit period when the candidate is %s', async period => {
    const { result, fetch } = await regenerate('2027-03书店消费是多少？把原流水编号也给我', query('bills_query', period), query('bills_query', '2027-03'));
    expect(result.status).toBe('ready'); expect(result.tasks[0]!.slots.billPeriod?.startPeriod).toBe('2027-03'); expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('does not ask for a missing year when the original period is explicit but model repair fails', async () => {
    const first = query('bills_query', '2027-03书店消费');
    const { result, fetch } = await regenerate('2027-03书店消费是多少', first, first);
    expect(result.status).toBe('clarification'); expect(fetch).toHaveBeenCalledTimes(2);
    expect(result.clarification).not.toMatch(/请明确完整年份|补.*年份/);
  });
  it.each(['2027年3月和5月', '2027年12月至2028年2月'])('preserves the complete original period: %s', async period => {
    const { result } = await regenerate(`比较${period}餐饮消费`, query('bills_query', `${period}餐饮消费`), query('bills_query', period));
    expect(result.status).toBe('ready'); expect(result.tasks[0]!.slots.billPeriod?.source.text).toBe(period);
    if (period.includes('和')) expect(result.tasks[0]!.slots.billPeriod?.periods).toEqual(['2027-03', '2027-05']);
  });
  it.each(['查询2027-03账单，再查2027-05收入', '查询3月账单', '不要查询2027-03账单', '查询2027-03账单，再给顾宁转120元'])('does not reinterpret ambiguous periods or a cropped query: %s', async text => {
    const first = query('bills_query'); if (text.includes('再给')) first.tasks[0]!.scope = { text: '查询2027-03账单' };
    const { result, fetch } = await regenerate(text, first, query('bills_query', '2027-03'));
    expect(result.status).not.toBe('ready'); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('regenerates a uniquely explicit monthly summary from funds into bills', async () => {
    const { result, fetch } = await regenerate('报一下2027年3月收入、支出和净额', query('funds_query'), query('bills_query', '2027年3月'));
    expect(result.status).toBe('ready'); expect(result.tasks[0]!.operation).toBe('bills_query'); expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('rejects the wrong monthly-summary domain even without provider regeneration', () => {
    expect(validateSemanticIntent(input('报一下2027年3月收入、支出和净额'), query('funds_query')).findings).toContain('SEMANTIC_BILL_OPERATION_CONFLICT');
  });
  it.each(['按现在余额、房租和生活费算还能安排多少', '用2027年3月收入计划下月预算', '报一下3月收入支出', '报一下2027年3月收入、支出和净额，再给顾宁转120元'])('does not reclassify an unsupported or mixed funds request: %s', async text => {
    const { fetch } = await regenerate(text, query('funds_query'), query('bills_query', '2027年3月'));
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each(['funds_query', 'transfer', 'investment_query'] as const)('cannot switch strategies to %s on the second attempt', async operation => {
    const second = query('bills_query', '2027年3月'); second.tasks[0]!.operation = operation;
    const { result, fetch } = await regenerate('报一下2027年3月收入、支出和净额', query('funds_query'), second);
    expect(result.status).toBe('clarification'); expect(result.findings).toContain('SEMANTIC_SOURCE_REPAIR_DRIFT'); expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('respects a one-attempt provider budget', async () => {
    const { result, fetch } = await regenerate(message, multi(), repairedMulti(), 1);
    expect(result.status).toBe('clarification'); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('does not repair an omitted bill period and two source scopes in the same attempt', async () => {
    const first = multi(); delete first.tasks[0]!.period;
    const { result, fetch } = await regenerate(message, first, repairedMulti());
    expect(result.status).toBe('clarification'); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each(['entity', 'amount', 'period', 'scope'])('does not use a scope retry to fix an ungrounded first-draft %s', async field => {
    const first = multi();
    if (field === 'entity') first.tasks[1]!.entity!.id = 'unknown';
    if (field === 'amount') first.tasks[1]!.amount = { text: '28.40 元' };
    if (field === 'period') first.tasks[0]!.period = { text: '3月' };
    if (field === 'scope') first.tasks[0]!.scope = { text: '2027年3月' };
    const { result, fetch } = await regenerate(message, first, repairedMulti());
    expect(result.status).toBe('clarification'); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each(['delete', 'add', 'disposition', 'amount', 'date', 'scope', 'period'])('locks %s during read-only classification repair', async change => {
    const second = query('bills_query', '2027年3月');
    if (change === 'delete') second.tasks = [];
    if (change === 'add') second.tasks.push(query('funds_query').tasks[0]!);
    if (change === 'disposition') second.tasks[0]!.disposition = 'request';
    if (change === 'amount') second.tasks[0]!.amount = { text: '3月' };
    if (change === 'date') second.tasks[0]!.date = { text: '2027年3月' };
    if (change === 'scope') second.tasks[0]!.scope = { text: '收入、支出和净额' };
    if (change === 'period') second.tasks[0]!.period = { text: '3月' };
    const { result, fetch } = await regenerate('报一下2027年3月收入、支出和净额', query('funds_query'), second);
    expect(result.findings).toContain('SEMANTIC_SOURCE_REPAIR_DRIFT'); expect(result.tasks).toEqual([]); expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('does not repair a valid supplied period into another one', async () => {
    const { result, fetch } = await regenerate('查询2027-03账单', query('bills_query', '2027-03'), query('bills_query', '2027-04'));
    expect(result.status).toBe('ready'); expect(fetch).toHaveBeenCalledTimes(1); expect(result.tasks[0]!.slots.billPeriod?.startPeriod).toBe('2027-03');
  });
  it('does not copy an invalid period supplied outside the original message', async () => {
    const { result, fetch } = await regenerate('查询2027-03账单', query('bills_query', '2027-04账单'), query('bills_query', '2027-03'));
    expect(result.status).toBe('clarification'); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('does not collapse a unique month selection during period repair', async () => {
    const { result } = await regenerate('比较2027年3月和5月餐饮消费', query('bills_query', '2027年3月和5月餐饮消费'), query('bills_query', '2027年3月'));
    expect(result.findings).toContain('SEMANTIC_SOURCE_REPAIR_DRIFT'); expect(result.tasks).toEqual([]);
  });
});

describe('G8D original-source example disposition', () => {
  it.each(['negated', 'historical', 'quoted', 'request'] as const)('recognizes a complete explicit example regardless of inactive label %s', disposition => {
    const raw: SemanticIntentDraft = { tasks: [{ operation: 'transfer', disposition, scope: { source: 'whole_message' }, entity: { kind: 'payee', id: 'p', mention: { text: '顾宁' } }, amount: { text: '100元' } }] };
    const result = validateSemanticIntent(input('给顾宁转账100元只是个示例'), raw);
    expect(result.status).toBe('no_action'); expect(result.tasks).toEqual([]);
  });
  it.each(['negated', 'historical', 'quoted', 'request'] as const)('does not dismiss a later real request using %s', disposition => {
    const raw: SemanticIntentDraft = { tasks: [{ operation: 'transfer', disposition, scope: { source: 'whole_message' } }] };
    const result = validateSemanticIntent(input('给顾宁转账100元只是个示例，另外给顾宁转120元'), raw);
    expect(result.status).toBe('clarification'); expect(result.tasks).toEqual([]);
  });
  it.each(['给顾宁转账100元只是个示例但现在给顾宁转120元', '给顾宁转120元，给顾宁转账100元只是个示例'])('does not hide a real request on either side of an example: %s', message => {
    const raw: SemanticIntentDraft = { tasks: [{ operation: 'transfer', disposition: 'request', scope: { source: 'whole_message' } }] };
    expect(validateSemanticIntent(input(message), raw).status).toBe('clarification');
  });
  it('keeps a separately declared example and subsequent real transfer distinct', () => {
    const example = '给顾宁转账100元只是个示例', actual = '另外给顾宁转120元';
    const raw: SemanticIntentDraft = { tasks: [
      { operation: 'transfer', disposition: 'historical', scope: { text: example } },
      { operation: 'transfer', disposition: 'request', scope: { text: actual }, entity: { kind: 'payee', id: 'p', mention: { text: '顾宁' } }, amount: { text: '120元' } },
    ] };
    const result = validateSemanticIntent(input(`${example}，${actual}`), raw);
    expect(result.status).toBe('ready'); expect(result.tasks).toHaveLength(1); expect(result.tasks[0]!.slots.amountMinor).toBe('12000');
  });
});
