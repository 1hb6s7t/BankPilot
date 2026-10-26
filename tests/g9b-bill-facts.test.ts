import { describe, expect, it } from 'vitest';
import { analyzeBills } from '../packages/agents/src/bills';
import { billReviewAssessmentSchema, buildBillReviewFacts, renderBillReviewAssessment, validateBillReviewAssessment } from '../packages/agents/src/bill-review-facts';
import type { BillReport, BillTransaction, SemanticTask } from '../packages/contracts/src/index';

function task(question = '请准确告诉我2026年6月总支出，并给出可核验的流水。'): SemanticTask {
  return { role: 'bills', operation: 'bills_query', source: { text: question }, canonicalMessage: '查询账单',
    slots: { billPeriod: { kind: 'month', startPeriod: '2026-06', endPeriod: '2026-06', source: { text: '2026年6月' } } } };
}
function row(id: string, period = '2026-06'): BillTransaction {
  return { id, accountId: 'account', bookedAt: `${period}-03T01:00:00Z`, merchant: '云杉音乐', amountMinor: '1250',
    direction: 'OUT', category: '订阅', source: 'SYNTHETIC_STATEMENT' };
}
function report(transactions: BillTransaction[] = [], coverage: BillReport['coverage'] = { status: 'complete' }): BillReport {
  const sum = (direction: BillTransaction['direction']) => transactions.filter(row => row.direction === direction).reduce((sum, row) => sum + BigInt(row.amountMinor), 0n);
  const income = sum('IN'), expense = sum('OUT');
  return { period: '2026-06', source: 'SYNTHETIC', coverage, incomeMinor: income.toString(), expenseMinor: expense.toString(),
    netMinor: (income - expense).toString(), previousExpenseMinor: '0', categories: [], transactions,
    evidenceTransactions: [], findings: [], generatedAt: '2026-07-01T00:00:00Z' };
}
function groupedReport(): BillReport {
  const value = report([row('current-a'), row('current-b')]);
  value.evidenceTransactions = [row('prior', '2026-05')];
  value.findings = [{ id: 'cycle', kind: 'RECURRING', summary: '可能为周期费用，尚未确认订阅关系。', transactionIds: ['prior', 'current-a', 'current-b'] }];
  return value;
}

describe('G9B recurring evidence supports homogeneous groups without changing the accounting period', () => {
  it('accepts one prior and two current rows and counts each current expense exactly once', () => {
    const value = groupedReport();
    const analysis = analyzeBills({ request: task('2026年6月订阅消费多少'), report: value });
    expect(analysis).toMatchObject({ status: 'complete', amountMinor: '2500', transactionIds: ['current-a', 'current-b'] });
    expect(analysis.evidence.filter(item => item.source === 'bill-finding:cycle')).toHaveLength(1);
    expect(analysis.evidence.find(item => item.source === 'bill-transaction:prior')?.detail).toContain('excluded-from-query-total');
    const facts = buildBillReviewFacts({ analysis, report: value });
    expect(facts.reports[0]).toMatchObject({ amountsStatus: 'known', expenseMinor: '2500', netMinor: '-2500' });
    expect(facts.transactions.find(item => item.id === 'prior')).toMatchObject({ usage: 'finding-support-only', bookedAt: '2026-05-03T01:00:00Z' });
    expect(facts.transactions.filter(item => item.usage === 'query-answer').map(item => item.id)).toEqual(['current-a', 'current-b']);
  });

  it('accepts multiple prior rows when every referenced row has the same evidence key', () => {
    const value = groupedReport();
    value.evidenceTransactions!.push(row('prior-b', '2026-05'));
    value.findings[0]!.transactionIds.push('prior-b');
    expect(analyzeBills({ request: task('2026年6月订阅消费多少'), report: value })).toMatchObject({ status: 'complete', amountMinor: '2500' });
  });

  it('counts a prior reference only once in its own month when both months are requested', () => {
    const current = groupedReport();
    const previous = { ...report([row('prior', '2026-05')]), period: '2026-05' };
    const request = task('2026年5月到6月订阅消费多少');
    request.slots.billPeriod = { kind: 'range', startPeriod: '2026-05', endPeriod: '2026-06', source: { text: '2026年5月到6月' } };
    const analysis = analyzeBills({ request, reports: [current, previous] });
    expect(analysis).toMatchObject({ status: 'complete', amountMinor: '3750', transactionIds: ['prior', 'current-a', 'current-b'] });
    const facts = buildBillReviewFacts({ analysis, reports: [current, previous] });
    expect(facts.transactions.filter(row => row.id === 'prior')).toHaveLength(1);
    expect(facts.transactions.find(row => row.id === 'prior')?.usage).toBe('query-answer');
  });

  it.each([
    ['current account', (r: BillReport) => { r.transactions[1]!.accountId = 'foreign'; }],
    ['prior account', (r: BillReport) => { r.evidenceTransactions![0]!.accountId = 'foreign'; }],
    ['current merchant', (r: BillReport) => { r.transactions[1]!.merchant = 'another merchant'; }],
    ['prior merchant', (r: BillReport) => { r.evidenceTransactions![0]!.merchant = 'another merchant'; }],
    ['current amount', (r: BillReport) => { r.transactions[1]!.amountMinor = '1251'; }],
    ['prior amount', (r: BillReport) => { r.evidenceTransactions![0]!.amountMinor = '1251'; }],
    ['current source', (r: BillReport) => { r.transactions[1]!.source = 'SANDBOX_TRANSFER'; }],
    ['prior source', (r: BillReport) => { r.evidenceTransactions![0]!.source = 'SANDBOX_TRANSFER'; }],
    ['current direction', (r: BillReport) => { r.transactions[1]!.direction = 'IN'; }],
    ['prior direction', (r: BillReport) => { r.evidenceTransactions![0]!.direction = 'IN'; }],
    ['current period', (r: BillReport) => { r.transactions[1]!.bookedAt = '2026-05-03T01:00:00Z'; }],
    ['prior period', (r: BillReport) => { r.evidenceTransactions![0]!.bookedAt = '2026-04-03T01:00:00Z'; }],
    ['duplicate reference', (r: BillReport) => { r.findings[0]!.transactionIds.push('current-a'); }],
    ['duplicate current ID', (r: BillReport) => { r.transactions[1]!.id = 'current-a'; }],
    ['duplicate prior ID', (r: BillReport) => { r.evidenceTransactions!.push({ ...r.evidenceTransactions![0]! }); }],
    ['unknown reference', (r: BillReport) => { r.findings[0]!.transactionIds.push('unknown'); }],
    ['no current evidence', (r: BillReport) => { r.findings[0]!.transactionIds = ['prior']; }],
    ['no prior evidence', (r: BillReport) => { r.findings[0]!.transactionIds = ['current-a', 'current-b']; }],
  ] as const)('rejects a grouped finding with %s mismatch and exposes no fabricated totals', (_name, mutate) => {
    const value = groupedReport(); mutate(value);
    const analysis = analyzeBills({ request: task('2026年6月订阅消费多少'), report: value });
    expect(analysis.status).toBe('unsupported');
    expect(analysis.amountMinor).toBeUndefined();
    expect(buildBillReviewFacts({ analysis, report: value })).toMatchObject({ reports: [{ amountsStatus: 'unknown', incomeMinor: null, expenseMinor: null, netMinor: null }], transactions: [] });
  });
});

describe('G9B review facts preserve unknown, true zero, net, and row provenance', () => {
  it('does not expose missing-report zero placeholders as known amounts', () => {
    const value = report([], { status: 'missing' });
    const analysis = analyzeBills({ request: task(), report: value });
    expect(analysis).toMatchObject({ status: 'missing_data', kind: 'summary', missingPeriods: ['2026-06'] });
    expect(analysis.filter).toBeUndefined();
    expect(analysis.amountMinor).toBeUndefined();
    const facts = buildBillReviewFacts({ analysis, report: value });
    expect(facts.reports).toEqual([{ period: '2026-06', source: 'SYNTHETIC', coverage: { status: 'missing' },
      amountsStatus: 'unknown', incomeMinor: null, expenseMinor: null, netMinor: null, provenance: null }]);
    expect(JSON.stringify(facts)).not.toContain('"expenseMinor":"0"');
  });
  it('preserves complete empty-statement zero as known', () => {
    const value = report();
    const analysis = analyzeBills({ request: task(), report: value });
    expect(analysis).toMatchObject({ status: 'complete', kind: 'summary' });
    expect(buildBillReviewFacts({ analysis, report: value }).reports[0]).toMatchObject({ amountsStatus: 'known', incomeMinor: '0', expenseMinor: '0', netMinor: '0' });
  });
  it('keeps a partial zero limited to supplied rows rather than claiming complete coverage', () => {
    const value = report([], { status: 'partial', through: '2026-06-04T00:00:00Z' });
    const analysis = analyzeBills({ request: task(), report: value });
    expect(analysis.status).toBe('partial');
    expect(buildBillReviewFacts({ analysis, report: value }).reports[0]).toMatchObject({ amountsStatus: 'partial', expenseMinor: '0', netMinor: '0', coverage: value.coverage });
  });
  it('exposes known net and exact merchant evidence while excluding unrelated reports', () => {
    const value = report([row('expense'), { ...row('income'), amountMinor: '10000', direction: 'IN' }]);
    const other = { ...report(), period: '2026-05', expenseMinor: '999999' };
    const analysis = analyzeBills({ request: task(), reports: [value, other] });
    const facts = buildBillReviewFacts({ analysis, reports: [value, other] });
    expect(facts.reports).toHaveLength(1);
    expect(facts.reports[0]).toMatchObject({ incomeMinor: '10000', expenseMinor: '1250', netMinor: '8750' });
    expect(facts.transactions.map(item => item.merchant)).toEqual(['云杉音乐', '云杉音乐']);
  });
  it('does not attach altered report totals or merchant rows to an earlier provenance record', () => {
    const value = report([row('expense')]);
    const analysis = analyzeBills({ request: task(), report: value });
    value.netMinor = '999999'; value.transactions[0]!.merchant = 'invented merchant';
    const facts = buildBillReviewFacts({ analysis, report: value });
    expect(facts.reports[0]).toMatchObject({ amountsStatus: 'unknown', netMinor: null });
    expect(facts.transactions).toEqual([]);
    expect(facts.analysis.summary).not.toContain('invented merchant');
  });
  it.each(['请准确告诉我', '请详细地查询', '帮我清楚地告诉我'])('strips the request verb in %s without inventing a merchant filter', prefix => {
    expect(analyzeBills({ request: task(`${prefix}2026年6月总支出多少`), report: report() })).toMatchObject({ kind: 'summary', status: 'complete' });
  });
  it('preserves literal adverbs inside actual merchant names', () => {
    const value = report([{ ...row('named'), merchant: '准确书店' }, row('unrelated')]);
    const analysis = analyzeBills({ request: task('2026年6月准确书店消费多少'), report: value });
    expect(analysis).toMatchObject({ kind: 'filtered_expense', filter: { kind: 'merchant_contains', value: '准确书店' }, amountMinor: '1250', transactionIds: ['named'] });
  });
});

describe('G9B typed billing review cannot publish free-text invented facts', () => {
  function factsFor(value: BillReport) {
    return buildBillReviewFacts({ analysis: analyzeBills({ request: task(), report: value }), report: value });
  }
  it('validates cited known facts and renders the known net from the server', () => {
    const facts = factsFor(report([row('expense')]));
    const assessment = { assessment: 'consistent', evidenceSources: ['bill-report:2026-06:SYNTHETIC'] };
    expect(validateBillReviewAssessment(facts, assessment)).toEqual([]);
    const rendered = renderBillReviewAssessment(facts, assessment);
    expect(rendered.summary).toContain('净额-12.50元');
    expect(rendered.findings).toContain('BILL_REVIEW_STATUS_COMPLETE');
    expect(rendered).not.toHaveProperty('approved');
  });
  it('renders missing as unknown without turning the zero placeholder into a contradiction', () => {
    const facts = factsFor(report([], { status: 'missing' }));
    const assessment = { assessment: 'missing_data', evidenceSources: ['data-availability'] };
    expect(validateBillReviewAssessment(facts, assessment)).toEqual([]);
    const rendered = renderBillReviewAssessment(facts, assessment);
    expect(rendered.summary).toContain('未将缺失月份视为零支出');
    expect(rendered.summary).not.toContain('支出0.00元');
    expect(rendered.findings).not.toContain('BILL_REVIEW_ASSESSMENT_MISMATCH');
  });
  it.each(['consistent', 'partial_data', 'unsupported'])('rejects %s for missing facts', assessment => {
    const facts = factsFor(report([], { status: 'missing' }));
    expect(validateBillReviewAssessment(facts, { assessment, evidenceSources: ['data-availability'] })).toContain('BILL_REVIEW_ASSESSMENT_MISMATCH');
  });
  it.each([{ evidenceSources: [] }, { evidenceSources: ['invented:merchant'] }, { evidenceSources: ['bill-report:2026-06:SYNTHETIC', 'bill-report:2026-06:SYNTHETIC'] }])('rejects absent, invented, or duplicate evidence references: %j', ({ evidenceSources }) => {
    expect(validateBillReviewAssessment(factsFor(report()), { assessment: 'consistent', evidenceSources })).toContain('BILL_REVIEW_EVIDENCE_REFERENCE_INVALID');
  });
  it('requires a partial assessment for partial rows even when their supplied total is zero', () => {
    const facts = factsFor(report([], { status: 'partial' }));
    expect(validateBillReviewAssessment(facts, { assessment: 'consistent', evidenceSources: ['bill-report:2026-06:SYNTHETIC'] })).toContain('BILL_REVIEW_ASSESSMENT_MISMATCH');
    expect(validateBillReviewAssessment(facts, { assessment: 'partial_data', evidenceSources: ['bill-report:2026-06:SYNTHETIC'] })).toEqual([]);
  });
  it('refuses fabricated merchant and amount prose at the strict schema boundary and never renders it', () => {
    const facts = factsFor(report([row('expense')]));
    const malicious = { assessment: 'consistent', evidenceSources: ['bill-report:2026-06:SYNTHETIC'],
      summary: '虚构商户净额999999元', findings: ['缺失账单支出为0元'] };
    expect(billReviewAssessmentSchema.safeParse(malicious).success).toBe(false);
    expect(validateBillReviewAssessment(facts, malicious)).toEqual(['BILL_REVIEW_ASSESSMENT_INVALID']);
    const rendered = renderBillReviewAssessment(facts, malicious);
    expect(rendered.summary).toContain('净额-12.50元');
    expect(JSON.stringify(rendered)).not.toMatch(/虚构商户|999999|缺失账单支出为0元/);
  });
  it('renders unsupported evidence failures without publishing unvalidated report amounts', () => {
    const value = groupedReport(); value.transactions[1]!.merchant = 'mismatch';
    const facts = factsFor(value);
    const assessment = { assessment: 'unsupported', evidenceSources: [] };
    expect(validateBillReviewAssessment(facts, assessment)).toEqual([]);
    expect(renderBillReviewAssessment(facts, assessment).findings).toContain('BILL_REVIEW_STATUS_UNSUPPORTED');
    expect(renderBillReviewAssessment(facts, assessment).summary).not.toContain('净额');
  });
});
