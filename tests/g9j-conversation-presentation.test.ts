import { describe, expect, it } from 'vitest';
import type { ConversationEnvelope } from '../packages/contracts/src/conversations';
import { formatConversationResultText, presentStoredResultText, projectConversationResult } from '../apps/api/src/conversation-presentation';

const safe = '账单结论尚未通过核对，未作为本次查询答案。请核对查询月份、商户或筛选条件后，完整重述查询请求。';
const secret = 'HIDDEN商户扣款998877.66元/row-private';
function result(): ConversationEnvelope {
  return { taskId: 'g9j-presentation', planVersion: 1, mode: 'model', summary: secret, clarification: secret,
    events: [
      { role: 'bills', status: 'completed', at: '2026-10-25T00:00:00Z', summary: secret },
      { role: 'card', status: 'completed', at: '2026-10-25T00:00:00Z', summary: secret },
      { role: 'reviewer', status: 'completed', at: '2026-10-25T00:00:00Z', summary: secret },
    ], suggestions: [], evidence: [{ source: 'model-explanation:card', detail: secret }],
    findings: ['BILL_DOMAIN_ASSESSMENT_REJECTED', 'BILL_DOMAIN_CONCERN:evidence_mismatch', 'BILL_ANSWER_REVIEW_REJECTED'],
    diagnostics: { domains: [{ role: 'bills', hasSuggestion: false, hasClarification: false, status: 'rejected' }], review: { rawApproved: true, effectiveApproved: false, summary: '未作为答案展示' } },
    billAnswerReview: { status: 'withheld', message: safe } };
}
const row = (text = '旧摘要\n\nBILL_DOMAIN_ASSESSMENT_REJECTED\n\nBILL_DOMAIN_CONCERN:evidence_mismatch') => ({ user_id: 'owner', conversation_id: 'chat', command_id: 'command', role: 'assistant', kind: 'result', text });
const command = (value: unknown = result()) => ({ user_id: 'owner', conversation_id: 'chat', command_id: 'command', status: 'complete', result: value });
const visible = (value: ConversationEnvelope) => [value.summary, value.clarification, value.billAnswerReview?.message, ...value.events.map(e => e.summary)].join('\n');

describe('G9J bill refusal user presentation, pure', () => {
  it('explains the refusal once without diagnostic codes or hidden facts and retains the complete audit record', () => {
    const original = result(), before = structuredClone(original);
    const text = formatConversationResultText(original), projected = projectConversationResult(original);
    expect(text).toContain(safe); expect(text.split(safe)).toHaveLength(2);
    expect(text).toContain('账单流水依据尚未核对一致'); expect(text).not.toMatch(/BILL_|HIDDEN|998877|row-private/);
    expect(visible(projected)).not.toMatch(/BILL_|HIDDEN|998877|row-private/); expect(projected.evidence).toEqual([]);
    expect(projected.findings).toEqual(original.findings); expect(projected.diagnostics).toEqual(original.diagnostics);
    expect(projected.billAnswerReview?.status).toBe('withheld'); expect(original).toEqual(before);
  });
  it.each(['period_mismatch', 'filter_mismatch', 'statistic_mismatch', 'evidence_mismatch', 'unresolved_query', 'additional_review_required'])('uses finite wording for concern %s', concern => {
    const value = result(); value.findings = [`BILL_DOMAIN_CONCERN:${concern}`];
    expect(formatConversationResultText(value)).not.toMatch(/BILL_|HIDDEN/);
    expect(formatConversationResultText(value).length).toBeGreaterThan(safe.length);
  });
  it('does not turn scope misalignment into a claim that the user entered the wrong query', () => {
    const value = result(); value.findings = ['BILL_DOMAIN_QUERY_SCOPE_MISMATCH', 'BILL_QUERY_SCOPE_MISMATCH'];
    const text = formatConversationResultText(value); expect(text).toContain('查询范围尚未核对一致');
    expect(text).not.toMatch(/输入错误|你.*错|月份错误|BILL_/);
    expect(text.match(/查询范围尚未核对一致/g)).toHaveLength(1);
  });
  it('does not display unknown concern payload or arbitrary legacy findings as rejected bill facts', () => {
    const value = result(); value.findings.push(`BILL_DOMAIN_CONCERN:future_${secret}`, secret);
    expect(formatConversationResultText(value)).not.toContain(secret); expect(formatConversationResultText(value)).not.toContain('future_');
    expect(projectConversationResult(value).findings).toEqual(value.findings);
  });
  it('never republishes legacy bill attachments even when an explicit withheld envelope still contains them', () => {
    const value = Object.assign(result(), { billReport: { secret }, billReports: [{ secret }], billAnalysis: { secret } }) as ConversationEnvelope;
    const p = projectConversationResult(value);
    expect(p.billReport).toBeUndefined(); expect(p.billReports).toBeUndefined(); expect(p.billAnalysis).toBeUndefined();
    expect(JSON.stringify(value)).toContain(secret);
  });
  it.each(['SUCCEEDED', 'CANCELLED', 'FAILED', 'AWAITING_CONFIRMATION'])('preserves action %s without falsely saying it awaits authorization', status => {
    const value = result(); value.actions = [{ id: 'a', status }]; value.managementActions = [{ id: 'm', status }];
    const p = projectConversationResult(value), text = formatConversationResultText(value);
    expect(p.actions).toEqual(value.actions); expect(p.managementActions).toEqual(value.managementActions);
    expect(text).toContain('具体状态以动作详情为准'); expect(text).not.toMatch(/待审阅动作|请.*再授权|已执行成功|已取消/);
  });
  it('retains funds protection reasons and typed decisions, without rebuilding any source facts', () => {
    const value = result(); value.fundsPreview = { reasons: ['需保留生活费'], allowed: false } as ConversationEnvelope['fundsPreview'];
    const p = projectConversationResult(value); expect(p.fundsPreview).toEqual(value.fundsPreview);
    expect(formatConversationResultText(value)).toContain('需保留生活费'); expect(p.suggestions).toEqual([]);
  });
  it.each(['partial', 'missing_data', 'unsupported'] as const)('leaves honest %s data, clarification and real business findings intact', status => {
    const value = result(); delete value.billAnswerReview; value.summary = '该查询的真实说明'; value.clarification = '请提供所需账单';
    value.billAnalysis = { status, kind: 'summary', periods: ['2026-07'], missingPeriods: ['2026-07'], transactionIds: [], summary: value.summary, findings: [], evidence: [] };
    value.findings = ['同日同商户同金额，可能重复，尚未证实。 [row-1,row-2]', 'BILL_DATA_PARTIAL'];
    expect(projectConversationResult(value)).toBe(value);
    const text = formatConversationResultText(value); expect(text).toContain(value.summary); expect(text).toContain(value.clarification!); expect(text).toContain(value.findings[0]!); expect(text).not.toContain('BILL_DATA_PARTIAL');
  });
  it('does not rewrite uppercase business prose, merchant words or ordinary card results', () => {
    const value = result(); delete value.billAnswerReview; value.summary = 'CARD_STORE商户金额已按流水核对'; value.clarification = undefined;
    value.findings = ['商户BILL_DOMAIN_BOOKS的消费按原流水保留', '建议核对账单（NOT_CONFIRMED），尚未证实', 'BILL_STORE: 与上月金额相同，尚未确认周期费用。 [row-1,row-2]'];
    const text = formatConversationResultText(value); expect(text).toContain(value.summary); for (const finding of value.findings) expect(text).toContain(finding);
    expect(projectConversationResult(value)).toBe(value);
  });
  it('reconstructs only a bound complete assistant result, without modifying message or result storage', () => {
    const m = row(), c = command(), before = structuredClone({ m, c });
    const text = presentStoredResultText(m, c, 'owner'); expect(text).toContain(safe); expect(text).not.toMatch(/BILL_|HIDDEN/);
    expect({ m, c }).toEqual(before);
  });
  it.each(['user', 'conversation', 'command', 'status', 'missing-result', 'bad-result', 'absent-command', 'message-owner'])('uses a neutral historical fallback for %s instead of borrowing another result', fault => {
    const m = row(), c = command();
    if (fault === 'user') c.user_id = 'other'; if (fault === 'conversation') c.conversation_id = 'other'; if (fault === 'command') c.command_id = 'other'; if (fault === 'status') c.status = 'running';
    if (fault === 'missing-result') c.result = undefined; if (fault === 'bad-result') c.result = { summary: secret }; if (fault === 'message-owner') m.user_id = 'other';
    const text = presentStoredResultText(m, fault === 'absent-command' ? undefined : c, 'owner');
    expect(text).toBe('这条历史账单结果暂时无法核对，请查看原请求状态。'); expect(text).not.toMatch(/BILL_|HIDDEN/);
  });
  it.each(['request', 'answer', 'failure', 'cancellation'])('preserves original %s messages even when they literally contain diagnostic-looking words', kind => {
    const m = { ...row('BILL_DOMAIN_CONCERN:用户明确引用的文字'), kind };
    expect(presentStoredResultText(m, command(), 'owner')).toBe(m.text);
    expect(presentStoredResultText({ ...row(m.text), role: 'user' }, command(), 'owner')).toBe(m.text);
  });
  it('retains the existing ordinary new-action wording outside the bill refusal scope', () => {
    const value = result(); delete value.billAnswerReview; value.summary = '普通转账提案'; value.findings = []; value.actions = [{ id: 'draft', status: 'AWAITING_CONFIRMATION' }];
    expect(formatConversationResultText(value)).toContain('1 个待审阅动作，请检查风险等级后再授权');
  });
  it('does not repurpose a normal nonbill historical result or revive a neutral subscription continuation', () => {
    const value = result(); delete value.billAnswerReview; value.summary = '原订阅请求已保存，需逐项独立确认。'; value.findings = [];
    const m = row(value.summary); expect(presentStoredResultText(m, command(value), 'owner')).toBe(m.text);
  });
});
