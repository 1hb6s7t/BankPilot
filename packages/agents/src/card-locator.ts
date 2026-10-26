type Span = { start: number; end: number; text: string };
type Card = { id: string; name: string; maskedNumber: string };

export type CardLocatorInput = {
  message: string;
  scope: Span;
  mention: Span;
  entityId: string;
  cards: readonly Card[];
  readOnly?: boolean;
  operation?: string;
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

function appositionRequestPrefix(text: string, readOnly: boolean) {
  let remaining = text.trim();
  const tokens = ['我需要', '查一下', '本人', '麻烦', '帮我', '替我', '我想', '我要', '查询', '查看', '看看', '挂失', '恢复', '解挂', '请', '我', '先', '再', '只', '仅', '把', '将', '给', '向', '为', '对', '从', '的'];
  for (let count = 0; count < 16; count++) {
    const token = tokens.find(value => remaining.startsWith(value));
    if (!token) break;
    remaining = remaining.slice(token.length).trimStart();
  }
  if (/^(?:我的|本人(?:的)?)?$/.test(remaining)) return true;
  return readOnly && /^(?:我)?(?:只|仅)?(?:想|要)?(?:确认|核实|核对)(?:一下|下)?\s*(?:我的|本人(?:的)?)?$/.test(remaining);
}

/** A copular locator must attach to an entire known-card subject, not merely
 * find a catalog substring somewhere earlier in the source. Unknown names,
 * quotes, conditions and additional objects remain unconsumed and fail. */
function knownCardApposition(beforeField: string, cards: readonly Card[], readOnly = false) {
  const clauses = beforeField.split(/[，,。；;：:\n!?！？]/);
  const clause = clauses.at(-1)!.trim();
  const copula = /(?:也就是|就是|也即|即)\s*$/.exec(clause);
  if (!copula) return undefined;
  const inlineSubject = clause.slice(0, copula.index).trim();
  const subject = inlineSubject || clauses.at(-2)?.trim();
  // A local subject cannot discard an earlier wrapper or shared condition.
  // Unsupported leading source remains clarification, rather than inventing
  // a current instruction from the last two clauses of history or a condition.
  const subjectIndex = clauses.length - (inlineSubject ? 1 : 2);
  if (clauses.slice(0, subjectIndex).some(part => part.trim())) return false;
  if (!subject || subject.length > 256 || /[“”「」『』‘’"']/.test(subject)) return false;
  const state = /^(?:(?:已经|刚刚|刚|已|又|终于|目前|现在|当前)?(?:找回|找到|寻回|挂失|报失|冻结|停用|恢复)(?:了)?)?$/;
  return cards.some(card => {
    const at = card.name ? subject.indexOf(card.name) : -1;
    return at >= 0 && appositionRequestPrefix(subject.slice(0, at), readOnly) && state.test(subject.slice(at + card.name.length).trim());
  });
}

/** The newly accepted apposition must not turn a local name/tail match into
 * permission to ignore the rest of a conditional, historical or mixed task. */
function currentAppositionTail(text: string, readOnly: boolean, operation?: string) {
  const clauses = text.split(/[，,。；;：:\n!?！？]/).map(part => part.trim()).filter(Boolean);
  let actions = 0;
  const polite = ['准备', '申请', '帮忙', '麻烦', '帮我', '替我', '为我', '现在', '本次', '这次', '请', '先', '再'];
  for (const clause of clauses) {
    if (clause.length > 256) return false;
    let body = clause;
    for (let count = 0; count < 16; count++) {
      const token = polite.find(value => body.startsWith(value));
      if (!token) break;
      body = body.slice(token.length).trimStart();
    }
    const query = /^(?:(?:查询|查看|查一下|查|核实|核对|确认|看看|列出)(?:其|它|这张卡|那张卡|该卡)?(?:的)?(?:当前|现在|现有|目前)?(?:使用|挂失)?状态|(?:当前|现在|目前)?是什么状态|(?:核实|核对|确认|查询)?(?:其|它|这张卡|那张卡|该卡)?(?:是否|是不是|有无|有没有)(?:已经|已)?(?:挂失|报失|冻结|恢复|解挂))$/;
    const lost = /^(?:挂失|报失)(?:这张卡|那张卡|卡片|银行卡|它)?(?:吧|一下)?$/;
    const restore = /^(?:解挂|解除挂失|恢复(?:这张卡|那张卡|卡片|银行卡)?(?:使用|使用状态)?)(?:这张卡|那张卡|它)?(?:吧|一下)?$/;
    const current = readOnly ? query.test(body) : operation === 'card_report_lost' ? lost.test(body) : operation === 'card_restore' ? restore.test(body) : lost.test(body) || restore.test(body);
    if (current) { if (++actions > 1) return false; continue; }
    if (actions === 1 && /^(?:之后|稍后|随后)?(?:我|本人)(?:再|会|将)?(?:单独)?(?:完成|进行)(?:本人|强|身份|授权)?验证$/.test(clause)) continue;
    if (readOnly && actions === 1 && /^(?:(?:现在|这次|本次|暂时|先))?(?:不要|别|不必|不用)(?:再)?(?:挂失|报失|解挂|恢复|变更|更改)(?:它|卡片|银行卡|状态|这张卡|那张卡)?$/.test(clause)) continue;
    if (readOnly && actions === 1 && /^(?:这次|本次)?(?:都)?(?:只|仅)(?:看|查询)(?:信息|状态)$/.test(clause)) continue;
    return false;
  }
  return actions === 1;
}

/** Resolve a complete typed card locator without rewriting its source mention.
 * Names without a locator remain the caller's normal name-grounding path.
 * The returned ID is derived from the source and catalog, never model choice.
 */
export function inspectCardLocator(input: CardLocatorInput): { suffix: string; cardId: string; appositionEnd?: number } | undefined {
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
  let hasNoun = named.length > 0;
  if (named.length) nounStart -= Math.max(...named.map(card => card.name.length));
  else {
    const container = /(?:银行卡|卡片|卡)\s*$/.exec(clause);
    if (container) { nounStart = container.index; hasNoun = true; }
  }
  const apposition = hasNoun ? undefined : knownCardApposition(beforeField, cards, input.readOnly);
  if (apposition === false || apposition === undefined && !requestPrefix(clause.slice(0, nounStart), input.readOnly)) fail('TOKEN_TRUNCATED');
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
  // The demonstrative is source grammar, never a replacement entity mention.
  // Unknown continuations and numeric extensions cannot borrow this boundary.
  const tail = message.slice(mention.end, scope.end);
  const ending = apposition ? /^\s*(?:的)?(?:那|这|该)(?:一)?张(?:银行卡|借记卡|信用卡|卡片|卡)?(?=\s*(?:$|[，,。；;：:!?！？]))/.exec(tail) : undefined;
  if (apposition && !ending && !/^\s*(?:$|[，,。；;：:!?！？])/.test(tail)) fail('TOKEN_TRUNCATED');
  if (apposition && !currentAppositionTail(tail.slice(ending?.[0].length ?? 0), input.readOnly ?? false, input.operation)) fail('TOKEN_TRUNCATED');
  return { suffix, cardId: matches[0]!.id, ...(ending ? { appositionEnd: mention.end + ending[0].length } : {}) };
}
