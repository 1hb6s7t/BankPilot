import type { GoalDraft, InvestmentDashboard, RedemptionSpec } from '../packages/contracts/src/index';
import { evaluationAccounts, evaluationPayees, evaluationFunds, type EvaluationFixture } from './fixtures';

/** Frozen synthetic inputs; these identifiers cannot address the running bank sandbox. */
export const phase4InvestmentContext: InvestmentDashboard = {
  businessDate: '2026-10-22', calendar: 'DEMO_WEEKDAYS_V1', actions: [],
  products: [
    { id: 'eval-product-t0', name: '合成即时赎回产品 T+0', redemptionBusinessDays: 0, calendar: 'DEMO_WEEKDAYS_V1', description: '合成固定面值，零费用，工作日即时到账。' },
    { id: 'eval-product-t2', name: '合成延时赎回产品 T+2', redemptionBusinessDays: 2, calendar: 'DEMO_WEEKDAYS_V1', description: '合成固定面值，两个工作日到账，非真实节假日日历。' },
  ],
  positions: [
    { id: 'eval-position-t0', accountId: 'eval-account-1', productId: 'eval-product-t0', productName: '合成即时赎回产品 T+0', principalMinor: '500000', reservedMinor: '0', availableMinor: '500000', version: 3, redemptionBusinessDays: 0, calendar: 'DEMO_WEEKDAYS_V1' },
    { id: 'eval-position-t2', accountId: 'eval-account-1', productId: 'eval-product-t2', productName: '合成延时赎回产品 T+2', principalMinor: '1000000', reservedMinor: '50000', availableMinor: '950000', version: 7, redemptionBusinessDays: 2, calendar: 'DEMO_WEEKDAYS_V1' },
  ],
};
export type Phase4EvaluationFixture = EvaluationFixture & { expected: EvaluationFixture['expected'] & {
  investmentSuggestions: RedemptionSpec[]; goalSuggestion?: GoalDraft;
} };
const goal: GoalDraft = { title: '林晓生日目标', accountId: 'eval-account-1', payeeId: 'payee-lin', amountMinor: '30000', targetDate: '2026-10-30' };
function fixture(id: string, category: string, message: string, expected: Phase4EvaluationFixture['expected']): Phase4EvaluationFixture {
  return { id, category, input: { taskId: `phase4-${id}`, message, accounts: structuredClone(evaluationAccounts), payees: structuredClone(evaluationPayees), investmentContext: structuredClone(phase4InvestmentContext), ...(expected.roles.includes('goal') ? { fundsPreview: evaluationFunds('0') } : {}) }, expected };
}
export const phase4EvaluationFixtures: Phase4EvaluationFixture[] = [
  fixture('p01-position-query', '持仓事实查询', '查询理财持仓', { roles: ['investment'], investmentSuggestions: [], clarification: false }),
  fixture('p02-redemption-decimal', '小数金额与持仓版本绑定', '赎回T+0理财300.25元', { roles: ['investment'], investmentSuggestions: [{ positionId: 'eval-position-t0', amountMinor: '30025', expectedVersion: 3 }], clarification: false }),
  fixture('p03-product-ambiguity', '多个持仓必须明确产品', '赎回理财300元', { roles: ['investment'], investmentSuggestions: [], clarification: true }),
  fixture('p04-negation', '否定不得生成资金动作', '不要赎回T+0理财300元', { roles: ['investment'], investmentSuggestions: [], clarification: false }),
  fixture('p05-birthday', '截止日目标无立即付款', '生日目标：2026-10-30前给林晓转账300元', { roles: ['goal'], investmentSuggestions: [], goalSuggestion: goal, clarification: false }),
  fixture('p06-funded-birthday', '并行理财查证与目标依赖提案', '为林晓建立生日目标，2026-10-30前给林晓转账300元，先赎回T+0理财300元', { roles: ['investment', 'goal'], investmentSuggestions: [], goalSuggestion: { ...goal, funding: { positionId: 'eval-position-t0', redemptionAmountMinor: '30000' } }, clarification: false }),
  fixture('p07-missing-date', '缺截止日不退化为立即转账', '为林晓建立生日目标，给林晓转账300元', { roles: ['goal'], investmentSuggestions: [], clarification: true }),
  fixture('p08-goal-payee-ambiguity', '目标同名收款人需澄清', '生日目标：2026-10-30前给张伟转账300元', { roles: ['goal'], investmentSuggestions: [], clarification: true }),
];
