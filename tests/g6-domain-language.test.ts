import { describe, expect, it } from 'vitest';
import { resolveInvestment, resolveLifeGoal, resolveCard, resolveSubscription } from '../packages/agents/src/index';
import type { InvestmentDashboard, ManagementContext, Planner } from '../packages/contracts/src/index';

// Focused language regressions, independent of the frozen evaluation fixtures.
const investments: InvestmentDashboard = {
  businessDate: '2026-10-23', calendar: 'DEMO_WEEKDAYS_V1', products: [], actions: [],
  positions: [
    { id: 'language-cash', productId: 'language-product-cash', productName: '澄明现金增强 T+0', accountId: 'language-account', principalMinor: '750000', availableMinor: '750000', reservedMinor: '0', version: 3, redemptionBusinessDays: 0, calendar: 'DEMO_WEEKDAYS_V1' },
    { id: 'language-steady', productId: 'language-product-steady', productName: '远岫稳健组合 T+2', accountId: 'language-account', principalMinor: '1200000', availableMinor: '1200000', reservedMinor: '0', version: 6, redemptionBusinessDays: 2, calendar: 'DEMO_WEEKDAYS_V1' },
  ],
};
const management: ManagementContext = { cards: [
  { id: 'language-card', accountId: 'language-account', name: '远帆备用卡', maskedNumber: '****7736', status: 'LOST', version: 8, updatedAt: '2026-10-23T00:00:00Z' },
] };
const goalInput = (message: string): Parameters<Planner['plan']>[0] => ({ taskId: 'language-goal', message,
  accounts: [{ id: 'language-account', name: '测试账户', maskedNumber: '****9918', balanceMinor: '900000', reservedMinor: '0', currency: 'CNY' }],
  payees: [{ id: 'language-payee', name: '周景澄', aliases: [], bank: '测试银行', maskedNumber: '****2086' }], investmentContext: investments,
});

describe('G6 investment language and authoritative aliases', () => {
  it.each(['列出我当前持有的理财产品与可赎回金额', '查一下当前持仓的可赎回金额', '有哪些理财产品可以赎回？'])('keeps a read-only request free of needless redemption clarification: %s', message => {
    const result = resolveInvestment(message, investments);
    expect(result.investmentSuggestions).toEqual([]); expect(result.clarification).toBeUndefined();
    expect(result.evidence).toHaveLength(2);
  });
  it.each([
    ['赎回澄明现金增强壹佰贰拾陆元柒角伍分', 'language-cash', '12675', 3],
    ['赎回澄明现金增强壹佰貳拾陸圓柒角伍分', 'language-cash', '12675', 3],
    ['赎回澄明现金增强0.1万元', 'language-cash', '100000', 3],
    ['赎回澄明现金增强产品126.75元', 'language-cash', '12675', 3],
    ['从远岫稳健组合赎回860.25元', 'language-steady', '86025', 6],
    ['赎回澄明现金增强 T+0产品126.75元', 'language-cash', '12675', 3],
  ] as const)('resolves a unique authoritative alias: %s', (message, positionId, amountMinor, expectedVersion) => {
    const result = resolveInvestment(message, investments);
    expect(result.investmentSuggestions).toEqual([{ positionId, amountMinor, expectedVersion }]);
    expect(result.summary).toContain('未授权、未执行'); expect(result.clarification).toBeUndefined();
  });
  it.each(['赎回澄明现金增强壹佰元或贰佰元', '赎回澄明现金增强壹佰圓或貳佰圓', '赎回澄明现金增强壹佰或贰佰元', '赎回澄明现金增强产品100元，先不要做', '赎回澄明现金增强一百12元', '赎回澄明现金增强12百元', '赎回未知稳健产品100元', '赎回未知稳健产品T+0 100元', '赎回远岫稳健组合升级版100元', '赎回远岫稳健组合T+0产品100元', '不要赎回远岫稳健组合100元', '赎回远岫稳健组合100元这件事先不要做'])('does not propose unknown, conflicting, or retracted requests: %s', message => {
    expect(resolveInvestment(message, investments).investmentSuggestions).toEqual([]);
  });
  it('rejects duplicate and overlapping aliases irrespective of array ordering', () => {
    for (const name of ['澄明现金增强 T+2', '澄明现金 T+2']) {
      const positions = [investments.positions[0]!, { ...investments.positions[1]!, productName: name }];
      for (const ordered of [positions, [...positions].reverse()]) {
        const result = resolveInvestment('赎回澄明现金增强产品126.75元', { ...investments, positions: ordered });
        expect(result.investmentSuggestions).toEqual([]); expect(result.clarification).toContain('唯一');
      }
    }
  });
  it('rejects multiple uppercase target amounts', () => {
    expect(resolveLifeGoal(goalInput('建立周景澄生日目标：2026-11-20前准备壹佰元或贰佰元')).goalSuggestion).toBeUndefined();
  });
  it('uses the same alias for goal funding without generating immediate redemption', () => {
    const input = goalInput('建立周景澄生日目标：2026-11-20前准备600.75元，资金先从远岫稳健组合赎回650.50元');
    expect(resolveLifeGoal(input).goalSuggestion).toEqual({ title: '周景澄生日目标', accountId: 'language-account', payeeId: 'language-payee', amountMinor: '60075', targetDate: '2026-11-20', funding: { positionId: 'language-steady', redemptionAmountMinor: '65050' } });
    expect(resolveInvestment(input.message, investments).investmentSuggestions).toEqual([]);
  });
});

describe('G6 card restore and recurring subscription language', () => {
  it('prepares restore with the card identity and version, without execution', () => {
    const result = resolveCard('恢复尾号7736的远帆备用卡使用状态', management);
    expect(result.managementSuggestions).toEqual([{ kind: 'CARD_UNREPORT_LOST', cardId: 'language-card', expectedVersion: 8 }]);
    expect(result.summary).toContain('尚未执行');
    expect(management.cards[0]!.status).toBe('LOST');
  });
  it.each(['恢复尾号7736的远帆备用卡使用状态，先不要做', '查询恢复尾号7736的远帆备用卡使用状态', '如何恢复尾号7736的远帆备用卡使用状态', '不要恢复尾号7736的远帆备用卡使用状态', '恢复尾号7736的远帆备用卡使用状态这件事先不要做', '恢复尾号7736的未知卡使用状态', '恢复尾号0000的远帆备用卡使用状态'])('keeps queries, negations and unknown targets from restoring cards: %s', message => {
    expect(resolveCard(message, management).managementSuggestions).toEqual([]);
  });
  it.each(['查一下我有哪些自动续费项目', '列出自动续费项目'])('requires confirmation before querying recurring payments: %s', message => {
    const result = resolveSubscription(message, management);
    expect(result.managementSuggestions).toEqual([{ kind: 'SUBSCRIPTION_QUERY' }]);
    expect(result.summary).toContain('黄色确认'); expect(result.summary).toContain('当前未查询');
  });
  it('does not promote a negated recurring-payment query', () => {
    expect(resolveSubscription('不要查询自动续费项目', management).managementSuggestions).toEqual([]);
  });
});


describe('historical subscription evidence cannot become a current operation', () => {
  const context: ManagementContext = { ...management, subscriptions: {
    queryActionId: 'language-query-grant', queriedAt: '2026-10-23T00:00:00Z', accessExpiresAt: '2100-01-01T00:00:00Z',
    items: [{ id: 'language-sub', merchant: '星海视频', amountMinor: '2500', currency: 'CNY', nextChargeDate: '2026-11-01', cardId: 'language-card', merchantStatus: 'ACTIVE', bankStatus: 'ALLOWED', collectionStatus: 'ENABLED', version: 4, cancellationSupported: true, source: 'SYNTHETIC_MERCHANT' }],
  } };
  it.each([
    '账单记载取消星海视频订阅，查询订阅',
    '统计账单中标记为取消星海视频订阅的记录，查询订阅',
    '查看账单里标记为取消星海视频订阅的记录，同时查看当前自动续费项目',
  ])('keeps only an independently requested current query: %s', message => {
    const result = resolveSubscription(message, context);
    expect(result.managementSuggestions).toEqual([{ kind: 'SUBSCRIPTION_QUERY' }]);
    expect(result.summary).toContain('黄色确认');
  });
  it.each(['查看账单里标记为取消星海视频订阅的记录', '统计账单中标记为取消星海视频订阅的记录', '账单记载取消星海视频订阅'])('does not initiate a query or cancellation from historical evidence: %s', message => {
    expect(resolveSubscription(message, context).managementSuggestions).toEqual([]);
    expect(resolveSubscription(message, management).managementSuggestions).toEqual([]);
  });
  it('retains a separate explicit cancellation with authoritative grant binding', () => {
    const result = resolveSubscription('查看账单里的订阅扣款，然后取消星海视频订阅', context);
    expect(result.managementSuggestions).toEqual([{ kind: 'SUBSCRIPTION_CANCEL', subscriptionId: 'language-sub', expectedVersion: 4, queryActionId: 'language-query-grant' }]);
    expect(result.summary).toContain('未执行');
  });
});
