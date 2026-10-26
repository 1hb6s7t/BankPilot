import { afterEach, describe, expect, it, vi } from 'vitest';
import { interpretSemanticIntent, semanticIntentSchema, validateSemanticIntent, type SemanticIntentDraft } from '../packages/agents/src/semantic-intent';
import type { Planner } from '../packages/contracts/src/index';

const base: Parameters<Planner['plan']>[0] = { taskId: 'whole-source', message: '', accounts: [], payees: [{ id: 'p', name: '林晓', aliases: [], bank: '合成银行', maskedNumber: '****1234' }] };
const transfer = (amount = '317.25元', memo = '会话恢复'): SemanticIntentDraft => ({ tasks: [{ operation: 'transfer', disposition: 'request', scope: { source: 'whole_message' }, entity: { kind: 'payee', id: 'p', mention: { text: '林晓' } }, amount: { text: amount }, memo: { text: memo } }] });
const provider = { baseURL: 'https://sentinel.invalid/v1', model: 'synthetic', outputMode: 'json_object' as const, maxAttempts: 2, retryDelayMs: 0, maxOutputTokens: 4096 };
const envelope = (raw: unknown) => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(raw) } }] }));
afterEach(() => vi.unstubAllGlobals());

describe('explicit immutable whole-message source reference', () => {
  it('preserves every original punctuation/code unit without model copying', () => {
    const message = '给林晓转账317.25元，备注会话恢复';
    const result = validateSemanticIntent({ ...base, message }, transfer());
    expect(result.status).toBe('ready'); expect(result.tasks[0]?.source).toEqual({ start: 0, end: message.length, text: message });
    expect(result.tasks[0]?.slots).toEqual({ entityId: 'p', amountMinor: '31725', memo: '会话恢复' });
    const normalizedCopy = transfer(); normalizedCopy.tasks[0]!.scope = { text: message.replace('，', ',') };
    expect(validateSemanticIntent({ ...base, message }, normalizedCopy).findings).toEqual(['SEMANTIC_SPAN_NOT_FOUND']);
  });
  it('allows the explicit marker to fix scope copying inside the same existing retry', async () => {
    const message = '给林晓转账317.25元，备注会话恢复', wrong = transfer(); wrong.tasks[0]!.scope = { text: message.replace('，', ',') };
    const fetch = vi.fn().mockResolvedValueOnce(envelope(wrong)).mockResolvedValueOnce(envelope(transfer())); vi.stubGlobal('fetch', fetch);
    const result = await interpretSemanticIntent({ ...base, message }, { provider });
    expect(result.status).toBe('ready'); expect(result.tasks[0]?.source.text).toBe(message); expect(fetch).toHaveBeenCalledTimes(2);
    expect(result.modelRuns.map(run => run.status)).toEqual(['failed', 'success']);
  });
  it('grounds funds query punctuation from original source', () => {
    const message = '帮我查一下扣除房租、生活费和最低余额之后，还能安排多少钱？';
    const result = validateSemanticIntent({ ...base, message }, { tasks: [{ operation: 'funds_query', disposition: 'query', scope: { source: 'whole_message' } }] });
    expect(result.status).toBe('ready'); expect(result.tasks[0]?.source.text).toBe(message); expect(result.tasks[0]?.slots).toEqual({});
  });
  it('keeps an explicit trailing memo distinct from an additional domain request', () => {
    const message = '给林晓转账317.25元，备注生活费';
    const result = validateSemanticIntent({ ...base, message }, transfer('317.25元', '生活费'));
    expect(result.status).toBe('ready'); expect(result.tasks[0]?.slots.memo).toBe('生活费');
    const withExtra = `${message}，查询账单`;
    expect(validateSemanticIntent({ ...base, message: withExtra }, transfer('317.25元', '生活费')).tasks).toEqual([]);
  });
  it('does not mistake a grounded product containing 计划 for a second goal operation', () => {
    const input: Parameters<Planner['plan']>[0] = { ...base, message: '从晨星储蓄计划赎回317.25元', investmentContext: {
      businessDate: '2026-10-23', calendar: 'DEMO_WEEKDAYS_V1', products: [], actions: [], positions: [{ id: 'position-plan', productId: 'product', productName: '晨星储蓄计划', accountId: 'account', principalMinor: '500000', availableMinor: '500000', reservedMinor: '0', version: 1, redemptionBusinessDays: 0, calendar: 'DEMO_WEEKDAYS_V1' }],
    } };
    const raw = { tasks: [{ operation: 'investment_redeem', disposition: 'request', scope: { source: 'whole_message' }, entity: { kind: 'position', id: 'position-plan', mention: { text: '晨星储蓄计划' } }, amount: { text: '317.25元' } }] };
    expect(validateSemanticIntent(input, raw).tasks[0]?.slots).toEqual({ entityId: 'position-plan', amountMinor: '31725' });
    expect(validateSemanticIntent({ ...input, message: `${input.message}，并查询账单` }, raw).tasks).toEqual([]);
  });
  it.each(['林晓，再查询账单', '林晓，挂失银行卡', '林晓并列出账单', '林晓然后转账'])('does not erase command cues inside a catalog-grounded alias: %s', alias => {
    const input = { ...base, message: `转给${alias}317.25元，备注会话恢复`, payees: [{ ...base.payees[0]!, aliases: [alias] }] };
    const raw = transfer(); raw.tasks[0]!.entity!.mention = { text: alias };
    const result = validateSemanticIntent(input, raw);
    expect(result.status).toBe('clarification'); expect(result.tasks).toEqual([]);
    expect(result.issues).toEqual([{ path: ['tasks', '0', 'entity', 'mention'], category: 'entity', code: 'SEMANTIC_ENTITY_COMMAND_CONTENT' }]);
  });
  it.each(['林晓，给小林转', '林晓，向小林转', '林晓并查询账单'])('does not mask command-shaped recipient language in an alias: %s', alias => {
    const input = { ...base, message: `转给${alias}317.25元，备注会话恢复`, payees: [{ ...base.payees[0]!, aliases: [alias] }] };
    const raw = transfer(); raw.tasks[0]!.entity!.mention = { text: alias };
    const result = validateSemanticIntent(input, raw);
    expect(result.status).toBe('clarification'); expect(result.tasks).toEqual([]); expect(result.findings).toEqual(['SEMANTIC_ENTITY_COMMAND_CONTENT']);
  });
  it.each(['林晓，顺手查下账单', '林晓，看下银行卡当前状态', '林晓，看一下银行卡当前状态', '林晓，顺手查一下账单'])('does not mask colloquial query commands in a saved alias: %s', alias => {
    const input = { ...base, message: `转给${alias}317.25元，备注会话恢复`, payees: [{ ...base.payees[0]!, aliases: [alias] }] };
    const raw = transfer(); raw.tasks[0]!.entity!.mention = { text: alias };
    const result = validateSemanticIntent(input, raw);
    expect(result.status).toBe('clarification'); expect(result.tasks).toEqual([]);
    expect(result.issues).toEqual([{ path: ['tasks', '0', 'entity', 'mention'], category: 'entity', code: 'SEMANTIC_ENTITY_COMMAND_CONTENT' }]);
  });
  it.each(['林晓瞧瞧账单', '林晓瞅一眼账单', '林晓浏览一下账单'])('does not erase common read verbs and particles in an alias: %s', alias => {
    const input = { ...base, message: `转给${alias}317.25元，备注会话恢复`, payees: [{ ...base.payees[0]!, aliases: [alias] }] };
    const raw = transfer(); raw.tasks[0]!.entity!.mention = { text: alias };
    const result = validateSemanticIntent(input, raw);
    expect(result.status).toBe('clarification'); expect(result.tasks).toEqual([]);
    expect(result.findings).toEqual(['SEMANTIC_ENTITY_COMMAND_CONTENT']);
  });
  it.each(['林晓注销银行卡', '林晓补办银行卡', '林晓销卡', '林晓补卡', '林晓换卡'])('does not hide card closure or reissue operations inside an alias: %s', alias => {
    const input = { ...base, message: `转给${alias}317.25元，备注会话恢复`, payees: [{ ...base.payees[0]!, aliases: [alias] }] };
    const raw = transfer(); raw.tasks[0]!.entity!.mention = { text: alias };
    const result = validateSemanticIntent(input, raw);
    expect(result.status).toBe('clarification'); expect(result.tasks).toEqual([]);
    expect(result.issues).toEqual([{ path: ['tasks', '0', 'entity', 'mention'], category: 'entity', code: 'SEMANTIC_ENTITY_COMMAND_CONTENT' }]);
  });
  it.each(['林晓卖出基金', '林晓买入基金', '林晓申购基金', '林晓认购基金', '林晓购买基金', '林晓购买理财'])('does not hide investment purchase or sale operations inside an alias: %s', alias => {
    const input = { ...base, message: `转给${alias}317.25元，备注会话恢复`, payees: [{ ...base.payees[0]!, aliases: [alias] }] };
    const raw = transfer(); raw.tasks[0]!.entity!.mention = { text: alias };
    const result = validateSemanticIntent(input, raw);
    expect(result.status).toBe('clarification'); expect(result.tasks).toEqual([]);
    expect(result.issues).toEqual([{ path: ['tasks', '0', 'entity', 'mention'], category: 'entity', code: 'SEMANTIC_ENTITY_COMMAND_CONTENT' }]);
  });
  it.each(['林晓报失银行卡', '林晓退订音乐订阅', '林晓禁止银行扣款', '林晓屏蔽银行扣款', '林晓拦截银行扣款', '林晓安排储蓄计划', '林晓制定储蓄目标'])('rejects resolver-aligned management and goal commands inside an alias: %s', alias => {
    const input = { ...base, message: `转给${alias}317.25元，备注会话恢复`, payees: [{ ...base.payees[0]!, aliases: [alias] }] };
    const raw = transfer(); raw.tasks[0]!.entity!.mention = { text: alias };
    const result = validateSemanticIntent(input, raw);
    expect(result.status).toBe('clarification'); expect(result.tasks).toEqual([]);
    expect(result.findings[0]).toMatch(/^SEMANTIC_(?:ENTITY_COMMAND_CONTENT|GOAL_IMMEDIATE_CONFLICT)$/);
  });
  it.each(['林晓开启自动续费', '林晓开通自动续费', '林晓启用自动续费'])('does not hide unsupported recurring-charge enablement inside an alias: %s', alias => {
    const input = { ...base, message: `转给${alias}317.25元，备注会话恢复`, payees: [{ ...base.payees[0]!, aliases: [alias] }] };
    const raw = transfer(); raw.tasks[0]!.entity!.mention = { text: alias };
    const result = validateSemanticIntent(input, raw);
    expect(result.status).toBe('clarification'); expect(result.tasks).toEqual([]);
    expect(result.findings).toEqual(['SEMANTIC_ENTITY_COMMAND_CONTENT']);
  });
  it('accepts a benign name containing 并 without a following operation', () => {
    const alias = '并蒂莲', message = `转给${alias}317.25元，备注会话恢复`;
    const raw = transfer(); raw.tasks[0]!.entity!.mention = { text: alias };
    const result = validateSemanticIntent({ ...base, message, payees: [{ ...base.payees[0]!, aliases: [alias] }] }, raw);
    expect(result.status).toBe('ready'); expect(result.tasks[0]?.slots).toEqual({ entityId: 'p', amountMinor: '31725', memo: '会话恢复' });
    expect(result.tasks[0]?.source.text).toBe(message);
  });
  it('does not erase a query embedded in an authoritative product name', () => {
    const productName = '晨星储蓄计划查询账单';
    const input: Parameters<Planner['plan']>[0] = { ...base, message: `赎回${productName}317.25元`, investmentContext: {
      businessDate: '2026-10-23', calendar: 'DEMO_WEEKDAYS_V1', products: [], actions: [], positions: [{ id: 'position-plan', productId: 'product', productName, accountId: 'account', principalMinor: '500000', availableMinor: '500000', reservedMinor: '0', version: 1, redemptionBusinessDays: 0, calendar: 'DEMO_WEEKDAYS_V1' }],
    } };
    const result = validateSemanticIntent(input, { tasks: [{ operation: 'investment_redeem', disposition: 'request', scope: { source: 'whole_message' }, entity: { kind: 'position', id: 'position-plan', mention: { text: productName } }, amount: { text: '317.25元' } }] });
    expect(result.status).toBe('clarification'); expect(result.tasks).toEqual([]); expect(result.findings).toEqual(['SEMANTIC_ENTITY_COMMAND_CONTENT']);
  });
  it('never hides a negation merely because it occurs in a saved alias', () => {
    const alias = '林晓不要转账';
    const input = { ...base, message: `给${alias}317.25元，备注会话恢复`, payees: [{ ...base.payees[0]!, aliases: [alias] }] };
    const raw = transfer(); raw.tasks[0]!.entity!.mention = { text: alias };
    const result = validateSemanticIntent(input, raw); expect(result.status).not.toBe('ready'); expect(result.tasks).toEqual([]);
  });
  it.each(['不要给林晓转账317.25元，备注会话恢复', '给林晓转账317.25元，备注会话恢复，只是个示例', '请翻译：给林晓转账317.25元，备注会话恢复', '历史记录：给林晓转账317.25元，备注会话恢复', '“给林晓转账317.25元，备注会话恢复”'])('keeps full-source safety vetoes: %s', message => {
    const result = validateSemanticIntent({ ...base, message }, transfer()); expect(result.tasks).toEqual([]); expect(result.status).not.toBe('ready');
  });
  it.each(['给林晓转账317.25元，备注会话恢复，并查询本月账单', '给林晓转账317.25元，备注会话恢复，挂失银行卡', '给林晓转账317.25元，备注会话恢复，再给林晓转账'])('rejects omitted extra operations: %s', message => {
    const raw = transfer(); raw.tasks[0]!.entity!.mention = { text: '林晓', start: 1, end: 3 };
    expect(validateSemanticIntent({ ...base, message }, raw).findings).toEqual(['SEMANTIC_WHOLE_MESSAGE_EXTRA_OPERATION']);
  });
  it('rejects multi-task markers without spending a regeneration to remove tasks', async () => {
    const message = '给林晓转账317.25元，备注会话恢复，并查询账单';
    const raw = { tasks: [...transfer().tasks, { operation: 'bills_query', disposition: 'query', scope: { text: '查询账单' } }] };
    expect(semanticIntentSchema.safeParse(raw).success).toBe(false);
    expect(validateSemanticIntent({ ...base, message }, raw).findings).toEqual(['SEMANTIC_WHOLE_MESSAGE_MULTITASK']);
    const fetch = vi.fn().mockImplementation(async () => envelope(raw)); vi.stubGlobal('fetch', fetch);
    const result = await interpretSemanticIntent({ ...base, message }, { provider });
    expect(result.tasks).toEqual([]); expect(result.findings).toEqual(['SEMANTIC_WHOLE_MESSAGE_MULTITASK']); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each([{}, { source: 'current_message' }, { source: 'whole_message', text: 'replacement' }, { source: 'whole_message', start: 1 }])('requires an exact explicit marker with no extra fields: %j', scope => {
    const raw = transfer(); (raw.tasks[0] as unknown as { scope: unknown }).scope = scope;
    expect(validateSemanticIntent({ ...base, message: '给林晓转账317.25元，备注会话恢复' }, raw).status).toBe('clarification');
  });
  it('still rejects partial amount and unknown recipient mentions', () => {
    for (const message of ['给林晓转账1317.25元，备注会话恢复', '给王林晓转账317.25元，备注会话恢复']) {
      const result = validateSemanticIntent({ ...base, message }, transfer()); expect(result.tasks).toEqual([]); expect(result.status).toBe('clarification');
    }
  });
});
