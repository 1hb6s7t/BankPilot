import { describe, expect, it } from 'vitest';
import { analyzeBills } from '../packages/agents/src/bills';
import { buildBillReviewFacts } from '../packages/agents/src/bill-review-facts';
import type { BillReport, BillTransaction, SemanticTask } from '../packages/contracts/src/index';

type Row = [string, string, string, BillTransaction['category'], BillTransaction['direction']?];
function report(period = '2026-10', rows: Row[] = [
  ['meal-a', '青苔便当店', '2350', '餐饮'], ['meal-b', '青苔便当店城南店', '3650', '餐饮'],
  ['other-meal', '山岚面馆', '1275', '餐饮'], ['income', '青苔便当店', '19000', '收入', 'IN'],
  ['shopping', '准确书店', '4420', '购物'],
], coverage: BillReport['coverage'] = { status: 'complete' }): BillReport {
  const transactions: BillTransaction[] = rows.map(([id, merchant, amountMinor, category, direction = 'OUT']) => ({
    id, merchant, amountMinor, category, direction, accountId: 'query-account', bookedAt: `${period}-03T01:00:00Z`, source: 'SYNTHETIC_STATEMENT',
  }));
  const sum = (direction: BillTransaction['direction']) => transactions.filter(row => row.direction === direction).reduce((n, row) => n + BigInt(row.amountMinor), 0n);
  return { period, transactions, coverage, source: 'SYNTHETIC', generatedAt: '2026-11-01T00:00:00Z',
    incomeMinor: sum('IN').toString(), expenseMinor: sum('OUT').toString(), netMinor: (sum('IN') - sum('OUT')).toString(), previousExpenseMinor: '0', categories: [], findings: [] };
}
function task(text: string): SemanticTask {
  return { role: 'bills', operation: 'bills_query', source: { text }, canonicalMessage: '模型猜测的餐饮月度汇总',
    slots: { billPeriod: { kind: 'month', startPeriod: '2026-10', endPeriod: '2026-10', source: { text: '2026/10' } } } };
}
const query = (text: string, value = report()) => analyzeBills({ request: task(text), report: value });

function expectUnsupported(text: string) {
  const result = query(text);
  expect(result.status).toBe('unsupported');
  expect(result.findings).toContain('BILL_QUERY_UNSUPPORTED');
  expect(result.clarification).toBeTruthy();
  expect(result.amountMinor).toBeUndefined();
  expect(result.filter).toBeUndefined();
  expect(result.transactionIds).toEqual([]);
  expect(result.evidence).toEqual([]);
  expect(result.summary).not.toContain('支出116.95元');
}

describe('G9C source bill queries retain scope across punctuation and natural expense predicates', () => {
  it('regresses the observed G9 merchant query without altering its historical fixture or scoring', () => {
    const result = query('看看2026/10账单里，青苔便当店一共扣了我多少钱，把对应流水也列出来。');
    expect(result).toMatchObject({ status: 'complete', kind: 'filtered_expense', filter: { kind: 'merchant_contains', value: '青苔便当店' }, amountMinor: '6000', transactionIds: ['meal-a', 'meal-b'] });
    expect(result.summary).toContain('60.00元');
    expect(result.summary).not.toMatch(/收入|净额|山岚|4420|19000/);
    const facts = buildBillReviewFacts({ analysis: result, report: report() });
    expect(facts.analysis).toMatchObject({ kind: 'filtered_expense', filter: result.filter, amountMinor: '6000' });
    expect(facts.transactions.map(row => row.id)).toEqual(['meal-a', 'meal-b']);
    expect(result.evidence.filter(row => row.source.startsWith('bill-transaction:')).map(row => row.source)).toEqual(['bill-transaction:meal-a', 'bill-transaction:meal-b']);
  });
  it.each(['，', ',', '；', ';', '。', '？', '?', '：', ':', '！', '!'])('retains a merchant query after context separator %s', separator => {
    const result = query(`请准确告诉我2026/10账单里${separator}山岚面馆总共花了多少钱${separator}把原流水编号也给我。`);
    expect(result).toMatchObject({ status: 'complete', kind: 'filtered_expense', filter: { value: '山岚面馆' }, amountMinor: '1275', transactionIds: ['other-meal'] });
    expect(result.summary).not.toContain('青苔');
  });
  it.each(['一共扣了我多少钱', '总共扣了多少钱', '扣我多少钱', '共花了多少钱', '花费了多少', '的消费总额是多少', '支出合计多少', '的总消费是多少', '总支出多少'])('consumes a complete supported expense predicate: %s', predicate => {
    expect(query(`2026/10青苔便当店${predicate}？`)).toMatchObject({ status: 'complete', amountMinor: '6000', filter: { kind: 'merchant_contains', value: '青苔便当店' } });
  });
  it.each(['请准确告诉我', '请详细地查询', '帮我清楚地告诉我'])('treats %s as request wording for a summary, category and merchant', prefix => {
    expect(query(`${prefix}2026/10总支出多少`)).toMatchObject({ status: 'complete', kind: 'summary' });
    expect(query(`${prefix}2026/10总支出多少`).filter).toBeUndefined();
    expect(query(`${prefix}2026/10账单中，餐饮类别支出是多少？`)).toMatchObject({ status: 'complete', amountMinor: '7275', filter: { kind: 'category', value: '餐饮' }, transactionIds: ['meal-a', 'meal-b', 'other-meal'] });
    expect(query(`${prefix}2026/10准确书店消费多少？`)).toMatchObject({ status: 'complete', amountMinor: '4420', filter: { kind: 'merchant_contains', value: '准确书店' }, transactionIds: ['shopping'] });
  });
  it.each(['“餐饮”', '「餐饮」', '"餐饮"'])('preserves a quoted category word %s as a literal merchant', quoted => {
    const result = query(`2026/10${quoted}消费多少`, report('2026-10', [['literal', '餐饮', '115', '购物'], ['category', '饭馆', '777', '餐饮']]));
    expect(result).toMatchObject({ amountMinor: '115', filter: { kind: 'merchant_contains', value: '餐饮' }, transactionIds: ['literal'] });
  });
  it('retains punctuation and conjunctions inside a quoted merchant without broadening its match', () => {
    const result = query('2026/10账单里；“春和，书店”一共扣了我多少钱？', report('2026-10', [['literal', '春和，书店', '415', '购物'], ['other', '春和书店', '9999', '购物']]));
    expect(result).toMatchObject({ status: 'complete', amountMinor: '415', filter: { kind: 'merchant_contains', value: '春和，书店' }, transactionIds: ['literal'] });
  });
  it.each(['请列出对应流水', '并给出可核验的流水', '把对应流水也列出来'])('allows the evidence instruction %s without losing the merchant', instruction => {
    expect(query(`2026/10山岚面馆消费多少？${instruction}`)).toMatchObject({ status: 'complete', amountMinor: '1275', transactionIds: ['other-meal'] });
  });
  it('sums exact fen beyond Number precision while excluding the matching incoming row', () => {
    expect(query('2026/10霁云杂货铺共花了多少钱', report('2026-10', [['big', '霁云杂货铺', '9007199254740993', '购物'], ['cent', '霁云杂货铺', '1', '购物'], ['in', '霁云杂货铺', '99999999999999999', '收入', 'IN']]))).toMatchObject({ amountMinor: '9007199254740994', transactionIds: ['big', 'cent'] });
  });
});

describe('G9C unsupported source constraints never become a monthly answer or invented merchant', () => {
  it.each([
    '2026/10账单里，青苔便当店收走了我多少钱？',
    '2026/10账单里，青苔便当店消费多少，只看周末。',
    '2026/10账单里，只看周末，青苔便当店消费多少。',
    '2026/10账单里，青苔便当店消费多少并只看周末。',
    '2026/10青苔便当店消费多少，山岚面馆消费多少。',
    '2026/10青苔便当店和山岚面馆消费多少。',
    '2026/10青苔便当店一共扣了我多少钱，排除100元以下的。',
    '2026/10总支出多少，按周列出来。',
    '2026/10周末支出多少', '2026/10线上消费多少', '2026/10信用卡消费多少', '2026/10我在青苔便当店消费多少',
    '2026/10尾号1234账户消费多少', '2026/10请认真告诉我青苔便当店消费多少',
    '2026/10“青苔便当店消费多少',
    '2026/10账单里，餐饮类别占比多少',
    '2026/10账单里，单笔最大消费，只看山岚面馆',
  ])('rejects an unknown or extra requested constraint: %s', expectUnsupported);
  it('uses the grounded source rather than the model canonical summary', () => {
    const request = task('2026/10只看晚上，青苔便当店消费多少');
    request.canonicalMessage = '查询2026年10月账单汇总';
    expect(analyzeBills({ request, report: report() }).status).toBe('unsupported');
  });
});

describe('G9C query grammar preserves data coverage and recurring evidence contracts', () => {
  const merchantQuestion = '看看2026/10账单里，石桥茶馆一共扣了我多少钱，把对应流水也列出来。';
  it('reports a genuine complete-statement zero without manufacturing rows', () => {
    const result = query(merchantQuestion);
    expect(result).toMatchObject({ status: 'complete', amountMinor: '0', transactionIds: [], filter: { value: '石桥茶馆' } });
    expect(result.evidence.some(row => row.source.startsWith('bill-transaction:'))).toBe(false);
  });
  it.each([undefined, { status: 'missing' as const }])('keeps missing data unknown with coverage %j', coverage => {
    const request = task(merchantQuestion);
    const result = analyzeBills({ request, ...(coverage ? { report: report('2026-10', [], coverage) } : {}) });
    expect(result).toMatchObject({ status: 'missing_data', kind: 'filtered_expense', missingPeriods: ['2026-10'] });
    expect(result.amountMinor).toBeUndefined();
    expect(result.summary).toContain('未将缺失月份视为零支出');
  });
  it.each([{ rows: [] as Row[], expected: '0' }, { rows: [['partial', '石桥茶馆', '387', '餐饮']] as Row[], expected: '387' }])('limits a partial zero or amount to supplied rows: %j', ({ rows, expected }) => {
    const value = report('2026-10', rows, { status: 'partial', through: '2026-10-09T00:00:00Z' });
    const result = query(merchantQuestion, value);
    expect(result).toMatchObject({ status: 'partial', amountMinor: expected });
    expect(result.summary).toContain('尚不完整');
    expect(result.findings).toContain('BILL_DATA_PARTIAL');
    expect(buildBillReviewFacts({ analysis: result, report: value }).reports[0]).toMatchObject({ amountsStatus: 'partial' });
  });
  it('cites current matching rows plus historical finding support without adding support amounts again', () => {
    const value = report('2026-10', [['current-a', '白露音乐', '2150', '订阅'], ['current-b', '白露音乐', '2150', '订阅'], ['other', '其他订阅', '999', '订阅']]);
    value.evidenceTransactions = [{ ...value.transactions[0]!, id: 'prior', bookedAt: '2026-09-03T01:00:00Z' }];
    value.findings = [{ id: 'recurring-music', kind: 'RECURRING', transactionIds: ['current-a', 'current-b', 'prior'], summary: '相同商户金额的周期费用线索' }];
    const result = query('2026/10账单里，白露音乐总共扣了我多少钱？把对应流水也列出来', value);
    expect(result).toMatchObject({ status: 'complete', amountMinor: '4300', transactionIds: ['current-a', 'current-b'] });
    expect(result.evidence.find(row => row.source === 'bill-transaction:prior')?.detail).toContain('purpose=finding-support-only;excluded-from-query-total');
    expect(result.evidence.find(row => row.source === 'bill-finding:recurring-music')?.detail).toBe('current-a,current-b,prior');
    expect(result.evidence.some(row => row.source === 'bill-transaction:other')).toBe(false);
    const invalid = structuredClone(value); invalid.evidenceTransactions![0]!.merchant = '其他订阅';
    expect(query('2026/10白露音乐消费多少', invalid).status).toBe('unsupported');
  });
  it('preserves complete selected-month category comparison across clauses and readonly instructions', () => {
    const request = task('把2026年8月和10月支出按类别比较一下，哪个类别增加最多？请保留支持判断的原流水引用，别据此替我改任何订阅。');
    request.slots.billPeriod = { kind: 'selection', startPeriod: '2026-08', endPeriod: '2026-10', periods: ['2026-08', '2026-10'], source: { text: '2026年8月和10月' } };
    const before = report('2026-08', [['before', '山岚面馆', '1000', '餐饮']]);
    const result = analyzeBills({ request, reports: [before, report()] });
    expect(result).toMatchObject({ status: 'complete', kind: 'category_comparison', periods: ['2026-08', '2026-10'], largestIncreaseCategories: ['餐饮'] });
    expect(result.categoryChanges?.find(row => row.category === '餐饮')).toMatchObject({ beforeMinor: '1000', afterMinor: '7275', changeMinor: '6275' });
    before.coverage = { status: 'partial' };
    expect(analyzeBills({ request, reports: [before, report()] })).toMatchObject({ status: 'missing_data', missingPeriods: ['2026-08'] });
  });
});
