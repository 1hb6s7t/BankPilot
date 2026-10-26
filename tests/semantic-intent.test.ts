import { describe, expect, it, vi } from 'vitest';
import { interpretSemanticIntent, validateSemanticIntent, type SourceSpan } from '../packages/agents/src/semantic-intent';
import type { Planner } from '../packages/contracts/src/index';
const base: Parameters<Planner['plan']>[0] = { taskId: 'semantic-test', message: '', accounts: [], payees: [
  { id: 'p1', name: '林晓', aliases: ['小林'], bank: '合成银行', maskedNumber: '****1234' },
], investmentContext: { businessDate: '2026-10-23', calendar: 'DEMO_WEEKDAYS_V1', products: [], actions: [], positions: [
  { id: 'position-1', productId: 'product-1', productName: '晨星储蓄计划 T+2', accountId: 'a', principalMinor: '500000', availableMinor: '500000', reservedMinor: '0', version: 2, redemptionBusinessDays: 2, calendar: 'DEMO_WEEKDAYS_V1' },
] } };
function span(message: string, text = message): SourceSpan { const start = message.indexOf(text); if (start < 0) throw new Error('invalid test span'); return { start, end: start + text.length, text }; }
const payee = (message: string) => ({ kind: 'payee', id: 'p1', mention: span(message, message.includes('小林') ? '小林' : '林晓') });
const transfer = (message: string, amount = '120元') => ({ operation: 'transfer', disposition: 'request', scope: span(message), entity: payee(message), amount: span(message, amount) });
const resolve = (message: string, tasks: unknown[], input = base) => validateSemanticIntent({ ...input, message }, { tasks });

describe('grounded semantic intent interpretation', () => {
  it('accepts a semantically classified colloquial payment without keyword routing', () => {
    const message = '给小林打点钱，就120元';
    const result = resolve(message, [transfer(message)]);
    expect(result.status).toBe('ready'); expect(result.tasks[0]!.slots).toEqual({ entityId: 'p1', amountMinor: '12000' });
    expect(result.tasks[0]!.canonicalMessage).toBe('转给林晓尾号1234，金额120.00元');
  });
  it.each(['三百零七块五', '三百零七块五毛', '307块5'])('derives colloquial fractional currency deterministically: %s', amount => {
    const message = `给林晓${amount}`;
    expect(resolve(message, [transfer(message, amount)]).tasks[0]?.slots.amountMinor).toBe('30750');
  });
  it('keeps funds preview separate from a future goal', () => {
    const message = '看看是否影响房租和最低余额';
    const result = resolve(message, [{ operation: 'funds_query', disposition: 'query', scope: { text: message } }]);
    expect(result.tasks[0]?.role).toBe('goal'); expect(result.tasks[0]?.operation).toBe('funds_query');
  });
  it('locates unique verbatim text without requiring model offsets', () => {
    const message = '给林晓120元';
    const result = resolve(message, [{ operation: 'transfer', disposition: 'request', scope: { text: message }, entity: { kind: 'payee', id: 'p1', mention: { text: '林晓' } }, amount: { text: '120元' } }]);
    expect(result.tasks[0]!.slots.amountMinor).toBe('12000');
  });
  it('preserves an exact explicit memo as data', () => {
    const message = '给林晓120元，备注晚餐分摊';
    const result = resolve(message, [{ ...transfer(message), memo: { text: '晚餐分摊' } }]);
    expect(result.tasks[0]!.slots.memo).toBe('晚餐分摊'); expect(result.tasks[0]!.canonicalMessage).toContain('晚餐分摊');
  });
  it('does not let a model pick one of several mentioned recipients', () => {
    const message = '给林晓或者陈明120元';
    const input = { ...base, payees: [...base.payees, { ...base.payees[0]!, id: 'p2', name: '陈明', aliases: [] }] };
    expect(resolve(message, [transfer(message)], input).findings).toContain('SEMANTIC_ENTITY_AMBIGUOUS');
  });
  it('rejects a suffix that contradicts an explicitly named saved recipient', () => {
    const message = '给陈明，尾号1234，金额120元';
    const input = { ...base, payees: [...base.payees, { ...base.payees[0]!, id: 'p2', name: '陈明', aliases: [], maskedNumber: '****3344' }] };
    expect(resolve(message, [{ ...transfer('给林晓120元'), scope: span(message), entity: { kind: 'payee', id: 'p1', mention: { text: '尾号1234' } }, amount: { text: '120元' } }], input).findings).toContain('SEMANTIC_ENTITY_CONFLICT');
  });
  it('rejects a card/payee suffix cropped from a longer number', () => {
    const message = '给林晓120元，尾号12340';
    expect(resolve(message, [{ ...transfer(message), entity: { kind: 'payee', id: 'p1', mention: { text: '尾号1234' } } }]).status).toBe('clarification');
  });
  it.each(['12元', '十二元'])('allows an amount adjacent to a completely grounded digit-ending name: %s', amount => {
    const message = `给张三${amount}`, input = { ...base, payees: [{ ...base.payees[0]!, name: '张三', aliases: [] }] };
    const result = resolve(message, [{ operation: 'transfer', disposition: 'request', scope: { text: message }, entity: { kind: 'payee', id: 'p1', mention: { text: '张三' } }, amount: { text: amount } }], input);
    expect(result.tasks[0]?.slots.amountMinor).toBe('1200');
  });
  it('queries a catalog product whose name contains 计划 without inventing a goal', () => {
    const message = '晨星储蓄计划现在还有多少';
    const result = resolve(message, [{ operation: 'investment_query', disposition: 'query', scope: span(message), entity: { kind: 'position', id: 'position-1', mention: span(message, '晨星储蓄计划') } }]);
    expect(result.tasks[0]!.role).toBe('investment'); expect(result.tasks[0]!.canonicalMessage).toBe('查询理财持仓 position-1');
  });
  it.each(['120元', '壹佰贰拾元'])('derives monetary values solely from raw currency spans: %s', amount => {
    const message = `给林晓${amount}`;
    expect(resolve(message, [transfer(message, amount)]).tasks[0]?.slots.amountMinor).toBe('12000');
  });
  it.each(['一百12元', '壹佰12元', '120.001元', '1e3元'])('rejects malformed raw money rather than interpreting a suffix: %s', amount => {
    const message = `给林晓${amount}`; expect(resolve(message, [transfer(message, amount)]).status).toBe('clarification');
  });
  it.each([['-100元', '100元'], ['负 壹佰元', '壹佰元'], ['1e3元', '3元'], ['1100元', '100元'], ['100.25元', '25元'], ['壹仟零六元', '六元']])('rejects a raw amount substring instead of accepting changed value: %s', (whole, selected) => {
    const message = `给林晓转账${whole}`;
    expect(resolve(message, [transfer(message, selected)]).status).toBe('clarification');
  });
  it.each(['给王林晓转账120元', '给林晓婷转账120元', '给林晓的姐姐转账120元', '给向林晓转账120元'])('rejects a known name cropped from an unknown name: %s', message => {
    expect(resolve(message, [transfer(message)]).status).toBe('clarification');
  });
  it('rejects invented amount fields and forged/verbatim-mismatched spans', () => {
    const message = '给林晓120元';
    expect(resolve(message, [{ ...transfer(message), amountMinor: '50000' }]).status).toBe('clarification');
    expect(resolve(message, [{ ...transfer(message), amount: { ...span(message, '120元'), text: '500元' } }]).status).toBe('clarification');
    const invalidEntity = resolve(message, [{ ...transfer(message), entity: { ...payee(message), id: 'invented' } }]);
    expect(invalidEntity.status).toBe('clarification'); expect(invalidEntity.recognizedRoles).toEqual(['transfer']);
  });
  it('cannot select one of duplicate catalog aliases based on a model-chosen id', () => {
    const message = '给林晓120元';
    const input = { ...base, payees: [...base.payees, { ...base.payees[0]!, id: 'p2' }] };
    expect(resolve(message, [transfer(message)], input).status).toBe('clarification');
  });
  it.each(['给林晓120元只是个示例', '先不要给林晓120元', '如何给林晓120元', '给林晓120元好吗', '给林晓120元，撤回', '“给林晓120元”'])('vetoes unsafe request classification: %s', message => {
    expect(resolve(message, [transfer(message)]).tasks).toEqual([]);
  });
  it('rejects cropping negation out of the selected request scope', () => {
    const message = '不要给林晓120元';
    expect(resolve(message, [{ ...transfer(message), scope: span(message, '给林晓120元') }]).findings).toContain('SEMANTIC_SCOPE_TRUNCATED');
  });
  it('does not let the model choose one of two explicit money amounts', () => {
    const message = '给林晓120元或200元'; expect(resolve(message, [transfer(message)]).status).toBe('clarification');
  });
  it('cannot relabel an explicit bank block as merchant contract cancellation', () => {
    const message = '只在银行这边拦截星海视频后续扣款，保留会员合同';
    const input = { ...base, managementContext: { cards: [], subscriptions: { queryActionId: 'grant', queriedAt: '2026-10-23T00:00:00Z', accessExpiresAt: '2100-01-01T00:00:00Z', items: [{ id: 'sub', merchant: '星海视频', amountMinor: '2500', currency: 'CNY' as const, nextChargeDate: '2026-11-01', cardId: 'card', merchantStatus: 'ACTIVE' as const, bankStatus: 'ALLOWED' as const, collectionStatus: 'ENABLED' as const, version: 1, cancellationSupported: true, source: 'SYNTHETIC_MERCHANT' as const }] } } };
    const draft = { operation: 'subscription_cancel', disposition: 'request', scope: { text: message }, entity: { kind: 'subscription', id: 'sub', mention: { text: '星海视频' } } };
    expect(resolve(message, [draft], input).findings).toContain('SEMANTIC_SUBSCRIPTION_OPERATION_CONFLICT');
    const opposite = '取消星海视频会员，别只限制银行扣款';
    expect(resolve(opposite, [{ ...draft, operation: 'subscription_block', scope: { text: opposite } }], input).findings).toContain('SEMANTIC_SUBSCRIPTION_OPERATION_CONFLICT');
  });
  it('returns explicit clarification for unsupported or ambiguous tasks', () => {
    const message = '替我买黄金';
    expect(resolve(message, [{ operation: 'unsupported', disposition: 'request', scope: span(message) }]).status).toBe('clarification');
    expect(resolve(message, [{ operation: 'transfer', disposition: 'ambiguous', scope: span(message) }]).status).toBe('clarification');
  });
  it.each(['仅记录“查询订阅”这句话', '停止查询订阅'])('does not turn quoted or stopped subscription access into a pending request: %s', message => {
    expect(resolve(message, [{ operation: 'subscription_query', disposition: 'query', scope: { text: message } }]).tasks).toEqual([]);
  });
  it('keeps model-labeled historical and quoted records as data', () => {
    const message = '账单记录取消订阅';
    expect(resolve(message, [{ operation: 'subscription_cancel', disposition: 'historical', scope: span(message) }]).status).toBe('no_action');
  });
});

describe('periods and future-goal dependencies retain their source spans', () => {
  it.each([
    ['2027年2月', 'month', '2027-02', '2027-02'],
    ['2027年2月至4月', 'range', '2027-02', '2027-04'],
    ['2026-12到2027-02', 'range', '2026-12', '2027-02'],
  ])('derives explicit period metadata: %s', (period, kind, startPeriod, endPeriod) => {
    const message = `看看${period}的账单`;
    const result = resolve(message, [{ operation: 'bills_query', disposition: 'query', scope: span(message), period: span(message, period) }]);
    expect(result.tasks[0]!.slots.billPeriod).toEqual({ kind, startPeriod, endPeriod, source: span(message, period) });
  });
  it('rejects a period cropped from an invalid larger month token', () => {
    const message = '查询2027-13账单';
    expect(resolve(message, [{ operation: 'bills_query', disposition: 'query', scope: span(message), period: { text: '2027-1' } }]).status).toBe('clarification');
  });
  it('rejects a valid date cropped from an invalid larger date token', () => {
    const message = '建立林晓生活目标，2027-11-200前准备120元';
    expect(resolve(message, [{ operation: 'goal_create', disposition: 'request', scope: span(message), entity: payee(message), date: { text: '2027-11-20' }, amount: { text: '120元' } }]).status).toBe('clarification');
  });
  it('never invents a year or resolves a relative month without a trusted reference', () => {
    for (const period of ['2月', '上个月']) {
      const message = `查询${period}账单`, draft = { tasks: [{ operation: 'bills_query', disposition: 'query', scope: span(message), period: span(message, period) }] };
      expect(validateSemanticIntent({ ...base, message }, draft).status).toBe('clarification');
      if (period === '上个月') expect(validateSemanticIntent({ ...base, message }, draft, { referenceDate: '2027-01-10' }).tasks[0]!.slots.billPeriod?.startPeriod).toBe('2026-12');
    }
  });
  it('rejects a future goal mislabeled as an immediate transfer', () => {
    const message = '建立林晓生日目标，2027-12-01前准备120元';
    expect(resolve(message, [transfer(message)]).findings).toContain('SEMANTIC_GOAL_IMMEDIATE_CONFLICT');
  });
  it('does not convert a future goal funding dependency into immediate redemption', () => {
    const message = '为林晓准备生日目标，2027-02-28前准备120元，从晨星储蓄计划赎回130元';
    const draft = { operation: 'goal_create', disposition: 'request', scope: span(message), entity: payee(message), amount: span(message, '120元'), date: span(message, '2027-02-28'), funding: { entity: { kind: 'position', id: 'position-1', mention: span(message, '晨星储蓄计划') }, amount: span(message, '130元') } };
    const result = resolve(message, [draft]); expect(result.status).toBe('ready'); expect(result.tasks).toHaveLength(1);
    expect(resolve(message, [{ ...draft, amount: span(message, '130元'), funding: { ...draft.funding, amount: span(message, '120元') } }]).findings).toContain('SEMANTIC_GOAL_AMOUNT_BINDING_INVALID');
    expect(result.tasks[0]!.slots.funding).toEqual({ positionId: 'position-1', amountMinor: '13000' });
    expect(resolve(message, [{ ...draft, date: { ...draft.date, text: '2028-02-28' } }]).status).toBe('clarification');
  });
});

describe('semantic provider boundary and explicit modes', () => {
  const provider = { baseURL: 'https://semantic-fixture.invalid', model: 'mock-model', outputMode: 'json_object' as const, maxAttempts: 1 };
  it('uses an injected semantic adapter for reproducible validation, never claims it is live', async () => {
    const message = '给林晓120元'; const fetchMock = vi.spyOn(globalThis, 'fetch');
    try {
      const result = await interpretSemanticIntent({ ...base, message }, { provider, adapter: async () => ({ tasks: [transfer(message)] }) });
      expect(result.status).toBe('ready'); expect(result.modelRuns).toEqual([]); expect(fetchMock).not.toHaveBeenCalled();
    } finally { fetchMock.mockRestore(); }
  });
  it('uses invokeStructured with a schema excluding executable permissions and invented money', async () => {
    const message = '给林晓120元';
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      expect(body.messages[0].content).not.toContain('amountMinor');
      expect(JSON.parse(body.messages[1].content).catalog[0].id).toBe('p1');
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ tasks: [transfer(message)] }) } }] }));
    });
    try { const result = await interpretSemanticIntent({ ...base, message }, { provider }); expect(result.status).toBe('ready'); expect(result.modelRuns).toHaveLength(1); }
    finally { fetchMock.mockRestore(); }
  });
  it('fails closed on provider failure without a scripted fallback', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 401 }));
    try { const result = await interpretSemanticIntent({ ...base, message: '给林晓120元' }, { provider }); expect(result.tasks).toEqual([]); expect(result.findings).toContain('MODEL_HTTP_401'); }
    finally { fetchMock.mockRestore(); }
  });
});
