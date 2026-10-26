import type { PayeeView, PlannerInput } from '../../../packages/contracts/src/index.js';
import type { Clarification, ClarificationAnswer, ClarificationValues, ConversationEnvelope, ConversationPlanningInput, FieldSource } from '../../../packages/contracts/src/conversations.js';
import { CoreError } from '../../../packages/core/src/index.js';
import { isGoalRequest, parseAmountMinor } from '../../../packages/agents/src/intent.js';

const fail = (message: string): never => { throw new CoreError('CLARIFICATION_INVALID', message, 409); };
const unsafe = (text: string) => /不要|不用|不必|无需|别|不想|不是|撤回|撤销|算了|示例|例子|假设|如果|如何|怎么|翻译|改写|历史|曾经|以前|[“”「」"`？?]/.test(text);
const amountTokens = (text: string) => [...text.matchAll(/[负+−\-]?[0-9零〇一二两三四五六七八九十百千万亿点壹贰貳叁參肆伍陆陸柒捌玖拾佰仟萬億.,]+\s*(?:元|块|人民币|CNY|RMB)(?:[零〇一二两三四五六七八九]角)?(?:零?[零〇一二两三四五六七八九]分)?/gi)];
const dateValue = (text: string) => {
  const match = text.match(/^(\d{4})[-年](\d{1,2})[-月](\d{1,2})日?$/);
  if (!match) return undefined;
  const value = `${match[1]}-${match[2]!.padStart(2, '0')}-${match[3]!.padStart(2, '0')}`;
  const time = new Date(`${value}T00:00:00Z`);
  return !value.startsWith('0000') && Number.isFinite(time.valueOf()) && time.toISOString().slice(0, 10) === value ? value : undefined;
};
const source = (field: FieldSource['field'], messageId: string, message: string, text: string, kind: FieldSource['kind'] = 'original'): FieldSource => {
  const start = message.indexOf(text);
  if (start < 0 || message.indexOf(text, start + 1) >= 0) fail('补充字段必须逐字出现且唯一，不能混入其他请求。');
  return { field, messageId, text, start, end: start + text.length, kind };
};
export function hasPlannedActions(result: ConversationEnvelope | undefined): boolean {
  return !!result && !!(result.actions?.length || result.managementActions?.length || result.investmentActions?.length || result.goal || result.suggestions?.length || result.managementSuggestions?.length || result.investmentSuggestions?.length || result.goalSuggestion);
}
export type ClarificationSeed = Pick<Clarification, 'operation' | 'values' | 'constraints' | 'sources' | 'candidates' | 'requestedSlots' | 'question'>;
/** Conservative partial extraction for the explicitly supported continuation types. */
export function buildClarification(input: PlannerInput, result: ConversationEnvelope, messageId: string): ClarificationSeed | undefined {
  const text = input.message;
  if (result.failure || !result.clarification || hasPlannedActions(result) || unsafe(text) || /赎回|订阅|挂失|恢复|备注|账单|理财|银行卡|查询|查看|然后|同时|另外|以及|并且|还要|并|或者|还是|或|[~～]/.test(text)) return undefined;
  const operation = isGoalRequest(text) ? 'goal_create' : /转账|转给|汇给|给.+(?:元|块|转钱)/.test(text) ? 'transfer' : undefined;
  if (!operation) return undefined;
  // Repeated same-domain requests must not collapse into one successor. A goal
  // may mention its later transfer, so count goal creation separately from pay.
  if (operation === 'transfer' && (text.match(/转账|转给|汇给|汇款/g) ?? []).length > 1) return undefined;
  if (operation === 'goal_create' && ((text.match(/建立|创建/g) ?? []).length > 1 || (text.match(/生日目标|生活目标/g) ?? []).length > 1)) return undefined;
  const values: ClarificationValues = {}, sources: FieldSource[] = [];
  let constraints: Clarification['constraints'];
  const amounts = amountTokens(text);
  if (amounts.length > 1) return undefined;
  if (amounts[0]) {
    const value = parseAmountMinor(amounts[0][0]);
    if (!value || /[\w负−.\-]$/.test(text.slice(0, amounts[0].index))) return undefined;
    values.amountMinor = value; sources.push(source('amountMinor', messageId, text, amounts[0][0]));
  } else if (/\d|[壹贰貳叁參肆伍陆陸柒捌玖拾佰仟]/.test(text.replace(/\d{4}[-年]\d{1,2}[-月]\d{1,2}日?|\d{1,2}月\d{1,2}日|(?:尾号|末四位)\s*\d{4}/g, ''))) return undefined;
  const mentions = input.payees.flatMap(p => [p.name, ...p.aliases].filter(Boolean).flatMap(name => {
    const index = text.indexOf(name);
    if (index < 0 || text.indexOf(name, index + 1) >= 0) return [];
    const before = text.slice(0, index), after = text.slice(index + name.length);
    if ((before && !/(?:给|向|为|对|转给|汇给|[\s，,。；;])$/.test(before)) || (after && !/^(?:转|汇|打|付|准备|建立|创建|生日|生活目标|目标|尾号|末四位|[\s，,。；;0-9零一二两三四五六七八九十百千万])/.test(after))) return [];
    return [{ payee: p, name }];
  }));
  const suffixes = [...text.matchAll(/(?:尾号|末四位)\s*(\d{4})(?!\d)/g)];
  if (suffixes.length > 1) return undefined;
  let candidates = mentions.length ? input.payees.filter(p => mentions.some(m => m.payee.id === p.id)) : input.payees;
  if (suffixes[0]) candidates = candidates.filter(p => p.maskedNumber.replace(/\D/g, '').endsWith(suffixes[0]![1]!));
  if (candidates.length === 1 && (mentions.length || suffixes.length)) {
    values.payeeId = candidates[0]!.id;
    sources.push(source('payeeId', messageId, text, suffixes[0]?.[0] ?? mentions.find(m => m.payee.id === values.payeeId)!.name));
  }
  if (operation === 'goal_create') {
    const dates = [...text.matchAll(/(?<!\d)\d{4}[-年]\d{1,2}[-月]\d{1,2}日?(?!\d)/g)];
    if (dates.length > 1) return undefined;
    if (!dates.length) {
      const partials = [...text.matchAll(/(?<!\d)(\d{1,2})月(\d{1,2})日(?!\d)/g)];
      if (partials.length > 1) return undefined;
      if (partials[0]) { constraints = { targetMonth: Number(partials[0][1]), targetDay: Number(partials[0][2]) }; if (constraints.targetMonth < 1 || constraints.targetMonth > 12 || constraints.targetDay < 1 || constraints.targetDay > 31) return undefined; sources.push(source('targetDate', messageId, text, partials[0][0])); }
      else if (/\d.*(?:年|月|日|-)/.test(text)) return undefined;
    }
    if (dates[0]) { const value = dateValue(dates[0][0]); if (!value) return undefined; values.targetDate = value; sources.push(source('targetDate', messageId, text, dates[0][0])); }
  }
  // Typed continuation only covers this small complete request grammar. Any
  // remaining purpose, second task or unknown argument needs a full restatement.
  let remainder = text;
  for (const item of [...sources].sort((a, b) => b.start - a.start)) remainder = remainder.slice(0, item.start) + ' '.repeat(item.end - item.start) + remainder.slice(item.end);
  for (const item of [...mentions].sort((a, b) => b.name.length - a.name.length)) remainder = remainder.replaceAll(item.name, '');
  remainder = remainder.replace(/(?:尾号|末四位)\s*\d{4}(?!\d)/g, '')
    .replace(/刚才那个人|上次那个人|生日目标|生活目标|收款人|转账|转给|汇给|汇款|建立|创建|准备|截止|日期|金额|帮我|替我|麻烦|目标|请|给|向|为|对|转|前|到/g, '').replace(/[\s，,。；;：:]/g, '');
  if (remainder) return undefined;
  const requestedSlots: Clarification['requestedSlots'] = [...(!values.payeeId ? ['payee' as const] : []), ...(!values.amountMinor ? ['amount' as const] : []), ...(operation === 'goal_create' && !values.targetDate ? ['targetDate' as const] : [])];
  if (sources.some((item, index) => sources.some((other, otherIndex) => index !== otherIndex && item.start < other.end && item.end > other.start))) return undefined;
  if (!requestedSlots.length || !candidates.length) return undefined;
  return { operation, values, ...(constraints ? { constraints } : {}), sources, candidates: candidates.map(({ id, name, bank, maskedNumber }) => ({ id, name, bank, maskedNumber })), requestedSlots, question: `请补充${requestedSlots.map(slot => ({ payee: '收款人（姓名或尾号）', amount: '明确金额（带元）', targetDate: '完整目标日期（YYYY-MM-DD）' })[slot]).join('、')}；原有字段保持不变。` };
}

/** Only fills requested fields; no history concatenation or authorization state. */
export function mergeClarification(clarification: Clarification, answer: ClarificationAnswer | undefined, text: string, messageId: string, freshPayees: PayeeView[], originalMessage: string): ConversationPlanningInput {
  if (unsafe(text)) fail('当前回答不是明确的字段补充，请取消澄清或新建请求。');
  const values = { ...clarification.values }, sources = [...clarification.sources], requested = new Set(clarification.requestedSlots);
  const supplied = answer ?? {};
  if (((supplied.payeeId || supplied.payeeSuffix) && !requested.has('payee')) || (supplied.amount && !requested.has('amount')) || (supplied.targetDate && !requested.has('targetDate'))) fail('只能补充当前问题允许的字段，不能覆盖原字段。');
  let remaining = text;
  const consume = (token: string) => { if (!remaining.includes(token)) fail('回答字段必须来自本次原文。'); remaining = remaining.replace(token, ''); };
  if (requested.has('payee')) {
    const suffix = supplied.payeeSuffix ?? text.match(/^(?:尾号|末四位)\s*(\d{4})$/)?.[1];
    const named = freshPayees.filter(p => clarification.candidates.some(c => c.id === p.id) && (supplied.payeeId ? p.id === supplied.payeeId : suffix ? p.maskedNumber.replace(/\D/g, '').endsWith(suffix) : [p.name, ...p.aliases].some(name => name === text.trim())));
    if (named.length !== 1) fail('请从当前有效候选中指定唯一收款人。');
    const selected = named[0]!;
    const saved = clarification.candidates.find(candidate => candidate.id === selected.id);
    if (!saved || saved.name !== selected.name || saved.bank !== selected.bank || saved.maskedNumber !== selected.maskedNumber) fail('候选收款人信息已变化，请重新发起请求核对。');
    if (suffix && !selected.maskedNumber.replace(/\D/g, '').endsWith(suffix)) fail('收款人和尾号不一致。');
    const mention = suffix ? text.match(new RegExp(`(?:尾号|末四位)?\\s*${suffix}(?!\\d)`))?.[0] : [selected.name, ...selected.aliases].find(name => text.includes(name));
    if (!mention) fail('请在回答中明确选中收款人的姓名或尾号。');
    values.payeeId = selected.id; sources.push(source('payeeId', messageId, text, mention!, 'selection')); consume(mention!);
  }
  if (requested.has('amount')) {
    const token = supplied.amount ?? (amountTokens(text).length === 1 ? amountTokens(text)[0]?.[0] : undefined);
    const amount = token ? parseAmountMinor(token) : undefined;
    if (!token || !amount || amountTokens(token).length !== 1 || amountTokens(token)[0]![0] !== token.trim()) fail('请提供唯一、完整且带币种的金额。');
    values.amountMinor = amount; sources.push(source('amountMinor', messageId, text, token!, 'answer')); consume(token!);
  }
  if (requested.has('targetDate')) {
    const token = supplied.targetDate ?? text.match(/\d{4}[-年]\d{1,2}[-月]\d{1,2}日?/)?.[0];
    const date = token && dateValue(token);
    if (!token || !date) fail('请提供有效的完整目标日期，不会猜测年份。');
    if (clarification.constraints && (Number(date!.slice(5, 7)) !== clarification.constraints.targetMonth || Number(date!.slice(8, 10)) !== clarification.constraints.targetDay)) fail('只能补充缺失年份，原请求的月日不能变更。');
    values.targetDate = date; sources.push(source('targetDate', messageId, text, token!, 'answer')); consume(token!);
  }
  if (remaining.replace(/[\s，,。；;：:]/g, '')) fail('回答包含未请求的字段或新指令，请只补充当前字段。');
  const payee = freshPayees.find(p => p.id === values.payeeId);
  const originalCandidate = clarification.candidates.find(candidate => candidate.id === values.payeeId);
  if (payee && (!originalCandidate || originalCandidate.name !== payee.name || originalCandidate.bank !== payee.bank || originalCandidate.maskedNumber !== payee.maskedNumber)) fail('原收款人信息已变化，请重新发起请求。');
  if (!payee || !values.amountMinor || (clarification.operation === 'goal_create' && !values.targetDate)) fail('原收款人已不可用或字段尚未补齐，请重新核对。');
  const money = `${BigInt(values.amountMinor!) / 100n}.${(BigInt(values.amountMinor!) % 100n).toString().padStart(2, '0')}元`;
  const message = clarification.operation === 'transfer' ? `转给${payee!.name}尾号${payee!.maskedNumber.replace(/\D/g, '').slice(-4)}，金额${money}` : `建立${payee!.name}${originalMessage.includes('生日') ? '生日' : '生活'}目标，${values.targetDate}前准备${money}`;
  return { version: 1, message, originalMessage, typed: { operation: clarification.operation, slots: values, sources } };
}
