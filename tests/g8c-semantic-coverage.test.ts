import { describe, expect, it } from 'vitest';
import type { Planner } from '../packages/contracts/src';
import { validateSemanticIntent, type SemanticIntentDraft } from '../packages/agents/src/semantic-intent';

const input = (message: string): Parameters<Planner['plan']>[0] => ({ taskId: 'coverage-independent', message, accounts: [], payees: [{ id: 'p', name: '顾宁', aliases: [], bank: '合成银行', maskedNumber: '****1172' }] });
const bill = (scope = '查询2027-03账单'): SemanticIntentDraft['tasks'][number] => ({ operation: 'bills_query', disposition: 'query', scope: { text: scope }, period: { text: '2027-03' } });
const transfer = (scope: string): SemanticIntentDraft['tasks'][number] => ({ operation: 'transfer', disposition: 'request', scope: { text: scope }, entity: { kind: 'payee', id: 'p', mention: { text: '顾宁' } }, amount: { text: '120元' } });
const run = (message: string, tasks: SemanticIntentDraft['tasks']) => validateSemanticIntent(input(message), { tasks });

describe('complete original source coverage', () => {
  it.each(['再给顾宁转120元', '不过给顾宁打120元', '但替我付120元给顾宁', '120元', '2027-05', '不要转账', '查询理财', '顾宁'])('does not omit meaningful text after an already grounded period: %s', tail => {
    const result = run(`查询2027-03账单，${tail}`, [bill()]);
    expect(result.status).toBe('clarification'); expect(result.tasks).toEqual([]);
  });
  it('accepts correct separately grounded domain scopes', () => {
    const result = run('查询2027-03账单，再给顾宁转120元', [bill(), transfer('再给顾宁转120元')]);
    expect(result.status).toBe('ready'); expect(result.tasks.map(task => task.role)).toEqual(['bills', 'transfer']);
  });
  it('allows an explicit connective gap with no omitted business content', () => {
    const result = run('请，查询2027-03账单，然后，给顾宁转120元', [bill(), transfer('给顾宁转120元')]);
    expect(result.status).toBe('ready');
  });
  it.each(['negated', 'historical', 'quoted'] as const)('does not use an ungrounded %s disposition to cover an omitted positive task', disposition => {
    const result = run('查询2027-03账单，给顾宁转120元', [bill(), { ...transfer('给顾宁转120元'), disposition }]);
    expect(result.status).toBe('clarification'); expect(result.tasks).toEqual([]);
  });
  it.each([
    ['不要给顾宁转120元', 'negated'],
    ['历史记录：给顾宁转120元', 'historical'],
    ['“给顾宁转120元”', 'quoted'],
  ] as const)('counts a verified inactive source as coverage: %s', (text, disposition) => {
    const result = run(`查询2027-03账单，${text}`, [bill(), { operation: 'transfer', disposition, scope: { text } }]);
    expect(result.status).toBe('ready'); expect(result.tasks.map(task => task.role)).toEqual(['bills']);
  });
  it('cannot hide a positive later request inside an historical label', () => {
    const text = '历史记录：给顾宁转120元，另外给顾宁打80元';
    const result = run(`查询2027-03账单，${text}`, [bill(), { operation: 'transfer', disposition: 'historical', scope: { text } }]);
    expect(result.status).toBe('clarification');
  });
  it('cannot hide a positive later request inside a negated label', () => {
    const text = '不要给顾宁转120元，但给顾宁打80元';
    const result = run(`查询2027-03账单，${text}`, [bill(), { operation: 'transfer', disposition: 'negated', scope: { text } }]);
    expect(result.status).toBe('clarification');
  });
  it('does not report no_action when a historical scope omits a current request', () => {
    const result = run('历史记录：给顾宁转120元，查询2027-03账单', [{ operation: 'transfer', disposition: 'historical', scope: { text: '历史记录：给顾宁转120元' } }]);
    expect(result.status).toBe('clarification');
  });
  it.each(['说明记录另一次120元', '补充记录90元'])('permits only a complete typed record-only amount annotation: %s', note => {
    const result = run(`给顾宁转120元，${note}`, [transfer('给顾宁转120元')]);
    expect(result.status).toBe('ready'); expect(result.tasks[0]?.slots.amountMinor).toBe('12000');
  });
  it.each(['说明记录顾宁120元', '说明记录2027-03-05的120元', '说明记录给顾宁转120元', '说明记录不要120元', '说明记录另一次120元再付80元', '说明记录另一次120元用于房租', '说明记录另一次120元，查询理财', '说明记录另一次120元，不转账', '说明记录另一次120元或80元'])('rejects business content inside or after a purported record-only note: %s', note => {
    const result = run(`给顾宁转120元，${note}`, [transfer('给顾宁转120元')]);
    expect(result.status).toBe('clarification'); expect(result.tasks).toEqual([]);
  });
});
