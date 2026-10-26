import { describe, expect, it } from 'vitest';
import type { PlannerInput } from '../packages/contracts/src/index';
import { validateSemanticIntent } from '../packages/agents/src/semantic-intent';
import { inspectCardLocator } from '../packages/agents/src/card-locator';

// The two actual G9H card02 visible drafts are preserved as regression inputs.
// They are already exposed evidence, not new or blind evaluation cases.
const actualMessage = '备用借记卡已经找回，就是尾号3906那张，帮我解挂，之后我再完成验证。';
const actualInput: PlannerInput = { taskId: 'g9i-actual-card02', message: actualMessage, accounts: [], payees: [], managementContext: { cards: [
  { id: 'g9-card-daily', accountId: 'a', name: '日常借记卡', maskedNumber: '****6812', status: 'ACTIVE', version: 4, updatedAt: '2026-10-20T01:00:00Z' },
  { id: 'g9-card-spare', accountId: 'a', name: '备用借记卡', maskedNumber: '****3906', status: 'LOST', version: 2, updatedAt: '2026-10-21T01:00:00Z' },
] } };
function independent(message: string): PlannerInput {
  return { taskId: 'g9i-independent', message, accounts: [], payees: [], managementContext: { cards: [
    { id: 'travel', accountId: 'local', name: '桐湾旅行卡', maskedNumber: '****5724', status: 'LOST', version: 7, updatedAt: '2026-10-22T00:00:00Z' },
    { id: 'daily', accountId: 'local', name: '青岚生活卡', maskedNumber: '****8361', status: 'ACTIVE', version: 3, updatedAt: '2026-10-22T00:00:00Z' },
  ] } };
}
function evaluate(message: string, mention = '尾号5724', operation = 'card_restore', entityId = 'travel', input = independent(message)) {
  return validateSemanticIntent(input, { tasks: [{ operation, disposition: operation === 'card_query' ? 'query' : 'request', scope: { source: 'whole_message' }, entity: { kind: 'card', id: entityId, mention: { text: mention } } }] });
}
function locator(message: string, mention = '尾号5724', input = independent(message)) {
  const start = message.indexOf(mention);
  return inspectCardLocator({ message, scope: { text: message, start: 0, end: message.length }, mention: { text: mention, start, end: start + mention.length }, entityId: 'travel', cards: input.managementContext!.cards });
}
describe('G9I card apposition original-source binding', () => {
  it.each([{ text: '尾号3906' }, { start: 12, end: 18, text: '尾号3906' }])('accepts the actual G9H card02 complete locator without losing source: %j', mention => {
    const draft = { tasks: [{ operation: 'card_restore', disposition: 'request', scope: { source: 'whole_message' }, entity: { kind: 'card', id: 'g9-card-spare', mention } }] };
    const result = validateSemanticIntent(actualInput, draft);
    expect(result.status).toBe('ready');
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]).toMatchObject({ operation: 'card_restore', role: 'card', source: { text: actualMessage, start: 0, end: actualMessage.length }, slots: { entityId: 'g9-card-spare' } });
  });

  it.each([
    ['桐湾旅行卡已经找回，就是尾号5724那张，帮我解挂。', '尾号5724'],
    ['请把桐湾旅行卡，也就是尾号5724的那张卡，准备解挂。', '尾号5724'],
    ['桐湾旅行卡也就是尾号5724这张银行卡，请准备解挂。', '尾号5724'],
    ['桐湾旅行卡已经找到了，也即尾号5724那一张，麻烦解挂。', '尾号5724'],
    ['桐湾旅行卡已寻回，即末四位5724的那张卡片，请解挂。', '末四位5724'],
    ['桐湾旅行卡，就是尾号 5724 那张信用卡，请解挂。', '尾号 5724'],
    ['桐湾旅行卡，就是尾号5724，请解挂。', '尾号5724'],
  ])('binds a complete known-card apposition without changing source: %s', (message, mention) => {
    const result = evaluate(message, mention);
    expect(result.status).toBe('ready');
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]).toMatchObject({ operation: 'card_restore', source: { text: message, start: 0, end: message.length }, slots: { entityId: 'travel' } });
    expect(result.tasks[0]!.slots).not.toHaveProperty('amountMinor');
  });

  it.each([
    '青岚生活卡，也就是尾号8361的那张卡，请先准备挂失。',
    '青岚生活卡即尾号8361那张，请挂失。',
  ])('keeps the distinct active card and requested loss operation: %s', message => {
    const result = evaluate(message, '尾号8361', 'card_report_lost', 'daily');
    expect(result.status).toBe('ready');
    expect(result.tasks[0]).toMatchObject({ operation: 'card_report_lost', slots: { entityId: 'daily' } });
  });

  it.each([
    '桐湾旅行卡，也就是尾号5724那张，请查询其状态，不要解挂。',
    '青岚生活卡，就是尾号8361的那张卡，当前是什么状态？不要挂失。',
  ])('retains read-only operation and local write prohibition: %s', message => {
    const daily = message.includes('8361');
    const result = evaluate(message, daily ? '尾号8361' : '尾号5724', 'card_query', daily ? 'daily' : 'travel');
    expect(result.status).toBe('ready');
    expect(result.tasks[0]?.operation).toBe('card_query');
  });

  it.each([
    '陌生旅行卡，就是尾号5724那张，请解挂。',
    '新桐湾旅行卡，就是尾号5724那张，请解挂。',
    '桐湾旅行卡附属账户，就是尾号5724那张，请解挂。',
    '给甲方代管的桐湾旅行卡，就是尾号5724那张，请解挂。',
    '银行卡，就是尾号5724那张，请解挂。',
    '如果桐湾旅行卡找回，就是尾号5724那张，请解挂。',
    '桐湾旅行卡找回后才用，就是尾号5724那张，请解挂。',
    '我说的是桐湾旅行卡或青岚生活卡，就是尾号5724那张，请解挂。',
  ])('rejects unconsumed subject modifiers, conditions and unknown card nouns: %s', message => {
    expect(() => locator(message)).toThrow('SEMANTIC_ENTITY_');
    expect(evaluate(message).status).not.toBe('ready');
  });

  it.each([
    ['桐湾旅行卡，就是尾号57245那张，请解挂。', '尾号5724'],
    ['桐湾旅行卡，就是1尾号5724那张，请解挂。', '尾号5724'],
    ['桐湾旅行卡，就是尾号5724那张123，请解挂。', '尾号5724'],
    ['桐湾旅行卡，就是尾号5724那张陌生卡，请解挂。', '尾号5724'],
    ['桐湾旅行卡，就是尾号5724 那张 陌生卡，请解挂。', '尾号5724'],
    ['桐湾旅行卡，就是尾号5724那张卡的附属卡，请解挂。', '尾号5724'],
    ['桐湾旅行卡，就是尾号5724那张卡ABC，请解挂。', '尾号5724'],
    ['桐湾旅行卡，就是尾号572那张，请解挂。', '尾号572'],
    ['桐湾旅行卡，就是尾号５７２４那张，请解挂。', '尾号５７２４'],
  ])('preserves complete digit and noun boundaries: %s', (message, mention) => {
    expect(() => locator(message, mention)).toThrow('SEMANTIC_ENTITY_');
    expect(evaluate(message, mention).status).not.toBe('ready');
  });

  it.each([
    '青岚生活卡，就是尾号5724那张，请解挂。',
    '桐湾旅行卡，就是尾号8361那张，请解挂。',
    '桐湾旅行卡，就是尾号5724那张，与尾号8361一并解挂。',
    '桐湾旅行卡，就是尾号5724那张；青岚生活卡也要解挂。',
  ])('rejects conflicting names, tails and multiple card objects: %s', message => {
    const mention = message.includes('尾号5724') ? '尾号5724' : '尾号8361';
    expect(() => locator(message, mention)).toThrow('SEMANTIC_ENTITY_');
    expect(evaluate(message, mention).status).not.toBe('ready');
  });

  it('cannot choose among duplicate catalog suffixes or accept the wrong catalog ID', () => {
    const message = '桐湾旅行卡，就是尾号5724那张，请解挂。', value = independent(message);
    value.managementContext!.cards.push({ ...value.managementContext!.cards[0]!, id: 'other-copy', name: '同尾号另一卡' });
    expect(evaluate(message, '尾号5724', 'card_restore', 'travel', value).status).not.toBe('ready');
    expect(evaluate(message, '尾号5724', 'card_restore', 'daily').status).not.toBe('ready');
  });

  it.each([
    '桐湾旅行卡，就是尾号5724那张，不要解挂。',
    '桐湾旅行卡，就是尾号5724那张，别恢复它。',
    '培训例句是“桐湾旅行卡，就是尾号5724那张，请解挂”，现在不要办理。',
    '有人说过“桐湾旅行卡，就是尾号5724那张，请解挂”。我只是复述。',
    '桐湾旅行卡，就是尾号5724那张，昨天已经解挂了。',
    '假设桐湾旅行卡，就是尾号5724那张，将来再解挂。',
    '旧稿里面写着：桐湾旅行卡，就是尾号5724那张，请解挂。不要执行旧稿。',
    '等我核实后，桐湾旅行卡，就是尾号5724那张，再解挂。',
    '只有我再次确认，桐湾旅行卡，就是尾号5724那张，才解挂。',
    '资料里原先要求，桐湾旅行卡即尾号5724那张，请解挂。只是资料记录。',
    '等我到柜台核对后，桐湾旅行卡即尾号5724那张，再解挂。',
    '不要桐湾旅行卡，就是尾号5724那张，请解挂。',
    '不用桐湾旅行卡，就是尾号5724那张，请解挂。',
    '别再桐湾旅行卡，就是尾号5724那张，请解挂。',
    '桐湾旅行卡，就是尾号5724那张，等我核实后再解挂。',
    '桐湾旅行卡，就是尾号5724那张，只有我再次确认才解挂。',
    '桐湾旅行卡，就是尾号5724那张，旧稿里写着请解挂，现在不要执行旧稿。',
  ])('never turns negation, quoted commands, history or hypotheticals into a current restore: %s', message => {
    expect(evaluate(message).status).not.toBe('ready');
  });

  it('preserves the locator source span and exposes only the proven demonstrative end', () => {
    const message = '桐湾旅行卡，就是尾号5724的那张银行卡，请解挂。';
    const result = locator(message)!;
    expect(result.cardId).toBe('travel');
    expect(message.slice(message.indexOf('尾号5724') + '尾号5724'.length, result.appositionEnd)).toBe('的那张银行卡');
    expect(message.slice(result.appositionEnd)).toBe('，请解挂。');
  });

  it('rejects a long unknown prefix through bounded apposition parsing', () => {
    const message = `${'别再'.repeat(60)}陌生桐湾旅行卡，就是尾号5724那张，请解挂。`;
    expect(() => locator(message)).toThrow('SEMANTIC_ENTITY_');
    expect(evaluate(message).status).not.toBe('ready');
  });

  it('does not reinterpret a complete catalog name ending in a copula token', () => {
    const message = '云即尾号5724，请解挂。', value = independent(message);
    value.managementContext!.cards[0]!.name = '云即';
    expect(evaluate(message, '尾号5724', 'card_restore', 'travel', value).status).toBe('ready');
    expect(locator(message, '尾号5724', value)).not.toHaveProperty('appositionEnd');
  });

  it.each([
    '桐湾旅行卡，就是尾号5724那张，请挂失。',
    '桐湾旅行卡，就是尾号5724那张，请解挂，再挂失。',
    '桐湾旅行卡，就是尾号5724那张，先给小禾转10元，再解挂。',
    '桐湾旅行卡，就是尾号5724那张，我完成验证后再解挂。',
    '桐湾旅行卡，就是尾号5724那张，之后我再完成验证，请解挂。',
  ])('does not change operations or discard extra/conditional tasks to bind a card: %s', message => {
    expect(evaluate(message).status).not.toBe('ready');
  });
});
