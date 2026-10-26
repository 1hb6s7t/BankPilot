import { describe, expect, it, vi } from 'vitest';
import type { Planner } from '../packages/contracts/src';
import { syntheticInvestmentProducts } from '../packages/contracts/src/investment';
import { inspectPositionLocator, positionNameMatches, selectPositionReference } from '../packages/agents/src/position-locator';
import { interpretSemanticIntent, validateSemanticIntent, type SemanticIntentDraft, type SourceSpan } from '../packages/agents/src/semantic-intent';

type Input = Parameters<Planner['plan']>[0];
type Task = SemanticIntentDraft['tasks'][number];
const base: Input = { taskId: 'g9b-independent-pairs', message: '', accounts: [], payees: [
  { id: 'payee', name: '顾霁', aliases: ['同住伙伴'], bank: '合成银行', maskedNumber: '****1628' },
], investmentContext: { businessDate: '2026-10-24', calendar: 'DEMO_WEEKDAYS_V1', products: [...syntheticInvestmentProducts], actions: [], positions: syntheticInvestmentProducts.map((product, index) => ({
  id: `position-${index}`, productId: product.id, productName: product.name, accountId: 'a', availableMinor: '600000', principalMinor: '600000', reservedMinor: '0', version: 3,
  redemptionBusinessDays: product.redemptionBusinessDays, calendar: product.calendar,
})) }, managementContext: { cards: [{ id: 'card', accountId: 'a', name: '青竹借记卡', maskedNumber: '****4168', status: 'ACTIVE', version: 2, updatedAt: '2026-10-23T00:00:00Z' }],
  subscriptions: { queryActionId: 'grant', queriedAt: '2026-10-24T04:00:00Z', accessExpiresAt: '2100-01-01T00:00:00Z', items: ['山海听书', '日光瑜伽'].map((merchant, index) => ({
    id: `subscription-${index}`, merchant, amountMinor: '2900', currency: 'CNY', nextChargeDate: '2026-11-01', cardId: 'card', merchantStatus: 'ACTIVE', bankStatus: 'ALLOWED', collectionStatus: 'ENABLED', version: 2, cancellationSupported: true, source: 'SYNTHETIC_MERCHANT',
  })) } } };
function span(message: string, text = message): SourceSpan { const start = message.indexOf(text); if (start < 0) throw new Error('test source missing'); return { start, end: start + text.length, text }; }
const entity = (kind: 'payee' | 'position' | 'card' | 'subscription', id: string, text: string) => ({ kind, id, mention: { text } });
const transfer = (message: string, amount: string, memo?: string): Task => ({ operation: 'transfer', disposition: 'request', scope: { source: 'whole_message' }, entity: entity('payee', 'payee', message.includes('同住伙伴') ? '同住伙伴' : '顾霁'), amount: { text: amount }, ...(memo ? { memo: { text: memo } } : {}) });
const goal = (message: string, purpose: string, date = '2028-03-12'): Task => ({ operation: 'goal_create', disposition: 'request', scope: { source: 'whole_message' }, entity: entity('payee', 'payee', '顾霁'), amount: { text: '680元' }, purpose: { text: purpose }, date: { text: date } });
const run = (message: string, tasks: Task[], input = base) => validateSemanticIntent({ ...input, message }, { tasks });

describe('G9B explicit text arguments keep their exact source and typed meaning', () => {
  it.each([
    ['备注请原样填写', '春游车费/已复核。'], ['备注写', '聚餐AA'], ['附言为', '11月押金补差'], ['备注', '取消山海听书订阅'],
  ])('accepts complete quoted memo data introduced by %s', (introducer, memo) => {
    const message = `请给顾霁汇叁佰捌拾陆元伍角柒分。${introducer}“${memo}”`;
    const result = run(message, [transfer(message, '叁佰捌拾陆元伍角柒分', memo)]);
    expect(result.status).toBe('ready'); expect(result.tasks[0]?.slots).toEqual({ entityId: 'payee', amountMinor: '38657', memo });
    expect(result.tasks[0]?.source.text).toBe(message);
  });
  it.each(['春游车费', '取消山海听书订阅'])('rejects cropped memo quotations and unrelated quotations: %s', memo => {
    const cropped = `给顾霁转680元，备注“${memo}补差”`;
    expect(run(cropped, [transfer(cropped, '680元', memo)]).status).toBe('clarification');
    const unrelated = `给顾霁转680元，有一段“${memo}”`;
    expect(run(unrelated, [transfer(unrelated, '680元', memo)]).status).toBe('clarification');
  });
  it('does not take a quoted payment as the real transfer even with a model memo slot', () => {
    const message = '请改写“给顾霁转680元，备注午餐”';
    expect(run(message, [transfer(message, '680元', '午餐')]).tasks).toEqual([]);
  });
  it.each(['给林晓转100元', '不要给林晓转100元'])('keeps a second saved payee inside a complete explicit memo as data: %s', memo => {
    const input = { ...base, payees: [...base.payees, { ...base.payees[0]!, id: 'other-payee', name: '林晓', aliases: [] }] };
    const message = `给顾霁转680元，备注“${memo}”`;
    const result = run(message, [transfer(message, '680元', memo)], input);
    expect(result.status).toBe('ready'); expect(result.tasks[0]?.slots).toEqual({ entityId: 'payee', amountMinor: '68000', memo });
  });
  it.each(['林晓或顾霁', '顾霁或林晓'])('still rejects a second saved payee outside the validated memo: %s', recipients => {
    const input = { ...base, payees: [...base.payees, { ...base.payees[0]!, id: 'other-payee', name: '林晓', aliases: [] }] };
    const message = `给${recipients}转680元，备注“聚餐AA”`;
    const result = run(message, [transfer(message, '680元', '聚餐AA')], input);
    expect(result.status).toBe('clarification'); expect(result.tasks).toEqual([]);
  });
  it.each([
    ['名称就用“书展摊位费”。2028-03-12前给顾霁转680元', '书展摊位费'],
    ['计划名请设成“排练室租金”。收款方是顾霁，金额680元，2028-03-12前完成', '排练室租金'],
    ['目标名严格写“陶艺课程材料费”。2028-03-12前给顾霁转680元', '陶艺课程材料费'],
  ])('preserves explicit goal names without inventing titles: %s', (tail, purpose) => {
    const message = `帮我建立生活目标，${tail}，直接用现金，不用赎回`;
    const result = run(message, [goal(message, purpose)]);
    expect(result.status).toBe('ready'); expect(result.tasks[0]?.slots).toMatchObject({ entityId: 'payee', purpose, targetDate: '2028-03-12', amountMinor: '68000' });
  });
  it('accepts quoted purpose within the create construction and retains a slash calendar date', () => {
    const message = '请建“登山装备尾款”生活目标：2028/03/12前给顾霁转680元，直接用现金';
    const result = run(message, [goal(message, '登山装备尾款', '2028/03/12')]);
    expect(result.status).toBe('ready'); expect(result.tasks[0]?.slots.targetDate).toBe('2028-03-12');
  });
  it('asks specifically for the missing year after validating a quoted title and known beneficiary', () => {
    const message = '建个“旧琴翻修”生活目标，11月30日前给顾霁转680元，直接用现金';
    const result = run(message, [goal(message, '旧琴翻修', '11月30日')]);
    expect(result.findings).toEqual(['SEMANTIC_TARGET_DATE_YEAR_REQUIRED']);
    expect(result.issues?.[0]?.path).toEqual(['tasks', '0', 'date']); expect(result.clarification).toContain('年份'); expect(result.clarification).not.toContain('收款人');
  });
  it.each(['2027/02/29', '2028/02/30', '2028/13/01', '2028/03-12'])('rejects an invalid or mixed calendar date: %s', date => {
    const message = `建立顾霁生活目标，名称“设备费”，${date}前准备680元`;
    expect(run(message, [goal(message, '设备费', date)]).status).toBe('clarification');
  });
  it('does not borrow a memo from a different task scope', () => {
    const message = '查询2028年3月账单，备注“书展分摊”；给顾霁转680元';
    const payment = { ...transfer(message, '680元', '书展分摊'), scope: { text: '给顾霁转680元' } };
    expect(run(message, [{ operation: 'bills_query', disposition: 'query', scope: { text: '查询2028年3月账单，备注“书展分摊”' }, period: { text: '2028年3月' } }, payment]).tasks).toEqual([]);
  });
});

describe('G9B full original money tokens and Chinese argument boundaries', () => {
  it.each([['二百四十五块六毛五', '24565'], ['137块2毛', '13720'], ['68元5角', '6850'], ['468元3角5分', '46835'], ['一千零三十六块八毛', '103680']])('derives integer minor units from %s', (amount, minor) => {
    const message = `这次收款的是顾霁。那份是${amount}，帮我转过去，备注写“餐费AA”`;
    const result = run(message, [transfer(message, amount, '餐费AA')]);
    expect(result.status).toBe('ready'); expect(result.tasks[0]?.slots.amountMinor).toBe(minor);
  });
  it.each(['二百45块六毛五', '245块六毛五五', '245元2角3角', '245.001元', '245块10毛', '245块六毛五或300元'])('rejects malformed or competing original money: %s', amount => {
    const message = `给顾霁转${amount}`;
    expect(run(message, [transfer(message, amount)]).tasks).toEqual([]);
  });
  it.each(['王顾霁', '顾霁婷', '向顾霁', '顾霁的姐姐'])('never extracts the saved name from an unknown full recipient: %s', recipient => {
    const message = `收款方是${recipient}，请转680元`;
    expect(run(message, [transfer(message, '680元')]).tasks).toEqual([]);
  });
  it('keeps duplicate saved names ambiguous even with complete declared-payee grammar', () => {
    const message = '收款方是顾霁，转680元';
    const result = run(message, [transfer(message, '680元')], { ...base, payees: [...base.payees, { ...base.payees[0]!, id: 'duplicate' }] });
    expect(result.findings).toContain('SEMANTIC_ENTITY_NOT_UNIQUE');
  });
});

describe('G9B local exclusions, historical draft coverage and read-only queries', () => {
  it.each([false, true])('clarifies an unpunctuated negative payment followed by a positive adversative payment, literal=%s', literal => {
    const input = { ...base, payees: [...base.payees, { ...base.payees[0]!, id: 'other-payee', name: '林晓', aliases: [] }] };
    const message = '不要给林晓转100元但给顾霁转680元';
    const task = transfer(message, '680元'); if (literal) task.scope = { text: message };
    const result = run(message, [task], input);
    expect(result.status).toBe('clarification'); expect(result.findings).toEqual(['SEMANTIC_INACTIVE_SOURCE_UNSUPPORTED']); expect(result.tasks).toEqual([]);
  });
  it('keeps an affirmative transfer with an adversative character in a saved recipient name intact', () => {
    const input = { ...base, payees: [{ ...base.payees[0]!, name: '顾但霁', aliases: [] }] };
    const message = '给顾但霁转680元';
    const task = { ...transfer(message, '680元'), entity: entity('payee', 'payee', '顾但霁') };
    expect(run(message, [task], input).status).toBe('ready');
  });
  it('does not treat a currency-plus-adversative sequence inside a saved recipient name as a positive tail', () => {
    const input = { ...base, payees: [{ ...base.payees[0]!, name: '元但给顾霁', aliases: [] }] };
    const message = '不要给元但给顾霁转100元';
    const task = { ...transfer(message, '100元'), entity: entity('payee', 'payee', '元但给顾霁') };
    expect(run(message, [task], input).status).toBe('no_action');
  });
  it('keeps adversative payment text inside a complete explicit memo inert', () => {
    const memo = '不要给林晓转100元但给顾霁转680元';
    const message = `给顾霁转680元，备注“${memo}”`;
    // The same recipient and money text occur twice; preserve the existing
    // requirement for exact offsets rather than choosing an occurrence.
    const task = transfer(message, '680元', memo);
    task.entity!.mention = span(message, '顾霁'); task.amount = span(message, '680元');
    expect(run(message, [task]).status).toBe('ready');
  });
  it('keeps an adversative character inside a known merchant name as part of that noun', () => {
    const subscriptions = base.managementContext!.subscriptions!;
    const input = { ...base, managementContext: { ...base.managementContext!, subscriptions: { ...subscriptions, items: [{ ...subscriptions.items[0]!, merchant: '但青听书' }] } } };
    const message = '取消但青听书订阅';
    expect(run(message, [{ operation: 'subscription_cancel', disposition: 'request', scope: { source: 'whole_message' }, entity: entity('subscription', 'subscription-0', '但青听书') }], input).status).toBe('ready');
  });
  it('preserves a positive card action when the other clause merely prohibits choosing the wrong card', () => {
    const message = '尾号4168的银行卡找不到了，请先替我准备挂失，卡号不要选错';
    const result = run(message, [{ operation: 'card_report_lost', disposition: 'request', scope: { source: 'whole_message' }, entity: entity('card', 'card', '尾号4168') }]);
    expect(result.status).toBe('ready'); expect(result.tasks[0]?.operation).toBe('card_report_lost');
  });
  it.each(['青竹借记卡现在是什么状态？我只想确认尾号4168是否挂失了，不要改它', '查询青竹借记卡的状态，不要挂失'])('keeps a card status question read-only: %s', message => {
    const result = run(message, [{ operation: 'card_query', disposition: 'query', scope: { source: 'whole_message' } }]);
    expect(result.status).toBe('ready'); expect(result.tasks.map(task => task.operation)).toEqual(['card_query']);
  });
  it('preserves a merchant cancellation when a bank restriction is explicitly excluded', () => {
    const message = '请取消山海听书订阅，不用再另设银行拦截';
    const result = run(message, [{ operation: 'subscription_cancel', disposition: 'request', scope: { source: 'whole_message' }, entity: entity('subscription', 'subscription-0', '山海听书') }]);
    expect(result.status).toBe('ready'); expect(result.tasks[0]?.operation).toBe('subscription_cancel');
  });
  it('keeps subscription access questions separate from an excluded cancellation', () => {
    const message = '现在有哪些自动续费订阅？先不要取消';
    const result = run(message, [{ operation: 'subscription_query', disposition: 'query', scope: { source: 'whole_message' } }]);
    expect(result.status).toBe('ready'); expect(result.tasks[0]?.operation).toBe('subscription_query');
  });
  it('treats a bill comparison and requested evidence as one query while retaining a subscription exclusion', () => {
    const message = '把2028年3月和5月支出按类别比较一下，哪个类别增加最多？请保留支持判断的原流水引用，别据此替我改任何订阅';
    const result = run(message, [{ operation: 'bills_query', disposition: 'query', scope: { source: 'whole_message' }, period: { text: '2028年3月和5月' } }]);
    expect(result.status).toBe('ready'); expect(result.tasks[0]?.slots.billPeriod?.periods).toEqual(['2028-03', '2028-05']);
  });
  it('accepts YYYY/M bill periods while preserving the complete temporal source', () => {
    const message = '看看2028/3账单里，明河面馆一共扣了多少钱，把对应流水也列出来';
    const result = run(message, [{ operation: 'bills_query', disposition: 'query', scope: { source: 'whole_message' }, period: { text: '2028/3' } }]);
    expect(result.status).toBe('ready'); expect(result.tasks[0]?.slots.billPeriod).toEqual({ kind: 'month', startPeriod: '2028-03', endPeriod: '2028-03', source: span(message, '2028/3') });
  });
  it.each(['查询青竹借记卡状态，然后挂失青竹借记卡', '查询青竹借记卡状态并挂失青竹借记卡'])('does not hide a same-domain write in a read-only query: %s', message => {
    expect(run(message, [{ operation: 'card_query', disposition: 'query', scope: { source: 'whole_message' } }]).tasks).toEqual([]);
  });
  it('does not hide a same-domain query behind a card action', () => {
    const message = '挂失青竹借记卡，再查询银行卡状态';
    expect(run(message, [{ operation: 'card_report_lost', disposition: 'request', scope: { source: 'whole_message' }, entity: entity('card', 'card', '青竹借记卡') }]).tasks).toEqual([]);
  });
  it.each([
    '我草稿里写了“给顾霁转420元”，那句现在作废。请别准备转账，我还没决定要不要还这笔。',
    '会议记录里有一句“查本月账单”，我只是把这句原话贴在这里存个背景。现在不用查询或分析账单。',
    '上次演示稿里的“赎回T+0理财500元”已经不适用了。这里只是在说明旧稿，我现在不查询也不赎回理财。',
    '我在旧账单备注里看到了“取消山海听书订阅”这几个字，只是在转述当时的笔记。现在不要查询、取消或拦截任何订阅。',
  ])('requires every clause of a withdrawn/historical draft to be data: %s', message => {
    const result = run(message, [{ operation: 'transfer', disposition: 'historical', scope: { source: 'whole_message' } }]);
    expect(result.status).toBe('no_action'); expect(result.tasks).toEqual([]);
  });
  it.each(['，另外给顾霁转680元', '，但请查询2028年3月账单'])('cannot hide an independent current instruction inside a historical scope: %s', tail => {
    const message = '我草稿里写了“给顾霁转420元”，那句现在作废' + tail;
    expect(run(message, [{ operation: 'transfer', disposition: 'historical', scope: { source: 'whole_message' } }]).status).toBe('clarification');
  });
  it.each(['quoted', 'request'] as const)('does not dismiss an independent current instruction merely because scope also contains a quoted command: %s', disposition => {
    const message = '“给顾霁转420元”是旧稿，另外给顾霁转680元';
    const task: Task = { operation: 'transfer', disposition, scope: { source: 'whole_message' } };
    expect(run(message, [task]).status).toBe('clarification');
  });
  it('keeps two distinct subscription actions on distinct objects as separately grounded tasks', () => {
    const message = '取消山海听书订阅；对日光瑜伽只做银行扣款拦截';
    const tasks: Task[] = [
      { operation: 'subscription_cancel', disposition: 'request', scope: { text: '取消山海听书订阅' }, entity: entity('subscription', 'subscription-0', '山海听书') },
      { operation: 'subscription_block', disposition: 'request', scope: { text: '对日光瑜伽只做银行扣款拦截' }, entity: entity('subscription', 'subscription-1', '日光瑜伽') },
    ];
    expect(run(message, tasks).tasks.map(task => task.operation)).toEqual(['subscription_cancel', 'subscription_block']);
    const contradictory = tasks.map(task => ({ ...task, scope: { text: message } }));
    expect(run(message, contradictory).tasks).toEqual([]);
  });
});

describe('G9B authoritative position names and unique typed settlement locators', () => {
  const positions = base.investmentContext!.positions;
  it('accepts the complete authoritative name with only the settlement whitespace formatted differently', () => {
    const message = '从我的合成即时赎回产品T+0中赎出肆佰贰拾伍元柒角伍分，先准备候选让我核对';
    const result = run(message, [{ operation: 'investment_redeem', disposition: 'request', scope: { source: 'whole_message' }, entity: entity('position', 'position-0', '合成即时赎回产品T+0'), amount: { text: '肆佰贰拾伍元柒角伍分' } }]);
    expect(result.status).toBe('ready'); expect(result.tasks[0]?.slots).toEqual({ entityId: 'position-0', amountMinor: '42575' });
    expect(positionNameMatches('合成即时赎回产品T+0', positions[0]!)).toBe(true);
  });
  it.each(['T+2', 'T + 2', 'T＋2合成理财'])('supports only a unique typed settlement reference: %s', mention => {
    const message = `要动的是我那笔${mention}。这次取回两千一百元零五分，帮我做赎回提案`;
    const result = run(message, [{ operation: 'investment_redeem', disposition: 'request', scope: { source: 'whole_message' }, entity: entity('position', 'position-1', mention), amount: { text: '两千一百元零五分' } }]);
    expect(result.status).toBe('ready'); expect(result.tasks[0]?.slots).toEqual({ entityId: 'position-1', amountMinor: '210005' });
  });
  it.each(['星际T+2理财', 'T+2增长计划', 'T+2理财特别版', '未知合成T+2理财', 'T+20理财'])('rejects unknown prefixes, suffixes and numeric cropping: %s', full => {
    const message = `从${full}赎回680元`;
    const mention = full.includes('T+20') ? 'T+2' : 'T+2';
    const result = run(message, [{ operation: 'investment_redeem', disposition: 'request', scope: { source: 'whole_message' }, entity: entity('position', 'position-1', mention), amount: { text: '680元' } }]);
    expect(result.tasks).toEqual([]); expect(selectPositionReference(message, positions).position).toBeUndefined();
  });
  it('counts an empty second same-settlement position as ambiguous', () => {
    const input = { ...base, investmentContext: { ...base.investmentContext!, positions: [...positions, { ...positions[1]!, id: 'empty-same-day', availableMinor: '0' }] } };
    const message = '从T+2理财赎回680元';
    const result = run(message, [{ operation: 'investment_redeem', disposition: 'request', scope: { source: 'whole_message' }, entity: entity('position', 'position-1', 'T+2'), amount: { text: '680元' } }], input);
    expect(result.findings).toContain('SEMANTIC_ENTITY_NOT_UNIQUE');
    expect(selectPositionReference(message, input.investmentContext.positions).error).toBe('not_unique');
  });
  it('rejects more than one typed locator even if the model chooses one id', () => {
    const message = '从T+0或T+2理财赎回680元';
    expect(() => inspectPositionLocator({ message, scope: span(message), mention: span(message, 'T+2'), positions, entityId: 'position-1' })).toThrow();
    expect(selectPositionReference(message, positions).error).toBe('not_unique');
  });
  it.each(['从未知理财，T+2理财赎回680元', '从T+2理财赎回680元未知份额', '从T+2理财赎回680元，顺便买入新产品'])('never erases unknown residue while canonicalizing a typed locator: %s', message => {
    const result = run(message, [{ operation: 'investment_redeem', disposition: 'request', scope: { source: 'whole_message' }, entity: entity('position', 'position-1', 'T+2'), amount: { text: '680元' } }]);
    expect(result.tasks).toEqual([]); expect(result.status).toBe('clarification');
  });
  it('keeps quote/history and typed source references inert', () => {
    const message = '请改写“从T+2理财赎回680元”';
    expect(run(message, [{ operation: 'investment_redeem', disposition: 'request', scope: { source: 'whole_message' }, entity: entity('position', 'position-1', 'T+2'), amount: { text: '680元' } }]).tasks).toEqual([]);
  });
});

it('uses only a mock adapter for the semantic provider path and preserves the original payload', async () => {
  const message = '给顾霁转680元，备注“车费/已核对。”';
  const fetch = vi.spyOn(globalThis, 'fetch');
  try {
    const result = await interpretSemanticIntent({ ...base, message }, { provider: { baseURL: 'https://unused.invalid', model: 'unused' }, adapter: async payload => {
      expect((payload as { message: string }).message).toBe(message);
      return { tasks: [transfer(message, '680元', '车费/已核对。')] };
    } });
    expect(result.status).toBe('ready'); expect(fetch).not.toHaveBeenCalled(); expect(result.modelRuns).toEqual([]);
  } finally { fetch.mockRestore(); }
});
