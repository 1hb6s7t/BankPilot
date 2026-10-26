import { describe, expect, it } from 'vitest';
import type { PlannerInput } from '../packages/contracts/src/index';
import { inspectCardLocator } from '../packages/agents/src/card-locator';
import { validateSemanticIntent } from '../packages/agents/src/semantic-intent';

function input(message: string): PlannerInput {
  return { taskId: 'g9i-independent-card-grammar', message, accounts: [], payees: [], managementContext: { cards: [
    { id: 'commute', accountId: 'private', name: '栖霞通勤卡', maskedNumber: '****4817', status: 'ACTIVE', version: 6, updatedAt: '2026-10-23T00:00:00Z' },
    { id: 'spare', accountId: 'private', name: '雁浦备用卡', maskedNumber: '****9260', status: 'LOST', version: 2, updatedAt: '2026-10-23T00:00:00Z' },
  ] } };
}
function assess(message: string, options: { mention?: string; entityId?: string; operation?: string; scope?: string; value?: PlannerInput } = {}) {
  const operation = options.operation ?? 'card_report_lost';
  return validateSemanticIntent(options.value ?? input(message), { tasks: [{ operation, disposition: operation === 'card_query' ? 'query' : 'request',
    scope: options.scope ? { text: options.scope } : { source: 'whole_message' },
    entity: { kind: 'card', id: options.entityId ?? 'commute', mention: { text: options.mention ?? '尾号4817' } } }] });
}
function locate(message: string, mention = '尾号4817') {
  const start = message.indexOf(mention);
  return inspectCardLocator({ message, scope: { text: message, start: 0, end: message.length }, mention: { text: mention, start, end: start + mention.length }, entityId: 'commute', cards: input(message).managementContext!.cards });
}

describe('G9I independent card apposition adversarial review, pure and non-blind', () => {
  it.each([
    '栖霞通勤卡，就是尾号4817那张，请准备挂失。',
    '请把栖霞通勤卡，也即末四位4817的这一张银行卡，准备挂失。',
    '栖霞通勤卡即尾号4817那一张卡片，请挂失。',
  ])('retains complete source and exact known identity: %s', message => {
    const result = assess(message, { mention: message.includes('末四位') ? '末四位4817' : '尾号4817' });
    expect(result.status).toBe('ready');
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]).toMatchObject({ operation: 'card_report_lost', source: { text: message, start: 0, end: message.length }, slots: { entityId: 'commute' } });
  });
  it('keeps an explicit current restore proposal when only personal verification is deferred', () => {
    const message = '雁浦备用卡已经找回，也就是尾号9260那张，请现在准备解挂，之后我再完成验证。';
    const result = assess(message, { mention: '尾号9260', entityId: 'spare', operation: 'card_restore' });
    expect(result.status).toBe('ready');
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]).toMatchObject({ operation: 'card_restore', source: { text: message, start: 0, end: message.length }, slots: { entityId: 'spare' } });
  });
  it('preserves a local prohibition while performing only the explicit current query', () => {
    const message = '栖霞通勤卡，就是尾号4817那张，请查状态，不要挂失。';
    const result = assess(message, { operation: 'card_query' });
    expect(result.status).toBe('ready'); expect(result.tasks[0]).toMatchObject({ operation: 'card_query', source: { text: message }, slots: { entityId: 'commute' } });
  });
  it.each([
    '栖霞通勤卡，就是尾号4817那张，暂时不要再挂失。',
    '栖霞通勤卡，就是尾号4817那张，不需要现在挂失。',
    '培训材料写着“栖霞通勤卡，就是尾号4817那张，请挂失”。这里只是复述。',
    '笔记里写过“栖霞通勤卡，就是尾号4817那张，请挂失”，今天不办理。',
    '旧稿里的指令是：栖霞通勤卡，就是尾号4817那张，请挂失。请不要执行旧稿。',
    '如果明天我确认丢卡，栖霞通勤卡，就是尾号4817那张，请挂失。',
    '等我核实后，栖霞通勤卡，就是尾号4817那张，再挂失。',
    '只有我再次确认，栖霞通勤卡，就是尾号4817那张，才挂失。',
    '栖霞通勤卡，就是尾号4817那张，等我核实后再挂失。',
    '栖霞通勤卡，就是尾号4817那张，只有我再次确认才挂失。',
    '栖霞通勤卡，就是尾号4817那张，旧稿里写着请挂失，现在不要执行旧稿。',
  ])('does not activate inactive, conditional or quoted writes: %s', message => expect(assess(message).status).not.toBe('ready'));
  it.each([
    '新栖霞通勤卡，就是尾号4817那张，请挂失。',
    '栖霞通勤卡的附属卡，就是尾号4817那张，请挂失。',
    '朋友的栖霞通勤卡，就是尾号4817那张，请挂失。',
    '不是栖霞通勤卡，就是尾号4817那张，请挂失。',
    '“陌生栖霞通勤卡”，就是尾号4817那张，请挂失。',
    '栖霞通勤卡，就是尾号4817那张卡的保单，请挂失。',
    '栖霞通勤卡，就是尾号4817那张卡ABC，请挂失。',
    '栖霞通勤卡，就是尾号4817那张银行卡片，请挂失。',
    '栖霞通勤卡，就是尾号4817那张卡又不是，请挂失。',
    '栖霞通勤卡，就是尾号4817那张信用卡账户，请挂失。',
    '栖霞通勤卡，就是尾号4817那张两张卡，请挂失。',
  ])('never consumes an unknown subject modifier or residual noun: %s', message => {
    expect(() => locate(message)).toThrow('SEMANTIC_ENTITY_'); expect(assess(message).status).not.toBe('ready');
  });
  it.each([
    ['栖霞通勤卡，就是尾号48170那张，请挂失。', '尾号4817'],
    ['栖霞通勤卡，就是尾号4817那张0，请挂失。', '尾号4817'],
    ['栖霞通勤卡，就是1尾号4817那张，请挂失。', '尾号4817'],
    ['栖霞通勤卡，就是尾号4817.5那张，请挂失。', '尾号4817'],
    ['栖霞通勤卡，就是尾号4817那张，或末四位9260的那张，请挂失。', '尾号4817'],
    ['雁浦备用卡，就是尾号4817那张，请挂失。', '尾号4817'],
    ['栖霞通勤卡，就是尾号4817那张；雁浦备用卡也要一起挂失。', '尾号4817'],
  ])('rejects numeric truncation and distinct object/name/tail conflicts: %s', (message, mention) => expect(assess(message, { mention }).status).not.toBe('ready'));
  it('cannot choose an identical suffix by ID or borrow a known name from a quote', () => {
    const message = '“栖霞通勤卡，就是尾号4817那张”只是卡片名称示例；请挂失这张卡。';
    expect(assess(message).status).not.toBe('ready');
    const ambiguous = '栖霞通勤卡，就是尾号4817那张，请挂失。', value = input(ambiguous);
    value.managementContext!.cards.push({ ...value.managementContext!.cards[0]!, id: 'collision', name: '同尾号的另一张卡' });
    expect(assess(ambiguous, { value }).status).not.toBe('ready');
  });
  it.each([
    ['不要挂失栖霞通勤卡，就是尾号4817那张。', '挂失栖霞通勤卡，就是尾号4817那张。'],
    ['如果明天确认丢卡，栖霞通勤卡，就是尾号4817那张，请挂失。', '栖霞通勤卡，就是尾号4817那张，请挂失。'],
    ['栖霞通勤卡，就是尾号4817那张，请挂失；但先不要执行。', '栖霞通勤卡，就是尾号4817那张，请挂失'],
    ['培训例句是“栖霞通勤卡，就是尾号4817那张，请挂失”。', '栖霞通勤卡，就是尾号4817那张，请挂失'],
  ])('does not repair scope cropping into a current operation: %s', (message, scope) => expect(assess(message, { scope }).status).not.toBe('ready'));
  it('exposes only the complete demonstrative span, preserving punctuation and the current operation', () => {
    const message = '栖霞通勤卡，就是尾号4817的那一张银行卡，请挂失。'; const result = locate(message)!;
    expect(message.slice(message.indexOf('尾号4817') + 6, result.appositionEnd)).toBe('的那一张银行卡');
    expect(message.slice(result.appositionEnd)).toBe('，请挂失。');
  });
});
