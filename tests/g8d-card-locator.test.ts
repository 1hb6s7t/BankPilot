import { describe, expect, it } from 'vitest';
import { validateSemanticIntent } from '../packages/agents/src/semantic-intent';
import type { Planner } from '../packages/contracts/src';
import { inspectCardLocator } from '../packages/agents/src/card-locator';

type Input = Parameters<Planner['plan']>[0];
const cards = [
  { id: 'card-a', accountId: 'a', name: '榆庭卡', maskedNumber: '****3750', status: 'ACTIVE' as const, version: 1, updatedAt: '2026-10-23T00:00:00Z' },
  { id: 'card-b', accountId: 'b', name: '栖木卡', maskedNumber: '****9162', status: 'ACTIVE' as const, version: 1, updatedAt: '2026-10-23T00:00:00Z' },
];
const input = (message: string, values = cards): Input => ({ taskId: 'g8d-locator-independent', message, accounts: [], payees: [], managementContext: { cards: values } });
function resolve(message: string, mention: string, operation: 'card_query' | 'card_report_lost' | 'card_restore' = 'card_report_lost',
  literal = false, values = cards, entityId = 'card-a') {
  return validateSemanticIntent(input(message, values), { tasks: [{ operation, disposition: operation === 'card_query' ? 'query' : 'request',
    scope: literal ? { text: message } : { source: 'whole_message' }, entity: { kind: 'card', id: entityId, mention: { text: mention } } }] });
}

describe.each([false, true])('typed card locators with literal scope=%s', literal => {
  it.each(['尾号3750', '卡尾号3750', '银行卡尾号3750', '卡片尾号3750', '银行卡末四位3750'])('keeps the complete typed mention %s and original source', mention => {
    const noun = mention.startsWith('尾号') ? '银行卡' : '';
    const message = `我的${noun}${mention}找不到了，请挂失`;
    const result = resolve(message, mention, 'card_report_lost', literal);
    expect(result.status).toBe('ready');
    expect(result.tasks[0]).toMatchObject({ source: { text: message }, slots: { entityId: 'card-a' } });
  });
  it('uses the same typed object for a read-only query', () => {
    const result = resolve('查询我的银行卡尾号3750当前状态', '银行卡尾号3750', 'card_query', literal);
    expect(result.status).toBe('ready'); expect(result.tasks[0]?.slots.entityId).toBe('card-a');
  });
  it.each([
    ['我的银行卡尾号3750找不到了，请挂失', '3750'],
    ['我的银行卡尾号37501找不到了，请挂失', '银行卡尾号3750'],
    ['我的银行卡尾号37501找不到了，请挂失', '银行卡尾号37501'],
    ['我的银行卡尾号13750找不到了，请挂失', '银行卡尾号13750'],
    ['我的陌生银行卡尾号3750找不到了，请挂失', '银行卡尾号3750'],
    ['我的陌生银行卡尾号3750找不到了，请挂失', '尾号3750'],
    ['新榆庭卡尾号3750找不到了，请挂失', '尾号3750'],
    ['我的银行卡尾号3750属于另一张卡，请挂失', '银行卡尾号3750'],
  ])('rejects a cropped/unknown/contradictory object: %s (%s)', (message, mention) => {
    const result = resolve(message, mention, 'card_report_lost', literal);
    expect(result.status).toBe('clarification'); expect(result.tasks).toEqual([]);
  });
  it.each(['card_query', 'card_report_lost'] as const)('rejects a conflicting saved card name for %s', operation => {
    const message = operation === 'card_query' ? '查询栖木卡尾号3750当前状态' : '栖木卡尾号3750找不到了，请挂失';
    const result = resolve(message, '尾号3750', operation, literal);
    expect(result.status).toBe('clarification'); expect(result.tasks).toEqual([]);
    expect(result.findings).toContain('SEMANTIC_ENTITY_CONFLICT');
  });
  it('does not use the model entity ID to choose among duplicate tails', () => {
    const values = [cards[0]!, { ...cards[1]!, maskedNumber: '****3750' }];
    const result = resolve('我的银行卡尾号3750找不到了，请挂失', '银行卡尾号3750', 'card_report_lost', literal, values);
    expect(result.status).toBe('clarification'); expect(result.findings).toContain('SEMANTIC_ENTITY_NOT_UNIQUE');
  });
  it('rejects an entity ID different from the uniquely typed target', () => {
    const result = resolve('我的银行卡尾号3750找不到了，请挂失', '银行卡尾号3750', 'card_report_lost', literal, cards, 'card-b');
    expect(result.status).toBe('clarification'); expect(result.tasks).toEqual([]);
  });
  it('preserves negation instead of creating a card action', () => {
    const result = resolve('不要挂失我的银行卡尾号3750', '银行卡尾号3750', 'card_report_lost', literal);
    expect(result.status).not.toBe('ready'); expect(result.tasks).toEqual([]);
  });
});

function inspect(message: string, mention: string, values = cards, entityId = 'card-a') {
  const start = message.indexOf(mention);
  return inspectCardLocator({ message, scope: { start: 0, end: message.length, text: message },
    mention: { start, end: start + mention.length, text: mention }, entityId, cards: values });
}

describe('typed card locator source and catalog boundaries', () => {
  it.each([
    ['我的银行卡尾号3750找不到了，请挂失', '银行卡尾号3750'],
    ['请帮我把银行卡尾号3750挂失', '银行卡尾号3750'],
    ['查询我的卡片末四位 3750当前状态', '卡片末四位 3750'],
    ['榆庭卡尾号3750找不到了，请挂失', '榆庭卡尾号3750'],
    ['查询榆庭卡尾号3750当前状态', '尾号3750'],
    ['查询尾号3750当前状态', '尾号3750'],
  ])('resolves a complete source locator: %s', (message, mention) => {
    expect(inspect(message, mention)).toEqual({ suffix: '3750', cardId: 'card-a' });
  });
  it('leaves exact name grounding to the caller', () => {
    expect(inspect('查询榆庭卡当前状态', '榆庭卡')).toBeUndefined();
  });
  it.each([
    ['查询我的陌生银行卡尾号3750当前状态', '银行卡尾号3750'],
    ['查询我的陌生银行卡尾号3750当前状态', '尾号3750'],
    ['查询我的新榆庭卡尾号3750当前状态', '榆庭卡尾号3750'],
    ['查询我的新榆庭卡尾号3750当前状态', '尾号3750'],
    ['查询未知前缀卡尾号3750当前状态', '卡尾号3750'],
    ['查询银行卡尾号37501当前状态', '尾号3750'],
    ['查询银行卡尾号13750当前状态', '尾号13750'],
    ['查询银行卡尾号3750当前状态', '行卡尾号3750'],
  ])('rejects incomplete typed syntax or hidden source qualifier: %s', (message, mention) => {
    expect(() => inspect(message, mention)).toThrow('SEMANTIC_ENTITY_TOKEN_TRUNCATED');
  });
  it('does not let the selected entity ID disambiguate duplicate tails', () => {
    expect(() => inspect('查询银行卡尾号3750当前状态', '银行卡尾号3750',
      [cards[0]!, { ...cards[1]!, maskedNumber: '****3750' }])).toThrow('SEMANTIC_ENTITY_NOT_UNIQUE');
  });
  it('can ground an exact saved card name together with its tail', () => {
    expect(inspect('查询榆庭卡尾号3750当前状态', '榆庭卡尾号3750',
      [cards[0]!, { ...cards[1]!, maskedNumber: '****3750' }])).toEqual({ suffix: '3750', cardId: 'card-a' });
  });
  it.each([
    ['查询栖木卡尾号3750当前状态', '尾号3750'],
    ['查询银行卡尾号3750和尾号9162当前状态', '银行卡尾号3750'],
  ])('rejects contradictory card evidence: %s', (message, mention) => {
    expect(() => inspect(message, mention)).toThrow('SEMANTIC_ENTITY_CONFLICT');
  });
  it('rejects a forged source span before resolving a catalog entry', () => {
    expect(() => inspectCardLocator({ message: '卡尾号3750', scope: { start: 0, end: 7, text: '卡尾号3750' },
      mention: { start: 0, end: 7, text: '卡尾号9162' }, cards, entityId: 'card-a' })).toThrow('SEMANTIC_ENTITY_SPAN_INVALID');
  });
});
