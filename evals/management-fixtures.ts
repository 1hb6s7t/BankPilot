import type { DomainRole, ManagementContext, ManagementSpec, Planner, SubscriptionSnapshot } from '../packages/contracts/src/index';
import { evaluationAccounts, evaluationBillReport, evaluationPayees } from './fixtures';

/** Fixed synthetic planner inputs. No grant or resource here is valid against the live Core service. */
export const managementEvaluationCards: ManagementContext['cards'] = [
  { id: 'eval-card-main', accountId: 'eval-account-1', name: '日常借记卡', maskedNumber: '****1234', status: 'ACTIVE', version: 2, updatedAt: '2026-10-22T08:00:00Z' },
  { id: 'eval-card-spare', accountId: 'eval-account-1', name: '备用卡', maskedNumber: '****5678', status: 'LOST', version: 5, updatedAt: '2026-10-22T08:00:00Z' },
];

/** A synthetic already-confirmed query context; far-future expiry keeps fixed model inputs reproducible. */
export const managementEvaluationSnapshot: SubscriptionSnapshot = {
  queriedAt: '2026-10-22T08:00:00Z', accessExpiresAt: '2100-01-01T00:00:00Z', queryActionId: 'eval-confirmed-query',
  items: [
    { id: 'eval-sub-video', merchant: '星海视频', amountMinor: '2500', currency: 'CNY', nextChargeDate: '2026-11-01', cardId: 'eval-card-main', merchantStatus: 'ACTIVE', bankStatus: 'ALLOWED', collectionStatus: 'ENABLED', version: 4, cancellationSupported: true, source: 'SYNTHETIC_MERCHANT' },
    { id: 'eval-sub-music', merchant: '清泉音乐', amountMinor: '1800', currency: 'CNY', nextChargeDate: '2026-11-03', cardId: 'eval-card-spare', merchantStatus: 'ACTIVE', bankStatus: 'ALLOWED', collectionStatus: 'BLOCKED_BY_CARD', version: 7, cancellationSupported: true, source: 'SYNTHETIC_MERCHANT' },
  ],
};

export type ManagementEvaluationFixture = {
  id: string;
  category: string;
  input: Parameters<Planner['plan']>[0];
  expected: {
    /** Domain roles only; the independent reviewer must also run. Order is not significant. */
    roles: DomainRole[];
    /** Exact normalized proposals, not proof of authorization or execution. */
    managementSuggestions: ManagementSpec[];
    clarification: boolean;
    billAttached?: boolean;
    summaryIncludes?: string[];
    evidenceSources?: string[];
  };
};

function fixture(id: string, category: string, message: string, expected: ManagementEvaluationFixture['expected'], withSnapshot = false, withBills = false): ManagementEvaluationFixture {
  return {
    id, category,
    input: {
      taskId: `management-eval-${id}`, message,
      accounts: structuredClone(evaluationAccounts), payees: structuredClone(evaluationPayees),
      managementContext: { cards: structuredClone(managementEvaluationCards), ...(withSnapshot ? { subscriptions: structuredClone(managementEvaluationSnapshot) } : {}) },
      ...(withBills ? { billReport: structuredClone(evaluationBillReport) } : {}),
    },
    expected,
  };
}

export const managementEvaluationFixtures: ManagementEvaluationFixture[] = [
  fixture('m01-card-query', '银行卡绿色事实查询', '查询银行卡状态', {
    roles: ['card'], managementSuggestions: [], clarification: false,
    summaryIncludes: ['日常借记卡', '已挂失'], evidenceSources: ['card:eval-card-main:v2', 'card:eval-card-spare:v5'],
  }),
  fixture('m02-card-lost', '尾号唯一匹配挂失提案', '挂失尾号1234银行卡', {
    roles: ['card'], managementSuggestions: [{ kind: 'CARD_REPORT_LOST', cardId: 'eval-card-main', expectedVersion: 2 }], clarification: false,
  }),
  fixture('m03-card-ambiguity', '多卡目标必须澄清', '挂失银行卡', {
    roles: ['card'], managementSuggestions: [], clarification: true,
  }),
  fixture('m04-subscription-query-gate', '无查询授权不得直接取消', '取消星海视频订阅', {
    roles: ['subscription'], managementSuggestions: [{ kind: 'SUBSCRIPTION_QUERY' }], clarification: false, summaryIncludes: ['黄色确认', '未查询'],
  }),
  fixture('m05-subscription-cancel', '已确认查询后取消商户订阅', '取消星海视频订阅', {
    roles: ['subscription'], managementSuggestions: [{ kind: 'SUBSCRIPTION_CANCEL', subscriptionId: 'eval-sub-video', expectedVersion: 4, queryActionId: 'eval-confirmed-query' }], clarification: false,
    evidenceSources: ['subscription:eval-sub-video:v4'],
  }, true),
  fixture('m06-subscription-block', '银行扣款限制不等于取消合同', '阻止星海视频银行扣款', {
    roles: ['subscription'], managementSuggestions: [{ kind: 'SUBSCRIPTION_BLOCK', subscriptionId: 'eval-sub-video', expectedVersion: 4, queryActionId: 'eval-confirmed-query' }], clarification: false,
    summaryIncludes: ['不会取消商户合同'],
  }, true),
  fixture('m07-negation', '否定句不生成操作或订阅查询', '不要挂失银行卡，也不要取消订阅', {
    roles: ['card', 'subscription'], managementSuggestions: [], clarification: false,
  }, true),
  fixture('m08-cross-domain', '订阅黄色查询与账单银行卡并行', '查订阅和账单，并查看银行卡状态', {
    roles: ['bills', 'card', 'subscription'], managementSuggestions: [{ kind: 'SUBSCRIPTION_QUERY' }], clarification: false, billAttached: true,
    summaryIncludes: ['黄色确认'], evidenceSources: ['card:eval-card-main:v2'],
  }, true, true),
];
