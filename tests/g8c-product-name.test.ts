import { describe, expect, it } from 'vitest';
import type { Planner } from '../packages/contracts/src';
import { validateSemanticIntent, type SemanticIntentDraft } from '../packages/agents/src/semantic-intent';

type Input = Parameters<Planner['plan']>[0];
const builtins = [
  { productId: 'synthetic-t0', productName: '合成即时赎回产品 T+0', redemptionBusinessDays: 0 },
  { productId: 'synthetic-t2', productName: '合成延时赎回产品 T+2', redemptionBusinessDays: 2 },
] as const;
const input = (message: string, product: { productId: string; productName: string; redemptionBusinessDays: number } = builtins[0]): Input => ({
  taskId: 'g8c-product-noun', message, accounts: [],
  payees: [{ id: 'payee', name: '顾宁', aliases: [], bank: '合成银行', maskedNumber: '****1172' }],
  investmentContext: { businessDate: '2026-10-23', calendar: 'DEMO_WEEKDAYS_V1', products: [], actions: [], positions: [
    { id: 'position', ...product, accountId: 'account', principalMinor: '500000', availableMinor: '500000', reservedMinor: '0', version: 1, calendar: 'DEMO_WEEKDAYS_V1' },
  ] },
});
const redemption = (mention: string, amount = '427.35元'): SemanticIntentDraft => ({ tasks: [{
  operation: 'investment_redeem', disposition: 'request', scope: { source: 'whole_message' },
  entity: { kind: 'position', id: 'position', mention: { text: mention } }, amount: { text: amount },
}] });
const investmentQuery = (): SemanticIntentDraft => ({ tasks: [{
  operation: 'investment_query', disposition: 'query', scope: { source: 'whole_message' },
  entity: { kind: 'position', id: 'position', mention: { text: builtins[0].productName } },
}] });

describe('G8C postfix built-in redemption product nouns', () => {
  it.each(['再赎回427.35元', '然后从中取出427.35元', '再给顾宁转120元', '金额超过120元才查询'])('does not omit a condition/action following a query: %s', tail => {
    const message = `查询${builtins[0].productName}当前持仓，${tail}`;
    for (const scope of [{ source: 'whole_message' as const }, { text: message }]) {
      const draft = investmentQuery(); draft.tasks[0]!.scope = scope;
      expect(validateSemanticIntent(input(message), draft).status).toBe('clarification');
    }
  });
  it.each(['查询合成即时赎回产品 T+0当前持仓', '合成即时赎回产品 T+0的可赎回余额是多少？', '请查看合成即时赎回产品 T+0持仓和预计到账规则'])('preserves a complete read-only scope: %s', message => {
    for (const scope of [{ source: 'whole_message' as const }, { text: message }]) {
      const draft = investmentQuery(); draft.tasks[0]!.scope = scope;
      expect(validateSemanticIntent(input(message), draft).status).toBe('ready');
    }
  });
  it('preserves a fully declared investment query and separate transfer', () => {
    const query = `查询${builtins[0].productName}当前持仓`, transfer = '再给顾宁转120元';
    const draft = investmentQuery(); draft.tasks[0]!.scope = { text: query };
    draft.tasks.push({ operation: 'transfer', disposition: 'request', scope: { text: transfer }, entity: { kind: 'payee', id: 'payee', mention: { text: '顾宁' } }, amount: { text: '120元' } });
    const result = validateSemanticIntent(input(`${query}，${transfer}`), draft);
    expect(result.status).toBe('ready'); expect(result.tasks.map(task => task.operation)).toEqual(['investment_query', 'transfer']);
  });
  it('does not let a payee alias borrow the noun exception with literal scope', () => {
    const mention = builtins[0].productName, message = `转给${mention}427.35元`, value = input(message);
    value.payees[0]!.aliases = [mention];
    const draft = redemption(mention); draft.tasks[0]!.operation = 'transfer'; draft.tasks[0]!.scope = { text: message };
    draft.tasks[0]!.entity = { kind: 'payee', id: 'payee', mention: { text: mention } };
    expect(validateSemanticIntent(value, draft).findings).toContain('SEMANTIC_ENTITY_COMMAND_CONTENT');
  });
  it.each([
    '合成即时赎回产品 T+0 427.35元',
    '合成即时赎回产品 T+0，金额427.35元',
    '从合成即时赎回产品 T+0赎回427.35元，再查询持仓',
    '从合成即时赎回产品 T+0赎回427.35元，然后看看持仓情况',
  ])('does not invent an outside redemption predicate or omit a same-domain query: %s', message => {
    const result = validateSemanticIntent(input(message), redemption(builtins[0].productName));
    expect(result.status).toBe('clarification'); expect(result.tasks).toEqual([]);
  });
  it.each(['再查询持仓', '然后看看持仓情况'])('does not silently drop an explicitly scoped same-domain query: %s', query => {
    const clause = `从${builtins[0].productName}赎回427.35元`;
    const draft = redemption(builtins[0].productName); draft.tasks[0]!.scope = { text: clause };
    draft.tasks.push({ operation: 'investment_query', disposition: 'query', scope: { text: query } });
    const result = validateSemanticIntent(input(`${clause}，${query}`), draft);
    expect(result.status).toBe('clarification');
    expect(result.findings).toContain('SEMANTIC_MULTIPLE_TASKS_SAME_DOMAIN');
    expect(result.tasks).toEqual([]);
  });
  it('preserves complete scopes for a redemption and a separate bill query', () => {
    const clause = `从${builtins[0].productName}赎回427.35元`, query = '再查询2027-03账单';
    const draft = redemption(builtins[0].productName); draft.tasks[0]!.scope = { text: clause };
    draft.tasks.push({ operation: 'bills_query', disposition: 'query', scope: { text: query }, period: { text: '2027-03' } });
    const result = validateSemanticIntent(input(`${clause}，${query}`), draft);
    expect(result.status).toBe('ready'); expect(result.tasks.map(task => task.operation)).toEqual(['investment_redeem', 'bills_query']);
    expect(result.tasks[0]!.slots.amountMinor).toBe('42735');
  });
  it.each([
    '合成即时赎回产品 T+0427.35元',
    '合成即时赎回产品 T+0，金额427.35元',
    '从合成即时赎回产品 T+0赎回427.35元，再查询持仓',
    '从合成即时赎回产品 T+0赎回427.35元，然后看看持仓情况',
  ])('applies the same outside-predicate requirement to literal scope: %s', message => {
    const draft = redemption(builtins[0].productName); draft.tasks[0]!.scope = { text: message };
    expect(validateSemanticIntent(input(message), draft).status).toBe('clarification');
  });
  it.each([
    { ...builtins[0], productId: 'unknown-product' },
    { ...builtins[0], redemptionBusinessDays: 9 },
    { ...builtins[0], productName: '合成即时赎回产品 T+0然后转账' },
  ])('does not bypass product checks with literal scope: %j', product => {
    const message = `从${product.productName}赎回427.35元`, draft = redemption(product.productName);
    draft.tasks[0]!.scope = { text: message };
    expect(validateSemanticIntent(input(message, product), draft).status).toBe('clarification');
  });
  it.each(builtins)('grounds the complete $productName without changing amount or source', product => {
    const message = `从${product.productName}赎回427.35元`;
    const result = validateSemanticIntent(input(message, product), redemption(product.productName));
    expect(result.status).toBe('ready');
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]).toMatchObject({ operation: 'investment_redeem', source: { text: message }, slots: { entityId: 'position', amountMinor: '42735' } });
  });
  it.each(builtins)('keeps the existing exact alias for $productName', product => {
    const alias = product.productName.replace(/ T\+\d$/, '');
    expect(validateSemanticIntent(input(`从${alias}赎回427.35元`, product), redemption(alias)).status).toBe('ready');
  });
  it.each(builtins)('allows a named read-only query for $productName', product => {
    const draft = redemption(product.productName); draft.tasks[0]!.operation = 'investment_query'; draft.tasks[0]!.disposition = 'query'; delete draft.tasks[0]!.amount;
    expect(validateSemanticIntent(input(`查询${product.productName}当前持仓`, product), draft).status).toBe('ready');
  });
  it.each([
    '合成即时赎回产品 T+0并查询账单', '合成即时赎回产品 T+0然后转账',
    '合成即时赎回产品 T+0再赎回', '合成即时赎回产品 T+0不要转账',
    '查询账单合成即时赎回产品 T+0', '任意赎回产品',
  ])('does not exempt a command-bearing catalog name: %s', productName => {
    const result = validateSemanticIntent(input(`从${productName}赎回427.35元`, { ...builtins[0], productName }), redemption(productName));
    expect(result.status).not.toBe('ready'); expect(result.tasks).toEqual([]);
  });
  it.each([
    { ...builtins[0], productId: 'unregistered' },
    { ...builtins[0], redemptionBusinessDays: 2 },
    { ...builtins[1], productId: 'synthetic-t0' },
  ])('does not infer a built-in product from inconsistent catalog metadata: %j', product => {
    expect(validateSemanticIntent(input(`从${product.productName}赎回427.35元`, product), redemption(product.productName)).findings).toContain('SEMANTIC_ENTITY_COMMAND_CONTENT');
  });
  it('does not accept an inconsistent runtime calendar as a built-in product', () => {
    const value = input(`从${builtins[0].productName}赎回427.35元`);
    Object.assign(value.investmentContext!.positions[0]!, { calendar: 'UNRECOGNIZED_CALENDAR' });
    expect(validateSemanticIntent(value, redemption(builtins[0].productName)).findings).toContain('SEMANTIC_ENTITY_COMMAND_CONTENT');
  });
  it('does not let the noun exception resolve duplicate catalog identities', () => {
    const value = input(`从${builtins[0].productName}赎回427.35元`);
    value.investmentContext!.positions.push({ ...value.investmentContext!.positions[0]!, id: 'another-position' });
    expect(validateSemanticIntent(value, redemption(builtins[0].productName)).findings).toContain('SEMANTIC_ENTITY_NOT_UNIQUE');
  });
  it.each([
    '从新合成即时赎回产品 T+0赎回427.35元', '从合成即时赎回产品 T+0精选赎回427.35元',
    '从合成即时赎回产品 T+0赎回427.35元，并查询账单',
    '从合成即时赎回产品 T+0赎回427.35元，再给顾宁转120元',
    '从合成即时赎回产品 T+0赎回427.35元，再赎回120元',
    '不要从合成即时赎回产品 T+0赎回427.35元',
    '请润色“从合成即时赎回产品 T+0赎回427.35元”',
  ])('preserves unknown-name, omitted-task and authorization context: %s', message => {
    expect(validateSemanticIntent(input(message), redemption(builtins[0].productName)).tasks).toEqual([]);
  });
  it('still rejects a cropped scope hiding another operation', () => {
    const clause = `从${builtins[0].productName}赎回427.35元`;
    const draft = redemption(builtins[0].productName); draft.tasks[0]!.scope = { text: clause };
    expect(validateSemanticIntent(input(`${clause}，再给顾宁转120元`), draft).findings).toContain('SEMANTIC_SOURCE_COVERAGE_INCOMPLETE');
  });
  it.each(['27.35元', '427.3', '42735元'])('does not relax the original amount binding: %s', amount => {
    expect(validateSemanticIntent(input(`从${builtins[0].productName}赎回427.35元`), redemption(builtins[0].productName, amount)).tasks).toEqual([]);
  });
  it('does not apply the position noun exception to a payee alias', () => {
    const mention = builtins[0].productName;
    const value = input(`转给${mention}427.35元`); value.payees[0]!.aliases = [mention];
    const draft = redemption(mention); draft.tasks[0]!.operation = 'transfer'; draft.tasks[0]!.entity = { kind: 'payee', id: 'payee', mention: { text: mention } };
    expect(validateSemanticIntent(value, draft).findings).toContain('SEMANTIC_ENTITY_COMMAND_CONTENT');
  });
});
