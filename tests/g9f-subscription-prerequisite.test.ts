import { describe, expect, it, vi } from 'vitest';
import type { PlannerInput, SemanticPlan } from '../packages/contracts/src';
import { recognizeSubscriptionPrerequisite, verifySubscriptionContinuation, type SubscriptionPrerequisite } from '../packages/agents/src/subscription-prerequisite';
import { validateSemanticIntent } from '../packages/agents/src/semantic-intent';

function recognize(message: string): SubscriptionPrerequisite {
  const value = recognizeSubscriptionPrerequisite(message);
  expect(value).toBeDefined();
  return value!;
}
function grounded(prerequisite: SubscriptionPrerequisite): SemanticPlan {
  return { status: 'ready', recognizedRoles: ['subscription'], tasks: prerequisite.tasks.map((task, index) => ({ operation: task.operation, role: 'subscription', source: { ...task.source }, canonicalMessage: `${task.operation} server-object-${index}`, slots: { entityId: `server-object-${index}` } })), findings: [], modelRuns: [] };
}

describe('G9F prerequisite recognizes complete subscription writes without a catalog or grant', () => {
  it.each([
    ['请取消秋浦听书的商户订阅', 'subscription_cancel'],
    ['麻烦终止鹤汀咖啡的订阅合同。', 'subscription_cancel'],
    ['退订苔桥剧场的订阅', 'subscription_cancel'],
    ['取消鹿岑跑团会员', 'subscription_cancel'],
    ['请取消未登记音频的自动续费', 'subscription_cancel'],
    ['仅在银行侧阻止星屿健身未来扣款', 'subscription_block'],
    ['请从银行端拦截南汐训练的下一次自动扣款。', 'subscription_block'],
    ['阻止鹭湾工作室的银行扣款', 'subscription_block'],
    ['对棠隅花房只做银行扣款拦截。', 'subscription_block'],
    ['给叶渡舞社设置银行侧自动扣款限制', 'subscription_block'],
    ['对泊森阅读仅在银行侧阻止未来扣款', 'subscription_block'],
    ['请取消𠮷枝音乐的订阅！', 'subscription_cancel'],
    ['取消Cedar Music的订阅', 'subscription_cancel'],
    ['取消南苔会员中心的订阅', 'subscription_cancel'],
    ['取消梧灯合同书院的商户订阅', 'subscription_cancel'],
    ['在银行侧阻止雁湾健身合约的扣款', 'subscription_block'],
    ['在银行侧阻止一杉订阅社的扣款', 'subscription_block'],
    ['退订成功剧场的订阅', 'subscription_cancel'],
    ['请退订完成书屋的服务', 'subscription_cancel'],
    ['退订失败乐队的订阅', 'subscription_cancel'],
  ] as const)('keeps an unknown literal name unresolved in %s', (message, operation) => {
    const result = recognize(message);
    expect(result).toEqual({ version: 1, message, tasks: [{ operation, source: { text: message, start: 0, end: message.length } }] });
    expect(Object.keys(result.tasks[0]!).sort()).toEqual(['operation', 'source']);
  });
  it.each([
    '对棠隅花房只做银行扣款拦截，不要取消商户合同。',
    '对棠隅花房只做银行扣款拦截，合约由我自己处理。先给待确认候选。',
    '棠隅花房的合约我自己联系商户，请仅在银行侧阻止这项订阅未来扣款。',
    '保留棠隅花房会员，但请从银行侧阻止下一次扣款，不要取消商户合同。',
  ])('retains all bank-only constraints and preceding object declarations: %s', message => {
    const result = recognize(message);
    expect(result.tasks).toEqual([{ operation: 'subscription_block', source: { text: message, start: 0, end: message.length } }]);
  });
  it.each([
    '取消秋浦听书的商户订阅，不要阻止银行扣款。',
    '取消秋浦听书的订阅，不做银行侧扣款限制。请生成待确认候选，不要执行。',
  ])('does not confuse cancellation with a bank restriction: %s', message => {
    expect(recognize(message).tasks[0]?.operation).toBe('subscription_cancel');
  });
  it('keeps exact complete nonoverlapping sources and order for two different operations', () => {
    const first = '本次分2项办理：取消秋浦听书的商户订阅；', second = ' 对棠隅花房只做银行扣款拦截，合约由我自己处理。请分别生成待确认候选。';
    const message = first + second, result = recognize(message);
    expect(result.tasks).toEqual([
      { operation: 'subscription_cancel', source: { text: first, start: 0, end: first.length } },
      { operation: 'subscription_block', source: { text: second, start: first.length, end: message.length } },
    ]);
    expect(result.tasks.map(task => task.source.text).join('')).toBe(message);
  });
  it.each([1, 2, 3, 4, 5, 6, 7, 8])('recognizes every one of %i explicit distinct requests', count => {
    const message = `本次分${count}项办理：` + Array.from({ length: count }, (_, index) => `取消青砚${index}号馆的订阅`).join('；') + '。请逐项准备待确认提案。';
    const result = recognize(message);
    expect(result.tasks).toHaveLength(count);
    expect(result.tasks.map(task => task.source.text).join('')).toBe(message);
    result.tasks.forEach((task, index) => { expect(message.slice(task.source.start, task.source.end)).toBe(task.source.text); if (index) expect(task.source.start).toBe(result.tasks[index - 1]!.source.end); });
    expect(verifySubscriptionContinuation(result, grounded(result))).toBe(true);
  });
  it('does not read the network or resolve unknown names', () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('NETWORK_FORBIDDEN'));
    try {
      const result = recognize('取消从未登记晨岛听歌的订阅；对未知白鹿瑜伽只做银行扣款限制');
      expect(result.tasks).toHaveLength(2); expect(fetch).not.toHaveBeenCalled();
    } finally { fetch.mockRestore(); }
  });
  it('supports the unchanged real seed request without treating a name noun as an operation', () => {
    const message = '取消云音乐的订阅；在银行侧阻止城市健身合约的扣款', pending = recognize(message);
    expect(pending.tasks.map(task => task.operation)).toEqual(['subscription_cancel', 'subscription_block']);
    expect(pending.tasks.map(task => task.source.text).join('')).toBe(message);
  });
});

describe('G9F unsupported source returns no partial prerequisite', () => {
  it.each([
    '', '   ', '查询订阅', '先查询订阅，再取消秋浦听书的订阅',
    '不要取消秋浦听书的订阅', '请别再取消秋浦听书的订阅', '以前取消秋浦听书的订阅',
    '旧稿里写了取消秋浦听书的订阅', '请改写“取消秋浦听书的订阅”', '取消“秋浦听书”的订阅',
    '如果还有扣款，就取消秋浦听书的订阅', '能不能取消秋浦听书的订阅', '取消秋浦听书的订阅吗',
    '取消秋浦听书的订阅？', '明天取消秋浦听书的订阅', '取消2028年10月青砚馆的订阅',
    '取消秋浦听书或棠隅花房的订阅', '取消秋浦听书和棠隅花房的订阅', '取消秋浦听书、棠隅花房的订阅',
    '取消秋浦听书且棠隅花房的订阅', '取消秋浦听书删除账号的订阅',
    '取消那个订阅', '取消这家会员', '退订某个', '取消所有会员', '取消部分订阅',
    '取消合同', '取消商户合同', '取消会员', '取消订阅', '退订商户合同', '对会员只做银行扣款拦截',
    '取消秋浦听书扣款', '取消秋浦听书的银行扣款', '阻止秋浦听书的商户订阅', '阻止秋浦听书扣款',
    '取消秋浦听书的订阅并取消棠隅花房的订阅',
    '取消秋浦听书的订阅；给任青砚转76元', '取消秋浦听书的订阅；查询银行卡状态',
    '取消秋浦听书的订阅；查询账单', '取消秋浦听书的订阅；赎回T+0理财200元',
    '取消秋浦听书的订阅；建立生活目标', '取消秋浦听书的订阅，备注“给任青砚转76元”',
    '取消秋浦听书的订阅；不用了', '取消秋浦听书的订阅；先等一下', '取消秋浦听书的订阅；未知说明',
    '取消秋浦听书的订阅；不要转账', '对棠隅花房只做银行扣款拦截；不要阻止银行扣款',
    '取消秋浦听书的订阅；不要取消商户合同', '对棠隅花房只做银行扣款拦截；不要取消秋浦听书订阅',
    '本次分3项办理：取消秋浦听书的订阅；对棠隅花房只做银行扣款拦截',
    '取消秋浦听书的订阅；对秋浦听书只做银行扣款拦截',
    '取消秋浦听书的订阅；再取消秋浦听书的订阅',
    '秋浦听书的合同我自己处理；对棠隅花房只做银行扣款拦截',
    '保留秋浦听书会员；取消秋浦听书的订阅',
    '秋浦听书的合同我自己处理；取消秋浦听书的订阅',
    '秋浦听书的合同我自己处理',
    '退订成功', '退订完成了', '退订已完成', '退订未成功', '退订没成功', '退订失败了',
    '退订没有完成', '退订已经生效了', '退订完成了吗', '退订没完成；请生成待确认候选',
    '退订好了', '退订不会成功', '退订苔桥剧场', '退订成功剧场', '请退订完成书屋',
  ])('rejects the entire unsupported request: %s', message => {
    expect(recognizeSubscriptionPrerequisite(message)).toBeUndefined();
  });
  it('rejects nine requests and overlong input without keeping a prefix', () => {
    expect(recognizeSubscriptionPrerequisite(Array.from({ length: 9 }, (_, index) => `取消青砚${index}号馆的订阅`).join('；'))).toBeUndefined();
    expect(recognizeSubscriptionPrerequisite('请'.repeat(12001) + '取消秋浦听书的订阅')).toBeUndefined();
    expect(recognizeSubscriptionPrerequisite('我想'.repeat(1000) + '取消秋浦听书的订阅')).toBeUndefined();
  });
});

describe('G9F continuation checks the exact frozen source and every grounded task', () => {
  const original = () => recognize('取消秋浦听书的订阅；对棠隅花房只做银行扣款拦截，合约由我自己处理。请分别生成待确认候选。');
  it('accepts exact ready tasks and leaves the original prerequisite and semantic plan unchanged', () => {
    const pending = original(), plan = grounded(pending), before = structuredClone({ pending, plan });
    expect(verifySubscriptionContinuation(pending, plan)).toBe(true);
    expect({ pending, plan }).toEqual(before);
  });
  it.each(['clarification', 'no_action', 'failed'] as const)('rejects %s even when task arrays happen to match', status => {
    const pending = original(), plan = grounded(pending); plan.status = status;
    expect(verifySubscriptionContinuation(pending, plan)).toBe(false);
  });
  it.each(['missing', 'extra', 'order', 'operation', 'role', 'text', 'start', 'end', 'missing-offsets', 'entity', 'duplicate-entity', 'amount', 'memo', 'funding', 'query', 'extra-role', 'issue', 'clarification'])('rejects %s drift in the authorized semantic plan', change => {
    const pending = original(), plan = grounded(pending);
    if (change === 'missing') plan.tasks.pop();
    if (change === 'extra') plan.tasks.push(structuredClone(plan.tasks[0]!));
    if (change === 'order') plan.tasks.reverse();
    if (change === 'operation') plan.tasks[0]!.operation = 'subscription_block';
    if (change === 'role') plan.tasks[0]!.role = 'card';
    if (change === 'text') plan.tasks[0]!.source.text = plan.tasks[0]!.source.text.replace('秋浦', '另一');
    if (change === 'start') plan.tasks[0]!.source.start = 1;
    if (change === 'end') plan.tasks[0]!.source.end!--;
    if (change === 'missing-offsets') { delete plan.tasks[0]!.source.start; delete plan.tasks[0]!.source.end; }
    if (change === 'entity') delete plan.tasks[0]!.slots.entityId;
    if (change === 'duplicate-entity') plan.tasks[1]!.slots.entityId = plan.tasks[0]!.slots.entityId;
    if (change === 'amount') plan.tasks[0]!.slots.amountMinor = '7600';
    if (change === 'memo') plan.tasks[0]!.slots.memo = '附加字段';
    if (change === 'funding') plan.tasks[0]!.slots.funding = { positionId: 'position', amountMinor: '100' };
    if (change === 'query') plan.tasks[0]!.operation = 'subscription_query';
    if (change === 'extra-role') plan.recognizedRoles!.push('transfer');
    if (change === 'issue') plan.issues = [{ path: ['tasks'], category: 'entity', code: 'UNRESOLVED' }];
    if (change === 'clarification') plan.clarification = '尚未唯一绑定';
    expect(verifySubscriptionContinuation(pending, plan)).toBe(false);
  });
  it.each(['version', 'message', 'operation', 'source', 'order', 'drop', 'invent'])('revalidates the stored prerequisite against its own full source: %s', change => {
    const pending = original(), plan = grounded(pending);
    if (change === 'version') (pending as { version: number }).version = 2;
    if (change === 'message') pending.message += '；给任青砚转76元';
    if (change === 'operation') pending.tasks[0]!.operation = 'subscription_block';
    if (change === 'source') pending.tasks[0]!.source.text = '取消秋浦听书订阅';
    if (change === 'order') pending.tasks.reverse();
    if (change === 'drop') pending.tasks.pop();
    if (change === 'invent') pending.tasks.push(structuredClone(pending.tasks[0]!));
    expect(verifySubscriptionContinuation(pending, plan)).toBe(false);
  });
  it('uses exact source rather than a normalized canonical message as the continuation identity', () => {
    const pending = original(), plan = grounded(pending);
    plan.tasks[0]!.canonicalMessage = '取消server-object-0订阅'; plan.tasks[1]!.canonicalMessage = '阻止server-object-1银行扣款';
    expect(verifySubscriptionContinuation(pending, plan)).toBe(true);
    plan.tasks[0]!.source.text = plan.tasks[0]!.canonicalMessage;
    expect(verifySubscriptionContinuation(pending, plan)).toBe(false);
  });
  it.each(['root-id', 'task-id', 'source-id', 'whitespace-entity', 'empty-entity', 'failure', 'canonical-only', 'source-swap'])('rejects unsupported persisted or semantic state: %s', change => {
    const pending = original(), plan = grounded(pending);
    if (change === 'root-id') (pending as any).entityId = 'premature-id';
    if (change === 'task-id') (pending.tasks[0] as any).entityId = 'premature-id';
    if (change === 'source-id') (pending.tasks[0]!.source as any).entityId = 'premature-id';
    if (change === 'whitespace-entity') plan.tasks[0]!.slots.entityId = ' id ';
    if (change === 'empty-entity') plan.tasks[0]!.slots.entityId = ' ';
    if (change === 'failure') plan.failure = { phase: 'semantic_intent', code: 'MODEL_TIMEOUT', retryable: true, message: '未完成', modelRuns: [] };
    if (change === 'canonical-only') { plan.tasks[0]!.source = { text: plan.tasks[0]!.canonicalMessage }; }
    if (change === 'source-swap') [plan.tasks[0]!.source, plan.tasks[1]!.source] = [plan.tasks[1]!.source, plan.tasks[0]!.source];
    expect(verifySubscriptionContinuation(pending, plan)).toBe(false);
  });
  it('preserves UTF-16 coordinates when an earlier unknown name contains a surrogate pair', () => {
    const first = '取消𠮷枝音乐的订阅；', second = '对棠隅花房只做银行扣款拦截', pending = recognize(first + second);
    expect(pending.tasks[1]!.source).toEqual({ text: second, start: first.length, end: first.length + second.length });
    expect(verifySubscriptionContinuation(pending, grounded(pending))).toBe(true);
  });
  it('accepts the real existing entity-grounding validator output after a synthetic authorized snapshot', () => {
    const pending = original();
    const input: PlannerInput = { taskId: 'g9f-pure-continuation', message: pending.message, accounts: [], payees: [], managementContext: { cards: [], subscriptions: {
      queryActionId: 'synthetic-query', queriedAt: '2026-10-25T00:00:00.000Z', accessExpiresAt: '2100-01-01T00:00:00.000Z', items: ['秋浦听书', '棠隅花房'].map((merchant, index) => ({ id: `sub-${index}`, merchant, amountMinor: '1700', currency: 'CNY', nextChargeDate: '2026-11-10', cardId: 'synthetic-card', merchantStatus: 'ACTIVE', bankStatus: 'ALLOWED', collectionStatus: 'ENABLED', version: 4, cancellationSupported: true, source: 'SYNTHETIC_MERCHANT' })),
    } } };
    const semantic = validateSemanticIntent(input, { tasks: pending.tasks.map((task, index) => ({ operation: task.operation, disposition: 'request', scope: task.source, entity: { kind: 'subscription', id: `sub-${index}`, mention: { text: index ? '棠隅花房' : '秋浦听书' } } })) });
    expect({ status: semantic.status, findings: semantic.findings }).toEqual({ status: 'ready', findings: [] });
    expect(verifySubscriptionContinuation(pending, semantic)).toBe(true);
    const unknown = structuredClone(input); unknown.managementContext!.subscriptions!.items = [];
    const unresolved = validateSemanticIntent(unknown, { tasks: pending.tasks.map(task => ({ operation: task.operation, disposition: 'request', scope: task.source, entity: { kind: 'subscription', id: 'invented', mention: { text: '未知商户' } } })) });
    expect(verifySubscriptionContinuation(pending, unresolved)).toBe(false);
  });
});
