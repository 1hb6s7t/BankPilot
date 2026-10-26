import { describe, expect, it, vi } from 'vitest';
import type { BillAnalysis, BillReport, PlannerInput } from '../packages/contracts/src/index';
import { createPlanner, createEvaluationPlanner, type LocalContext, type ReviewContext } from '../packages/agents/src/index';
import { analyzeBills } from '../packages/agents/src/bills';
import { buildBillReviewFacts, type BillReviewFacts } from '../packages/agents/src/bill-review-facts';
import { billDomainAssessmentSchema, billDomainApproved, renderBillDomainAssessment, schemaForBillDomainAssessment, scriptBillDomainAssessment } from '../packages/agents/src/bill-domain-assessment';

const request = '查询2026年7月合成枫亭书屋消费多少，把对应流水也列出来。';
function input(coverage: 'complete' | 'partial' | 'missing' = 'complete'): PlannerInput {
  const report: BillReport = { period: '2026-07', source: 'SYNTHETIC', coverage: { status: coverage }, incomeMinor: '0', expenseMinor: '8900', netMinor: '-8900', previousExpenseMinor: '0', categories: [], findings: [], generatedAt: '2026-08-01T00:00:00Z', transactions: [
    { id: 'g9h-book-a', accountId: 'a', bookedAt: '2026-07-06T00:00:00Z', merchant: '合成枫亭书屋', amountMinor: '2300', direction: 'OUT', category: '购物', source: 'SYNTHETIC_STATEMENT' },
    { id: 'g9h-book-b', accountId: 'a', bookedAt: '2026-07-08T00:00:00Z', merchant: '合成枫亭书屋东店', amountMinor: '4100', direction: 'OUT', category: '购物', source: 'SYNTHETIC_STATEMENT' },
    { id: 'g9h-other', accountId: 'a', bookedAt: '2026-07-09T00:00:00Z', merchant: '合成雁汀衣铺', amountMinor: '2500', direction: 'OUT', category: '购物', source: 'SYNTHETIC_STATEMENT' },
  ] };
  return { taskId: 'g9h-bill-wire', message: request, accounts: [], payees: [], billReport: report,
    semanticIntent: { status: 'ready', findings: [], modelRuns: [], tasks: [{ role: 'bills', operation: 'bills_query', source: { text: request }, canonicalMessage: '查询账单', slots: { billPeriod: { kind: 'month', startPeriod: '2026-07', endPeriod: '2026-07', source: { text: '2026年7月' } } } }] } };
}
function facts(value = input()): BillReviewFacts {
  const analysis = analyzeBills({ request: value.semanticIntent!.tasks[0], report: value.billReport });
  return buildBillReviewFacts({ analysis, report: value.billReport });
}
async function acceptedReview(context: ReviewContext) {
  const f = context.deterministic!.bills!;
  return { approved: true, billQueryAligned: true, bill: { assessment: scriptBillDomainAssessment(f, context.planVersion).assessment, evidenceSources: f.analysis.evidence.map(e => e.source).slice(0, 64) }, concerns: [] };
}
function typed(context: LocalContext) { return scriptBillDomainAssessment(context.data.billFacts as BillReviewFacts, context.planVersion); }

describe('G9H compact bills domain wire preserves facts and independent judgment', () => {
  it('has no free-text monetary or narrative fields and renders all server evidence', () => {
    const f = facts(), wire = scriptBillDomainAssessment(f, 3);
    expect(Object.keys(wire).sort()).toEqual(['assessment', 'concerns', 'evidenceSources', 'planVersion', 'queryAligned', 'role']);
    const selected = { ...wire, evidenceSources: [wire.evidenceSources[0]!] };
    const proposal = renderBillDomainAssessment(f, selected);
    expect(proposal.summary).toContain('64.00');
    expect(proposal.evidence).toEqual(f.analysis.evidence);
    expect(f.analysis.transactionIds).toEqual(['g9h-book-a', 'g9h-book-b']);
    expect(billDomainApproved(selected)).toBe(true);
    expect(proposal).not.toHaveProperty('suggestion');
    expect(proposal).not.toHaveProperty('managementSuggestions');
  });

  it.each(['summary', 'findings', 'evidence', 'clarification', 'amountMinor', 'suggestion', 'managementSuggestions'])('rejects legacy or injected %s instead of dropping it', field => {
    const f = facts(), wire = scriptBillDomainAssessment(f, 1);
    expect(schemaForBillDomainAssessment(f, 1).safeParse({ ...wire, [field]: '虚构商户998877.66元已扣款' }).success).toBe(false);
  });

  it.each([
    { role: 'transfer' }, { planVersion: 2 }, { evidenceSources: [] }, { evidenceSources: ['invented:transaction'] },
    { evidenceSources: ['bill-report:2026-07:SYNTHETIC', 'bill-report:2026-07:SYNTHETIC'] },
    { concerns: ['invented_concern'] }, { concerns: ['evidence_mismatch', 'evidence_mismatch'] },
  ])('rejects wrong identity, absent/invented/duplicate references or invalid concerns: %j', change => {
    const f = facts(), wire = scriptBillDomainAssessment(f, 1);
    expect(schemaForBillDomainAssessment(f, 1).safeParse({ ...wire, ...change }).success).toBe(false);
  });

  it.each([-1, 0, 1.5, Number.MAX_SAFE_INTEGER + 1])('rejects invalid expected version %s', version => {
    expect(() => schemaForBillDomainAssessment(facts(), version)).toThrow('BILL_DOMAIN_PLAN_VERSION_INVALID');
  });

  it.each(['partial', 'missing'] as const)('cannot promote %s coverage to complete', coverage => {
    const f = facts(input(coverage)), wire = scriptBillDomainAssessment(f, 1);
    expect(schemaForBillDomainAssessment(f, 1).safeParse({ ...wire, assessment: 'consistent' }).success).toBe(false);
    const p = renderBillDomainAssessment(f, wire);
    if (coverage === 'missing') {
      expect(f.analysis.amountMinor).toBeUndefined();
      expect(p.summary).not.toContain('0.00元');
      expect(p.summary).toContain('未将缺失月份视为零');
    } else {
      expect(f.analysis.status).toBe('partial');
      expect(p.summary).toContain('64.00');
    }
  });

  it('keeps a supported complete zero distinct from unknown and retains unsupported diagnostics', () => {
    const zero = input(); zero.billReport!.transactions = []; zero.billReport!.expenseMinor = '0'; zero.billReport!.netMinor = '0';
    const zf = facts(zero), zw = scriptBillDomainAssessment(zf, 1);
    expect(zf.analysis).toMatchObject({ status: 'complete', amountMinor: '0' });
    expect(zw.assessment).toBe('consistent');
    const unsupported: BillAnalysis = { status: 'unsupported', kind: 'summary', periods: ['2026-07'], missingPeriods: [], transactionIds: [], summary: '该筛选条件暂不支持，请说明已支持的统计范围。', clarification: '请明确支持的账单范围。', findings: ['BILL_QUERY_UNSUPPORTED'], evidence: [] };
    const uf: BillReviewFacts = { analysis: unsupported, reports: [], transactions: [] }, uw = scriptBillDomainAssessment(uf, 1);
    expect(uw.assessment).toBe('unsupported');
    expect(renderBillDomainAssessment(uf, uw)).toMatchObject({ clarification: unsupported.clarification, findings: ['BILL_QUERY_UNSUPPORTED'] });
    expect(schemaForBillDomainAssessment(uf, 1).safeParse({ ...uw, assessment: 'consistent' }).success).toBe(false);
  });

  it.each([{ queryAligned: false }, { concerns: ['filter_mismatch' as const] }])('accepts an honest negative decision as wire but withholds the answer despite reviewer approval: %j', negative => {
    return (async () => {
      const review = vi.fn(acceptedReview);
      const result = await createPlanner({ provider: false, domainAdapter: async c => ({ ...typed(c), ...negative }), reviewerAdapter: review }).plan(input());
      expect(review).toHaveBeenCalledOnce();
      expect(result.billAnswerReview?.status).toBe('withheld');
      expect(result.billAnalysis).toBeUndefined(); expect(result.billReport).toBeUndefined(); expect(result.billReports).toBeUndefined();
      expect(JSON.stringify(result)).not.toMatch(/6400|64\.00|g9h-book|枫亭/);
      expect(result.findings).toContain('BILL_DOMAIN_ASSESSMENT_REJECTED');
      expect(result.diagnostics?.review).toMatchObject({ rawApproved: true, effectiveApproved: false });
      expect(result.diagnostics?.review?.summary).not.toContain('同意提案');
      expect(result.suggestions).toEqual([]);
    })();
  });

  it('preserves exact original bill request and grants the reviewer its independent rejection', async () => {
    const domain = vi.fn(async (c: LocalContext) => {
      expect(c.data.originalRequest).toBe(request);
      expect(c.data.semanticRequest).toEqual(input().semanticIntent!.tasks[0]);
      expect(c.data.analysis).toEqual((c.data.billFacts as BillReviewFacts).analysis);
      return typed(c);
    });
    const result = await createPlanner({ provider: false, domainAdapter: domain, reviewerAdapter: async c => ({ ...await acceptedReview(c), approved: false }) }).plan(input());
    expect(domain).toHaveBeenCalledOnce();
    expect(result.billAnswerReview?.status).toBe('withheld');
    expect(result.diagnostics?.review?.effectiveApproved).toBe(false);
  });

  it('strictly rejects the legacy bills adapter shape and never uses it as a fallback', async () => {
    const review = vi.fn(acceptedReview);
    await expect(createPlanner({ provider: false, domainAdapter: async c => ({ role: c.role, planVersion: c.planVersion, summary: '已完成998877.66元扣款', findings: [], evidence: [] }), reviewerAdapter: review }).plan(input())).rejects.toMatchObject({ failure: { stage: 'domain:bills' } });
    expect(review).not.toHaveBeenCalled();
  });

  it('withholding removes every domain model narrative while retaining unrelated server card evidence', async () => {
    const value = input(), cardSource = '查询我银行卡的现有状态';
    value.message += cardSource;
    value.semanticIntent!.tasks.push({ role: 'card', operation: 'card_query', source: { text: cardSource }, canonicalMessage: '查询银行卡状态', slots: {} });
    value.managementContext = { cards: [{ id: 'g9h-readonly-card', accountId: 'a', name: '合成蓝杉卡', maskedNumber: '****1752', status: 'ACTIVE', version: 1, updatedAt: '2026-07-01T00:00:00Z' }] };
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('NO_HTTP_ALLOWED'));
    try {
      const result = await createPlanner({ provider: { baseURL: 'https://controlled.invalid/v1', model: 'pure-adapters' },
        domainAdapter: async c => c.role === 'bills' ? { ...typed(c), queryAligned: false } : { role: c.role, planVersion: c.planVersion, summary: 'opaque-private-bill-sentinel；账单支出998877.66元，流水private-foreign-row', findings: [], evidence: [], managementSuggestions: [] },
        reviewerAdapter: acceptedReview }).plan(value);
      expect(result.billAnswerReview?.status).toBe('withheld');
      expect(result.evidence.some(e => e.source.startsWith('model-explanation:'))).toBe(false);
      expect(JSON.stringify(result)).not.toMatch(/opaque-private-bill-sentinel|998877|private-foreign-row/);
      expect(result.evidence.some(e => e.source === 'card:g9h-readonly-card:v1')).toBe(true);
      expect(result.summary).toContain('合成蓝杉卡');
      expect(fetch).not.toHaveBeenCalled();
    } finally { fetch.mockRestore(); }
  });

  it('does not invent a precise original bill scope for a legacy nonsemantic request', async () => {
    const legacy = input(); delete legacy.semanticIntent; legacy.message = '查询2026年7月账单的收入和支出';
    const domain = vi.fn(async (c: LocalContext) => {
      expect(c.data).not.toHaveProperty('originalRequest');
      expect(c.data).not.toHaveProperty('semanticRequest');
      expect(c.instruction).toContain('没有精确账单原文范围');
      return typed(c);
    });
    const result = await createPlanner({ semantic: false, provider: false, domainAdapter: domain, reviewerAdapter: acceptedReview }).plan(legacy);
    expect(domain).toHaveBeenCalledOnce();
    expect(result.billAnalysis?.status).toBe('complete');
  });

  it('fails closed on a forged server handoff with two bill tasks rather than silently taking the first', async () => {
    const value = input(); value.semanticIntent!.tasks.push(structuredClone(value.semanticIntent!.tasks[0]!));
    await expect(createPlanner({ provider: false }).plan(value)).rejects.toMatchObject({ code: 'SEMANTIC_MULTIPLE_TASKS_SAME_DOMAIN' });
  });

  it.each(['single', 'parallel', 'parallel-review'] as const)('scripted %s still uses the typed domain and complete server facts', async orchestration => {
    const result = await createEvaluationPlanner(orchestration, { provider: false }).plan(input());
    expect(result.billAnalysis).toMatchObject({ amountMinor: '6400', transactionIds: ['g9h-book-a', 'g9h-book-b'] });
    expect(result.billAnswerReview).toBeUndefined();
    expect(result.evidence.some(e => e.source === 'model-explanation:bills')).toBe(false);
    expect(result.events.some(e => e.role === 'bills')).toBe(true);
    expect(result.events.some(e => e.role === 'reviewer')).toBe(orchestration === 'parallel-review');
  });

  it('base wire alone does not accept free fields even before contextual fact checks', () => {
    expect(billDomainAssessmentSchema.safeParse({ ...scriptBillDomainAssessment(facts(), 1), summary: 'unknown means zero' }).success).toBe(false);
  });
});
