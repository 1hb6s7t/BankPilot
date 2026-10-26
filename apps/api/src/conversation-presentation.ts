import type { ConversationEnvelope } from '../../../packages/contracts/src/conversations.js';

const billUnavailable = '这条历史账单结果暂时无法核对，请查看原请求状态。';
const billUnverified = '账单结论尚未通过核对，未作为本次查询答案。请核对查询月份、商户或筛选条件后，完整重述查询请求。';
const billReasons: Record<string, string> = {
  BILL_DOMAIN_ASSESSMENT_REJECTED: billUnverified,
  BILL_ANSWER_REVIEW_REJECTED: billUnverified,
  BILL_DOMAIN_QUERY_SCOPE_MISMATCH: '本次账单结果的查询范围尚未核对一致。',
  BILL_QUERY_SCOPE_MISMATCH: '本次账单结果的查询范围尚未核对一致。',
  'BILL_DOMAIN_CONCERN:period_mismatch': '账单期间尚未核对一致。',
  'BILL_DOMAIN_CONCERN:filter_mismatch': '账单筛选条件尚未核对一致。',
  'BILL_DOMAIN_CONCERN:statistic_mismatch': '账单统计口径尚未核对一致。',
  'BILL_DOMAIN_CONCERN:evidence_mismatch': '账单流水依据尚未核对一致。',
  'BILL_DOMAIN_CONCERN:unresolved_query': '账单查询范围仍需进一步核对。',
  'BILL_DOMAIN_CONCERN:additional_review_required': '账单结果还需进一步核对。',
  BILL_QUERY_UNSUPPORTED: '本次账单查询包含暂不支持的条件，请查看查询说明。',
  BILL_DATA_PARTIAL: '账单仅有部分流水，金额只对应已提供的数据。',
  BILL_SCOPE_DATA_MISSING: '本次查询所需的账单数据尚未提供，未按零消费处理。',
  BILL_REVIEW_STATUS_COMPLETE: '本次查询所需的账单资料已提供。',
  BILL_REVIEW_STATUS_PARTIAL: '本次查询仅有部分账单资料。',
  BILL_REVIEW_STATUS_MISSING_DATA: '本次查询缺少账单资料。',
  BILL_REVIEW_STATUS_UNSUPPORTED: '本次账单查询条件仍需明确。',
};
// Classify an entire structured diagnostic finding, never replace substrings in
// a merchant, an original user message, or a genuine business finding.
const isBillCode = (text: string) => Object.hasOwn(billReasons, text)
  || /^BILL_[A-Z0-9_]+$/.test(text) || text.startsWith('BILL_DOMAIN_CONCERN:');
const findingText = (text: string) => isBillCode(text) ? billReasons[text] ?? '账单信息还需进一步核对，请查看查询说明。' : text;
const unique = (parts: (string | undefined)[]) => [...new Set(parts.filter((part): part is string => typeof part === 'string' && !!part.trim()))];

/** Only an explicit withheld outcome taints its free answer prose. Do not
 * reinterpret another business or change any stored result, action or decision.
 * The original envelope remains the audit record; this is a read projection. */
export function projectConversationResult(envelope: ConversationEnvelope): ConversationEnvelope {
  if (envelope.billAnswerReview?.status !== 'withheld') return envelope;
  const { billReport: _report, billReports: _reports, billAnalysis: _analysis, ...rest } = envelope;
  return { ...rest, summary: billUnverified, clarification: billUnverified,
    billAnswerReview: { status: 'withheld', message: billUnverified },
    // Historical free event prose/evidence cannot establish that rejected bill
    // facts were removed. Typed business actions/statuses and funds stay intact.
    evidence: [], events: envelope.events.map(event => ({ ...event, summary:
      event.role === 'bills' ? billUnverified : event.role === 'reviewer'
        ? '本次账单答案尚未通过核对，其他操作状态请查看对应详情。'
        : event.status === 'completed' ? '本领域核对已返回，请查看对应操作状态。' : '本领域核对正在处理。' })),
  };
}

/** User text only. Audit findings, diagnostics, facts and the original envelope
 * are never modified; this function does not authorize or evaluate a result. */
export function formatConversationResultText(envelope: ConversationEnvelope, options: { historical?: boolean } = {}): string {
  const projected = projectConversationResult(envelope);
  const withheld = projected.billAnswerReview?.status === 'withheld';
  const parts = withheld ? unique([
    projected.billAnswerReview!.message,
    ...projected.findings.filter(text => isBillCode(text) && !['BILL_DOMAIN_ASSESSMENT_REJECTED', 'BILL_ANSWER_REVIEW_REJECTED'].includes(text)).map(findingText),
    ...(projected.fundsPreview?.reasons ?? []),
  ]) : unique([projected.summary, projected.clarification, ...projected.findings.map(findingText)]);
  const count = (projected.actions?.length ?? 0) + (projected.managementActions?.length ?? 0) + (projected.investmentActions?.length ?? 0);
  if (count) parts.push(withheld || options.historical ? `服务端已生成 ${count} 个动作，具体状态以动作详情为准；生成不等于执行。` : `服务端生成了 ${count} 个待审阅动作，请检查风险等级后再授权。`);
  else if (projected.suggestions.length) parts.push(`规划器返回 ${projected.suggestions.length} 条转账建议；当前响应没有可确认的动作。`);
  return parts.join('\n\n') || '规划请求已返回。';
}

type StoredMessage = { user_id: string; conversation_id: string; command_id?: string | null; role: string; kind: string; text: string };
type StoredCommand = { user_id: string; conversation_id: string; command_id: string; status: string; result?: unknown };
export function isConversationPresentationEnvelope(value: unknown): value is ConversationEnvelope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as ConversationEnvelope;
  return typeof v.summary === 'string' && Array.isArray(v.findings) && v.findings.every(item => typeof item === 'string')
    && Array.isArray(v.suggestions) && Array.isArray(v.events) && v.events.every(item => item && typeof item.role === 'string' && typeof item.status === 'string' && typeof item.summary === 'string')
    && [v.actions, v.managementActions, v.investmentActions].every(items => items === undefined || Array.isArray(items))
    && (v.clarification === undefined || typeof v.clarification === 'string')
    && (v.billAnswerReview === undefined || v.billAnswerReview && ['withheld', 'diagnostic'].includes(v.billAnswerReview.status) && typeof v.billAnswerReview.message === 'string')
    && (v.fundsPreview === undefined || v.fundsPreview && Array.isArray(v.fundsPreview.reasons) && v.fundsPreview.reasons.every(item => typeof item === 'string'));
}

/** Read-only projection of already stored assistant results. The caller supplies
 * its existing owner-scoped batch, never another command or a fresh plan. */
export function presentStoredResultText(message: StoredMessage, command: StoredCommand | undefined, userId: string): string {
  if (message.role !== 'assistant' || message.kind !== 'result') return message.text;
  const bound = message.user_id === userId && command?.user_id === userId && message.conversation_id === command.conversation_id
    && !!message.command_id && message.command_id === command.command_id && command.status === 'complete';
  const result = bound && isConversationPresentationEnvelope(command.result) ? command.result : undefined;
  const legacyBillText = message.text.split(/\r?\n/).some(line => isBillCode(line.trim()));
  const billResult = result?.billAnswerReview !== undefined || result?.findings.some(isBillCode);
  if (!legacyBillText && !billResult) return message.text;
  return result ? formatConversationResultText(result, { historical: true }) : billUnavailable;
}
