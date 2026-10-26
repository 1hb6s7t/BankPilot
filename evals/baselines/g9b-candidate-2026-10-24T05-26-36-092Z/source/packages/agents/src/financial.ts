import type { GoalDraft, InvestmentDashboard, InvestmentPosition, Planner, RedemptionSpec } from '../../contracts/src/index';
import { goalDraftSchema } from '../../contracts/src/goals';
import { isGoalRequest, normalizeMoneyNumerals, parseAmountMinor } from './intent';
import { positionNameAlias, selectPositionReference } from './position-locator';

type Evidence = { source: string; detail: string };
export type InvestmentResolution = { investmentSuggestions: RedemptionSpec[]; summary: string; clarification?: string; findings: string[]; evidence: Evidence[] };
export type GoalResolution = { goalSuggestion?: GoalDraft; summary: string; clarification?: string; findings: string[]; evidence: Evidence[] };
const parts = (text: string) => text.split(/[，。；;\n]|并且|然后/).map(p => p.trim()).filter(Boolean);
const withdrawn = (text: string) => parts(text).some(part => /^(?:(?:这件事|这笔|这次|该笔|上述请求|我)\s*)?(?:(?:先|暂时|现在)?(?:不要|别|暂不|不用)(?:做|执行|办理|操作)?|暂缓|撤回|撤销|取消(?:这笔|这次|该笔)?(?:操作|请求)?|算了|不用了)(?:了|吧)?[！!。]?$/.test(part));
const negated = (text: string, operation: RegExp) => {
  const index = text.search(operation);
  return index >= 0 && (/不要|不用|不必|不需要|无需|不想|不打算|不再|暂不|先不|别|不是|没有/.test(text.slice(0, index)) || /不要|不用|不做|不执行|暂缓|先不|暂不|不再/.test(text.slice(index)));
};
const query = (text: string) => /查询|查看|查一下|看看|列出|有哪些|了解|介绍|如何|怎么|是否|状态|可赎回金额|[?？]/.test(text);
const amountError = (text: string) => {
  text = normalizeMoneyNumerals(text);
  if (/[零〇一二两三四五六七八九十百千万亿][0-9]|[0-9][零〇一二两三四五六七八九十百千亿]/.test(text)) return '金额数字格式不明确，请使用完整且一致的数字格式。';
  const number = '[0-9零〇一二两三四五六七八九十百千万亿点.,]+';
  if (new RegExp(`${number}\\s*(?:元|块)?\\s*(?:或(?:者)?|还是|、|和|与|or|/)\\s*${number}`, 'i').test(text)) return '金额存在多个选项，请明确唯一金额。';
  if ((text.match(/[0-9零〇一二两三四五六七八九十百千万亿点.,]+\s*(?:元|块|人民币|CNY|RMB)/gi) ?? []).length > 1) return '检测到多个金额，请分别明确目标金额与赎回金额。';
  return undefined;
};
function selectPosition(text: string, dashboard?: InvestmentDashboard): { position?: InvestmentPosition; clarification?: string } {
  if (!dashboard?.positions.length) return { clarification: '没有可用的服务端持仓事实，请先查看理财持仓。' };
  const all = dashboard.positions;
  const selected = selectPositionReference(text, all);
  if (selected.error === 'not_unique') return { clarification: '检测到多个理财产品或T+到账规则，请明确唯一持仓，不会选择第一个。' };
  // The pre-existing generic single-position request is separate from a named
  // or typed locator; an invalid explicit locator must never fall back here.
  const genericSingle = selected.error === 'unknown' && all.length === 1 && /^(?:请|帮我|赎回|理财|持仓|产品|金额|元|块|人民币|[\d\s.,万零〇一二两三四五六七八九十百千万亿点角分])+$/i.test(normalizeMoneyNumerals(text));
  const position = selected.position ?? (genericSingle ? all[0] : undefined);
  if (!position) return { clarification: '请从服务端持仓中指定唯一理财产品或持仓（例如 T+0）；不会猜测资金来源。' };
  const alias = positionNameAlias(position.productName);
  // An explicit unknown name must not disappear through settlement fallback or
  // through a known alias embedded inside a different product name.
  let remaining = text;
  for (const name of [position.productName, position.productId, position.id, alias].filter(Boolean).sort((a, b) => b.length - a.length)) remaining = remaining.replaceAll(name, '');
  remaining = normalizeMoneyNumerals(remaining).replace(/T\s*[+＋]\s*\d+(?:(?:合成)?(?:理财|持仓|产品))?/gi, '')
    .replace(/[0-9零〇一二两三四五六七八九十百千万亿点.,]+\s*(?:人民币|CNY|RMB|元|块|角|分)?/gi, '')
    .replace(/请你|麻烦你|帮我|为我|给我|我想|我要|我需要|资金|先从|请|麻烦|现在|立即|马上|先|从|把|将|中|里|的|赎回|redeem|理财|持仓|产品|金额|人民币|CNY|RMB|元|块|整|正|一下|谢谢|吧|啊|呀|\s|[：:！!（）()]/gi, '');
  if (remaining) return { clarification: '未找到明确匹配的理财产品名称，请核对持仓名称；不会默认选择其他产品。' };
  return { position };
}
export function resolveInvestment(message: string, dashboard?: InvestmentDashboard, partOfGoal = isGoalRequest(message)): InvestmentResolution {
  const evidence = (dashboard?.positions ?? []).map(p => ({ source: `investment-position:${p.id}:v${p.version}`, detail: `${p.productName};availableMinor=${p.availableMinor};reservedMinor=${p.reservedMinor};redemptionBusinessDays=${p.redemptionBusinessDays};calendar=${p.calendar}` }));
  const facts = dashboard?.positions.map(p => `${p.productName}：可赎回${p.availableMinor}分，到账规则T+${p.redemptionBusinessDays}（合成工作日历）`).join('；');
  const base: InvestmentResolution = { investmentSuggestions: [], summary: facts ? `理财持仓来自服务端事实：${facts}。未执行赎回，不预测收益。` : '当前缺少理财持仓事实，未生成赎回操作。', findings: [], evidence };
  if (withdrawn(message)) return base;
  if (partOfGoal) return { ...base, summary: `${base.summary}生日/生活目标的赎回属于后续DAG依赖，不另行创建立即赎回建议。` };
  const requests = parts(message).filter(p => /赎回|redeem/i.test(p) && !negated(p, /赎回|redeem/i) && !query(p));
  if (!requests.length) return base;
  if (requests.length !== 1) return { ...base, clarification: '一次仅提出一项赎回，请明确唯一持仓与金额。' };
  const text = requests[0]!, selected = selectPosition(text, dashboard);
  if (!selected.position) return { ...base, clarification: selected.clarification };
  const error = amountError(text), amountMinor = parseAmountMinor(text);
  if (error || !amountMinor) return { ...base, clarification: error ?? '请明确赎回金额并注明元。' };
  if (BigInt(amountMinor) > BigInt(selected.position.availableMinor)) return { ...base, findings: ['REDEMPTION_POSITION_INSUFFICIENT'], clarification: '赎回金额超过服务端可用持仓，请调整金额。' };
  const spec = { positionId: selected.position.id, amountMinor, expectedVersion: selected.position.version };
  return { ...base, investmentSuggestions: [spec], summary: `已提出${selected.position.productName}赎回${amountMinor}分的待强验证建议，未授权、未执行；预计到账不等于当前可用现金。` };
}

export function resolveLifeGoal(input: Parameters<Planner['plan']>[0]): GoalResolution {
  const base: GoalResolution = { summary: '生活目标需要明确已保存收款人、目标金额、YYYY-MM-DD截止日期和资金来源；未创建立即转账。', findings: [], evidence: [] };
  const text = input.message;
  if (!isGoalRequest(text)) return base;
  if (withdrawn(text)) return { ...base, clarification: '目标请求已撤回，未生成目标。' };
  if (query(text)) return { ...base, clarification: '当前是目标咨询或查询，未建立生日计划；如需创建，请明确提出目标金额、日期和收款人。' };
  if (negated(text, /生日|生活目标|储蓄目标|存钱目标|旅行目标|目标|计划/)) return { ...base, clarification: '目标请求已否定或暂缓，未生成目标；请明确是否需要建立计划。' };
  const dates = [...text.matchAll(/\d{4}-\d{2}-\d{2}/g)].map(m => m[0]);
  if (dates.length !== 1 || /明天|后天|下周|下月|下个月|或者|还是/.test(text)) return { ...base, clarification: '请明确唯一目标截止日期（YYYY-MM-DD）；不会猜测生日日期或多个备选日期。' };
  const targetDate = dates[0]!;
  if (!Number.isFinite(Date.parse(`${targetDate}T00:00:00Z`)) || targetDate.startsWith('0000') || new Date(`${targetDate}T00:00:00Z`).toISOString().slice(0, 10) !== targetDate) return { ...base, clarification: '目标日期不存在，请提供真实的 YYYY-MM-DD。' };
  let payees = input.payees.filter(p => [p.name, ...p.aliases].some(n => n && text.includes(n)));
  if (payees.length > 1) {
    const bank = payees.filter(p => text.includes(p.bank)); if (bank.length) payees = bank;
    const suffix = text.match(/(?:尾号|末四位)\s*(\d{4})/); if (suffix) payees = payees.filter(p => p.maskedNumber.replace(/\D/g, '').endsWith(suffix[1]!));
  }
  if (payees.length !== 1) return { ...base, clarification: payees.length ? '存在同名收款人，请明确银行或尾号以选择唯一已保存收款人。' : '请选择一位已保存收款人，不会创建陌生目标收款人。' };
  if (input.accounts.length !== 1) return { ...base, clarification: '请明确唯一付款账户；不会猜测目标资金账户。' };
  const sourceParts = parts(text).filter(p => /赎回|redeem/i.test(p));
  const targetParts = parts(text).filter(p => !/赎回|redeem/i.test(p));
  const amountText = targetParts.join(' '), error = amountError(amountText), amountMinor = parseAmountMinor(amountText);
  if (error || !amountMinor) return { ...base, clarification: error ?? '请单独明确目标转账金额并注明元，不会把赎回金额当作目标金额。' };
  let funding: GoalDraft['funding'];
  if (sourceParts.length) {
    if (sourceParts.length !== 1 || negated(sourceParts[0]!, /赎回|redeem/i) || query(sourceParts[0]!)) return { ...base, clarification: '请明确一项实际需要的赎回资金来源；未建立含歧义或否定赎回的计划。' };
    const source = sourceParts[0]!, selected = selectPosition(source, input.investmentContext);
    if (!selected.position || selected.position.accountId !== input.accounts[0]!.id) return { ...base, clarification: selected.clarification ?? '赎回到账账户与目标付款账户不一致，请调整资金来源。' };
    const sourceError = amountError(source), redemptionAmountMinor = parseAmountMinor(source);
    if (sourceError || !redemptionAmountMinor) return { ...base, clarification: sourceError ?? '请在赎回分句单独注明金额，不会自动补造赎回金额。' };
    if (BigInt(redemptionAmountMinor) > BigInt(selected.position.availableMinor)) return { ...base, clarification: '目标赎回金额超过服务端可用持仓，请调整资金来源。' };
    funding = { positionId: selected.position.id, redemptionAmountMinor };
  } else if (/理财|基金|持仓|到账资金/.test(text)) return { ...base, clarification: '目标提及理财资金，但未明确一项赎回及金额，请补充资金来源。' };
  const groundedGoal = input.semanticIntent?.status === 'ready' ? input.semanticIntent.tasks.find(task => task.operation === 'goal_create'
    && task.slots.entityId === payees[0]!.id && task.slots.amountMinor === amountMinor && task.slots.targetDate === targetDate) : undefined;
  // Purpose is a source-validated goal label, independent of a transfer memo.
  // Keep it out of operation parsing and never derive money or permission from it.
  const purpose = groundedGoal?.slots.purpose;
  const title = purpose && goalDraftSchema.shape.title.safeParse(purpose).success ? purpose : `${payees[0]!.name}${text.includes('生日') ? '生日' : '生活'}目标`;
  const suggestion: GoalDraft = { title, accountId: input.accounts[0]!.id, payeeId: payees[0]!.id, amountMinor, targetDate, ...(funding ? { funding } : {}) };
  return { goalSuggestion: suggestion, summary: `已提出${suggestion.title}：${targetDate}前向已保存收款人准备${amountMinor}分。${funding ? '依赖顺序为赎回、确认实际到账、再准备转账；每笔资金动作独立授权。' : '转账准备前须通过最新资金保护检查，并独立确认或强验证。'}截止日期不是自动预约付款许可；目前未执行任何动作。`, findings: [], evidence: [{ source: 'goal-input', detail: JSON.stringify(suggestion) }, { source: 'saved-payees', detail: '目标收款人来自服务端已保存名单；未执行资金操作。' }] };
}
