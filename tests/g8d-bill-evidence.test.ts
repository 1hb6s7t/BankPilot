import { describe, expect, it } from 'vitest';
import { analyzeBills } from '../packages/agents/src/bills';
import type { BillReport, BillTransaction, SemanticTask } from '../packages/contracts/src/index';

type Row = [id: string, merchant: string, amountMinor: string, category: BillTransaction['category'], direction?: BillTransaction['direction'], bookedAt?: string];

function report(period: string, rows: Row[], coverage: BillReport['coverage'] = { status: 'complete' }): BillReport {
  const transactions: BillTransaction[] = rows.map(([id, merchant, amountMinor, category, direction = 'OUT', bookedAt = `${period}-03T01:00:00.000Z`]) => ({
    id, merchant, amountMinor, category, direction, bookedAt, accountId: 'account', source: 'SYNTHETIC_STATEMENT',
  }));
  const sum = (side: BillTransaction['direction']) => transactions.filter(row => row.direction === side).reduce((total, row) => total + BigInt(row.amountMinor), 0n);
  const income = sum('IN'), expense = sum('OUT');
  return {
    period, source: 'SYNTHETIC', coverage, incomeMinor: income.toString(), expenseMinor: expense.toString(), netMinor: (income - expense).toString(),
    previousExpenseMinor: '0', categories: [], transactions, evidenceTransactions: [], findings: [], generatedAt: '2026-11-01T00:00:00.000Z',
  };
}

const augOctSelection: NonNullable<SemanticTask['slots']['billPeriod']> = {
  kind: 'selection', startPeriod: '2026-08', endPeriod: '2026-10', periods: ['2026-08', '2026-10'], source: { text: '2026年8月和10月' },
};

function comparisonTask(period = augOctSelection): SemanticTask {
  return {
    role: 'bills', operation: 'bills_query', source: { text: '比较2026年8月和10月哪类支出涨得最多' }, canonicalMessage: '查询账单',
    slots: { billPeriod: period },
  };
}

function transactionEvidence(result: ReturnType<typeof analyzeBills>) {
  return result.evidence.filter(item => item.source.startsWith('bill-transaction:'));
}

describe('G8D bill evidence is scoped, complete, and source-grounded', () => {
  it('keeps the valid October report and transaction evidence when August is missing, without comparing or filling zero', () => {
    const october = report('2026-10', [['oct-shop', '合成木棉书局', '12360', '购物']]);
    const result = analyzeBills({ request: comparisonTask(), reports: [october] });

    expect(result).toMatchObject({ status: 'missing_data', periods: ['2026-08', '2026-10'], missingPeriods: ['2026-08'] });
    expect(result.evidence.some(item => item.source === 'bill-report:2026-10:SYNTHETIC')).toBe(true);
    expect(transactionEvidence(result).map(item => item.source)).toEqual(['bill-transaction:oct-shop']);
    expect(transactionEvidence(result)[0]?.detail).toContain('合成木棉书局');
    expect(result.categoryChanges).toBeUndefined();
    expect(result.largestIncreaseCategories).toBeUndefined();
    expect(result.amountMinor).toBeUndefined();
    expect(result.summary).not.toMatch(/增加最多|增加\d|没有类别支出上升/);
    expect(result.summary).toContain('未将缺失月份视为零支出');
  });

  it('does not attach a valid but out-of-selection report or its rows to the answer', () => {
    const october = report('2026-10', [['oct-shop', '合成木棉书局', '12360', '购物']]);
    const september = report('2026-09', [['sep-only', '九月商户', '99999', '交通']]);
    const result = analyzeBills({ request: comparisonTask(), reports: [september, october] });

    expect(result.status).toBe('missing_data');
    expect(result.missingPeriods).toEqual(['2026-08']);
    expect(result.periods).toEqual(['2026-08', '2026-10']);
    expect(result.evidence.some(item => item.source.includes('2026-09'))).toBe(false);
    expect(result.evidence.some(item => item.source === 'bill-transaction:sep-only')).toBe(false);
    expect(result.transactionIds).not.toContain('sep-only');
    expect(result.categoryChanges).toBeUndefined();
  });

  it('accepts valid prior-period evidence for a recurring finding and exposes the referenced source row', () => {
    const october = report('2026-10', [['current-recurring', '合成流媒体订阅', '2500', '订阅']]);
    const prior: BillTransaction = {
      id: 'prior-recurring', merchant: '合成流媒体订阅', amountMinor: '2500', category: '订阅', direction: 'OUT',
      bookedAt: '2026-09-03T01:00:00.000Z', accountId: 'account', source: 'SYNTHETIC_STATEMENT',
    };
    october.evidenceTransactions = [prior];
    october.findings = [{
      id: 'recurring:current-recurring', kind: 'RECURRING', summary: '上月存在同商户同金额支出，可能为周期费用；尚未确认订阅关系。',
      transactionIds: ['current-recurring', 'prior-recurring'],
    }];
    const period: NonNullable<SemanticTask['slots']['billPeriod']> = {
      kind: 'month', startPeriod: '2026-10', endPeriod: '2026-10', source: { text: '2026年10月' },
    };
    const request: SemanticTask = { role: 'bills', operation: 'bills_query', source: { text: '2026年10月订阅消费是多少？' }, canonicalMessage: '查询账单', slots: { billPeriod: period } };
    const result = analyzeBills({ request, report: october });

    expect(result.status).toBe('complete');
    expect(result).toMatchObject({ amountMinor: '2500', transactionIds: ['current-recurring'] });
    expect(result.transactionIds).not.toContain('prior-recurring');
    expect(result.evidence.some(item => item.source === 'bill-finding:recurring:current-recurring')).toBe(true);
    expect(result.evidence.some(item => item.source === 'bill-transaction:prior-recurring' && item.detail.includes('2026-09-03') && item.detail.includes('2500'))).toBe(true);
  });

  it('rejects a recurring support row outside the immediately previous month', () => {
    const october = report('2026-10', [['current-recurring', '合成流媒体订阅', '2500', '订阅']]);
    october.evidenceTransactions = [{
      id: 'stale-recurring', merchant: '合成流媒体订阅', amountMinor: '2500', category: '订阅', direction: 'OUT',
      bookedAt: '2026-08-03T01:00:00.000Z', accountId: 'account', source: 'SYNTHETIC_STATEMENT',
    }];
    october.findings = [{
      id: 'recurring:current-recurring', kind: 'RECURRING', summary: '可能为周期费用。',
      transactionIds: ['current-recurring', 'stale-recurring'],
    }];
    const period: NonNullable<SemanticTask['slots']['billPeriod']> = {
      kind: 'month', startPeriod: '2026-10', endPeriod: '2026-10', source: { text: '2026年10月' },
    };
    const request: SemanticTask = { role: 'bills', operation: 'bills_query', source: { text: '2026年10月订阅消费是多少？' }, canonicalMessage: '查询账单', slots: { billPeriod: period } };
    const result = analyzeBills({ request, report: october });

    expect(result.status).toBe('unsupported');
    expect(result.amountMinor).toBeUndefined();
    expect(result.transactionIds).not.toContain('stale-recurring');
  });

  it('retains partial-month rows only as explicitly incomplete evidence, without comparing them as full months', () => {
    const augustPartial = report('2026-08', [['partial-aug', '八月商户', '5000', '购物']], { status: 'partial', through: '2026-08-12T00:00:00.000Z' });
    const octoberComplete = report('2026-10', [['oct-complete', '十月商户', '12360', '购物']]);
    const result = analyzeBills({ request: comparisonTask(), reports: [augustPartial, octoberComplete] });

    expect(result).toMatchObject({ status: 'missing_data', missingPeriods: ['2026-08'] });
    expect(result.missingPeriods).toContain('2026-08');
    expect(result.summary).toMatch(/2026年8月|2026-08/);
    expect(result.summary).toMatch(/未完整|不完整|缺少/);
    expect(result.evidence.some(item => item.source === 'bill-report:2026-10:SYNTHETIC')).toBe(true);
    expect(result.evidence.some(item => item.source === 'bill-report:2026-08:SYNTHETIC' && item.detail.includes('coverage=partial'))).toBe(true);
    expect(transactionEvidence(result).map(item => item.source)).toContain('bill-transaction:oct-complete');
    expect(transactionEvidence(result).map(item => item.source)).toContain('bill-transaction:partial-aug');
    expect(result.evidence.find(item => item.source === 'bill-transaction:partial-aug')?.detail).toMatch(/partial|partial-month|incomplete|不完整|未完整/i);
    expect(result.transactionIds).toContain('partial-aug');
    expect(result.categoryChanges).toBeUndefined();
    expect(result.amountMinor).toBeUndefined();
  });

  it.each([
    ['duplicate IDs', report('2026-10', [['duplicate', '商户甲', '1000', '购物'], ['duplicate', '商户乙', '2000', '餐饮']])],
    ['cross-month transaction', report('2026-10', [['wrong-month', '商户丙', '3000', '交通', 'OUT', '2026-08-31T16:30:00.000Z']])],
    ['invalid amount', report('2026-10', [['bad-amount', '商户丁', '1000', '购物']])],
  ])('does not retain report or transaction evidence from a selected report with %s', (fault, october) => {
    if (fault === 'invalid amount') october.transactions[0]!.amountMinor = '-1';
    const august = report('2026-08', [['aug-valid', '八月商户', '4000', '餐饮']]);
    const result = analyzeBills({ request: comparisonTask(), reports: [august, october] });

    expect(result.status).not.toBe('complete');
    expect(result.categoryChanges).toBeUndefined();
    expect(transactionEvidence(result).some(item => /duplicate|wrong-month|bad-amount/.test(item.source))).toBe(false);
    expect(result.evidence.some(item => item.source === 'bill-report:2026-10:SYNTHETIC')).toBe(false);
  });
});

describe('merchant wording stays transparent without inventing a category', () => {
  it('matches a general bookstore synonym transparently, while excluding unrelated merchants in the same category', () => {
    const september = report('2026-09', [
      ['shop-suffix', '合成木棉书局', '2300', '购物'],
      ['shop-literal', '合成海棠书店', '1000', '购物'],
      ['same-category-other-merchant', '合成便利店', '8700', '购物'],
    ]);
    const period: NonNullable<SemanticTask['slots']['billPeriod']> = {
      kind: 'month', startPeriod: '2026-09', endPeriod: '2026-09', source: { text: '2026年9月' },
    };
    const request: SemanticTask = {
      role: 'bills', operation: 'bills_query', source: { text: '2026年9月书店消费是多少？' }, canonicalMessage: '查询账单', slots: { billPeriod: period },
    };
    const result = analyzeBills({ request, report: september });

    expect(result).toMatchObject({ status: 'complete', kind: 'filtered_expense', amountMinor: '3300', filter: { kind: 'merchant_contains', value: '书店', terms: ['书店', '书局'] } });
    expect(result.transactionIds).toEqual(['shop-suffix', 'shop-literal']);
    expect(result.transactionIds).not.toContain('same-category-other-merchant');
    expect(result.summary).toContain('书局');
    expect(result.summary).toMatch(/书店|书局/);
    expect(result.evidence.some(item => item.source === 'bill-transaction:shop-suffix')).toBe(true);
    expect(result.summary).not.toContain('「购物」类别');
  });

  it.each([
    ['quoted generic wording', '2026年9月“书店”消费是多少？', '书店'],
    ['a full merchant name', '2026年9月合成海棠书店消费是多少？', '合成海棠书店'],
  ])('does not expand %s into a broader merchant alias set', (_caseName, source, expectedMerchant) => {
    const september = report('2026-09', [
      ['literal-bookstore', '合成海棠书店', '1000', '购物'],
      ['alias-bookshop', '合成木棉书局', '2300', '购物'],
    ]);
    const period: NonNullable<SemanticTask['slots']['billPeriod']> = {
      kind: 'month', startPeriod: '2026-09', endPeriod: '2026-09', source: { text: '2026年9月' },
    };
    const request: SemanticTask = { role: 'bills', operation: 'bills_query', source: { text: source }, canonicalMessage: '查询账单', slots: { billPeriod: period } };
    const result = analyzeBills({ request, report: september });

    expect(result.status).toBe('complete');
    expect(result.filter).toMatchObject({ kind: 'merchant_contains', value: expectedMerchant });
    expect(result.filter?.terms).toBeUndefined();
    expect(result.transactionIds).toEqual(['literal-bookstore']);
    expect(result.amountMinor).toBe('1000');
  });
});
