import { describe, expect, it, vi } from 'vitest';
import { analyzeBills, billPeriods } from '../packages/agents/src/bills';
import { createPlanner } from '../packages/agents/src/index';
import { preparePlannerInput } from '../apps/api/src/planning';
import type { BillReport, BillTransaction, PlannerInput, SemanticTask } from '../packages/contracts/src/index';

function report(period: string, rows: [string, string, string, BillTransaction['category'], BillTransaction['direction']?][], coverage: BillReport['coverage'] = { status: 'complete' }): BillReport {
  const transactions = rows.map(([id, merchant, amountMinor, category, direction = 'OUT']) => ({ id, merchant, amountMinor, category, direction, bookedAt: `${period}-03T01:00:00.000Z`, accountId: 'account', source: 'SYNTHETIC_STATEMENT' as const }));
  const sum = (direction: BillTransaction['direction']) => transactions.filter(row => row.direction === direction).reduce((total, row) => total + BigInt(row.amountMinor), 0n);
  return { period, source: 'SYNTHETIC', coverage, incomeMinor: sum('IN').toString(), expenseMinor: sum('OUT').toString(), netMinor: (sum('IN') - sum('OUT')).toString(), previousExpenseMinor: '0', transactions, categories: [], findings: [], generatedAt: '2026-11-01T00:00:00Z' };
}
function task(message: string, period: SemanticTask['slots']['billPeriod'] = { kind: 'month', startPeriod: '2026-09', endPeriod: '2026-09', source: { text: '2026年9月' } }): SemanticTask {
  return { role: 'bills', operation: 'bills_query', source: { text: message }, canonicalMessage: '查询账单', slots: { billPeriod: period } };
}
const september = report('2026-09', [
  ['first-small', '青禾书店', '1000', '购物'], ['other-shop', '数码商店', '8700', '购物'],
  ['second-book', '青禾书店', '2300', '购物'], ['large', '远山书店', '9000', '购物'],
  ['large-tie', '晚风餐厅', '9000', '餐饮'], ['income', '书店退款收入', '99000', '收入', 'IN'],
]);

describe('deterministic bill answers preserve the actual question and evidence', () => {
  it('finds the greatest OUT amount, all ties, and excludes a larger IN without depending on row order', () => {
    const result = analyzeBills({ request: task('先列出2026年9月账单中金额最大的消费'), report: september });
    expect(result).toMatchObject({ status: 'complete', kind: 'largest_expense', amountMinor: '9000', transactionIds: ['large', 'large-tie'] });
    expect(result.summary).toContain('并列2笔');
    expect(result.evidence.filter(item => item.source.startsWith('bill-transaction:'))).toHaveLength(2);
  });
  it('sums all matching merchant expenses, not the whole category, and cites every matching row', () => {
    const result = analyzeBills({ request: task('2026年9月青禾书店消费是多少？把原流水编号也给我'), report: september });
    expect(result).toMatchObject({ kind: 'filtered_expense', amountMinor: '3300', filter: { kind: 'merchant_contains', value: '青禾书店' }, transactionIds: ['first-small', 'second-book'] });
    expect(result.summary).not.toContain('other-shop'); expect(result.summary).not.toContain('income');
  });
  it('explains merchant substring semantics and does not include matching income', () => {
    const result = analyzeBills({ request: task('2026年9月书店消费是多少'), report: september });
    expect(result.amountMinor).toBe('12300');
    expect(result.summary).toContain('商户名称含「书店」');
    expect(result.transactionIds).toEqual(['first-small', 'second-book', 'large']);
  });
  it('uses a genuine category filter independently of merchant names', () => {
    const result = analyzeBills({ request: task('查询2026年9月餐饮支出是多少'), report: september });
    expect(result).toMatchObject({ amountMinor: '9000', filter: { kind: 'category', value: '餐饮' }, transactionIds: ['large-tie'] });
  });
  it('recognizes a category suffix rather than falsely returning a zero merchant total', () => {
    expect(analyzeBills({ request: task('2026年9月餐饮类消费有多少？'), report: september })).toMatchObject({ amountMinor: '9000', filter: { kind: 'category', value: '餐饮' } });
  });
  it('preserves exact fen values beyond floating point precision', () => {
    const result = analyzeBills({ request: task('2026年9月书店消费是多少'), report: report('2026-09', [['huge', '书店', '9007199254740993', '购物'], ['cent', '书店', '1', '购物']]) });
    expect(result.amountMinor).toBe('9007199254740994'); expect(result.summary).toContain('90071992547409.94元');
  });
  it('allows true zero for a known complete empty statement', () => {
    const result = analyzeBills({ request: task('2026年9月书店消费是多少'), report: report('2026-09', []) });
    expect(result).toMatchObject({ status: 'complete', amountMinor: '0', transactionIds: [] });
  });
  it.each(['超过100元的消费', '排除交通后的支出', '平均消费', '支出增幅', '收入最高', '前3笔消费', '书店最大的消费', '哪类支出最多', '哪家商户消费最多', '小额消费是多少', '商户支出总额是多少', '各商户消费总额', '每个商户的消费总额', '商家消费总额'])('does not silently answer an unsupported filter with an unfiltered total: %s', question => {
    const result = analyzeBills({ request: task(`查询2026年9月${question}`), report: september });
    expect(result.status).toBe('unsupported'); expect(result.clarification).toBeTruthy(); expect(result.amountMinor).toBeUndefined();
  });
  it('does not label missing data as a zero-expense month', () => {
    const result = analyzeBills({ request: task('2026年9月书店消费是多少'), report: report('2026-09', [], { status: 'missing' }) });
    expect(result).toMatchObject({ status: 'missing_data', missingPeriods: ['2026-09'] }); expect(result.amountMinor).toBeUndefined();
  });
  it('marks an as-of statement partial in both structured data and user wording', () => {
    const result = analyzeBills({ request: task('2026年9月书店消费是多少'), report: { ...september, coverage: { status: 'partial', through: '2026-09-12T00:00:00Z' } } });
    expect(result.status).toBe('partial'); expect(result.summary).toContain('尚不完整');
  });
  it.each(['duplicate', 'wrong-month', 'invalid-amount'])('rejects inconsistent evidence: %s', fault => {
    const copy = structuredClone(september);
    if (fault === 'duplicate') copy.transactions.push({ ...copy.transactions[0]! });
    if (fault === 'wrong-month') copy.transactions[0]!.bookedAt = '2026-10-03T00:00:00Z';
    if (fault === 'invalid-amount') copy.transactions[0]!.amountMinor = '-3';
    expect(analyzeBills({ request: task('2026年9月书店消费是多少'), report: copy }).status).toBe('unsupported');
  });
});

describe('two-month comparison and exact bounded month retrieval', () => {
  const selection = { kind: 'selection' as const, periods: ['2026-08', '2026-10'], startPeriod: '2026-08', endPeriod: '2026-10', source: { text: '2026年8月和10月' } };
  const request = task('比较2026年8月和10月哪类支出涨得最多', selection);
  const august = report('2026-08', [['a-food', '饭馆', '300', '餐饮'], ['a-shop', '百货', '100', '购物']]);
  const october = report('2026-10', [['o-food', '饭馆', '400', '餐饮'], ['o-shop-1', '百货', '300', '购物'], ['o-shop-2', '书店', '500', '购物']]);
  it('compares exact categories across nonadjacent months without demanding the intervening month', () => {
    const result = analyzeBills({ request, reports: [october, september, august] });
    expect(result.periods).toEqual(['2026-08', '2026-10']); expect(result.largestIncreaseCategories).toEqual(['购物']);
    expect(result.categoryChanges?.find(row => row.category === '购物')).toEqual({ category: '购物', beforeMinor: '100', afterMinor: '800', changeMinor: '700', transactionIds: ['a-shop', 'o-shop-1', 'o-shop-2'] });
    expect(result.transactionIds).not.toContain('other-shop');
  });
  it.each(['absent', 'partial', 'missing'])('refuses a full-month comparison with %s data', coverage => {
    const reports = [october, ...(coverage === 'absent' ? [] : [{ ...august, coverage: { status: coverage as 'partial' | 'missing' } }])];
    const result = analyzeBills({ request, reports });
    expect(result).toMatchObject({ status: 'missing_data', missingPeriods: ['2026-08'] });
    expect(result.summary).toContain('8月'); expect(result.categoryChanges).toBeUndefined();
  });
  it('reports no increase rather than choosing the least negative decrease', () => {
    const result = analyzeBills({ request, reports: [august, report('2026-10', [['o-food', '饭馆', '200', '餐饮']])] });
    expect(result.largestIncreaseCategories).toEqual([]); expect(result.summary).toContain('没有类别支出上升');
  });
  it('preserves two tied category increases', () => {
    const result = analyzeBills({ request, reports: [august, report('2026-10', [['o-food', '饭馆', '400', '餐饮'], ['o-shop', '百货', '200', '购物']])] });
    expect(result.largestIncreaseCategories).toEqual(['餐饮', '购物']);
  });
  it('bounds ranges and rejects invalid month selections', () => {
    expect(billPeriods(selection)).toEqual(['2026-08', '2026-10']);
    expect(billPeriods({ ...selection, kind: 'range' })).toEqual(['2026-08', '2026-09', '2026-10']);
    expect(billPeriods({ ...selection, kind: 'range', endPeriod: '2027-08' })).toEqual([]);
    expect(billPeriods({ ...selection, periods: ['2026-08', '2026-13'] })).toEqual([]);
  });
  it('API fetches only the grounded selection once and planner consumes that frozen data', async () => {
    const input: PlannerInput = { taskId: 'bill-selection', message: request.source.text, accounts: [], payees: [], semanticIntent: { status: 'ready', tasks: [request], findings: [], modelRuns: [] } };
    const billReport = vi.fn(async (_actor, month) => month === '2026-08' ? august : october);
    const planner = createPlanner({ provider: false });
    const prepared = await preparePlannerInput({ planner, finance: { billReport } as any }, { userId: 'u' }, input, { accounts: [], payees: [] } as any, new Date('2026-11-01T00:00:00Z'), input.semanticIntent);
    expect(billReport.mock.calls.map(call => call[1])).toEqual(['2026-08', '2026-10']);
    const result = await planner.plan(prepared);
    expect(result.billAnalysis?.largestIncreaseCategories).toEqual(['购物']);
    expect(result.billReports?.map(row => row.period)).toEqual(['2026-08', '2026-10']);
    expect(result.suggestions).toEqual([]); expect(result.clarification).toBeUndefined();
  });
  it('does not relabel a service returning the wrong month', async () => {
    const input: PlannerInput = { taskId: 'wrong-month', message: request.source.text, accounts: [], payees: [], semanticIntent: { status: 'ready', tasks: [request], findings: [], modelRuns: [] } };
    const planner = createPlanner({ provider: false });
    const prepared = await preparePlannerInput({ planner, finance: { billReport: async () => september } as any }, { userId: 'u' }, input, { accounts: [], payees: [] } as any, new Date(), input.semanticIntent);
    expect((await planner.plan(prepared)).billAnalysis).toMatchObject({ status: 'missing_data', missingPeriods: ['2026-08', '2026-10'] });
  });
});
