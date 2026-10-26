import { describe, expect, it } from 'vitest';
import { activeRoles, parseAmountMinor, resolveTransfer } from '../packages/agents/src/intent';
import { createPlanner, evaluationRoles } from '../packages/agents/src/index';
import type { PayeeView, Planner } from '../packages/contracts/src/index';

// Independent regression examples; no unseen G6 fixtures or expectation table.
const payees: PayeeView[] = [
  { id: 'language-zhou', name: '周景澄', bank: '合成甲银行', maskedNumber: '****4107', aliases: [] },
  { id: 'language-zhao-a', name: '赵清越', bank: '合成乙银行', maskedNumber: '****7635', aliases: [] },
  { id: 'language-zhao-b', name: '赵清越', bank: '合成丙银行', maskedNumber: '****2190', aliases: [] },
];

describe('G6 financial numeral language', () => {
  it.each([
    ['人民币壹仟零六元零八分', '100608'], ['貳萬參仟肆佰伍拾陸圓柒角捌分', '2345678'],
    ['玖元伍角陆分', '956'], ['零元捌分', '8'], ['壹佰元整', '10000'], ['壹亿零贰万叁仟零肆元零伍分', '10002300405'],
    ['120元零八分', '12008'], ['30元伍角陆分', '3056'], ['叁点零伍元', '305'],
    ['负壹仟元', undefined], ['−貳佰圆', undefined], ['零元零分', undefined],
    ['壹点贰叁肆元', undefined], ['壹点贰元伍角', undefined], ['1.20元叁分', undefined],
    ['壹佰12元', undefined], ['壹12元', undefined], ['1元12角', undefined], ['壹佰元十二分', undefined],
    ['1e3元', undefined], ['100元-5分', undefined], ['一百百元', undefined], ['一百点零零一元', undefined], ['壹點貳元', '120'], ['1万元', '1000000'], ['2萬元', '2000000'],
  ])('parses integer cents without dropping financial subunits: %s', (message, expected) => {
    expect(parseAmountMinor(message)).toBe(expected);
  });

  it('preserves Arabic 万 multiplier support at the transfer boundary', () => {
    expect(resolveTransfer('汇给周景澄1万元', payees).suggestion).toMatchObject({ amountMinor: '1000000' });
  });

  it('recognizes 汇给 before extracting the amount', () => {
    const message = '请汇给周景澄人民币壹仟零六元零八分';
    expect(activeRoles(message)).toEqual(['transfer']);
    expect(resolveTransfer(message, payees).suggestion).toMatchObject({ payeeId: 'language-zhou', amountMinor: '100608' });
  });

  it.each(['先不要汇给周景澄人民币壹仟元', '如何汇给周景澄壹仟元', '仅记录“汇给周景澄壹仟元”', '汇给周景澄壹仟元，先不要执行'])('preserves no-action safeguards for new verbs: %s', message => {
    expect(resolveTransfer(message, payees).suggestion).toBeUndefined();
  });
});

describe('G6 adjacent transfer metadata', () => {
  it.each([
    '转给赵清越，选尾号7635那张收款账户，金额92.40元',
    '转给赵清越,指定末四位7635账户,金额人民币玖拾贰元肆角',
    '转给赵清越，金额92.40元，尾号7635',
  ])('binds explicit metadata to the same action: %s', message => {
    expect(resolveTransfer(message, payees).suggestion).toMatchObject({ payeeId: 'language-zhao-a', amountMinor: '9240' });
  });

  it.each([
    '不要转给赵清越，选尾号7635那张收款账户，金额92.40元',
    '仅记录“转给赵清越”，尾号7635，金额92.40元',
    '转给赵清越；尾号7635，金额92.40元',
    '转给赵清越\n尾号7635，金额92.40元',
    '转给赵清越，查询账单，尾号7635，金额92.40元',
    '转给赵清越，尾号7635，金额92.40元，取消',
    '转给赵清越，尾号7635，尾号2190，金额92.40元',
    '转给周景澄，尾号7635，金额92.40元',
    '转给赵清越，尾号7635，金额92.40元，金额100元',
    '不要转给周景澄100元；转给赵清越，尾号7635',
    '转给赵清越，尾号7635，不要分析金额92.40元',
    '转给赵清越，尾号7635，金额三12元',
    '转给赵清越100元，尾号7635，然后撤回',
    '转给赵清越100元，尾号7635，不用了',
    '转给赵清越100元，尾号7635，但取消这笔操作',
  ])('fails closed for withdrawal, conflicting fields or foreign field scope: %s', message => {
    expect(resolveTransfer(message, payees).suggestion).toBeUndefined();
  });
});

describe('G6 domain routing language', () => {
  it.each([
    ['查询2026年9月的收入、支出和净额', ['bills']],
    ['请找出2026-10里达到大额提示条件的消费并给原交易编号', ['bills']],
    ['查看晴岚日常卡状态', ['card']],
    ['恢复尾号7736的远帆备用卡使用状态', ['card']],
    ['查看晴岚日常卡状态，并查一下我有哪些自动续费项目', ['card', 'subscription']],
    ['阻止云帆影音后续从银行卡扣款，但不要说商户合同取消了', ['subscription']],
    ['从银行卡里自动扣款的订阅有哪些', ['subscription']],
    ['看看2027年2月账单里有没有订阅扣款', ['bills']],
    ['查询上月账单中的自动续费记录', ['bills']],
    ['查看账单里标记为取消订阅的记录', ['bills']],
    ['上月账单中哪些属于订阅扣款', ['bills']],
    ['查看账单里标记为“取消订阅并阻止扣款”的记录', ['bills']],
    ['查看账单里的订阅扣款以及查询当前订阅', ['bills', 'subscription']],
    ['查询2月账单，并查看我当前有哪些订阅', ['bills', 'subscription']],
    ['查询2月账单里有没有订阅扣款，并取消云帆影音订阅', ['bills', 'subscription']],
    ['查看2月账单并阻止云帆影音后续从银行卡扣款', ['bills', 'subscription']],
    ['请取消账单里提到的云帆影音订阅', ['bills', 'subscription']],
    ['阻止账单里记录的云帆影音后续扣款', ['bills', 'subscription']],
    ['阻止云帆影音后续从银行卡扣款，并查询晴岚日常卡状态', ['card', 'subscription']],
    ['阻止云帆影音后续从银行卡扣款，并挂失银行卡', ['card', 'subscription']],
  ])('activates requested domains: %s', (message, expected) => expect(activeRoles(message as string)).toEqual(expected));
});


describe('historical bill scope remains read-only with a live subscription snapshot', () => {
  const input = (message: string): Parameters<Planner['plan']>[0] => ({
    taskId: 'historical-subscription-scope', message, accounts: [], payees: [],
    managementContext: { cards: [], subscriptions: {
      queryActionId: 'history-existing-grant', queriedAt: '2026-10-23T00:00:00Z', accessExpiresAt: '2100-01-01T00:00:00Z',
      items: [{ id: 'history-subscription', merchant: '星海视频', amountMinor: '2500', currency: 'CNY', nextChargeDate: '2026-11-01', cardId: 'history-card', merchantStatus: 'ACTIVE', bankStatus: 'ALLOWED', collectionStatus: 'ENABLED', version: 4, cancellationSupported: true, source: 'SYNTHETIC_MERCHANT' }],
    } },
  });

  it.each([
    '看看2027年2月账单里有没有订阅扣款',
    '查看账单里标记为取消星海视频订阅的记录',
    '账单记载取消星海视频订阅',
    '统计账单中标记为取消星海视频订阅的记录',
  ])('does not reintroduce a subscription request through the merchant fallback: %s', async message => {
    expect(evaluationRoles(input(message))).toEqual(['bills']);
    const result = await createPlanner({ provider: false }).plan(input(message));
    expect(result.managementSuggestions).toEqual([]);
    expect(result.events.some(event => event.role === 'subscription')).toBe(false);
  });

  it.each([
    '统计账单中标记为取消星海视频订阅的记录，查询订阅',
    '账单记载取消星海视频订阅，并查询当前订阅',
    '查看账单里标记为“取消星海视频订阅并阻止扣款”的记录，以及查看我当前有哪些订阅',
  ])('isolates a live query from historical cancellation wording: %s', async message => {
    const result = await createPlanner({ provider: false }).plan(input(message));
    expect(result.managementSuggestions).toEqual([{ kind: 'SUBSCRIPTION_QUERY' }]);
  });
});
