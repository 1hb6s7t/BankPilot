import { describe, expect, it } from 'vitest';
import { g9Dataset } from '../evals/g9-holdout-fixtures';
import { validateSemanticIntent as frozenG9B } from '../evals/baselines/g9b-candidate-2026-10-24T05-26-36-092Z/source/packages/agents/src/semantic-intent';
import { validateSemanticIntent, type SemanticIntentDraft } from '../packages/agents/src/semantic-intent';

// G9B did not persist raw model scopes. These are hand-authored extractions of
// exposed source grammar, not reconstructions of its payload or score changes.
// The untouched frozen implementation establishes the concrete grammar gap.
type Task = SemanticIntentDraft['tasks'][number];
const e = (kind: 'payee' | 'card' | 'subscription', id: string, text: string) => ({ kind, id, mention: { text } });
const payment = (text: string, id: string, payee: string, amount: string, memo: string): Task => ({ operation: 'transfer', disposition: 'request', scope: { text }, entity: e('payee', id, payee), amount: { text: amount }, memo: { text: memo } });
const cases: { id: string; tasks: Task[]; operations: string[] }[] = [
  { id: 'g9-transfer-06', operations: ['bills_query', 'transfer'], tasks: [
    { operation: 'bills_query', disposition: 'query', scope: { text: '核对2026年9月的收支合计' }, period: { text: '2026年9月' } },
    payment('请给合住室友转137块2毛，备注“路由器分摊”', 'g9-payee-song', '合住室友', '137块2毛', '路由器分摊'),
  ] },
  { id: 'g9-investment-06', operations: ['investment_query', 'transfer'], tasks: [
    { operation: 'investment_query', disposition: 'query', scope: { text: '先展示一下我的理财持仓，不要赎回' } },
    payment('给梁若晴转68元5角，备注“材料垫付”，从现有现金安排。', 'g9-payee-liang', '梁若晴', '68元5角', '材料垫付'),
  ] },
  { id: 'g9-card-03', operations: ['card_query'], tasks: [
    { operation: 'card_query', disposition: 'query', scope: { source: 'whole_message' }, entity: e('card', 'g9-card-daily', '尾号6812') },
  ] },
  { id: 'g9-card-06', operations: ['card_query', 'bills_query'], tasks: [
    { operation: 'card_query', disposition: 'query', scope: { text: '查询我两张银行卡的现有状态' } },
    { operation: 'bills_query', disposition: 'query', scope: { text: '列一下2026年9月账单的收入和支出' }, period: { text: '2026年9月' } },
  ] },
  { id: 'g9-subscription-06', operations: ['subscription_cancel', 'subscription_block'], tasks: [
    { operation: 'subscription_cancel', disposition: 'request', scope: { text: '取消竹音听书的商户订阅' }, entity: e('subscription', 'g9-sub-audio', '竹音听书') },
    { operation: 'subscription_block', disposition: 'request', scope: { text: '对城市瑜伽只做银行扣款拦截，合约我自己处理' }, entity: e('subscription', 'g9-sub-yoga', '城市瑜伽') },
  ] },
];
describe('G9C exposed source grammar compared with the immutable G9B candidate', () => {
  it.each(cases)('$id closes its independently demonstrated grammar gap without changing known scores', sample => {
    const input = g9Dataset.cases.find(item => item.id === sample.id)!.input;
    const draft = { tasks: sample.tasks }, saved = structuredClone(draft);
    const before = frozenG9B(input, draft, { referenceDate: input.referenceDate });
    const after = validateSemanticIntent(input, draft, { referenceDate: input.referenceDate });
    expect(before.status).toBe('clarification'); expect(before.tasks).toEqual([]);
    expect({ status: after.status, findings: after.findings }).toEqual({ status: 'ready', findings: [] });
    expect(after.tasks.map(task => task.operation)).toEqual(sample.operations); expect(draft).toEqual(saved);
    for (const task of after.tasks) expect(input.message.slice(task.source.start, task.source.end)).toBe(task.source.text);
    for (const task of after.tasks.filter(task => task.operation === 'transfer')) expect(task.slots).toMatchObject({ amountMinor: sample.id === 'g9-transfer-06' ? '13720' : '6850', memo: sample.id === 'g9-transfer-06' ? '路由器分摊' : '材料垫付' });
  });
});
