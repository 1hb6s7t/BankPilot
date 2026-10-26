import { describe, expect, it } from 'vitest';
import { createPlanner, type ReviewContext } from '../packages/agents/src/index';
import { stageDependencyDigest } from '../packages/agents/src/stage-recovery';
import type { BillReport, PlannerInput, PlanningStageJournal } from '../packages/contracts/src/index';
import { reviewResponse } from './fixtures/review-response';

function input(coverage: BillReport['coverage'] = { status: 'complete' }, transfer = false): PlannerInput {
  const message = '查询2026年6月总支出' + (transfer ? '，给林晓转100元' : '');
  return { taskId: 'g9b-bill-review', message, accounts: [], payees: [{ id: 'p', name: '林晓', aliases: [], bank: '合成银行', maskedNumber: '****1234' }],
    billReport: { period: '2026-06', source: 'SYNTHETIC', coverage, incomeMinor: '0', expenseMinor: '0', netMinor: '0', previousExpenseMinor: '0', categories: [], transactions: [], findings: [], generatedAt: '2026-07-01T00:00:00Z' },
    semanticIntent: { status: 'ready', findings: [], modelRuns: [], tasks: [
      { role: 'bills', operation: 'bills_query', source: { text: '查询2026年6月总支出' }, canonicalMessage: '查询2026年6月总支出', slots: { billPeriod: { kind: 'month', startPeriod: '2026-06', endPeriod: '2026-06', source: { text: '2026年6月' } } } },
      ...(transfer ? [{ role: 'transfer' as const, operation: 'transfer', source: { text: '给林晓转100元' }, canonicalMessage: '给林晓转100元', slots: { entityId: 'p', amountMinor: '10000', memo: '' } }] : []),
    ] } };
}

describe('G9B planner typed bill review integration', () => {
  it.each(['missing', 'complete', 'partial'] as const)('preserves %s data through the actual reviewer boundary', async status => {
    let captured: ReviewContext | undefined;
    const result = await createPlanner({ provider: false, reviewerAdapter: async context => { captured = context; return reviewResponse(context); } }).plan(input({ status }));
    const fact = captured!.deterministic!.bills!.reports[0]!;
    expect(fact.amountsStatus).toBe(status === 'missing' ? 'unknown' : status === 'partial' ? 'partial' : 'known');
    expect(fact.expenseMinor).toBe(status === 'missing' ? null : '0');
    if (status === 'missing') {
      expect(result.diagnostics?.review?.summary).toContain('未将缺失月份视为零支出');
      expect(result.diagnostics?.review?.summary).not.toContain('支出0.00元');
    } else expect(result.diagnostics?.review?.summary).toContain('0.00元');
  });
  it('keeps a genuine independent refusal and suppresses the mixed transfer proposal', async () => {
    const result = await createPlanner({ provider: false, reviewerAdapter: async c => reviewResponse(c, { approved: false, concerns: [{ role: 'transfer', code: 'evidence_mismatch' }] }) }).plan(input(undefined, true));
    expect(result.diagnostics?.review).toMatchObject({ rawApproved: false, effectiveApproved: false });
    expect(result.suggestions).toEqual([]);
    expect(result.findings).toContain('transfer: 复核要求核对提案与原始证据');
  });
  it('treats a concern as refusal even if the reviewer boolean is true', async () => {
    const result = await createPlanner({ provider: false, reviewerAdapter: async c => reviewResponse(c, { approved: true, concerns: [{ role: 'all', code: 'additional_review_required' }] }) }).plan(input(undefined, true));
    expect(result.diagnostics?.review).toMatchObject({ rawApproved: true, effectiveApproved: false });
    expect(result.suggestions).toEqual([]);
  });
  it('retains a valid mixed proposal without treating review as authorization', async () => {
    const result = await createPlanner({ provider: false, reviewerAdapter: async c => reviewResponse(c, { approved: true }) }).plan(input(undefined, true));
    expect(result.suggestions).toMatchObject([{ payeeId: 'p', amountMinor: '10000' }]);
    expect(result.diagnostics?.review).toMatchObject({ rawApproved: true, effectiveApproved: true });
    expect(result.events.some(e => e.role === 'reviewer' && e.summary.includes('未授予资金权限'))).toBe(true);
  });
  it.each(['old-prose', 'wrong-assessment', 'invented-reference', 'invented-prose', 'inactive-concern'] as const)('rejects %s at the typed boundary', async fault => {
    const planner = createPlanner({ provider: false, reviewerAdapter: async c => {
      const value: any = reviewResponse(c, { approved: true });
      if (fault === 'old-prose') return { approved: true, summary: '虚构商户999999元', findings: [] };
      if (fault === 'wrong-assessment') value.bill.assessment = 'missing_data';
      if (fault === 'invented-reference') value.bill.evidenceSources = ['invented:merchant'];
      if (fault === 'invented-prose') value.summary = '虚构商户999999元';
      if (fault === 'inactive-concern') value.concerns = [{ role: 'investment', code: 'evidence_mismatch' }];
      return value;
    } });
    await expect(planner.plan(input())).rejects.toMatchObject({ failure: { stage: 'reviewer', retryable: false } });
  });
  it('does not reuse an old free-text review under the new typed review protocol', async () => {
    const saved = new Map<string, { dependency: string; value: any }>(); let calls = 0;
    const journal: PlanningStageJournal = {
      async completed() { return [...saved.keys()] as any; },
      async load(key, dependency) { const old = saved.get(key); if (old && old.dependency !== dependency) throw Object.assign(new Error('STAGE_DEPENDENCY_MISMATCH'), { code: 'STAGE_DEPENDENCY_MISMATCH' }); return old?.value; },
      async save(key, dependency, value) { saved.set(key, { dependency, value: structuredClone(value) }); },
      async recordFailure() {}, async history() { return []; },
    };
    const planner = createPlanner({ provider: false, reviewerAdapter: async c => { calls++; return reviewResponse(c); } });
    await planner.plan(input(), { stageJournal: journal });
    await planner.plan(input(), { stageJournal: journal });
    expect(calls).toBe(1);
    const domain = saved.get('domain:bills')!.value;
    saved.set('reviewer', { dependency: stageDependencyDigest({ protocol: 'g8f-stage-v1', orchestration: 'parallel-review', planVersion: 1, proposals: domain.proposals, rejected: [] }), value: { review: { approved: true, summary: '虚构商户999999元', findings: [] }, modelRuns: [] } });
    await expect(planner.plan(input(), { stageJournal: journal })).rejects.toMatchObject({ failure: { code: 'STAGE_DEPENDENCY_MISMATCH', retryable: false } });
    expect(calls).toBe(1);
  });
});
