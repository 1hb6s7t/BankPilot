import { describe, expect, it } from 'vitest';
import type { Planner } from '../packages/contracts/src';
import { validateSemanticIntent, type SemanticIntentDraft } from '../packages/agents/src/semantic-intent';
import { resolveLifeGoal } from '../packages/agents/src/financial';

type Input = Parameters<Planner['plan']>[0];
const base: Input = { taskId: 'g8f-independent-goal', message: '', referenceDate: '2026-10-23',
  accounts: [{ id: 'account-a', name: '合成账户', maskedNumber: '****2040', balanceMinor: '800000', reservedMinor: '0', currency: 'CNY' }],
  payees: [{ id: 'payee-a', name: '陈禾', aliases: [], bank: '合成银行', maskedNumber: '****1240' }],
  investmentContext: { businessDate: '2026-10-23', calendar: 'DEMO_WEEKDAYS_V1', products: [], actions: [], positions: [
    { id: 'position-a', accountId: 'account-a', productId: 'product-a', productName: '雾岚稳健组合 T+0', principalMinor: '600000', availableMinor: '600000', reservedMinor: '0', version: 2, redemptionBusinessDays: 0, calendar: 'DEMO_WEEKDAYS_V1' },
  ] } };
const normal = '给陈禾准备640元学费，2028-11-20前到账；先从雾岚稳健组合赎回900元';
function draft(message: string, literal: boolean): SemanticIntentDraft {
  return { tasks: [{ operation: 'goal_create', disposition: 'request', scope: literal ? { text: message } : { source: 'whole_message' },
    entity: { kind: 'payee', id: 'payee-a', mention: { text: '陈禾' } }, amount: { text: '640元' }, date: { text: '2028-11-20' },
    funding: { entity: { kind: 'position', id: 'position-a', mention: { text: '雾岚稳健组合' } }, amount: { text: '900元' } } }] };
}
function resolve(message: string, literal: boolean, edit?: (value: SemanticIntentDraft) => void, input = base) {
  const value = draft(message, literal); edit?.(value);
  return validateSemanticIntent({ ...input, message }, value);
}

describe.each([false, true])('future-goal funding provenance with literal scope=%s', literal => {
  it.each([
    normal,
    normal.replace('先从', '从'),
    normal.replace('先从', '另外从') + '，作为这个目标的资金来源',
    normal.replace('先从', '现在从') + '用于支付这笔学费',
    normal.replace('先从', '先单独从') + '用于学费，每笔动作单独授权',
    normal.replace('学费', '医疗备用金') + '，用作该目标的资金来源',
    normal.replace('学费', '独立研究课程学费'),
    normal.replace('640元', '640元').replace('先从', '为此先从'),
    '先从雾岚稳健组合赎回900元用于学费；给陈禾准备640元学费，2028-11-20前到账',
    normal.replace('；先从', '；作为学费的资金来源，先从'),
    normal.replace('学费', '学费生活目标') + '，确认实际到账后再准备转账',
  ])('preserves an actual goal dependency without an immediate action: %s', message => {
    const result = resolve(message, literal);
    expect(result.status).toBe('ready'); expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]).toMatchObject({ operation: 'goal_create', source: { text: message }, slots: {
      entityId: 'payee-a', amountMinor: '64000', targetDate: '2028-11-20', funding: { positionId: 'position-a', amountMinor: '90000' },
    } });
    const domain = resolveLifeGoal({ ...base, message: result.tasks[0]!.canonicalMessage });
    expect(domain.goalSuggestion).toMatchObject({ accountId: 'account-a', payeeId: 'payee-a', amountMinor: '64000', targetDate: '2028-11-20',
      funding: { positionId: 'position-a', redemptionAmountMinor: '90000' } });
    expect(domain.summary).toContain('每笔资金动作独立授权');
  });
  it.each([
    normal.replace('先从', '另外独立立即从'),
    normal.replace('先从', '另外单独从'),
    normal.replace('先从', '另外从'),
    normal.replace('先从', '立即从'),
    normal.replace('先从', '另外从') + '，这笔赎回与学费目标无关',
    normal + '，这笔赎回与目标分开处理',
    normal + '，这次赎回和学费目标没有关系',
    normal.replace('学费，', '学费但这次赎回跟该目标没关系，'),
    normal + '，赎回资金用于另外的旅行开销',
    normal + '，目标资金来源另算',
    normal + '，另外查询这款理财的余额',
    normal + '，然后查看理财到账规则',
    normal.replace('学费，', '学费并查询理财余额，'),
    normal.replace('学费，', '生活目标并立即转账给他，'),
    normal + '，2028-11-25才是实际截止日期',
  ])('does not collapse an independent operation or missing condition into funding: %s', message => {
    const result = resolve(message, literal);
    expect(result.status).toBe('clarification'); expect(result.tasks).toEqual([]);
  });
  it('cannot repair the operation by deleting the date and funding fields', () => {
    const result = resolve(normal, literal, value => { value.tasks[0]!.operation = 'transfer'; delete value.tasks[0]!.date; delete value.tasks[0]!.funding; });
    expect(result.status).toBe('clarification'); expect(result.tasks).toEqual([]);
  });
  it('keeps a transfer candidate with goal-only fields rejected rather than rewriting it', () => {
    expect(resolve(normal, literal, value => { value.tasks[0]!.operation = 'transfer'; }).findings).toContain('SEMANTIC_UNEXPECTED_SLOT');
  });
  it('does not swap the target and redemption amounts', () => {
    const result = resolve(normal, literal, value => { value.tasks[0]!.amount = { text: '900元' }; value.tasks[0]!.funding!.amount = { text: '640元' }; });
    expect(result.findings).toContain('SEMANTIC_GOAL_AMOUNT_BINDING_INVALID'); expect(result.tasks).toEqual([]);
  });
  it('does not invent a missing year', () => {
    expect(resolve(normal.replace('2028-11-20', '11-20'), literal, value => { value.tasks[0]!.date = { text: '11-20' }; }).findings).toContain('SEMANTIC_TARGET_DATE_INVALID');
  });
  it('cannot discard the explicitly supplied funding amount', () => {
    expect(resolve(normal, literal, value => { delete value.tasks[0]!.funding; }).findings).toContain('SEMANTIC_AMOUNT_AMBIGUOUS');
  });
  it('does not guess an unknown funding position', () => {
    const message = normal.replace('雾岚稳健组合', '未知优选理财');
    const result = resolve(message, literal, value => { value.tasks[0]!.funding!.entity.mention = { text: '未知优选理财' }; });
    expect(result.status).toBe('clarification'); expect(result.tasks).toEqual([]);
  });
  it.each(['不要' + normal, '以前' + normal, `“${normal}”`])('does not act on negated, historical or quoted source: %s', message => {
    expect(resolve(message, literal).tasks).toEqual([]);
  });
  it('cannot crop the full source to omit a separate current transfer', () => {
    const message = normal + '，另外立即给林舟转账50元';
    const result = resolve(message, literal, value => { value.tasks[0]!.scope = { text: normal }; });
    expect(result.findings).toContain('SEMANTIC_SOURCE_COVERAGE_INCOMPLETE'); expect(result.tasks).toEqual([]);
  });
  it('does not flatten a full-scope goal and independent transfer into one task', () => {
    const result = resolve(normal + '，另外立即给林舟转账50元', literal);
    expect(result.status).toBe('clarification'); expect(result.tasks).toEqual([]);
  });
});

it('preserves a funded goal and an independent bills query when each has its own complete scope', () => {
  const billScope = '查询2027年3月账单';
  const message = normal + '；' + billScope;
  const value = draft(normal, true);
  value.tasks.push({ operation: 'bills_query', disposition: 'query', scope: { text: billScope }, period: { text: '2027年3月' } });
  const result = validateSemanticIntent({ ...base, message }, value);
  expect(result.status).toBe('ready');
  expect(result.tasks.map(task => task.operation)).toEqual(['goal_create', 'bills_query']);
  expect(result.tasks[0]).toMatchObject({ source: { text: normal }, slots: {
    entityId: 'payee-a', amountMinor: '64000', targetDate: '2028-11-20', funding: { positionId: 'position-a', amountMinor: '90000' },
  } });
  expect(result.tasks[1]).toMatchObject({ source: { text: billScope }, slots: { billPeriod: { kind: 'month', startPeriod: '2027-03', endPeriod: '2027-03', source: { text: '2027年3月' } } } });
});
