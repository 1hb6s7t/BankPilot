import { describe, expect, it } from 'vitest';
import type { Planner } from '../packages/contracts/src';
import { interpretSemanticIntent, validateSemanticIntent, type SemanticIntentDraft, type SourceSpan } from '../packages/agents/src/semantic-intent';

type Input = Parameters<Planner['plan']>[0];
type Task = SemanticIntentDraft['tasks'][number];
const base: Input = { taskId: 'g9c-independent-source-boundaries', message: '', accounts: [], payees: [
  { id: 'payee', name: '许越', aliases: ['同住伙伴'], bank: '合成银行', maskedNumber: '****1759' },
], managementContext: { cards: [
  { id: 'card', accountId: 'account', name: '青竹借记卡', maskedNumber: '****4168', status: 'ACTIVE', version: 2, updatedAt: '2026-10-24T00:00:00Z' },
  { id: 'other-card', accountId: 'account', name: '山樱储蓄卡', maskedNumber: '****7385', status: 'LOST', version: 3, updatedAt: '2026-10-24T00:00:00Z' },
], subscriptions: { queryActionId: 'grant', queriedAt: '2026-10-24T00:00:00Z', accessExpiresAt: '2100-01-01T00:00:00Z', items: ['云杉听书', '溪岸瑜伽'].map((merchant, index) => ({
  id: `subscription-${index}`, merchant, amountMinor: '4200', currency: 'CNY', nextChargeDate: '2026-11-01', cardId: 'card', merchantStatus: 'ACTIVE', bankStatus: 'ALLOWED', collectionStatus: 'ENABLED', version: 1, cancellationSupported: true, source: 'SYNTHETIC_MERCHANT',
})) } } };
const entity = (kind: 'payee' | 'card' | 'subscription', id: string, text: string) => ({ kind, id, mention: { text } });
const query = (operation: 'card_query' | 'bills_query' | 'investment_query', text: string, period?: string): Task => ({ operation, disposition: 'query', scope: { text }, ...(period ? { period: { text: period } } : {}) });
const transfer = (text: string): Task => ({ operation: 'transfer', disposition: 'request', scope: { text }, entity: entity('payee', 'payee', '许越'), amount: { text: '263元8角' }, memo: { text: '帐篷分摊' } });
const card = (message: string, mention: string, operation: 'card_query' | 'card_report_lost' = 'card_query'): Task => ({ operation, disposition: operation === 'card_query' ? 'query' : 'request', scope: { source: 'whole_message' }, entity: entity('card', 'card', mention) });
const run = (message: string, tasks: Task[], input = base) => validateSemanticIntent({ ...input, message }, { tasks });
const source = (message: string, text: string): SourceSpan => { const start = message.indexOf(text); return { start, end: start + text.length, text }; };

describe('G9C read-only card arguments have complete typed query boundaries', () => {
  it.each([
    ['我只想确认尾号4168是否挂失了，不要改它。', '尾号4168'],
    ['请核实末四位 4168是不是已经冻结。', '末四位 4168'],
    ['我想核对青竹借记卡有没有挂失。', '青竹借记卡'],
    ['青竹借记卡是否已经挂失？', '青竹借记卡'],
    ['先确认我的银行卡尾号4168有无停用。', '银行卡尾号4168'],
    ['青竹借记卡现在是什么状态？我只想确认尾号4168是否挂失了，不要改它。', '尾号4168'],
  ])('grounds only the status query in %s', (message, mention) => {
    const result = run(message, [card(message, mention)]);
    expect({ status: result.status, findings: result.findings }).toEqual({ status: 'ready', findings: [] });
    expect(result.tasks).toHaveLength(1); expect(result.tasks[0]).toMatchObject({ operation: 'card_query', source: source(message, message), slots: { entityId: 'card' } });
  });
  it.each([
    ['我只想确认陌生银行卡尾号4168是否挂失。', '尾号4168'],
    ['我只想确认新青竹借记卡是否挂失。', '青竹借记卡'],
    ['我只想确认尾号41685是否挂失。', '尾号4168'],
    ['我只想确认尾号4168是否挂失。', '4168'],
    ['山樱储蓄卡是否挂失？我只想确认尾号4168是否挂失。', '尾号4168'],
  ])('never drops an unknown qualifier or conflicting locator from %s', (message, mention) => {
    const result = run(message, [card(message, mention)]);
    expect(result.status).toBe('clarification'); expect(result.tasks).toEqual([]);
  });
  it('does not use the model ID to choose between duplicate tails', () => {
    const input: Input = { ...base, managementContext: { ...base.managementContext!, cards: base.managementContext!.cards.map(value => ({ ...value, maskedNumber: '****4168' })) } };
    const message = '我只想确认尾号4168是否挂失了';
    expect(run(message, [card(message, '尾号4168')], input).findings).toContain('SEMANTIC_ENTITY_NOT_UNIQUE');
  });
  it.each(['我只想确认尾号4168是否挂失了', '青竹借记卡是否已经挂失？'])('a read-only status predicate cannot activate a model-labelled write: %s', message => {
    const result = run(message, [card(message, message.includes('尾号') ? '尾号4168' : '青竹借记卡', 'card_report_lost')]);
    expect(result.tasks).toEqual([]); expect(result.status).not.toBe('ready');
  });
  it.each([
    '不要确认尾号4168是否挂失。',
    '历史记录：我只想确认尾号4168是否挂失。',
    '请改写“我只想确认尾号4168是否挂失”。',
  ])('quoted, negated and historical confirmation remains inactive: %s', message => {
    const result = run(message, [card(message, '尾号4168')]);
    expect(result.tasks).toEqual([]); expect(result.status).not.toBe('ready');
  });
});

describe('G9C deterministic request wrappers retain the unchanged original source', () => {
  it.each(['另外', '同时', '接着', '然后', '再', '另外  请'])('retains the full %s wrapper without model regeneration', connector => {
    const first = '先展示我的理财持仓，不要赎回', action = '给许越转263元8角，备注“帐篷分摊”，从现有现金安排。';
    const message = `${first}；${connector}${action}`;
    const result = run(message, [query('investment_query', first), transfer(action)]);
    expect({ status: result.status, findings: result.findings }).toEqual({ status: 'ready', findings: [] });
    expect(result.tasks[0]?.source).toEqual(source(message, first));
    expect(result.tasks[1]?.source).toEqual(source(message, `${connector}${action}`));
    expect(result.tasks[1]?.slots).toEqual({ entityId: 'payee', amountMinor: '26380', memo: '帐篷分摊' });
  });
  it.each(['？', '?', '！', '!'])('accepts a complete sentence boundary %s on either side of the scope', punctuation => {
    const first = `查询两张银行卡状态${punctuation}`, second = '列出2028年4月账单的收入和支出。';
    const message = `${first}再${second}`;
    const result = run(message, [query('card_query', first), query('bills_query', second, '2028年4月')]);
    expect(result.status).toBe('ready'); expect(result.tasks.map(task => task.source.text)).toEqual([first, `再${second}`]);
  });
  it.each(['这次分两件办：', '本次分2项处理:', '分两件事分别办理：', '请分别处理：'])('retains a complete task-count frame %s', frame => {
    const first = '取消云杉听书的商户订阅', second = '对溪岸瑜伽只做银行扣款拦截，合约我自己处理';
    const message = `${frame}${first}；${second}。请分别生成待确认提案。`;
    const tasks: Task[] = [
      { operation: 'subscription_cancel', disposition: 'request', scope: { text: first }, entity: entity('subscription', 'subscription-0', '云杉听书') },
      { operation: 'subscription_block', disposition: 'request', scope: { text: second }, entity: entity('subscription', 'subscription-1', '溪岸瑜伽') },
    ];
    const result = run(message, tasks);
    expect({ status: result.status, findings: result.findings }).toEqual({ status: 'ready', findings: [] });
    expect(result.tasks.map(task => task.operation)).toEqual(['subscription_cancel', 'subscription_block']);
    expect(result.tasks.map(task => task.source.text)).toEqual([`${frame}${first}`, `${second}。请分别生成待确认提案。`]);
  });
  it.each(['不要', '如果', '历史记录：', '示例：', '这次分三件办：', '仅当余额充足时'])('does not reinterpret non-wrapper context %s as a safe prefix', prefix => {
    const first = '查询两张银行卡状态', second = '给许越转263元8角，备注“帐篷分摊”';
    const message = `${first}；${prefix}${second}`;
    const result = run(message, [query('card_query', first), transfer(second)]);
    expect(result.tasks).toEqual([]); expect(result.status).toBe('clarification');
  });
  it('never repairs a punctuation-normalized model string', () => {
    const message = '查询两张银行卡状态；另外给许越转263元8角，备注“帐篷分摊”。';
    expect(run(message, [query('card_query', '查询两张银行卡状态'), transfer('给许越转263元8角,备注“帐篷分摊”。')]).findings).toContain('SEMANTIC_SPAN_NOT_FOUND');
  });
  it('never changes the caller draft or inferred amount when normalizing source boundaries', async () => {
    const message = '查询2028年4月账单；另外给许越转263元8角，备注“帐篷分摊”。请分别生成待确认候选。';
    const draft: SemanticIntentDraft = { tasks: [query('bills_query', '查询2028年4月账单', '2028年4月'), transfer('给许越转263元8角，备注“帐篷分摊”')] };
    const saved = structuredClone(draft); let calls = 0;
    const result = await interpretSemanticIntent({ ...base, message }, { provider: { baseURL: 'https://unused.invalid', model: 'unused', maxAttempts: 1 }, adapter: async () => { calls++; return draft; } });
    expect(calls).toBe(1); expect(draft).toEqual(saved); expect(result.status).toBe('ready'); expect(result.tasks[1]?.source.text).toBe('另外给许越转263元8角，备注“帐篷分摊”。请分别生成待确认候选。');
  });
});

describe('G9C shared presentation clauses keep their original provenance and restrictions', () => {
  it.each(['这两件事都先给我看结果或候选', '以上两项分别展示结果和提案', '请分别生成待确认候选', '这次都先准备待确认提案'])('retains the complete preview clause %s', tail => {
    const first = '查询2028年4月的收支合计', second = '给许越转263元8角，备注“帐篷分摊”';
    const message = `${first}；另外${second}，${tail}。`;
    const result = run(message, [query('bills_query', first, '2028年4月'), transfer(second)]);
    expect(result.status).toBe('ready'); expect(result.tasks[1]?.source).toEqual(source(message, `另外${second}，${tail}。`));
    expect(result.tasks[1]?.slots.memo).toBe('帐篷分摊');
  });
  it.each(['这次都只看信息', '以上两项仅查看状态', '本次分别只查询结果'])('supports complete read-only tasks with %s and keeps the clause in source', tail => {
    const first = '查询青竹借记卡和山樱储蓄卡的状态', second = '列一下2028年4月账单的收入和支出';
    const message = `${first}，再${second}；${tail}。`;
    const result = run(message, [query('card_query', first), query('bills_query', second, '2028年4月')]);
    expect(result.status).toBe('ready'); expect(result.tasks.map(task => task.operation)).toEqual(['card_query', 'bills_query']);
    expect(result.tasks[0]?.source.text).toContain('青竹借记卡和山樱储蓄卡'); expect(result.tasks[1]?.source.text).toBe(`再${second}；${tail}。`);
  });
  it.each(['这次都只看信息', '以上两项仅查看状态', '本次分别只查询结果'])('cannot ignore %s while proposing a write', tail => {
    const first = '查询2028年4月账单', second = '给许越转263元8角，备注“帐篷分摊”';
    const message = `${first}；${second}；${tail}。`;
    const result = run(message, [query('bills_query', first, '2028年4月'), transfer(second)]);
    expect(result.status).toBe('clarification'); expect(result.findings).toEqual(['SEMANTIC_READ_ONLY_CONSTRAINT_CONFLICT']); expect(result.tasks).toEqual([]);
  });
  it.each([
    '从现有现金安排', '从另一张卡扣款', '只有余额充足时才准备候选', '请分别生成待确认候选并执行',
    '请分别生成待确认候选，然后再给许越转20元', '请分别生成待确认候选，到账后自动转账', '给我看680元候选',
    '只展示2028年5月的结果', '候选备注请用露营费用', '请分别生成待确认候选，别生成转账提案',
  ])('never discards a real funding, condition, operation or argument as presentation: %s', tail => {
    const first = '查询2028年4月账单', second = '给许越转263元8角，备注“帐篷分摊”';
    const message = `${first}；${second}；${tail}。`;
    const result = run(message, [query('bills_query', first, '2028年4月'), transfer(second)]);
    expect(result.status).toBe('clarification'); expect(result.tasks).toEqual([]);
  });
  it.each(['“请分别生成待确认候选”', '历史记录中写着请分别生成待确认候选', '假如请分别生成待确认候选'])('never treats %s as an active presentation clause', tail => {
    const first = '查询两张银行卡状态', second = '查询2028年4月账单', message = `${first}；${second}；${tail}。`;
    expect(run(message, [query('card_query', first), query('bills_query', second, '2028年4月')]).tasks).toEqual([]);
  });
  it('rejects separate same-domain queries that the domain stage cannot yet consume completely', () => {
    const first = '查询青竹借记卡状态', second = '查询山樱储蓄卡状态', message = `${first}；另外${second}；这次都只看信息。`;
    const result = run(message, [query('card_query', first), query('card_query', second)]);
    expect(result.status).toBe('clarification'); expect(result.findings).toContain('SEMANTIC_MULTIPLE_TASKS_SAME_DOMAIN'); expect(result.tasks).toEqual([]);
  });
  it('rejects two same-domain card writes rather than dropping either one', () => {
    const first = '挂失青竹借记卡', second = '恢复山樱储蓄卡', message = `${first}；另外${second}；请分别生成待确认候选。`;
    const result = run(message, [
      { operation: 'card_report_lost', disposition: 'request', scope: { text: first }, entity: entity('card', 'card', '青竹借记卡') },
      { operation: 'card_restore', disposition: 'request', scope: { text: second }, entity: entity('card', 'other-card', '山樱储蓄卡') },
    ]);
    expect(result.status).toBe('clarification'); expect(result.findings).toContain('SEMANTIC_MULTIPLE_TASKS_SAME_DOMAIN'); expect(result.tasks).toEqual([]);
  });
});
