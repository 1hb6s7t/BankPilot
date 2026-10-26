import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BillReport, BillTransaction, PlannerInput } from '../packages/contracts/src';
import { analyzeBills } from '../packages/agents/src/bills';
import { interpretSemanticIntent, validateSemanticIntent, type SemanticIntentDraft } from '../packages/agents/src/semantic-intent';
import type { OpenAICompatibleConfig } from '../packages/agents/src/provider';

const period = '2026年8月';
const base: PlannerInput = { taskId: 'g9g-independent-bill-literal', message: '', accounts: [], payees: [], referenceDate: '2026-10-25' };
const provider: OpenAICompatibleConfig = { baseURL: 'https://g9g-pure.invalid/v1', model: 'synthetic', outputMode: 'json_object', maxAttempts: 2, maxStructureRepairs: 1, retryDelayMs: 0, maxOutputTokens: 4096 };
const envelope = (raw: unknown) => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(raw) } }] }));
type Row = [string, string, string, BillTransaction['category'], BillTransaction['direction']?];
const rows: Row[] = [
  ['meal-a', '汀鹭食堂', '1785', '餐饮'], ['meal-b', '汀鹭食堂北店', '2468', '餐饮'], ['other-food', '近叶茶馆', '1024', '餐饮'],
  ['incoming', '汀鹭食堂', '99999', '收入', 'IN'], ['books', '北岭文具店', '3588', '购物'], ['audio', '禾隙听书', '2300', '订阅'],
];
function statement(values = rows, coverage: BillReport['coverage'] = { status: 'complete' }): BillReport {
  const transactions: BillTransaction[] = values.map(([id, merchant, amountMinor, category, direction = 'OUT']) => ({ id, merchant, amountMinor, category, direction, accountId: 'synthetic-bill-account', bookedAt: '2026-08-12T01:00:00Z', source: 'SYNTHETIC_STATEMENT' }));
  const sum = (direction: BillTransaction['direction']) => transactions.filter(row => row.direction === direction).reduce((total, row) => total + BigInt(row.amountMinor), 0n);
  return { period: '2026-08', source: 'SYNTHETIC', coverage, generatedAt: '2026-09-01T00:00:00Z', incomeMinor: sum('IN').toString(), expenseMinor: sum('OUT').toString(), netMinor: (sum('IN') - sum('OUT')).toString(), previousExpenseMinor: '0', categories: [], transactions, findings: [] };
}
const billDraft = (): SemanticIntentDraft => ({ tasks: [{ operation: 'bills_query', disposition: 'query', scope: { source: 'whole_message' }, period: { text: period } }] });
function sourceToAnalysis(message: string, report?: BillReport, input = base) {
  const resolution = validateSemanticIntent({ ...input, message }, billDraft(), { referenceDate: input.referenceDate });
  expect({ status: resolution.status, findings: resolution.findings }).toEqual({ status: 'ready', findings: [] });
  expect(resolution.tasks).toHaveLength(1); expect(resolution.tasks[0]!.source).toEqual({ text: message, start: 0, end: message.length });
  expect(resolution.tasks[0]!.slots).toEqual({ billPeriod: { kind: 'month', startPeriod: '2026-08', endPeriod: '2026-08', source: { text: period, start: message.indexOf(period), end: message.indexOf(period) + period.length } } });
  return analyzeBills({ request: resolution.tasks[0], ...(report ? { report } : {}) });
}
afterEach(() => vi.unstubAllGlobals());

describe('G9G bills extraction guidance distinguishes literal predicates from execution identities', () => {
  it('sends the operation-specific contract and schema descriptions without adding output fields or statement hints', async () => {
    const message = `看看${period}账单里，汀鹭食堂一共扣了我多少钱，把对应流水也列出来。`;
    const fetch = vi.fn(async (_url: unknown, _init?: RequestInit) => envelope(billDraft())); vi.stubGlobal('fetch', fetch);
    const result = await interpretSemanticIntent({ ...base, message }, { provider });
    expect(result.status).toBe('ready'); expect(fetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(fetch.mock.calls[0]![1]!.body)), task = JSON.parse(body.messages[1].content);
    expect(task.message).toBe(message); expect(task.catalog).toEqual([]); expect(task.billReport).toBeUndefined();
    expect(task.sourceBindingContract.billQueryScope).toContain('literal source predicates');
    expect(task.sourceBindingContract.billQueryScope).toContain('NO payee/position/card/subscription catalog identity');
    expect(task.sourceBindingContract.billQueryScope).toContain('ALL conditions/evidence requests');
    expect(task.sourceBindingContract.billQueryScope).toContain('genuine zero, partial or missing data');
    expect(task.sourceBindingContract.billQueryScope).toContain('Preserve ambiguous/unsupported');
    expect(task.instruction).toContain('Only tasks that bind a payee, position, card or subscription');
    expect(task.instruction).toContain('do not mark a clear query ambiguous merely because that name is absent');
    const schema = JSON.parse(body.messages[0].content.split('Required JSON schema: ')[1].trim());
    const fields = schema.properties.tasks.items.properties;
    expect(Object.keys(fields).sort()).toEqual(['operation', 'disposition', 'scope', 'entity', 'amount', 'memo', 'purpose', 'date', 'period', 'funding'].sort());
    expect(fields.entity.description).toContain('literal source filters');
    expect(fields.scope.description).toContain('every original merchant/category predicate');
    expect(fields.period.description).toContain('Merchant/category names and filter conditions stay unchanged in scope');
    expect(schema.properties.tasks.items.required).not.toContain('entity');
  });
  it('does not flip ambiguous or spend a repair to turn it into a query', async () => {
    const message = `看看${period}账单里，汀鹭食堂一共扣了我多少钱。`, ambiguous = billDraft(); ambiguous.tasks[0]!.disposition = 'ambiguous';
    const fetch = vi.fn().mockResolvedValueOnce(envelope(ambiguous)).mockResolvedValueOnce(envelope(billDraft())); vi.stubGlobal('fetch', fetch);
    const result = await interpretSemanticIntent({ ...base, message }, { provider });
    expect(result.status).toBe('clarification'); expect(result.tasks).toEqual([]); expect(result.findings).toContain('SEMANTIC_UNSUPPORTED_OR_AMBIGUOUS'); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('preserves the literal predicate through the existing bounded missing-period repair', async () => {
    const message = `看看${period}账单里，汀鹭食堂一共扣了我多少钱，把对应流水也列出来。`, first = billDraft(); delete first.tasks[0]!.period;
    const fetch = vi.fn().mockResolvedValueOnce(envelope(first)).mockResolvedValueOnce(envelope(billDraft())); vi.stubGlobal('fetch', fetch);
    const result = await interpretSemanticIntent({ ...base, message }, { provider });
    expect(fetch).toHaveBeenCalledTimes(2); expect(result.status).toBe('ready'); expect(result.tasks[0]!.source.text).toBe(message); expect(result.tasks[0]!.slots.entityId).toBeUndefined();
    expect(analyzeBills({ request: result.tasks[0], report: statement() })).toMatchObject({ status: 'complete', kind: 'filtered_expense', filter: { kind: 'merchant_contains', value: '汀鹭食堂' }, amountMinor: '4253', transactionIds: ['meal-a', 'meal-b'] });
  });
});

describe('G9G original source still governs read-only merchant/category predicates and coverage', () => {
  it.each([
    [`看看${period}账单里，汀鹭食堂一共扣了我多少钱，把对应流水也列出来。`, '汀鹭食堂', '4253', ['meal-a', 'meal-b']],
    [`${period}北岭文具店消费多少，请给出对应流水编号。`, '北岭文具店', '3588', ['books']],
    [`${period}禾隙听书一共扣了我多少钱。`, '禾隙听书', '2300', ['audio']],
  ] as const)('reads the literal without a payee or subscription identity: %s', (message, value, amountMinor, transactionIds) => {
    const result = sourceToAnalysis(message, statement());
    expect(result).toMatchObject({ status: 'complete', kind: 'filtered_expense', filter: { kind: 'merchant_contains', value }, amountMinor, transactionIds: [...transactionIds] });
    expect(result.evidence.filter(row => row.source.startsWith('bill-transaction:')).map(row => row.source)).toEqual(transactionIds.map(id => `bill-transaction:${id}`));
  });
  it('keeps a category query distinct from the one-merchant query and excludes matching incoming rows', () => {
    expect(sourceToAnalysis(`请查询${period}餐饮类别的总支出，并给出对应流水编号。`, statement())).toMatchObject({ status: 'complete', filter: { kind: 'category', value: '餐饮' }, amountMinor: '5277', transactionIds: ['meal-a', 'meal-b', 'other-food'] });
    expect(sourceToAnalysis(`${period}汀鹭食堂消费多少`, statement())).toMatchObject({ amountMinor: '4253', transactionIds: ['meal-a', 'meal-b'] });
  });
  it('does not turn a literal matching a saved payee into a payment identity', () => {
    const input: PlannerInput = { ...base, payees: [{ id: 'payee-only', name: '汀鹭食堂', aliases: [], bank: '合成银行', maskedNumber: '****3901' }] };
    expect(sourceToAnalysis(`${period}汀鹭食堂消费多少`, statement(), input)).toMatchObject({ filter: { kind: 'merchant_contains', value: '汀鹭食堂' }, amountMinor: '4253' });
  });
  it('keeps bill charges read-only when the same literal also names an authorized subscription', () => {
    const input: PlannerInput = { ...base, managementContext: { cards: [], subscriptions: { queryActionId: 'synthetic-query', queriedAt: '2026-10-25T00:00:00Z', accessExpiresAt: '2100-01-01T00:00:00Z', items: [{ id: 'subscription-only', merchant: '禾隙听书', amountMinor: '2300', currency: 'CNY', nextChargeDate: '2026-11-08', cardId: 'synthetic-card', merchantStatus: 'ACTIVE', bankStatus: 'ALLOWED', collectionStatus: 'ENABLED', version: 3, cancellationSupported: true, source: 'SYNTHETIC_MERCHANT' }] } } };
    expect(sourceToAnalysis(`${period}禾隙听书消费多少`, statement(), input)).toMatchObject({ status: 'complete', filter: { kind: 'merchant_contains', value: '禾隙听书' }, amountMinor: '2300', transactionIds: ['audio'] });
  });
  it('accepts a genuinely absent literal as complete zero without inventing matching rows', () => {
    const result = sourceToAnalysis(`${period}海棠手作店消费多少`, statement());
    expect(result).toMatchObject({ status: 'complete', amountMinor: '0', filter: { kind: 'merchant_contains', value: '海棠手作店' }, transactionIds: [] });
    expect(result.evidence.some(item => item.source.startsWith('bill-transaction:'))).toBe(false);
  });
  it.each([{ values: [] as Row[] }, { values: [['partial', '汀鹭食堂', '619', '餐饮']] as Row[] }])('does not promote partial supplied rows into a complete answer: %j', ({ values }) => {
    const result = sourceToAnalysis(`${period}汀鹭食堂消费多少`, statement(values, { status: 'partial', through: '2026-08-07T00:00:00Z' }));
    expect(result.status).toBe('partial'); expect(result.amountMinor).toBe(values.length ? '619' : '0'); expect(result.findings).toContain('BILL_DATA_PARTIAL');
  });
  it.each(['absent', 'missing'] as const)('does not interpret %s statement data as zero', state => {
    const result = sourceToAnalysis(`${period}海棠手作店消费多少`, state === 'missing' ? statement([], { status: 'missing' }) : undefined);
    expect(result).toMatchObject({ status: 'missing_data', missingPeriods: ['2026-08'], transactionIds: [] }); expect(result.amountMinor).toBeUndefined();
  });
  it.each(['只看周末', '排除100元以下的', '按周列出来', '近叶茶馆消费多少', '只看线上', '餐饮类别占比多少'])('never drops the extra unsupported condition: %s', tail => {
    const message = `${period}汀鹭食堂消费多少，${tail}`, resolution = validateSemanticIntent({ ...base, message }, billDraft());
    if (resolution.status !== 'ready') { expect(resolution.status).toBe('clarification'); expect(resolution.tasks).toEqual([]); return; }
    expect(resolution.tasks[0]!.source.text).toBe(message);
    const result = analyzeBills({ request: resolution.tasks[0], report: statement() });
    expect(result.status).toBe('unsupported'); expect(result.amountMinor).toBeUndefined(); expect(result.transactionIds).toEqual([]); expect(result.evidence).toEqual([]);
  });
});

describe('G9G source and execution boundaries remain conservative', () => {
  it.each(['transfer', 'subscription_cancel', 'subscription_block'] as const)('the same unknown literal does not supply a %s execution identity', operation => {
    const message = operation === 'transfer' ? '给汀鹭食堂转76元' : operation === 'subscription_cancel' ? '取消汀鹭食堂的订阅' : '在银行侧阻止汀鹭食堂扣款';
    const draft: SemanticIntentDraft = { tasks: [{ operation, disposition: 'request', scope: { source: 'whole_message' }, ...(operation === 'transfer' ? { amount: { text: '76元' } } : {}) }] };
    expect(validateSemanticIntent({ ...base, message }, draft).tasks).toEqual([]);
    draft.tasks[0]!.entity = { kind: operation === 'transfer' ? 'payee' : 'subscription', id: 'invented-execution-id', mention: { text: '汀鹭食堂' } };
    const result = validateSemanticIntent({ ...base, message }, draft);
    expect(result.status).toBe('clarification'); expect(result.tasks).toEqual([]);
  });
  it('does not delete an invented entity if a model still supplies one for a bill predicate', () => {
    const message = `${period}汀鹭食堂消费多少`, raw = billDraft(); raw.tasks[0]!.entity = { kind: 'payee', id: 'invented', mention: { text: '汀鹭食堂' } };
    expect(validateSemanticIntent({ ...base, message }, raw).tasks).toEqual([]);
  });
  it.each(['merchant', 'tail', 'period'])('rejects %s source shortening instead of answering an enlarged monthly scope', change => {
    const message = `看看${period}账单里，汀鹭食堂消费多少，请列出对应流水编号。`, raw = billDraft();
    if (change === 'merchant') raw.tasks[0]!.scope = { text: `看看${period}账单里` };
    if (change === 'tail') raw.tasks[0]!.scope = { text: `看看${period}账单里，汀鹭食堂消费多少` };
    if (change === 'period') raw.tasks[0]!.period = { text: '8月' };
    const result = validateSemanticIntent({ ...base, message }, raw);
    expect(result.status).toBe('clarification'); expect(result.tasks).toEqual([]);
  });
  it.each([`不要查询${period}汀鹭食堂消费多少`, `请改写“查询${period}汀鹭食堂消费多少”`])('does not activate a negated/quoted request: %s', message => {
    const result = validateSemanticIntent({ ...base, message }, billDraft());
    expect(result.status).not.toBe('ready'); expect(result.tasks).toEqual([]);
  });
  it('retains the existing unknown quoted-noun source guard', () => {
    const message = `${period}“汀鹭食堂”消费多少`, result = validateSemanticIntent({ ...base, message }, billDraft());
    expect(result.status).toBe('clarification'); expect(result.findings).toContain('SEMANTIC_QUOTED_ARGUMENT_UNRESOLVED');
  });
  it('does not swallow an independent unknown payment after a valid bill query', () => {
    const read = `${period}汀鹭食堂消费多少`, payment = '另外给海棠手作店转76元', message = `${read}；${payment}`;
    const onlyBill = validateSemanticIntent({ ...base, message }, billDraft()); expect(onlyBill.tasks).toEqual([]);
    const raw = billDraft(); raw.tasks[0]!.scope = { text: read }; raw.tasks.push({ operation: 'transfer', disposition: 'request', scope: { text: payment }, amount: { text: '76元' } });
    const result = validateSemanticIntent({ ...base, message }, raw); expect(result.status).toBe('clarification'); expect(result.tasks).toEqual([]);
  });
});
