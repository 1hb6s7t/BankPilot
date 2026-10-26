import { describe, expect, it } from 'vitest';
import { goalDraftSchema, type Planner } from '../packages/contracts/src/index';
import { resolveLifeGoal } from '../packages/agents/src/financial';
import { interpretSemanticIntent, semanticIntentSchema, validateSemanticIntent, type SemanticIntentDraft } from '../packages/agents/src/semantic-intent';

type Input = Parameters<Planner['plan']>[0];
type DraftTask = SemanticIntentDraft['tasks'][number];
const base: Input = {
  taskId: 'future-purpose-language', message: '',
  accounts: [{ id: 'account-a', name: '合成账户', maskedNumber: '****3518', balanceMinor: '900000', reservedMinor: '0', currency: 'CNY' }],
  payees: [{ id: 'payee-a', name: '陈禾', aliases: ['小禾'], bank: '合成银行', maskedNumber: '****2468' }],
  investmentContext: { businessDate: '2026-10-24', calendar: 'DEMO_WEEKDAYS_V1', actions: [], products: [], positions: [
    { id: 'position-a', accountId: 'account-a', productId: 'product-a', productName: '雾岚稳健组合 T+1', principalMinor: '400000', reservedMinor: '0', availableMinor: '400000', version: 4, redemptionBusinessDays: 1, calendar: 'DEMO_WEEKDAYS_V1' },
  ] },
};
function goal(message: string, literal: boolean, options: { purpose?: string; date?: string; funding?: boolean } = {}): DraftTask {
  return { operation: 'goal_create', disposition: 'request', scope: literal ? { text: message } : { source: 'whole_message' },
    entity: { kind: 'payee', id: 'payee-a', mention: { text: '陈禾' } }, amount: { text: '640元' }, date: { text: options.date ?? '2028-11-20' },
    ...(options.purpose ? { purpose: { text: options.purpose } } : {}),
    ...(options.funding ? { funding: { entity: { kind: 'position', id: 'position-a', mention: { text: '雾岚稳健组合' } }, amount: { text: '900元' } } } : {}),
  };
}
const resolve = (message: string, task: DraftTask, input = base) => validateSemanticIntent({ ...input, message }, { tasks: [task] });

describe.each([false, true])('general future goal source with literal scope=%s', literal => {
  it('preserves an 80-code-unit purpose through the existing goal title schema', () => {
    const purpose = `${'课'.repeat(78)}学费`;
    expect(purpose.length).toBe(80);
    const message = `给陈禾准备640元${purpose}，2028-11-20前到账`;
    const result = resolve(message, goal(message, literal, { purpose }));
    expect(result.status).toBe('ready'); expect(result.tasks[0]!.slots.purpose).toBe(purpose);
    const domain = resolveLifeGoal({ ...base, message: result.tasks[0]!.canonicalMessage, semanticIntent: result });
    expect(domain.goalSuggestion?.title).toBe(purpose);
    expect(goalDraftSchema.safeParse(domain.goalSuggestion).success).toBe(true);
  });

  it('returns a typed value clarification for an 81-code-unit source purpose without truncation', () => {
    const purpose = `${'课'.repeat(79)}学费`;
    expect(purpose.length).toBe(81);
    const message = `给陈禾准备640元${purpose}，2028-11-20前到账`;
    const draft = goal(message, literal, { purpose });
    // Raw semantic spans carry the complete immutable source. The existing
    // title limit belongs to grounded value validation, not source rewriting.
    expect(semanticIntentSchema.parse({ tasks: [draft] }).tasks[0]!.purpose!.text).toBe(purpose);
    const result = resolve(message, draft);
    expect(result).toMatchObject({ status: 'clarification', tasks: [], issues: [{ path: ['tasks', '0', 'purpose'], category: 'value', code: 'SEMANTIC_GOAL_PURPOSE_TOO_LONG' }] });
    expect(result.clarification).toContain('80');
  });

  it('keeps the raw purpose verbatim instead of applying the title schema trim transform', () => {
    const purpose = ` ${'课'.repeat(79)}`;
    const message = `给陈禾准备640元${purpose}，2028-11-20前到账`;
    const draft = goal(message, literal, { purpose });
    expect(semanticIntentSchema.parse({ tasks: [draft] }).tasks[0]!.purpose!.text).toBe(purpose);
    expect(resolve(message, draft).findings).toContain('SEMANTIC_GOAL_PURPOSE_INVALID');
  });

  it.each(['学费', '搬家预算', '医疗状态评估费', '家庭旅行费用', '职业培训报名费'])('preserves an exact explicit purpose without turning it into payment memo: %s', purpose => {
    const message = `请在2028-11-20前替陈禾准备640元${purpose}`;
    const result = resolve(message, goal(message, literal, { purpose }));
    expect(result).toMatchObject({ status: 'ready', tasks: [{ operation: 'goal_create', source: { text: message }, slots: {
      entityId: 'payee-a', amountMinor: '64000', targetDate: '2028-11-20', purpose,
    } }] });
    expect(result.tasks[0]!.slots).not.toHaveProperty('memo');
    // The operation parser receives only the canonical operation. A purpose
    // noun such as 状态评估 stays in its typed slot and original source.
    expect(result.tasks[0]!.canonicalMessage).not.toContain(purpose);
    const domain = resolveLifeGoal({ ...base, message: result.tasks[0]!.canonicalMessage, semanticIntent: result });
    expect(domain.goalSuggestion).toMatchObject({ title: purpose, accountId: 'account-a', payeeId: 'payee-a', amountMinor: '64000', targetDate: '2028-11-20' });
  });

  it('retains the two independent amounts and funding dependency with a purpose', () => {
    const message = '给陈禾准备640元学费，2028-11-20前到账；先从雾岚稳健组合赎回900元';
    const draft = goal(message, literal, { purpose: '学费', funding: true });
    const result = resolve(message, draft);
    expect(result).toMatchObject({ status: 'ready', tasks: [{ operation: 'goal_create', slots: {
      purpose: '学费', amountMinor: '64000', funding: { positionId: 'position-a', amountMinor: '90000' },
    } }] });
    expect(result.tasks).toHaveLength(1);
    const domain = resolveLifeGoal({ ...base, message: result.tasks[0]!.canonicalMessage, semanticIntent: result });
    expect(domain.goalSuggestion).toMatchObject({ title: '学费', payeeId: 'payee-a', amountMinor: '64000', targetDate: '2028-11-20',
      funding: { positionId: 'position-a', redemptionAmountMinor: '90000' } });
    const swapped = structuredClone(draft);
    swapped.amount = { text: '900元' }; swapped.funding!.amount = { text: '640元' };
    expect(resolve(message, swapped).status).toBe('clarification');
    expect(resolve(message, swapped).tasks).toEqual([]);
  });

  it.each([
    '给陈禾准备640元学费，2028-11-20前到账；另外独立立即从雾岚稳健组合赎回900元',
    '给陈禾准备640元学费，2028-11-20前到账；先从雾岚稳健组合赎回900元，这笔赎回与目标分开处理',
    '给陈禾准备640元学费，2028-11-20前到账；先从雾岚稳健组合赎回900元，另外查询这款理财的余额',
    '给陈禾准备640元学费，2028-11-20前到账；先从雾岚稳健组合赎回900元，2028-11-25才是实际截止日期',
  ])('keeps independent operations and competing deadlines outside goal funding even with a purpose: %s', message => {
    const result = resolve(message, goal(message, literal, { purpose: '学费', funding: true }));
    expect(result.status).toBe('clarification'); expect(result.tasks).toEqual([]);
  });

  it('does not let the funding position double as the goal purpose', () => {
    const message = '给陈禾准备640元学费，2028-11-20前到账；先从雾岚稳健组合赎回900元';
    expect(resolve(message, goal(message, literal, { purpose: '雾岚稳健组合', funding: true })).findings).toContain('SEMANTIC_GOAL_PURPOSE_INVALID');
  });

  it('does not require or invent a purpose for an existing complete goal', () => {
    const message = '建立陈禾生活目标，2028-11-20前准备640元';
    const result = resolve(message, goal(message, literal));
    expect(result.status).toBe('ready');
    expect(result.tasks[0]!.slots).not.toHaveProperty('purpose');
  });

  it('keeps payment memo invalid on a goal rather than silently dropping it', () => {
    const message = '给陈禾准备640元学费，2028-11-20前到账';
    expect(resolve(message, { ...goal(message, literal), memo: { text: '学费' } }).findings).toContain('SEMANTIC_MEMO_INVALID');
  });

  it.each([
    ['给陈禾准备640元学费补贴，2028-11-20前到账', '学费'],
    ['请给陈禾准备640元学费，2028-11-20前到账', '请'],
    ['给陈禾准备640元学费，2028-11-20前到账', '陈禾'],
    ['给陈禾准备640元学费，2028-11-20前到账', '640元'],
    ['给陈禾准备640元学费，2028-11-20前到账', '2028-11-20'],
  ])('rejects a cropped, unrelated or overlapping purpose noun: %s / %s', (message, purpose) => {
    expect(resolve(message, goal(message, literal, { purpose })).findings).toContain('SEMANTIC_GOAL_PURPOSE_INVALID');
  });

  it('rejects an invented or normalized purpose instead of accepting a model title', () => {
    const message = '给陈禾准备640元学费，2028-11-20前到账';
    expect(resolve(message, goal(message, literal, { purpose: '学习储备金' })).findings).toContain('SEMANTIC_SPAN_NOT_FOUND');
  });

  it('does not let a purpose span cover an independent transfer command', () => {
    const message = '给陈禾准备640元学费；另外给陈禾转账900元，2028-11-20前到账';
    const result = resolve(message, goal(message, literal, { purpose: '学费；另外给陈禾转账900元' }));
    expect(result.status).toBe('clarification'); expect(result.tasks).toEqual([]);
  });

  it('does not erase a second competing goal deadline', () => {
    const message = '给陈禾准备640元学费，2028-11-20或2028-12-20前到账';
    expect(resolve(message, goal(message, literal, { purpose: '学费' })).findings).toContain('SEMANTIC_GOAL_DEADLINE_AMBIGUOUS');
  });

  it.each(['request', 'ambiguous'] as const)('asks for the absent year after grounding beneficiary and amount: %s', disposition => {
    const message = '给陈禾准备640元培训报名费，1月18日前攒好';
    const result = resolve(message, { ...goal(message, literal, { purpose: '培训报名费', date: '1月18日' }), disposition });
    expect(result).toMatchObject({ status: 'clarification', tasks: [], issues: [{ path: ['tasks', '0', 'date'], category: 'value', code: 'SEMANTIC_TARGET_DATE_YEAR_REQUIRED' }] });
    expect(result.clarification).toContain('年份'); expect(result.clarification).not.toContain('收款人');
  });

  it('identifies missing year without filling an omitted model date slot', () => {
    const message = '给陈禾准备640元培训报名费，1月18日前攒好';
    const draft = goal(message, literal, { purpose: '培训报名费', date: '1月18日' });
    delete draft.date; draft.disposition = 'ambiguous';
    const result = resolve(message, draft);
    expect(result.findings).toContain('SEMANTIC_TARGET_DATE_YEAR_REQUIRED'); expect(result.tasks).toEqual([]);
  });

  it.each([
    '给王陈禾准备640元培训报名费，1月18日前攒好',
    '给陈禾准备640元或900元培训报名费，1月18日前攒好',
    '给陈禾准备640元培训报名费，1月18日或2月19日前攒好',
  ])('does not replace another unresolved field or choice with missing-year diagnosis: %s', message => {
    const result = resolve(message, { ...goal(message, literal, { date: '1月18日' }), disposition: 'ambiguous' });
    expect(result.status).toBe('clarification'); expect(result.tasks).toEqual([]);
    expect(result.findings).not.toContain('SEMANTIC_TARGET_DATE_YEAR_REQUIRED');
  });

  it('keeps a duplicate saved beneficiary ambiguous before choosing a date clarification', () => {
    const message = '给陈禾准备640元培训报名费，1月18日前攒好';
    const input = { ...base, payees: [...base.payees, { ...base.payees[0]!, id: 'payee-b' }] };
    const result = resolve(message, { ...goal(message, literal, { date: '1月18日' }), disposition: 'ambiguous' }, input);
    expect(result.findings).toContain('SEMANTIC_ENTITY_NOT_UNIQUE');
    expect(result.findings).not.toContain('SEMANTIC_TARGET_DATE_YEAR_REQUIRED');
  });

  it.each(['不要给陈禾准备640元学费，1月18日前攒好', '“给陈禾准备640元学费，1月18日前攒好”', '如果给陈禾准备640元学费，1月18日前攒好'])('preserves source refusal, quotation and conditions before missing-year diagnosis: %s', message => {
    const result = resolve(message, { ...goal(message, literal, { date: '1月18日' }), disposition: 'ambiguous' });
    expect(result.status).toBe('no_action'); expect(result.tasks).toEqual([]);
  });

  it('never upgrades an ambiguous goal into a ready task even with valid slots', () => {
    const message = '给陈禾准备640元学费，2028-11-20前到账';
    const result = resolve(message, { ...goal(message, literal, { purpose: '学费' }), disposition: 'ambiguous' });
    expect(result.findings).toContain('SEMANTIC_UNSUPPORTED_OR_AMBIGUOUS'); expect(result.tasks).toEqual([]);
  });

  it('vetoes an immediate transfer classification for a general future preparation request', () => {
    const message = '给陈禾准备640元医疗费用，2028-11-20前到账';
    const { date: _date, purpose: _purpose, ...draft } = goal(message, literal);
    expect(resolve(message, { ...draft, operation: 'transfer' }).findings).toContain('SEMANTIC_GOAL_IMMEDIATE_CONFLICT');
  });
});

it('does not permit a purpose slot on a transfer', () => {
  const message = '给陈禾转账640元，备注学费';
  const { date: _date, ...draft } = goal(message, false, { purpose: '学费' });
  expect(resolve(message, { ...draft, operation: 'transfer' }).findings).toContain('SEMANTIC_UNEXPECTED_SLOT');
});

it('does not let a cropped goal scope conceal an independent task while naming a missing year', () => {
  const source = '给陈禾准备640元学费，1月18日前攒好';
  const message = `${source}；另外查询账单`;
  const result = resolve(message, { ...goal(source, true, { date: '1月18日' }), disposition: 'ambiguous' });
  expect(result.status).toBe('clarification'); expect(result.findings).not.toContain('SEMANTIC_TARGET_DATE_YEAR_REQUIRED');
});

it('does not infer a missing goal year from the trusted reference date or accept an invented complete date', () => {
  const message = '给陈禾准备640元培训报名费，1月18日前攒好';
  const input = { ...base, message };
  const partial = validateSemanticIntent(input, { tasks: [goal(message, false, { date: '1月18日' })] }, { referenceDate: '2028-01-01' });
  expect(partial.findings).toContain('SEMANTIC_TARGET_DATE_YEAR_REQUIRED'); expect(partial.tasks).toEqual([]);
  const invented = resolve(message, goal(message, false, { date: '2028-01-18' }));
  expect(invented.findings).toContain('SEMANTIC_SPAN_NOT_FOUND'); expect(invented.tasks).toEqual([]);
});

it('gives the semantic provider explicit operation-specific purpose/memo and incomplete-deadline instructions', async () => {
  const message = '给陈禾准备640元培训报名费，1月18日前攒好';
  const result = await interpretSemanticIntent({ ...base, message }, {
    provider: { baseURL: 'https://fixture.invalid/v1', model: 'fixture-model', maxAttempts: 1 },
    adapter: async task => {
      const instruction = (task as { instruction: string }).instruction;
      expect(instruction).toContain('goal_create must omit memo');
      expect(instruction).toContain('Only transfer may use memo');
      expect(instruction).toContain('Do not mark the whole operation ambiguous just because a deadline year is missing');
      return { tasks: [goal(message, false, { purpose: '培训报名费', date: '1月18日' })] };
    },
  });
  expect(result.findings).toContain('SEMANTIC_TARGET_DATE_YEAR_REQUIRED');
  expect(result.modelRuns).toEqual([]);
});
