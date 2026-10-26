import type { SemanticPlan } from '../../contracts/src/index';
import { inactiveSourceSupported, quotedRanges, sourceClauses } from './inactive-source';

type SubscriptionWrite = 'subscription_cancel' | 'subscription_block';
export type SubscriptionPrerequisite = {
  version: 1;
  message: string;
  tasks: Array<{ operation: SubscriptionWrite; source: { text: string; start: number; end: number } }>;
};
type Request = { operation: SubscriptionWrite; merchant: string; start: number };
const maxMessageLength = 12000;
const prefix = /^(?:请你|麻烦你|帮我|替我|麻烦|我需要|我要求|我想|我要|另外|同时|然后|并且|但是|不过|本次|这次|现在|请|先|再|并|但)\s*/;
function requestHead(text: string): string {
  let rest = text.trim();
  for (let count = 0; count < 8; count++) {
    const matched = prefix.exec(rest)?.[0];
    if (!matched) break;
    rest = rest.slice(matched.length);
  }
  return rest;
}
// A lexical object is an unresolved name, never an identity. These narrow
// names cannot absorb another command, object list, condition or prohibition.
const noun = '([\\p{L}\\p{N}][\\p{L}\\p{N}\\p{M} ._·•・-]{0,79}?)';
function merchantName(value: string): string | undefined {
  const name = value.trim();
  if (!name || name.length > 80 || !/\p{L}/u.test(name)
    || /取消|退订|终止|阻止|拦截|限制|屏蔽|停止|关闭|暂停|恢复|删除|注销|销户|销卡|冻结|补卡|换卡|购买|买入|卖出|申购|认购|取出|取回|开通|开启|启用|转账|查询|查看|赎回|支付|付款|汇款|转给|汇给|打给|挂失|解挂|授权|确认|执行|准备|如果|假如|假设|只有|只要|除非|否则|是否|能否|可否|能不能|可不可以|如何|怎么|怎样|不要|不用|不必|无需|不需要|暂不|不再|不想|不打算|不准备|别|撤回|撤销|暂缓|算了|以前|曾经|历史|旧稿|草稿|记录|示例|例子|会议|文档|笔记|或|还是|以及|和|与|及|且|并|包括|连同|一并|两个|两家|所有|全部|部分|同时|然后|另外|但是|不过|这些|那些|这个|那个|这家|那家|这项|那项|该项|另一|未来|后续|下次|下一次|明天|后天|下周|下月/.test(name)
    || /^(?:某|某个|某家|一家|一个|一些|它|它们|他们|该|上述|其中)$/u.test(name)
    || /^(?:银行|商户|订阅|合同|合约|会员|商户合同|商户订阅|订阅合同|自动续费|扣款|银行扣款|账单|银行卡|理财|余额|目标)$/u.test(name)
    || /\d{4}[-年]\d{1,2}|\d{1,2}月\d{1,2}日/.test(name)
    || /\b(?:and|or|if|not|cancel|block|transfer|query)\b/i.test(name)
    || /[0-9零〇一二两三四五六七八九十百千万亿]+\s*(?:元|块|角|分)/.test(name)) return;
  return name;
}
const cancel = new RegExp(`^(?:只|仅)?(?:取消|终止)(?:一下)?${noun}(?:的)?(?:商户订阅(?:合同)?|订阅(?:合同)?|会员(?:订阅)?|商户合同|自动续费)$`, 'u');
// Bare 退订 + an arbitrary unknown noun cannot distinguish a merchant from a
// result/status phrase. Require an explicit subscription/service object edge.
const unsubscribe = new RegExp(`^(?:只|仅)?退订${noun}(?:的)?(?:商户订阅(?:合同)?|订阅(?:合同)?|会员(?:订阅)?|服务)$`, 'u');
const bank = '(?:在|从)?银行(?:侧|端)?';
const stop = '(?:阻止|拦截|限制|屏蔽|停止)';
const debit = '(?:未来|后续|下一次|下次)?(?:自动)?扣款';
const block = [
  new RegExp(`^(?:只|仅)?${bank}(?:只|仅)?${stop}${noun}(?:的)?(?:订阅)?${debit}$`, 'u'),
  new RegExp(`^(?:只|仅)?${stop}${noun}(?:的)?银行(?:侧|端)?${debit}$`, 'u'),
  new RegExp(`^(?:对|给)${noun}(?:只|仅)?(?:做|设置)?银行(?:侧|端)?(?:的)?(?:自动)?扣款(?:拦截|限制|屏蔽)$`, 'u'),
  new RegExp(`^(?:对|给)${noun}(?:只|仅)?${bank}${stop}(?:订阅)?${debit}$`, 'u'),
];
const declaredContract = new RegExp(`^${noun}(?:的)?(?:合约|合同)(?:由)?我自己(?:处理|联系商户)$`, 'u');
const retainedContract = new RegExp(`^保留${noun}(?:的)?(?:会员|订阅|商户合同)$`, 'u');
function contractObject(text: string): string | undefined {
  const matched = declaredContract.exec(text) ?? retainedContract.exec(text);
  return matched ? merchantName(matched[1]!) : undefined;
}
function positiveRequest(text: string, declared?: string): { operation: SubscriptionWrite; merchant: string } | undefined {
  const cancellation = cancel.exec(text) ?? unsubscribe.exec(text);
  if (cancellation) {
    const merchant = merchantName(cancellation[1]!);
    return merchant ? { operation: 'subscription_cancel', merchant } : undefined;
  }
  for (const pattern of block) {
    const matched = pattern.exec(text), merchant = matched && merchantName(matched[1]!);
    if (merchant) return { operation: 'subscription_block', merchant };
  }
  if (declared && new RegExp(`^(?:只|仅)?${bank}(?:只|仅)?${stop}(?:(?:这项|该项)(?:订阅)?)?${debit}$`).test(text)) {
    return { operation: 'subscription_block', merchant: declared };
  }
  return;
}
function localConstraint(text: string, request: Request): boolean {
  if (request.operation === 'subscription_block') {
    if (/^(?:不要|不用|不必|无需|别|不)(?:取消|退订|终止)(?:商户)?(?:合同|合约|订阅|会员)$/.test(text)
      || /^(?:合同|合约)(?:由)?我自己(?:处理|联系商户)$/.test(text)) return true;
    const declared = contractObject(text);
    return declared !== undefined && normalizeName(declared) === normalizeName(request.merchant);
  }
  return /^(?:不要|不用|不必|无需|别|不)(?:(?:在|从)?银行(?:侧|端)?(?:阻止|拦截|限制|屏蔽)(?:自动)?扣款|(?:阻止|拦截|限制|屏蔽)银行(?:侧|端)?(?:自动)?扣款|(?:做|设置)?银行(?:侧|端)?(?:自动)?扣款(?:拦截|限制|屏蔽))$/.test(text);
}
function previewOnly(text: string): boolean {
  return /^(?:分别|逐项)?(?:生成|准备|提出)(?:一个)?(?:待确认)?(?:候选|提案)$/.test(text)
    || /^(?:先)?(?:给我|让我)(?:看|查看|核对)(?:结果|候选|提案)(?:(?:或|和|与|及)(?:结果|候选|提案))*$/.test(text)
    || /^(?:先)?给(?:一个)?待确认(?:候选|提案)$/.test(text)
    || /^(?:只|仅)(?:生成|准备|提出)待确认(?:候选|提案)$/.test(text)
    || /^(?:不要|不)(?:自动)?执行$/.test(text);
}
function normalizeName(name: string): string { return name.normalize('NFKC').replace(/\s/g, '').toLowerCase(); }

/** Pregrant source recognition only: no lookup, object ID, grant or write spec.
 * Every clause must be a supported request or its complete local constraint.
 * Unsupported/mixed/quoted text returns undefined without publishing a prefix. */
export function recognizeSubscriptionPrerequisite(message: string): SubscriptionPrerequisite | undefined {
  if (typeof message !== 'string' || !message.trim() || message.length > maxMessageLength
    || /[？?"'`“”‘’「」『』]/.test(message) || quotedRanges(message).length
    || inactiveSourceSupported(message, 'historical')) return;
  const clauses = sourceClauses(message), requests: Request[] = [];
  let search = 0, declared: { merchant: string; start: number } | undefined, declaredCount: number | undefined;
  for (const [index, clause] of clauses.entries()) {
    const at = message.indexOf(clause, search);
    if (at < 0) return;
    let start = at;
    while (start > 0 && /\s/.test(message[start - 1]!)) start--;
    search = at + clause.length;
    let text = clause;
    if (index === 0) {
      const frame = /^(?:这次|本次|现在)?(?:请)?(?:分(?:成)?([一二两三四五六七八1-8])(?:件事|件|项)(?:分别)?(?:办理|处理|办)|分别(?:办理|处理))[：:]\s*/.exec(text);
      if (frame) {
        declaredCount = frame[1] ? ({ 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8 } as Record<string, number>)[frame[1]] ?? Number(frame[1]) : undefined;
        text = text.slice(frame[0].length);
        if (!text) continue;
      }
    }
    text = requestHead(text);
    const current = requests.at(-1);
    if (current && !declared && (localConstraint(text, current) || previewOnly(text))) continue;
    const positive = positiveRequest(text, declared?.merchant);
    if (positive) {
      if (requests.length >= 8 || (declared && (positive.operation !== 'subscription_block' || normalizeName(declared.merchant) !== normalizeName(positive.merchant)))
        || requests.some(request => normalizeName(request.merchant) === normalizeName(positive.merchant))) return;
      requests.push({ ...positive, start: requests.length ? declared?.start ?? start : 0 }); declared = undefined;
      continue;
    }
    const merchant = contractObject(text);
    if (!declared && merchant) { declared = { merchant, start: requests.length ? start : 0 }; continue; }
    return;
  }
  if (declared || !requests.length || (declaredCount !== undefined && declaredCount !== requests.length)) return;
  return { version: 1, message, tasks: requests.map((request, index) => {
    const start = request.start, end = requests[index + 1]?.start ?? message.length;
    return { operation: request.operation, source: { text: message.slice(start, end), start, end } };
  }) };
}

/** Only accepts a server-grounded SemanticPlan from the normal authorized
 * recognition path. Snapshot membership/grant validity still belong to that
 * path and Core; entityId alone cannot authenticate untrusted model JSON. */
export function verifySubscriptionContinuation(prerequisite: SubscriptionPrerequisite, plan: SemanticPlan): boolean {
  if (!prerequisite || prerequisite.version !== 1 || typeof prerequisite.message !== 'string' || !Array.isArray(prerequisite.tasks)
    || Object.keys(prerequisite).some(key => !['version', 'message', 'tasks'].includes(key))
    || !plan || plan.status !== 'ready' || plan.failure || plan.clarification || plan.issues?.length || !Array.isArray(plan.tasks)
    || (plan.recognizedRoles && (plan.recognizedRoles.length !== 1 || plan.recognizedRoles[0] !== 'subscription'))) return false;
  const recognized = recognizeSubscriptionPrerequisite(prerequisite.message);
  if (!recognized || recognized.tasks.length !== prerequisite.tasks.length || plan.tasks.length !== recognized.tasks.length) return false;
  const entities = new Set<string>();
  return recognized.tasks.every((expected, index) => {
    const stored = prerequisite.tasks[index], actual = plan.tasks[index];
    if (!stored || !actual || stored.operation !== expected.operation || actual.operation !== expected.operation || actual.role !== 'subscription'
      || Object.keys(stored).some(key => !['operation', 'source'].includes(key))
      || !stored.source || stored.source.text !== expected.source.text || stored.source.start !== expected.source.start || stored.source.end !== expected.source.end
      || Object.keys(stored.source).some(key => !['text', 'start', 'end'].includes(key))
      || !actual.source || actual.source.text !== expected.source.text || actual.source.start !== expected.source.start || actual.source.end !== expected.source.end
      || typeof actual.canonicalMessage !== 'string' || !actual.canonicalMessage.trim() || !actual.slots
      || typeof actual.slots.entityId !== 'string' || !actual.slots.entityId.trim() || actual.slots.entityId !== actual.slots.entityId.trim()
      || Object.keys(actual.slots).some(key => key !== 'entityId') || entities.has(actual.slots.entityId)) return false;
    entities.add(actual.slots.entityId);
    return true;
  });
}
