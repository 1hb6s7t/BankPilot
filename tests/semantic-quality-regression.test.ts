import { describe, expect, it } from 'vitest';
import type { Planner } from '../packages/contracts/src/index';
import { interpretSemanticIntent, validateSemanticIntent } from '../packages/agents/src/semantic-intent';
import { resolveInvestment } from '../packages/agents/src/financial';
import { resolveSubscription } from '../packages/agents/src/management';

type Input = Parameters<Planner['plan']>[0];
// Synthetic grammar probes, independent of the frozen evaluation fixtures.
const base: Input = {
  taskId: 'quality-synthetic', message: '', accounts: [],
  payees: [{ id: 'p', name: '许安', aliases: ['小许'], bank: '合成银行', maskedNumber: '****2356' }],
  investmentContext: { businessDate: '2026-10-23', calendar: 'DEMO_WEEKDAYS_V1', actions: [], products: [], positions: [
    { id: 'position', accountId: 'a', productId: 'product', productName: '溪岸稳健组合 T+2', principalMinor: '500000', availableMinor: '500000', reservedMinor: '0', version: 1, redemptionBusinessDays: 2, calendar: 'DEMO_WEEKDAYS_V1' },
  ] },
  managementContext: { cards: [
    { id: 'card', accountId: 'a', name: '银杏储蓄卡', maskedNumber: '****6281', status: 'LOST', version: 1, updatedAt: '2026-10-23T00:00:00Z' },
  ], subscriptions: { queryActionId: 'grant', queriedAt: '2026-10-23T00:00:00Z', accessExpiresAt: '2100-01-01T00:00:00Z', items: [
    { id: 'sub', merchant: '澜汀阅读', amountMinor: '1800', currency: 'CNY', nextChargeDate: '2026-11-01', cardId: 'card', merchantStatus: 'ACTIVE', bankStatus: 'ALLOWED', collectionStatus: 'ENABLED', version: 1, cancellationSupported: false, source: 'SYNTHETIC_MERCHANT' },
  ] } },
};
function task(message: string, operation: string, kind?: string, id?: string, mention?: string) {
  return { operation, disposition: 'request', scope: { text: message }, ...(kind ? { entity: { kind, id, mention: { text: mention } } } : {}) };
}
const run = (message: string, draft: unknown) => validateSemanticIntent({ ...base, message }, { tasks: [draft] });

describe('semantic grounding quality without weakening authority', () => {
  it.each(['我的银行卡尾号6281遗失了，请申请挂失', '卡片尾号6281找不到了，申请挂失'])('grounds a typed locator independently of card state grammar: %s', message => {
    const result = run(message, task(message, 'card_report_lost', 'card', 'card', '尾号6281'));
    expect(result.status).toBe('ready'); expect(result.tasks[0]?.slots.entityId).toBe('card');
  });
  it.each(['不是丢失的卡', '并非丢失的卡', '属于另一张卡'])('rejects a locator followed by an incompatible argument qualifier: %s', qualifier => {
    const message = `尾号6281${qualifier}，先挂失另一张`;
    const result = run(message, task(message, 'card_report_lost', 'card', 'card', '尾号6281'));
    expect(result.status).toBe('clarification'); expect(result.tasks).toEqual([]);
    expect(result.findings).toContain('SEMANTIC_ENTITY_TOKEN_TRUNCATED');
  });
  it('accepts a locator subject with found state and explicit restoration request', () => {
    const message = '尾号6281已经找回，请恢复这张卡';
    expect(run(message, task(message, 'card_restore', 'card', 'card', '尾号6281')).status).toBe('ready');
  });
  it('keeps complete card subject and restoration request in one task', () => {
    const message = '银杏储蓄卡已经找回，请恢复这张卡';
    expect(run(message, task(message, 'card_restore', 'card', 'card', '银杏储蓄卡')).status).toBe('ready');
    const cropped = { ...task(message, 'card_restore', 'card', 'card', '银杏储蓄卡'), scope: { text: '请恢复这张卡' } };
    expect(run(message, cropped).issues).toEqual([{ path: ['tasks', '0', 'entity', 'mention'], category: 'source', code: 'SEMANTIC_SPAN_OUTSIDE_SCOPE' }]);
  });
  it.each(['停止澜汀阅读会员自动续费，按商户合同处理', '帮我终止澜汀阅读的商户会员'])('grounds merchant syntax and preserves downstream capability checks: %s', message => {
    const result = run(message, task(message, 'subscription_cancel', 'subscription', 'sub', '澜汀阅读'));
    expect(result.status).toBe('ready');
    const domain = resolveSubscription(result.tasks[0]!.canonicalMessage, base.managementContext);
    expect(domain.managementSuggestions).toEqual([]);
  });
  it.each(['从“溪岸稳健组合”赎回62元', '把“溪岸稳健组合”里的62元赎出来'])('treats a quoted exact product noun as the redemption object: %s', message => {
    const result = run(message, { ...task(message, 'investment_redeem', 'position', 'position', '溪岸稳健组合'), amount: { text: '62元' } });
    expect(result.status).toBe('ready'); expect(result.tasks[0]?.slots.amountMinor).toBe('6200');
  });
  it.each(['request', 'quoted', 'ambiguous'])('clarifies unknown quoted nouns instead of ignoring a current request: %s', disposition => {
    const message = '从“溪岸优选”赎回62元';
    const result = run(message, { ...task(message, 'investment_redeem'), disposition, amount: { text: '62元' } });
    expect(result.status).toBe('clarification'); expect(result.clarification).toContain('理财产品'); expect(result.tasks).toEqual([]);
  });
  it.each(['“从溪岸稳健组合赎回62元”', '请改写“从溪岸稳健组合赎回62元”', '不要从“溪岸稳健组合”赎回62元'])('never promotes a quoted or negated instruction: %s', message => {
    expect(run(message, { ...task(message, 'investment_redeem', 'position', 'position', '溪岸稳健组合'), amount: { text: '62元' } }).tasks).toEqual([]);
  });
  it.each(['请改写给“许安”62元这句话', '请翻译：给“许安”62元', '请翻译我的请求：给“许安”62元', '请记录给“许安”62元这句话'])('noun quotes do not turn text editing into a payment: %s', message => {
    expect(run(message, { ...task(message, 'transfer', 'payee', 'p', '许安'), amount: { text: '62元' } }).status).toBe('no_action');
  });
  it('keeps translation of a quoted product request as data', () => {
    const message = '请翻译：从“溪岸稳健组合”赎回62元';
    expect(run(message, { ...task(message, 'investment_redeem', 'position', 'position', '溪岸稳健组合'), amount: { text: '62元' } }).status).toBe('no_action');
  });
  it.each(['银杏储蓄卡已经恢复', '已经给许安62元', '已经从溪岸稳健组合赎回62元'])('does not confuse completed operations with current requests: %s', message => {
    const draft = message.includes('许安') ? { ...task(message, 'transfer', 'payee', 'p', '许安'), amount: { text: '62元' } } : message.includes('组合') ? { ...task(message, 'investment_redeem', 'position', 'position', '溪岸稳健组合'), amount: { text: '62元' } } : task(message, 'card_restore', 'card', 'card', '银杏储蓄卡');
    expect(run(message, draft).tasks).toEqual([]);
  });
  it.each(['request', 'ambiguous'])('asks for the missing recipient explicitly: %s', disposition => {
    const message = '再给上次那位转62元';
    const result = run(message, { ...task(message, 'transfer'), disposition, amount: { text: '62元' } });
    expect(result.status).toBe('clarification'); expect(result.clarification).toContain('收款人');
  });
  it('copies an exact alias, Chinese subunit amount and memo without normalization', () => {
    const message = '请给小许汇二百零五元零七分，备注修车分摊';
    const result = run(message, { ...task(message, 'transfer', 'payee', 'p', '小许'), amount: { text: '二百零五元零七分' }, memo: { text: '修车分摊' } });
    expect(result.status).toBe('ready'); expect(result.tasks[0]?.slots).toEqual({ entityId: 'p', amountMinor: '20507', memo: '修车分摊' });
  });
  it('reports absent spans without echoing model data', () => {
    const message = '给许安六十二元';
    const result = run(message, { ...task(message, 'transfer', 'payee', 'p', '许安'), amount: { text: 'SECRET 62元' } });
    expect(result.issues).toEqual([{ path: ['tasks', '0', 'amount'], category: 'source', code: 'SEMANTIC_SPAN_NOT_FOUND' }]);
    expect(JSON.stringify(result)).not.toContain('SECRET');
  });
  it('reports repeated spans separately and permits scoped unique text', () => {
    const message = '给许安62元，说明记录另一次62元';
    const draft = { ...task(message, 'transfer', 'payee', 'p', '许安'), amount: { text: '62元' } };
    expect(run(message, draft).issues?.[0]).toEqual({ path: ['tasks', '0', 'amount'], category: 'source', code: 'SEMANTIC_SPAN_NOT_UNIQUE' });
    expect(run(message, { ...draft, scope: { text: '给许安62元' } }).tasks[0]?.slots.amountMinor).toBe('6200');
  });
  it('provides safe schema paths instead of arbitrary model keys', () => {
    const result = run('查询账单', { ...task('查询账单', 'bills_query'), period: { text: 123 } });
    expect(result.issues?.[0]).toEqual({ path: ['tasks', '0', 'period', 'text'], category: 'schema', code: 'SEMANTIC_SCHEMA_INVALID' });
  });
  it.each(['我的银行卡尾号62810遗失了，请挂失', '挂失新银杏储蓄卡', '挂失银杏储蓄卡特别版'])('still rejects cropped unknown card arguments: %s', message => {
    const mention = message.includes('尾号') ? '尾号6281' : '银杏储蓄卡';
    expect(run(message, task(message, 'card_report_lost', 'card', 'card', mention)).tasks).toEqual([]);
  });
  it.each(['给“许安”的姐姐62元', '给向“许安”62元', '给王“许安”62元'])('noun quotes do not hide unknown recipient arguments: %s', message => {
    expect(run(message, { ...task(message, 'transfer', 'payee', 'p', '许安'), amount: { text: '62元' } }).tasks).toEqual([]);
  });
  it('does not bypass catalog ambiguity with noun quotes', () => {
    const message = '从“溪岸优选”赎回62元';
    expect(run(message, { ...task(message, 'investment_redeem', 'position', 'position', '溪岸优选'), amount: { text: '62元' } }).tasks).toEqual([]);
  });
  it.each(['给许安转账62元只是个示例', '请改写给许安62元这句话', '历史记录：给许安62元'])('accepts a model quoted label for an explicit full-message data wrapper: %s', message => {
    const result = run(message, { ...task(message, 'transfer', 'payee', 'p', '许安'), disposition: 'quoted', amount: { text: '62元' } });
    expect(result.status).toBe('no_action'); expect(result.tasks).toEqual([]); expect(result.clarification).toBeUndefined();
  });
  it('does not let a quoted label turn an ordinary current request into a ready task', () => {
    const message = '给许安转账62元';
    const result = run(message, { ...task(message, 'transfer', 'payee', 'p', '许安'), disposition: 'quoted', amount: { text: '62元' } });
    expect(result.status).toBe('clarification'); expect(result.tasks).toEqual([]);
  });
  it('does not apply the data-wrapper exception to a cropped task scope', () => {
    const message = '给许安62元只是个示例，另做一件事';
    const result = run(message, { ...task(message, 'transfer', 'payee', 'p', '许安'), scope: { text: '给许安62元只是个示例' }, disposition: 'quoted', amount: { text: '62元' } });
    expect(result.status).toBe('clarification'); expect(result.tasks).toEqual([]);
  });
  it.each([
    ['demo-position-plan', '427.35元', '42735'],
    ['demo-position-42', '0.09元', '9'],
    ['demo-position9', '123.01元', '12301'],
  ])('preserves grounded money through the investment resolver for %s', (id, amount, minor) => {
    const message = `从溪岸稳健组合赎回${amount}`;
    const dashboard = { ...base.investmentContext!, positions: [{ ...base.investmentContext!.positions[0]!, id }] };
    const result = validateSemanticIntent({ ...base, message, investmentContext: dashboard }, { tasks: [{ ...task(message, 'investment_redeem', 'position', id, '溪岸稳健组合'), amount: { text: amount } }] });
    expect(result.status).toBe('ready'); expect(result.tasks[0]?.slots.amountMinor).toBe(minor);
    expect(result.tasks[0]?.canonicalMessage).toContain(`${id} 金额`);
    const domain = resolveInvestment(result.tasks[0]!.canonicalMessage, dashboard);
    expect(domain.clarification).toBeUndefined();
    expect(domain.investmentSuggestions).toEqual([{ positionId: id, amountMinor: minor, expectedVersion: 1 }]);
  });
  it('provides general extraction instructions to the provider adapter', async () => {
    let payload: unknown;
    await interpretSemanticIntent({ ...base, message: '查询账单' }, { provider: { baseURL: 'http://unused', model: 'unused', apiKey: 'unused' }, adapter: async value => { payload = value; return { tasks: [] }; } });
    expect(JSON.stringify(payload)).toContain('WHOLE task');
    expect(JSON.stringify(payload)).toContain('character for character');
  });
});
