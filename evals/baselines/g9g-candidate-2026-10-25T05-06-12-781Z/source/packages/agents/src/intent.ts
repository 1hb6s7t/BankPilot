import type { DomainRole, PayeeView, TransferSuggestion } from '../../contracts/src/index';

// Normalize standard financial numerals before applying the same integer-only parser.
export function normalizeMoneyNumerals(text: string): string {
  const financial: Record<string, string> = { 壹: '一', 贰: '二', 貳: '二', 叁: '三', 參: '三', 肆: '四', 伍: '五', 陆: '六', 陸: '六', 柒: '七', 捌: '八', 玖: '九', 拾: '十', 佰: '百', 仟: '千', 萬: '万', 億: '亿', 圆: '元', 圓: '元', 點: '点' };
  return text.replace(/[壹贰貳叁參肆伍陆陸柒捌玖拾佰仟萬億圆圓點]/g, c => financial[c]!);
}

const digits: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const units: Record<string, number> = { 十: 10, 百: 100, 千: 1000 };

function chineseInteger(text: string): number | undefined {
  if (/^\d+$/.test(text)) return Number(text);
  if (!text || !/^[零〇一二两三四五六七八九十百千万亿]+$/.test(text)) return undefined;
  if (!/[十百千万亿]/.test(text)) return Number([...text].map(c => digits[c]).join(''));
  let total = 0, section = 0, current = 0, previousUnit = 10000;
  for (const c of text) {
    if (c in digits) current = digits[c]!;
    else if (c === '万' || c === '亿') {
      section += current;
      if (c === '亿') { total = (total + section) * 100000000; section = 0; }
      else { total += section * 10000; section = 0; }
      current = 0; previousUnit = 10000;
    } else {
      const unit = units[c]!;
      if (unit >= previousUnit || (!current && !(unit === 10 && section === 0))) return undefined;
      section += (current || 1) * unit; current = 0; previousUnit = unit;
    }
  }
  return total + section + current;
}

/** Parses only an explicit currency amount, never treats an account suffix as money. */
export function parseAmountMinor(message: string): string | undefined {
  // Financial glyphs adjacent to Arabic digits form an invalid mixed token.
  if (/[壹贰貳叁參肆伍陆陸柒捌玖拾佰仟萬億][0-9]|[0-9][壹贰貳叁參肆伍陆陸柒捌玖拾佰仟億]/.test(message)) return undefined;
  message = normalizeMoneyNumerals(message);
  if (/(?:负|[-−])\s*[0-9零〇一二两三四五六七八九十百千万亿点.,]+\s*(?:元|块|人民币|CNY|RMB)/i.test(message)) return undefined;
  // A malformed numeral, exponent or decimal must never be shortened to a
  // valid-looking suffix (壹佰12元, 1e3元, 一点零零一元).
  const numeric = message.match(/(?<![a-z0-9十百千万亿点.,-])(?:(?:人民币|CNY|RMB)\s*)?([0-9]+(?:,[0-9]{3})*(?:\.[0-9]{1,2})?)\s*(万)?\s*(?:元|块|人民币|CNY|RMB)(?![a-z])/i);
  const chinese = message.match(/(?<![a-z0-9零〇一二两三四五六七八九十百千万亿点.,-])([零〇一二两三四五六七八九十百千万亿]+)(?:点([零〇一二两三四五六七八九]{1,2}))?\s*(?:元|块)/i);
  const match = numeric ?? chinese;
  if (!match) return undefined;
  const tail = message.slice(match.index! + match[0].length);
  const subunits = tail.match(/^\s*(?:([零〇一二两三四五六七八九])角)?(?:零?([零〇一二两三四五六七八九])分)?(?:整|正)?/)!;
  const remainder = tail.slice(subunits[0].length);
  if (/^[0-9零〇一二两三四五六七八九十百千万亿点角分]|^(?:负|[-−])\s*[0-9零〇一二两三四五六七八九十百千万亿]+(?:角|分)/.test(remainder)) return undefined;
  const fractionMinor = BigInt((digits[subunits[1] ?? ''] ?? 0) * 10 + (digits[subunits[2] ?? ''] ?? 0));
  let amount: bigint;
  if (numeric) {
    const [whole, fractional = ''] = numeric[1]!.replace(/,/g, '').split('.');
    if ((subunits[1] || subunits[2]) && (fractional || numeric[2])) return undefined;
    amount = (BigInt(whole!) * 100n + BigInt(fractional.padEnd(2, '0'))) * (numeric[2] ? 10000n : 1n) + fractionMinor;
  } else {
    const whole = chineseInteger(chinese![1]!);
    if (whole === undefined || !Number.isSafeInteger(whole)) return undefined;
    if (chinese![2] && (subunits[1] || subunits[2])) return undefined;
    const decimal = chinese![2] ? BigInt([...chinese![2]].map(c => digits[c]).join('').padEnd(2, '0')) : fractionMinor;
    amount = BigInt(whole) * 100n + decimal;
  }
  return amount > 0n && amount < 1000000000000n ? amount.toString() : undefined;
}

/** A future life-goal request, distinct from the existing immediate-transfer budget check. */
export function isGoalRequest(message: string): boolean {
  return /生日|生活目标|储蓄目标|存钱目标|旅行目标|(?:制定|建立|创建|规划|安排).{0,12}(?:目标|计划)|(?:目标|计划).{0,12}(?:截止|完成日期|转账|赎回)/.test(message);
}

/** Subscription request scope shared by routing and deterministic resolution. */
export function subscriptionRequestClauses(message: string): string[] {
  // Preserve quoted records as one clause, including conjunctions inside them.
  const pieces: string[] = [];
  let start = 0;
  const delimiters = /```[\s\S]*?(?:```|$)|`[^`]*(?:`|$)|“[^”]*(?:”|$)|‘[^’]*(?:’|$)|「[^」]*(?:」|$)|『[^』]*(?:』|$)|"[^"\n]*(?:"|$)|'[^'\n]*(?:'|$)|[，,。；;\n]|并(?:且)?|同时|另外|然后|以及|但是|不过/g;
  for (const match of message.matchAll(delimiters)) {
    if (/^[`“‘「『"']/.test(match[0])) continue;
    pieces.push(message.slice(start, match.index));
    start = match.index! + match[0].length;
  }
  pieces.push(message.slice(start));
  return pieces.map(clause => clause.trim()).filter(Boolean).filter(clause => {
    // A historical line can describe “取消订阅” without requesting that action.
    const historicalBill = clause.search(/账单(?:里|中|内|上|明细|记录|记载)/);
    if (historicalBill < 0) return true;
    const prefix = clause.slice(0, historicalBill);
    const command = /^(?:\s|请|帮我|麻烦|先|再|也|顺便)*(?:取消|阻止|限制|停止|关闭|暂停|恢复)/.test(prefix);
    const read = /^(?:\s|请|帮我|麻烦|先|再|也|顺便|我想)*(?:查看|看看|看一下|查询|查一下|查查|查|找出|检索|统计|核对|分析|列出|汇总|确认)/.test(prefix)
      || /有没有|是否|哪些|多少/.test(clause.slice(historicalBill))
      || /账单(?:明细|记录|记载)/.test(clause);
    return command || !read;
  });
}

/** Veto-only view of standalone transfer exclusions. Never use this view to
 * ground an action or its arguments: the original message remains authoritative.
 * Exact clause boundaries deliberately exclude qualified/conditional negations. */
export function withoutStandaloneTransferExclusions(message: string): string {
  return message.replace(/(^|[，,。；;\n！？?])\s*(?:先|暂时|现在)?(?:不|不要|不用|无需|不需要|别|暂不|不再)(?:做|进行)?转账(?:操作)?[，,。；;\n！？?!\s]*$/, '$1');
}

/** A later clause can revoke the exclusion or introduce an operation absent
 * from the legacy keyword router. Never erase a nonterminal exclusion. */
export function hasNonterminalTransferExclusion(message: string): boolean {
  return /(?:^|[，,。；;\n！？?])\s*(?:先|暂时|现在)?(?:不|不要|不用|无需|不需要|别|暂不|不再)(?:做|进行)?转账(?:操作)?[，,。；;\n！？?!\s]+[\s\S]*[\p{L}\p{N}]/u.test(message);
}

/** Detect possible extra domains without treating a typed investment field or
 * an exact no-transfer constraint as another requested operation. */
export function extraOperationRoles(message: string, operation: string): DomainRole[] {
  let text = withoutStandaloneTransferExclusions(message);
  if (operation === 'investment_query') text = text.replace(/可赎回余额/g, '可赎回额度');
  return activeRoles(text);
}

export function activeRoles(message: string): DomainRole[] {
  const roles: DomainRole[] = [];
  if (!isGoalRequest(message) && /转账|转给|(?:给|向).{1,40}转|汇款|汇给|打给|付款给|支付给|transfer|send\s+money/i.test(message)) roles.push('transfer');
  if (/账单|收支|消费分析|支出分析|(?:查询|查看|统计|汇总).{0,40}(?:收入|支出|净额)|(?:找出|查询|查看|列出).{0,40}大额.{0,20}消费|bill|spending/i.test(message)) roles.push('bills');
  if (/理财|投资|基金|赎回|持仓|investment|redeem/i.test(message)) roles.push('investment');
  // In a subscription request, a bank card can merely name the debit channel.
  // Remove only that channel phrase, leaving explicit card queries/actions intact.
  const cardText = message.replace(/(?:从|通过|经由)?银行卡(?:里|中|上)?(?:自动)?扣款/g, '扣款');
  if (/银行卡|卡片|冻结.*卡|挂失|解挂|card|卡.{0,8}(?:当前状态|使用状态|状态)|(?:恢复|冻结).{0,30}卡/i.test(cardText)) roles.push('card');
  const subscriptionText = subscriptionRequestClauses(message).join('；');
  if (/订阅|自动续费|自动扣款|银行.{0,8}扣款|(?:阻止|限制|停止|取消).{0,30}扣款|subscription/i.test(subscriptionText)) roles.push('subscription');
  if (isGoalRequest(message) || /房租|生活费|不影响|余额|预算|goal/i.test(message)) roles.push('goal');
  return roles;
}

const transferOperation = /转账|转给|(?:给|向).{1,40}转|汇款|汇给|打给|付款给|支付给|transfer|send\s+money/i;
type TransferResolution = { suggestion?: TransferSuggestion; clarification?: string; noActionReason?: string };

function inactiveTransfer(text: string): boolean {
  // Locate the verb itself, not the start of "给…转"; negation can appear
  // between the recipient and the verb ("给林晓先不要转账").
  const explicitVerb = text.search(/转账|转给|汇款|汇给|打给|付款给|支付给|transfer|send\s+money/i);
  const actionIndex = explicitVerb >= 0 ? explicitVerb : text.search(/转/);
  // An invalid request to bypass authorization never grants authority, but it is
  // not itself a negation of an otherwise valid pending payment intention.
  const prefix = text.slice(0, actionIndex)
    .replace(/(?:不要|不得|禁止|不许|别)(?:绕过|跳过|省略|伪造)(?:确认|验证|授权|STRONG(?:验证)?)/gi, '')
    .replace(/(?:不要|不用|无需|不需要|不必)(?:\s|再次|额外|重复|人工|强|进行|用户|二次|任何|再|先)*(?:确认|验证|授权|询问|问我)/g, '')
    .replace(/\b(?:do\s+not|don't|never)\s+(?:skip|bypass)\s+(?:confirmation|verification|authorization)\b/gi, '');
  const inquiry = /如何|怎么|怎样|假如|如果|假设|是否|能否|只是(?:说说|讨论|提及)|[？?]/.test(text)
    || /^(?:请(?:问)?|我想|我(?:只)?是(?:在)?|先|帮我|仅|只是)?(?:查询|核对|咨询|模拟|举例|示例|例如|讨论|了解|记录)/.test(text)
    || /示例|举例|例如/.test(prefix)
    || /^\s*(?:how\b|can\s+i\b|what\b|could\s+i\b|if\b|suppose\b|example\b|quote\b)/i.test(text);
  return /不要|不想|不用|无需|不需要|不必|暂不|不再|不打算|不准备|不希望|不能|不可|不是|并非|别|禁止|取消|撤销|撤回|作废/.test(prefix)
    || /\b(?:do\s+not|don't|never|not|cancel|stop)\b/i.test(prefix)
    || inquiry
    || /(?:这件事|这笔|这次|该笔).*(?:不做|暂缓)|(?:先|暂时|现在)?(?:不要|别|暂不|不再)(?:做|执行|转(?:账)?|办理|付款)|暂缓|先等一下/.test(text.slice(actionIndex));
}

function positiveTransferClauses(message: string): { positive: string[]; ambiguousRetraction: boolean } {
  // Quoted examples/data cannot provide an operation, payee or amount to an
  // independent request. Unclosed quotes are conservatively masked to the end.
  const unquoted = message.replace(/```[\s\S]*?(?:```|$)|`[^`]*(?:`|$)|“[^”]*(?:”|$)|‘[^’]*(?:’|$)|「[^」]*(?:」|$)|『[^』]*(?:』|$)|"[^"\n]*(?:"|$)|'[^'\n]*(?:'|$)/g, ' [QUOTED_DATA] ');
  // Do not split decimal/thousands punctuation. Conjunctions delimit tasks, not
  // monetary alternatives (the existing amount guards still handle those).
  const pieces = unquoted.split(/([。；;\n])|[，]|(?<!\d),(?!\d)|并(?:且)?|而是|但是|不过|然后|(?=但(?:先|暂时|现在|取消|撤销|撤回|不要|别))/).filter((p): p is string => p !== undefined).map(p => /^[。；;\n]$/.test(p) ? p : p.trim()).filter(Boolean);
  const candidates: { text: string; inactive: boolean }[] = [];
  let previous: { text: string; inactive: boolean } | undefined;
  let exampleScope = false, ambiguousRetraction = false, continuationOpen = false;
  for (const piece of pieces) {
    const text = piece.replace(/^但(?=(?:先|暂时|现在|取消|撤销|撤回|不要|别))/, '');
    if (/^[。；;\n]$/.test(text)) { continuationOpen = false; continue; }
    if (/^(?:实际(?:上)?|现在|正式|真正)(?:请|要|需要|给|向|帮我)/.test(text)) exampleScope = false;
    const retraction = /^(?:(?:我|这件事|这笔|这次|该笔|上述转账)\s*)?(?:(?:先|暂时|现在)?(?:不要|别|暂不)(?:做|执行|转(?:账)?)|暂缓|先等一下|(?:取消|撤销|撤回|作废)(?:这笔(?:转账|操作)?)?|不用)(?:了|吧)?$|^(?:我)?只是在核对(?:金额|这笔|转账)/.test(text);
    if (retraction) {
      if (previous) previous.inactive = true;
      else if (candidates.some(c => !c.inactive)) ambiguousRetraction = true;
      continue;
    }
    if (!transferOperation.test(text)) {
      // Only adjacent, explicitly labelled transfer metadata can extend an
      // operative command. Negated commands, examples and other business tasks
      // never supply fields to a later or earlier payment.
      const continuationText = normalizeMoneyNumerals(text);
      const continuation = /^(?:(?:请)?(?:选|选择|使用|用|指定)?(?:尾号|末四位)\s*\d{4}(?:的|那张|这张)?(?:收款账户|收款账号|账户|账号)?|金额(?:为|是|[:：])?\s*(?:人民币)?[0-9零〇一二两三四五六七八九十百千万亿点.,]+(?:元|块)(?:[零〇一二两三四五六七八九]角)?(?:零?[零〇一二两三四五六七八九]分)?(?:整|正)?)$/.test(continuationText);
      if (continuation && continuationOpen && previous && !previous.inactive) { previous.text += `，${text}`; continue; }
      continuationOpen = false;
      const preface = !text.includes('[QUOTED_DATA]') && /^(?:下面|以下|这|上述).*(?:示例|例子|举例|假设|引用)|^(?:例如|举例|假设|假如|如果)/.test(text);
      if (preface) { exampleScope = true; previous = undefined; }
      // A separate business task ends the implicit retraction association; an
      // explanatory aside does not erase a pending command's later withdrawal.
      else if (activeRoles(text).some(role => role !== 'transfer') && /查|分析|挂失|解挂|取消|阻止|赎回|建立|创建/.test(text)) previous = undefined;
      continue;
    }
    previous = { text, inactive: exampleScope || inactiveTransfer(text) };
    candidates.push(previous);
    continuationOpen = !previous.inactive;
  }
  return { positive: candidates.filter(c => !c.inactive).map(c => c.text), ambiguousRetraction };
}

export function resolveTransfer(message: string, payees: PayeeView[]): TransferResolution {
  const { positive: transferClauses, ambiguousRetraction } = positiveTransferClauses(message);
  if (ambiguousRetraction) return { clarification: '撤回指令与多个任务的关联不明确，请明确要保留或取消哪一笔；未创建转账。' };
  if (!transferClauses.length) return { noActionReason: '当前转账内容为否定、撤回、咨询或引用；未创建转账提案，也未执行转账。' };
  if (transferClauses.length > 1) return { clarification: '本阶段一次仅处理一笔转账，请先明确其中一笔。' };
  const selected = transferClauses[0]!;
  // Match only inside the sole operative request, never borrow a target or an
  // amount from a negated request, quoted example, or another domain's query.
  const matched = payees.filter(p => [p.name, ...p.aliases].some(name => name.length > 0 && selected.includes(name)));
  let candidates = matched;
  const suffixes = [...selected.matchAll(/(?:尾号|末四位)\s*(\d{4})/g)].map(match => match[1]!);
  if (new Set(suffixes).size > 1) return { clarification: '收款账户尾号存在多个选项，请明确唯一账户。' };
  if (suffixes.length) candidates = candidates.filter(p => p.maskedNumber.replace(/\D/g, '').endsWith(suffixes[0]!));
  if (candidates.length > 1) {
    const bankMatches = candidates.filter(p => selected.includes(p.bank));
    if (bankMatches.length) candidates = bankMatches;
  }
  if (candidates.length > 1) return { clarification: `找到同名收款人，请指定银行或尾号：${candidates.map(p => `${p.name}（${p.bank}，${p.maskedNumber}）`).join('、')}` };
  if (!candidates.length) return { clarification: '请指定已保存的收款人姓名；当前信息不足以确定收款人。' };
  // Names such as 张三/王五 end in Chinese digits; remove the resolved name before
  // parsing an adjacent amount ("转给张三十二元" means 张三 + 十二元).
  let amountText = normalizeMoneyNumerals(selected);
  for (const name of [candidates[0]!.name, ...candidates[0]!.aliases].filter(Boolean)) amountText = amountText.split(normalizeMoneyNumerals(name)).join(' ');
  const actionIndex = amountText.search(/转|汇款|汇给|打给|付款给|支付给|transfer/i);
  if (actionIndex >= 0) amountText = amountText.slice(actionIndex);
  amountText = amountText.split(/不影响|保留|预留|留出|余额|预算/)[0]!;
  const number = '[0-9零〇一二两三四五六七八九十百千万亿点.,]+';
  // Commas remain part of the number token: 1,234 is a single thousands-formatted
  // amount. Explicit alternatives/conjunctions never select the final number.
  if (new RegExp(`${number}\\s*(?:元|块)?\\s*(?:或(?:者|是)?|还是|、|和|与|以及|or|/|到|至|~|～|-)\\s*${number}`, 'i').test(amountText)) return { clarification: '转账金额存在多个选项或范围，请明确唯一金额。' };
  const explicitAmounts = amountText.match(/[0-9零〇一二两三四五六七八九十百千万亿点.,]+\s*(?:万)?\s*(?:元|块|人民币|CNY|RMB)/gi) ?? [];
  if (explicitAmounts.length > 1) return { clarification: '检测到多个转账金额，请明确本次唯一金额。' };
  // Names have already been removed here, so unlike the standalone utility
  // there is no legitimate name-ending digit adjacent to an Arabic amount.
  if (/[零〇一二两三四五六七八九十百千万亿][0-9]|[0-9][零〇一二两三四五六七八九十百千亿]/.test(amountText)) return { clarification: '金额数字格式不明确，请使用完整且一致的数字格式。' };
  const amountMinor = parseAmountMinor(amountText);
  if (!amountMinor) return { clarification: '请明确转账金额并注明元，例如“三百元”或“300元”。' };
  return { suggestion: { payeeId: candidates[0]!.id, amountMinor, memo: 'BankPilot 合成银行沙箱转账' } };
}
