import type { CardView, ManagementContext, ManagementSpec, SubscriptionSnapshot } from '../../contracts/src/index';
import { subscriptionRequestClauses } from './intent';

export type ManagementResolution = {
  managementSuggestions: ManagementSpec[]; summary: string; clarification?: string;
  findings: string[]; evidence: { source: string; detail: string }[];
};
const clauses = (message: string) => message.split(/[，。；;\n]|并且|但是|不过/).map(part => part.trim()).filter(Boolean);
const withdrawn = (message: string) => clauses(message).some(text => /^(?:(?:这件事|这笔|这次|该笔|上述请求|我)\s*)?(?:(?:先|暂时|现在)?(?:不要|别|暂不|不用)(?:做|执行|办理|操作)?|暂缓|撤回|撤销|取消(?:这笔|这次|该笔)?(?:操作|请求)?|算了|不用了)(?:了|吧)?[！!。]?$/.test(text));
const isQuestionOrExplanation = (text: string) => /查询|查看|查一下|查查|看看|了解|介绍|如何|怎么|假如|如果|是否|有没有|状态|了吗|吗[？?]?$|[？?]/.test(text);
function isNegated(text: string, operation: RegExp) {
  const index = text.search(operation);
  if (index < 0) return false;
  // Negation applies to this clause, including a deferred/retracted command after its target.
  // Conservative refusal is preferable to turning narrative or a cancelled intention into a write.
  return /不要|不想|不用|无需|不需要|不必|暂不|不再|不希望|不准备|不打算|并非|不是|别|禁止|没有|未曾|尚未|还没|未$|没$|不$/.test(text.slice(0, index))
    || /不要|不用|不必|不需要|无需|别做|别办|别执行|别操作|先不|暂不|不再|不做|不办|不执行|不操作|暂缓/.test(text.slice(index + (text.match(operation)?.[0].length ?? 0)));
}
const queryPattern = /查询|查看|查一下|查查|看看|查|看|列出|哪些|有哪些|列表|状态|list|show|query/i;
const cardRestore = /解除挂失|取消挂失|解挂|恢复(?:银行卡|卡片|卡)?(?:使用)?/;
const cardLost = /挂失|报失/;
const cancelPattern = /取消|退订|终止|cancel/i;
const blockPattern = /阻止|禁止|限制|屏蔽|拦截|停止.{0,8}扣款|block/i;
const formatCards = (cards: CardView[]) => cards.map(card => `${card.name}（${card.maskedNumber}）：${card.status === 'LOST' ? '已挂失' : '正常'}，版本${card.version}`).join('；');
const empty = (summary: string, evidence: ManagementResolution['evidence'] = [], findings: string[] = []): ManagementResolution => ({ managementSuggestions: [], summary, evidence, findings });
const clarify = (message: string, evidence: ManagementResolution['evidence'] = []): ManagementResolution => ({ ...empty('管理请求需要澄清，尚未生成操作。', evidence), clarification: message });

export function resolveCard(message: string, context?: ManagementContext): ManagementResolution {
  const cards = context?.cards ?? [];
  const evidence = cards.map(card => ({ source: `card:${card.id}:v${card.version}`, detail: `${card.name};${card.maskedNumber};status=${card.status};version=${card.version};updatedAt=${card.updatedAt}` }));
  if (withdrawn(message)) return empty('管理请求已撤回，未生成操作。', evidence);
  const operations: { kind: 'CARD_REPORT_LOST' | 'CARD_UNREPORT_LOST'; text: string }[] = [];
  for (const text of clauses(message)) {
    if (!/卡|挂失|解挂|报失|尾号|末四位/.test(text)) continue;
    const restore = cardRestore.test(text);
    const pattern = restore ? cardRestore : cardLost;
    // “恢复…卡使用状态” is an imperative; the terminal state noun alone
    // must not turn it into a query. Explicit query/question words still win.
    const questionText = restore ? text.replace(/使用状态\s*[。！!]?$/, '') : text;
    if (!pattern.test(text) || isQuestionOrExplanation(questionText) || isNegated(text, pattern) || /已经|已挂失|曾经/.test(text)) continue;
    if (restore && cardLost.test(text.replace(cardRestore, ''))) { operations.push({ kind: 'CARD_REPORT_LOST', text }, { kind: 'CARD_UNREPORT_LOST', text }); continue; }
    operations.push({ kind: restore ? 'CARD_UNREPORT_LOST' : 'CARD_REPORT_LOST', text });
  }
  if (!operations.length) return empty(cards.length ? `银行卡状态来自服务端卡片事实：${formatCards(cards)}。未提出挂失或解挂操作。` : '当前没有可用银行卡事实；未生成管理操作。', evidence);
  if (operations.length !== 1) return clarify('一次仅处理一项银行卡挂失或解挂操作，请明确唯一卡片和操作。', evidence);
  const operation = operations[0]!;
  if (/另一|其他|陌生|不存在|别的/.test(operation.text)) return clarify('请从当前卡片事实中明确选择唯一银行卡。', evidence);
  if (/(?:尾号|末四位)\s*\d{4}\s*(?:、|和|与|或|\/)\s*(?:(?:尾号|末四位)\s*)?\d{4}/.test(operation.text)) return clarify('检测到多个卡片尾号，请选择唯一银行卡。', evidence);
  let candidates = cards;
  const named = cards.filter(card => card.name && operation.text.includes(card.name));
  if (named.length) candidates = named;
  const suffix = operation.text.match(/(?:尾号|末四位)\s*(\d{4})/);
  // A sole available card is a default only for generic references. An explicit unknown
  // bank/card name must not disappear merely because the service returned one card.
  let unmatchedTarget = operation.text.replace(cardRestore, '').replace(cardLost, '').replace(/(?:尾号|末四位)\s*\d{4}/g, '');
  for (const card of cards) if (card.name) unmatchedTarget = unmatchedTarget.replaceAll(card.name, '');
  unmatchedTarget = unmatchedTarget.replace(/使用状态|银行卡|卡片|这张卡|该卡|这张|我的|唯一|卡|请你|麻烦你|帮我|为我|给我|我想|我要|我需要|请|麻烦|现在|立即|马上|先|办理|进行|一下|谢谢|把|将|的|吧|啊|呀|\s|[！!]/g, '');
  if (unmatchedTarget) return clarify('未找到明确匹配的银行卡名称，请核对名称或尾号；不会默认选择其他卡片。', evidence);
  if (suffix) candidates = candidates.filter(card => card.maskedNumber.replace(/\D/g, '').endsWith(suffix[1]!));
  if (candidates.length !== 1) return clarify(candidates.length ? `请指定唯一卡片的名称或尾号：${formatCards(candidates)}` : '未找到明确匹配的银行卡，请核对名称或尾号。', evidence);
  const card = candidates[0]!;
  if (operation.kind === 'CARD_REPORT_LOST' && card.status === 'LOST') return empty('该卡已挂失，无需重复挂失；没有新增操作。', evidence);
  if (operation.kind === 'CARD_UNREPORT_LOST' && card.status !== 'LOST') return empty('该卡当前未挂失，无需解挂；没有新增操作。', evidence);
  return { managementSuggestions: [{ kind: operation.kind, cardId: card.id, expectedVersion: card.version }], summary: `已生成${operation.kind === 'CARD_REPORT_LOST' ? '挂失' : '解挂'}待确认提案：${card.name}（${card.maskedNumber}）。尚未执行，卡片实际状态以管理服务回执为准。`, findings: [], evidence };
}

function usableSnapshot(snapshot?: SubscriptionSnapshot): snapshot is SubscriptionSnapshot {
  return !!snapshot?.queryActionId && Array.isArray(snapshot.items) && Number.isFinite(Date.parse(snapshot.accessExpiresAt)) && Date.parse(snapshot.accessExpiresAt) > Date.now();
}
export function resolveSubscription(message: string, context?: ManagementContext): ManagementResolution {
  if (withdrawn(message)) return empty('订阅请求已撤回，未生成操作。');
  const pieces = subscriptionRequestClauses(message).filter(text => /订阅|自动续费|扣款|subscription/i.test(text) || context?.subscriptions?.items.some(item => text.includes(item.merchant)));
  const positive = pieces.filter(text => !(isNegated(text, cancelPattern) || isNegated(text, blockPattern)));
  const wantsQuery = pieces.some(text => queryPattern.test(text) && !isNegated(text, queryPattern));
  const operations = positive.flatMap<{ kind: 'AMBIGUOUS' | 'SUBSCRIPTION_CANCEL' | 'SUBSCRIPTION_BLOCK'; text: string }>(text => {
    if (cardRestore.test(text) && !/订阅|自动续费|扣款/.test(text) && !context?.subscriptions?.items.some(item => text.includes(item.merchant))) return [];
    if (isQuestionOrExplanation(text)) return [];
    const cancel = cancelPattern.test(text), block = blockPattern.test(text);
    if (cancel && block) return [{ kind: 'AMBIGUOUS' as const, text }];
    if (cancel) return [{ kind: 'SUBSCRIPTION_CANCEL' as const, text }];
    if (block) return [{ kind: 'SUBSCRIPTION_BLOCK' as const, text }];
    return [];
  });
  if (!wantsQuery && !operations.length) return empty('没有明确的订阅查询、取消合同或银行扣款限制请求；未生成操作。');
  const snapshot = context?.subscriptions;
  if (!usableSnapshot(snapshot)) return {
    managementSuggestions: [{ kind: 'SUBSCRIPTION_QUERY' }],
    summary: '需先确认订阅查询请求（黄色确认）。当前未查询或取消订阅，也未阻止扣款；确认查询后才能依据服务端快照选择具体商户。',
    findings: ['SUBSCRIPTION_QUERY_CONFIRMATION_REQUIRED：查询本身也必须经过黄色确认；不能由模型跳过。'],
    evidence: [{ source: 'subscription-access', detail: snapshot ? '未提供可用查询快照；旧快照不延长、不作为取消或阻止依据，API/service仍须校验owner与grant有效期。' : '尚无已确认查询快照。' }],
  };
  const evidence = [{ source: `subscription-snapshot:${snapshot.queryActionId}`, detail: `queriedAt=${snapshot.queriedAt};accessExpiresAt=${snapshot.accessExpiresAt};source=SYNTHETIC_MERCHANT` }, ...snapshot.items.map(item => ({ source: `subscription:${item.id}:v${item.version}`, detail: `${item.merchant};merchantStatus=${item.merchantStatus};bankStatus=${item.bankStatus};collectionStatus=${item.collectionStatus};amountMinor=${item.amountMinor};nextChargeDate=${item.nextChargeDate}` }))];
  if (!operations.length) return { managementSuggestions: [{ kind: 'SUBSCRIPTION_QUERY' }], summary: '已提出订阅查询待黄色确认请求；不会因已有快照跳过本次查询确认，也不会取消合同或阻止扣款。', findings: ['SUBSCRIPTION_QUERY_CONFIRMATION_REQUIRED：实际查询结果来自管理服务回执。'], evidence };
  if (operations.length !== 1) return clarify('一次仅处理一家商户的一项操作：取消商户订阅合同，或仅在银行侧阻止扣款，请明确选择。', evidence);
  const operation = operations[0]!;
  if (operation.kind === 'AMBIGUOUS') return clarify('请明确选择取消商户订阅合同，或仅在银行侧阻止扣款，不能混为一个操作。', evidence);
  if (operation.kind === 'SUBSCRIPTION_CANCEL' && /扣款/.test(operation.text) && !/订阅|合同|退订/.test(operation.text)) return clarify('“取消扣款”含义不明确：是取消商户订阅合同，还是仅在银行侧阻止扣款？', evidence);
  const candidates = snapshot.items.filter(item => item.merchant && operation.text.includes(item.merchant));
  if (candidates.length !== 1) return clarify(candidates.length ? '同名商户存在多个订阅，当前无法唯一确定目标；请在订阅列表选择具体项目。' : '请明确已查询快照中的唯一商户名称；不会猜测或操作其他订阅。', evidence);
  const item = candidates[0]!;
  if (operation.kind === 'SUBSCRIPTION_CANCEL' && !item.cancellationSupported) return empty('该商户未提供可用的合同取消接口，不能自动改为银行扣款限制。如需仅阻止扣款，请明确提出。', evidence, ['SUBSCRIPTION_CANCELLATION_UNSUPPORTED']);
  if (operation.kind === 'SUBSCRIPTION_CANCEL' && item.merchantStatus === 'CANCELLED') return empty('商户合同已取消，无需重复操作；银行扣款状态仍按独立字段展示。', evidence);
  if (operation.kind === 'SUBSCRIPTION_BLOCK' && item.bankStatus === 'BLOCKED') return empty('该订阅已设置银行侧扣款限制；这不表示商户合同已取消。', evidence);
  const kind = operation.kind;
  return { managementSuggestions: [{ kind, subscriptionId: item.id, expectedVersion: item.version, queryActionId: snapshot.queryActionId }], summary: kind === 'SUBSCRIPTION_CANCEL' ? `已生成${item.merchant}商户订阅合同取消待确认提案，未执行；不能用它冒充银行扣款限制。` : `已生成${item.merchant}银行侧扣款限制待确认提案，未执行；这不会取消商户合同或免除合同义务。`, findings: [], evidence };
}
