import type { ManagementContext, SemanticTask } from '../../contracts/src/index';
import { resolveSubscription, type ManagementResolution } from './management';

/** Aggregate separately grounded independent requests; never silently keep only
 * tasks.find(role). Every member must resolve before any proposal is published.
 * Preparation/authorization/execution still happen separately for each spec. */
export function resolveSubscriptionBatch(tasks: SemanticTask[], context?: ManagementContext): ManagementResolution {
  const invalid = (clarification: string, evidence: ManagementResolution['evidence'] = []): ManagementResolution => ({
    managementSuggestions: [], summary: '订阅请求需要澄清，尚未生成操作。', clarification, evidence, findings: ['SUBSCRIPTION_BATCH_UNRESOLVED'],
  });
  if (tasks.length < 2 || tasks.length > 8 || tasks.some(task => task.role !== 'subscription' || !['subscription_cancel','subscription_block'].includes(task.operation) || !task.slots.entityId)
    || new Set(tasks.map(task => task.slots.entityId)).size !== tasks.length) return invalid('请为每项订阅操作分别指定不同且唯一的订阅；查询和同一订阅的连续变更需要分步办理。');
  const resolved = tasks.map(task => resolveSubscription(task.canonicalMessage, context));
  if (resolved.every(item => !item.clarification && item.managementSuggestions.length === 1 && item.managementSuggestions[0]!.kind === 'SUBSCRIPTION_QUERY')) return {
    managementSuggestions: [{ kind: 'SUBSCRIPTION_QUERY' }],
    summary: '需要先完成一次订阅查询确认，取得有效查询结果后再分别核对原请求中的取消或阻止操作；尚未取消商户合同或设置银行扣款限制。',
    evidence: [], findings: ['SUBSCRIPTION_QUERY_CONFIRMATION_REQUIRED'],
  };
  const evidence = [...new Map(resolved.flatMap(item => item.evidence).map(item => [`${item.source}\0${item.detail}`,item])).values()];
  for (const [index, item] of resolved.entries()) {
    const task = tasks[index]!, spec = item.managementSuggestions[0];
    const expectedKind = task.operation === 'subscription_cancel' ? 'SUBSCRIPTION_CANCEL' : 'SUBSCRIPTION_BLOCK';
    const known = context?.subscriptions?.items.filter(entry => entry.id === task.slots.entityId) ?? [];
    const alreadySatisfied = !item.clarification && !item.findings.length && item.managementSuggestions.length === 0 && known.length === 1
      && (expectedKind === 'SUBSCRIPTION_CANCEL' ? known[0]!.merchantStatus === 'CANCELLED' : known[0]!.bankStatus === 'BLOCKED');
    if (alreadySatisfied) continue;
    if (item.clarification || item.managementSuggestions.length !== 1 || spec?.kind !== expectedKind || !('subscriptionId' in spec) || spec.subscriptionId !== task.slots.entityId) {
      return invalid(item.clarification ?? '其中一项订阅操作与已核对对象或操作类型不一致，请分别明确。', evidence);
    }
  }
  return { managementSuggestions: resolved.flatMap(item => item.managementSuggestions),
    summary: resolved.map(item => item.summary).join(' '), evidence,
    findings: [...new Set(resolved.flatMap(item => item.findings))],
  };
}
