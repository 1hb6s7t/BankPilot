type Span = { start: number; end: number; text: string };
type Card = { id: string; name: string; maskedNumber: string };

export type CardLocatorInput = {
  message: string;
  scope: Span;
  mention: Span;
  entityId: string;
  cards: readonly Card[];
  readOnly?: boolean;
};

function validSpan(message: string, span: Span) {
  return Number.isInteger(span.start) && Number.isInteger(span.end) && span.start >= 0
    && span.end > span.start && span.end <= message.length && message.slice(span.start, span.end) === span.text;
}
function fail(code: string): never { throw new Error(`SEMANTIC_ENTITY_${code}`); }

// These are grammatical request wrappers, never an inferred card name or ID.
// Anchoring the entire prefix prevents “陌生银行卡” or “新榆庭卡” from being
// silently shortened to a known container/name by a model's mention span.
function requestPrefix(text: string, readOnly = false) {
  const query = readOnly ? '(?:(?:我)?(?:只|仅)?(?:想|要)?(?:确认|核实|核对)(?:一下|下)?\\s*)?' : '';
  return new RegExp(`^(?:(?:请|麻烦|帮我|替我|我想|我要|我需要|我|先|再|只|仅|不要|别|不必|不用|别再|查询|查看|查一下|查|看看|挂失|恢复|解挂|把|将|给|向|为|对|从|的)\\s*)*${query}(?:(?:我的|本人(?:的)?)\\s*)?$`).test(text.trim());
}

/** Resolve a complete typed card locator without rewriting its source mention.
 * Names without a locator remain the caller's normal name-grounding path.
 * The returned ID is derived from the source and catalog, never model choice.
 */
export function inspectCardLocator(input: CardLocatorInput): { suffix: string; cardId: string } | undefined {
  const { message, scope, mention, cards, entityId } = input;
  if (!validSpan(message, scope) || !validSpan(message, mention)
    || mention.start < scope.start || mention.end > scope.end) fail('SPAN_INVALID');
  if (!/尾号|末四位/.test(mention.text)) return undefined;

  const field = /(?:尾号|末四位)\s*([0-9]{4})$/.exec(mention.text);
  if (!field || /[0-9]/.test(message.slice(mention.end, mention.end + 1))) fail('TOKEN_TRUNCATED');
  const fieldStart = mention.start + field.index;
  const mentionNoun = mention.text.slice(0, field.index).trim();
  if (mentionNoun && !['卡', '银行卡', '卡片'].includes(mentionNoun)
    && !cards.some(card => card.name === mentionNoun)) fail('TOKEN_TRUNCATED');

  const beforeField = message.slice(scope.start, fieldStart);
  const clause = beforeField.split(/[，,。；;：:\n!?！？]/).at(-1)!.trim();
  const named = cards.filter(card => card.name && clause.endsWith(card.name));
  let nounStart = clause.length;
  if (named.length) nounStart -= Math.max(...named.map(card => card.name.length));
  else {
    const container = /(?:银行卡|卡片|卡)\s*$/.exec(clause);
    if (container) nounStart = container.index;
  }
  if (!requestPrefix(clause.slice(0, nounStart), input.readOnly)) fail('TOKEN_TRUNCATED');
  // A digit immediately before a bare field is also a truncated numeric token.
  if (/[0-9]$/.test(beforeField)) fail('TOKEN_TRUNCATED');

  const suffix = field[1]!;
  const withSuffix = cards.filter(card => card.maskedNumber.replace(/\D/g, '').slice(-4) === suffix);
  const mentionedNames = cards.filter(card => card.name && scope.text.includes(card.name));
  if (mentionedNames.some(card => !withSuffix.some(candidate => candidate.id === card.id))) fail('CONFLICT');
  const matches = named.length ? withSuffix.filter(card => named.some(item => item.id === card.id)) : withSuffix;
  if (matches.length !== 1 || matches[0]!.id !== entityId) fail('NOT_UNIQUE');
  // Multiple typed objects in a single scope cannot be collapsed into this one.
  const fields = [...scope.text.matchAll(/(?:尾号|末四位)\s*([0-9]+)/g)];
  if (fields.some(item => item[1] !== suffix)) fail('CONFLICT');
  return { suffix, cardId: matches[0]!.id };
}
