type Position = { id: string; productId?: string; productName: string; redemptionBusinessDays: number };
type Span = { start: number; end: number; text: string };

export const positionNameAlias = (name: string) => name.replace(/\s*[（(]?T\s*[+＋]\s*\d+[）)]?\s*$/i, '').trim();
const nameKey = (name: string) => name.replace(/\s*[（(]?T\s*[+＋]\s*(\d+)[）)]?\s*$/i, ' T+$1');
/** Only the authoritative trailing settlement suffix has formatting aliases. */
export function positionNameMatches(mention: string, position: Position): boolean {
  return mention === position.id || (!!position.productId && mention === position.productId) || mention === positionNameAlias(position.productName)
    || nameKey(mention) === nameKey(position.productName);
}

/** A settlement locator is a typed field, never a substring of a product name.
 * Count all current positions, including empty/reserved positions. */
export function inspectPositionLocator(input: { message: string; scope: Span; mention: Span; positions: readonly Position[]; entityId?: string }): { positionId: string; days: number } | undefined {
  const { message, scope, mention, positions, entityId } = input;
  if (message.slice(mention.start, mention.end) !== mention.text || mention.start < scope.start || mention.end > scope.end) throw new Error('SEMANTIC_ENTITY_SPAN_INVALID');
  if (!/^T\s*[+＋]/i.test(mention.text)) return;
  const field = /^T\s*[+＋]\s*(0|[1-9]\d*)(?:(?:合成)?(?:理财|持仓|产品))?$/i.exec(mention.text);
  if (!field || !Number.isSafeInteger(Number(field[1])) || /^\d/.test(message.slice(mention.end))) throw new Error('SEMANTIC_ENTITY_TOKEN_TRUNCATED');
  const fields = [...scope.text.matchAll(/T\s*[+＋]\s*\d+/gi)];
  if (fields.length !== 1) throw new Error('SEMANTIC_ENTITY_NOT_UNIQUE');
  const before = message.slice(scope.start, mention.start).split(/[，,。；;：:\n]/).at(-1)!.trim();
  const prefix = /^(?:(?:请|麻烦|帮我|替我|我想|我要|我需要|先|再|这次|本次|筹资|资金来源|要动的|是|从|把|将|我的|我那笔|那笔|这笔|本人(?:的)?|赎回|赎出|取回|取出|卖出)\s*)*$/;
  if (!prefix.test(before)) throw new Error('SEMANTIC_ENTITY_TOKEN_TRUNCATED');
  let after = message.slice(mention.end, scope.end);
  if (!/(?:理财|持仓|产品)$/.test(mention.text)) after = after.replace(/^(?:合成)?(?:理财|持仓|产品)/, '');
  if (after && !/^(?:[\s，,。；;：:！？?!）)0-9零〇一二两三四五六七八九十百千万亿壹贰叁肆伍陆柒捌玖拾佰仟]|的|里|中|内|赎回|赎出|取回|取出|卖出|现在|当前)/.test(after)) throw new Error('SEMANTIC_ENTITY_TOKEN_TRUNCATED');
  const days = Number(field[1]), matches = positions.filter(position => position.redemptionBusinessDays === days);
  if (matches.length !== 1 || (entityId !== undefined && matches[0]!.id !== entityId)) throw new Error('SEMANTIC_ENTITY_NOT_UNIQUE');
  return { positionId: matches[0]!.id, days };
}

/** Shared candidate selection for a complete financial request. Callers still
 * validate operation, money and all residual source text before proposing. */
export function selectPositionReference<T extends Position>(text: string, positions: readonly T[]): { position?: T; error?: 'unknown' | 'not_unique' | 'invalid' } {
  const fields = [...text.matchAll(/T\s*[+＋]\s*\d+/gi)];
  if (fields.length > 1) return { error: 'not_unique' };
  const names = positions.filter(position => [position.productName, positionNameAlias(position.productName), position.id, position.productId].filter((name): name is string => !!name).some(name => text.includes(name)));
  if (names.length > 1) return { error: 'not_unique' };
  if (names.length === 1) {
    if (fields.length && names[0]!.redemptionBusinessDays !== Number(fields[0]![0].match(/\d+/)![0])) return { error: 'invalid' };
    return { position: names[0]! };
  }
  if (!fields.length) return { error: 'unknown' };
  const field = fields[0]!, mention = { start: field.index!, end: field.index! + field[0].length, text: field[0] };
  try {
    const locator = inspectPositionLocator({ message: text, scope: { start: 0, end: text.length, text }, mention, positions });
    return { position: positions.find(position => position.id === locator?.positionId) };
  } catch (error) { return { error: error instanceof Error && error.message.endsWith('NOT_UNIQUE') ? 'not_unique' : 'invalid' }; }
}
