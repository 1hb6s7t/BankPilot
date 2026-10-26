import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import type { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { z } from 'zod';
import { goalDraftSchema, managementSpecSchema, redemptionSpecSchema, type AgentEvent, type BillReport, type DomainRole, type FundsPreview, type GoalDraft, type ManagementSpec, type ModelRun, type PlanResult, type Planner, type PlannerInput, type PlannerExecutionContext, type SemanticTask, type RedemptionSpec } from '../../contracts/src/index';
import { activeRoles, isGoalRequest, resolveTransfer, subscriptionRequestClauses } from './intent';
import { resolveCard, resolveSubscription, type ManagementResolution } from './management';
import { resolveSubscriptionBatch } from './management-batch';
import { resolveInvestment, resolveInvestmentQuery, resolveLifeGoal, type InvestmentResolution, type GoalResolution } from './financial';
import { invokeStructured, ModelAttemptPersistenceError, ModelProviderError, normalizeMaxAttempts, providerFromEnv, type OpenAICompatibleConfig } from './provider';
import { interpretSemanticIntent } from './semantic-intent';
import { createStageOutputPlan, SEMANTIC_OUTPUT_TOKEN_LIMIT } from './budget';
import { analyzeBills } from './bills';
import { billReviewAssessmentSchema, buildBillReviewFacts, validateBillReviewAssessment, renderBillReviewAssessment, type BillReviewFacts } from './bill-review-facts';
import { createStageRecovery, stageDependencyDigest } from './stage-recovery';
import { stageError } from './planning-failures';
export { interpretSemanticIntent, validateSemanticIntent } from './semantic-intent';

export { activeRoles, isGoalRequest, parseAmountMinor, resolveTransfer } from './intent';
export { resolveCard, resolveSubscription } from './management';
export { resolveInvestment, resolveInvestmentQuery, resolveLifeGoal } from './financial';
export { providerFromEnv, normalizeBaseURL, invokeStructured, ModelProviderError, type OpenAICompatibleConfig } from './provider';
export { runPersistenceProbe, resumePersistenceProbe, createPersistenceProbe, type PersistenceProbeOptions } from './recovery';
const roles = ['transfer', 'bills', 'investment', 'card', 'subscription', 'goal'] as const;
export const proposalSchema = z.object({
  role: z.enum(roles), planVersion: z.number().int().positive(), summary: z.string().max(1000),
  suggestion: z.object({ payeeId: z.string(), amountMinor: z.string().regex(/^[1-9]\d{0,11}$/), memo: z.string().max(120) }).strict().optional().describe('For transfer: when data.resolved.suggestion exists, include this structured field with the exact payeeId and integer amountMinor. Describing a transfer only in summary is invalid. Omit for a genuine unresolved ambiguity and non-transfer roles.'),
  managementSuggestions: z.array(managementSpecSchema).max(8).optional().describe('For card/subscription only: repeat exactly the deterministic resolved managementSuggestions. Never invent a target, kind, version, or queryActionId. These are pending requests, not authorized execution.'),
  investmentSuggestions: z.array(redemptionSpecSchema).max(1).optional().describe('For investment only: repeat the exact deterministic redemption request. Never authorized or executed; do not return separate redemptions for a life-goal DAG.'),
  goalSuggestion: goalDraftSchema.optional().describe('For an explicit life goal only: repeat exactly the server-resolved future goal. Never combine with immediate transfer or redemption suggestions.'),
  clarification: z.string().max(1000).optional().describe('Only an unresolved question requiring missing information from the user. Omit when the request is complete, negated, or read-only. Authorization reminders and limitations belong in summary/findings, never in clarification.'), findings: z.array(z.string().max(1000)),
  evidence: z.array(z.object({ source: z.string().max(200), detail: z.string().max(1000) }).strict()),
}).strict();
export type DomainProposal = z.infer<typeof proposalSchema>;
export type LocalContext = { role: DomainRole; taskId: string; planVersion: number; instruction: string; data: Record<string, unknown> };
function exactManagementSpecSchema(spec: ManagementSpec) {
  if ('cardId' in spec) return z.object({ kind: z.literal(spec.kind), cardId: z.literal(spec.cardId), expectedVersion: z.literal(spec.expectedVersion) }).strict();
  if ('subscriptionId' in spec) return z.object({ kind: z.literal(spec.kind), subscriptionId: z.literal(spec.subscriptionId), expectedVersion: z.literal(spec.expectedVersion), queryActionId: z.literal(spec.queryActionId) }).strict();
  if (spec.kind === 'CONTACT_ALIAS_SAVE') return z.object({ kind: z.literal(spec.kind), payeeId: z.literal(spec.payeeId), alias: z.literal(spec.alias) }).strict();
  return z.object({ kind: z.literal(spec.kind) }).strict();
}
function schemaForLocalContext(context: LocalContext): z.ZodType<DomainProposal> {
  const scoped = proposalSchema.extend({ role: z.literal(context.role), planVersion: z.literal(context.planVersion) });
  if (context.role === 'investment') {
    const resolved = context.data.investment as InvestmentResolution, spec = resolved.investmentSuggestions[0];
    const investment = scoped.omit({ suggestion: true, managementSuggestions: true, goalSuggestion: true, clarification: true }).extend({ investmentSuggestions: spec ? z.tuple([z.object({ positionId: z.literal(spec.positionId), amountMinor: z.literal(spec.amountMinor), expectedVersion: z.literal(spec.expectedVersion) }).strict()]) : z.tuple([]) });
    return resolved.clarification ? investment.extend({ clarification: z.string().min(1).max(1000) }) : investment;
  }
  if (context.role === 'goal' && context.data.lifeGoal) {
    const resolved = context.data.lifeGoal as GoalResolution, draft = resolved.goalSuggestion;
    const goal = scoped.omit({ suggestion: true, managementSuggestions: true, investmentSuggestions: true, goalSuggestion: true, clarification: true });
    if (!draft) return goal.extend({ clarification: z.string().min(1).max(1000) });
    const exact = z.object({ title: z.literal(draft.title), accountId: z.literal(draft.accountId), payeeId: z.literal(draft.payeeId), amountMinor: z.literal(draft.amountMinor), targetDate: z.literal(draft.targetDate) }).strict();
    const exactDraft = draft.funding ? exact.extend({ funding: z.object({ positionId: z.literal(draft.funding.positionId), redemptionAmountMinor: z.literal(draft.funding.redemptionAmountMinor) }).strict() }) : exact;
    return goal.extend({ goalSuggestion: exactDraft });
  }
  if (context.role === 'card' || context.role === 'subscription') {
    const resolved = context.data.management as ManagementResolution;
    const expected = resolved.managementSuggestions;
    const managed = scoped.omit({ suggestion: true }).extend({
      managementSuggestions: expected.length ? z.tuple(expected.map(exactManagementSpecSchema) as [ReturnType<typeof exactManagementSpecSchema>, ...ReturnType<typeof exactManagementSpecSchema>[]]).describe('REQUIRED: preserve every exact deterministic management request, in order. Each request needs separate confirmation; do not execute or omit any member.') : z.tuple([]).describe('REQUIRED empty array: read-only card facts, negation or unresolved target does not create a management operation.'),
    });
    return resolved.clarification ? managed.extend({ clarification: z.string().min(1).max(1000) }) : managed;
  }
  if (context.role === 'bills') {
    const bill = scoped.omit({ suggestion: true, managementSuggestions: true, investmentSuggestions: true, goalSuggestion: true, clarification: true });
    return scriptDomain(context).clarification ? bill.extend({ clarification: z.string().min(1).max(1000) }) : bill;
  }
  if (context.role !== 'transfer') return scoped;
  const resolved = context.data.resolved as ReturnType<typeof resolveTransfer>;
  if (resolved.noActionReason) return scoped.omit({ suggestion: true, clarification: true }).describe('NO_ACTION: a negation, retracted request, inquiry or quotation. Explain data.resolved.noActionReason; suggestion and clarification are forbidden. Do not ask the user to authorize a payment they did not request.');
  if (resolved.suggestion) return scoped.extend({
    suggestion: proposalSchema.shape.suggestion.unwrap().extend({
      payeeId: z.literal(resolved.suggestion.payeeId), amountMinor: z.literal(resolved.suggestion.amountMinor),
      memo: context.data.semanticRequest ? z.literal(resolved.suggestion.memo) : proposalSchema.shape.suggestion.unwrap().shape.memo,
    }).describe('REQUIRED structured transfer proposal. Preserve the server-resolved payeeId and integer amountMinor. A summary-only response is invalid. This creates no authorization.'),
  });
  if (resolved.clarification) return scoped.omit({ suggestion: true }).extend({
    clarification: z.string().min(1).max(1000).describe('REQUIRED: explain the deterministic unresolved ambiguity in data.resolved.clarification. Do not invent a payee or amount; suggestion is forbidden.'),
  });
  return scoped;
}
export type ReviewContext = { role: 'reviewer'; instruction: string; taskId: string; planVersion: number; originalRequest?: string; groundedIntent?: SemanticTask[]; proposals: DomainProposal[]; rejected: string[]; deterministic?: { funds?: Pick<FundsPreview, 'allowed' | 'amountMinor' | 'shortfallMinor' | 'policyVersion'>; bills?: BillReviewFacts } };
export const reviewSchema = z.object({
  approved: z.boolean().describe('Proposal-completeness decision only: true means the evidence-consistent proposal may become a PENDING draft, then require human confirmation and Core authorization. It NEVER grants financial authority. Pending confirmation, RED risk, or a need for strong verification alone is NOT a reason to reject. Return false for actual missing/contradictory evidence, unresolved ambiguity, rejected proposals, or a deterministic funds refusal.'),
  findings: z.array(z.string().max(1000)),
  summary: z.string().max(1000).describe('Explain proposal completeness and any evidence-based refusal; distinguish it from future human confirmation and Core authorization.'),
}).strict();
export type ReviewResult = z.infer<typeof reviewSchema>;
const billAnswerWithheldMessage = '账单结论尚未通过核对，未作为本次查询答案。请核对查询月份、商户或筛选条件后重试。';
const reviewConcernCodes = ['proposal_incomplete', 'unresolved_ambiguity', 'evidence_mismatch', 'funds_refused', 'additional_review_required'] as const;
const reviewConcernText: Record<typeof reviewConcernCodes[number], string> = {
  proposal_incomplete: '复核要求检查提案完整性', unresolved_ambiguity: '复核要求澄清尚未解决的歧义', evidence_mismatch: '复核要求核对提案与原始证据', funds_refused: '复核要求检查资金保护约束', additional_review_required: '独立复核要求进一步核对',
};
function schemaForBillReview(facts: BillReviewFacts, active: readonly DomainRole[]) {
  return z.object({
    approved: reviewSchema.shape.approved,
    billQueryAligned: z.boolean().describe('Independently compare the original bill question with analysis: same requested period, merchant/category, operation and scope. True for an accurate answer or an honest missing/unsupported diagnostic; false if a merchant query became a whole-month summary or any requested constraint disappeared. This does not grant financial authority.'),
    bill: billReviewAssessmentSchema.superRefine((value, context) => {
      for (const code of validateBillReviewAssessment(facts, value)) context.addIssue({ code: 'custom', message: code });
    }),
    concerns: z.array(z.object({ role: z.enum(['all', ...active]), code: z.enum(reviewConcernCodes) }).strict()).max(8),
  }).strict();
}
type DomainDiagnostic = NonNullable<PlanResult['diagnostics']>['domains'][number];
type ReviewDiagnostic = NonNullable<NonNullable<PlanResult['diagnostics']>['review']>;
export type PlannerOptions = {
  planVersion?: number; provider?: OpenAICompatibleConfig | false;
  domainAdapter?: (context: LocalContext) => Promise<unknown>;
  reviewerAdapter?: (context: ReviewContext) => Promise<unknown>; branchDelayMs?: number;
  semantic?: boolean; intentAdapter?: (task: unknown) => Promise<unknown>;
  /** Server-only durable saver. A server execution context is mandatory when supplied. */
  checkpointer?: PostgresSaver;
};
const State = Annotation.Root({
  active: Annotation<DomainRole[]>(),
  proposals: Annotation<DomainProposal[]>({ reducer: (a, b) => [...a, ...b], default: () => [] }),
  events: Annotation<AgentEvent[]>({ reducer: (a, b) => [...a, ...b], default: () => [] }),
  rejected: Annotation<string[]>({ reducer: (a, b) => [...a, ...b], default: () => [] }),
  modelRuns: Annotation<ModelRun[]>({ reducer: (a, b) => [...a, ...b], default: () => [] }),
  domainDiagnostics: Annotation<DomainDiagnostic[]>({ reducer: (a, b) => [...a, ...b], default: () => [] }),
  reviewDiagnostic: Annotation<ReviewDiagnostic | undefined>(),
  review: Annotation<ReviewResult | undefined>(),
  billReviewBinding: Annotation<string | undefined>(),
  billAnswerApproved: Annotation<boolean | undefined>(),
});
const nodeUpdateSchema = z.object({
  proposals: z.array(proposalSchema).optional(), rejected: z.array(z.string()).optional(),
  events: z.array(z.object({ role: z.string(), status: z.enum(['started','completed']), at: z.string(), summary: z.string() }).strict()).optional(),
  modelRuns: z.array(z.custom<ModelRun>((value: any) => !!value && typeof value === 'object' && typeof value.role === 'string' && typeof value.model === 'string' && ['success','failed'].includes(value.status))).optional(),
  domainDiagnostics: z.array(z.object({ role: z.enum(roles), hasSuggestion: z.boolean(), hasClarification: z.boolean(), status: z.enum(['accepted','rejected','failed']) }).strict()).optional(),
  billReviewBinding: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  billAnswerApproved: z.boolean().optional(),
  review: reviewSchema.optional(), reviewDiagnostic: z.object({ rawApproved: z.boolean().nullable(), summary: z.string(), effectiveApproved: z.boolean() }).strict().optional(),
}).strict();
type NodeUpdate = z.infer<typeof nodeUpdateSchema>;
const validatedNodeUpdate = (value: unknown): NodeUpdate => nodeUpdateSchema.parse(value);
function event(role: string, status: AgentEvent['status'], summary: string): AgentEvent { return { role, status, at: new Date().toISOString(), summary }; }
const yuan = (minor: string) => { const value = BigInt(minor); return `${value < 0n ? '-' : ''}${(value < 0n ? -value : value) / 100n}.${((value < 0n ? -value : value) % 100n).toString().padStart(2, '0')}`; };
function scriptDomain(context: LocalContext): DomainProposal {
  const base = { role: context.role, planVersion: context.planVersion, findings: [] as string[], evidence: [] as { source: string; detail: string }[] };
  if (context.role === 'investment') return { ...base, ...(context.data.investment as InvestmentResolution) };
  if (context.role === 'goal' && context.data.lifeGoal) return { ...base, ...(context.data.lifeGoal as GoalResolution) };
  if (context.role === 'card' || context.role === 'subscription') return { ...base, ...(context.data.management as ManagementResolution) };
  if (context.role === 'transfer') {
    const resolved = context.data.resolved as ReturnType<typeof resolveTransfer>;
    const { noActionReason, ...proposal } = resolved;
    return { ...base, summary: noActionReason ?? (resolved.suggestion ? '已识别一笔待确认的合成沙箱转账提案。' : '转账信息需要澄清。'), ...proposal, evidence: noActionReason ? [{ source: 'transfer-intent', detail: noActionReason }] : [{ source: 'saved-payees', detail: '收款人仅从服务端保存的合成名单中匹配；未执行转账。' }] };
  }
  if (context.role === 'bills') {
    const analysis = context.data.analysis as ReturnType<typeof analyzeBills>;
    return { ...base, summary: analysis.summary, findings: analysis.findings, evidence: analysis.evidence, ...(analysis.clarification ? { clarification: analysis.clarification } : {}) };
  }
  if (context.role === 'goal') {
    const funds = context.data.funds as FundsPreview | undefined;
    if (!funds) return { ...base, summary: '缺少服务端资金预演，无法判断是否影响房租、生活费或预算。', findings: ['FUNDS_PREVIEW_MISSING：需要确定性资金预演；不由模型估算可用资金。'], evidence: [{ source: 'data-availability', detail: '未提供FundsPreview。' }] };
    return { ...base, summary: `资金预演：当前可用${yuan(funds.availableBeforeMinor)}元，需保护${yuan(funds.protectedMinor)}元，扣除保护金额后可安排${yuan(funds.spendableMinor)}元。${funds.amountMinor === '0' ? '本次仅查询可安排额度，未安排支出' : `拟支出${yuan(funds.amountMinor)}元，支出后账户可用${yuan(funds.availableAfterMinor)}元`}；${funds.allowed ? '本次符合当前资金保护策略' : `不符合保护策略，缺口${yuan(funds.shortfallMinor)}元`}。这不是执行授权。`, findings: funds.reasons, evidence: [{ source: `funds-preview:policy-${funds.policyVersion}`, detail: `amountMinor=${funds.amountMinor};availableBeforeMinor=${funds.availableBeforeMinor};spendableMinor=${funds.spendableMinor};allowed=${funds.allowed};protectedMinor=${funds.protectedMinor};shortfallMinor=${funds.shortfallMinor};horizonEnd=${funds.horizonEnd}` }, ...funds.obligations.map(o => ({ source: `fund-obligation:${o.id}`, detail: `${o.title};${o.amountMinor};${o.dueDate}` }))] };
  }
  return { ...base, summary: `${context.role} 场景尚未实现业务分析。`, findings: [`${context.role} 仅识别意图，本阶段无该领域的产品或执行工具。`], evidence: [{ source: 'phase1-scope', detail: '没有该领域的产品或执行工具。' }] };
}
function inputForRole(input: PlannerInput, role: DomainRole): PlannerInput {
  const task = input.semanticIntent?.tasks.find(task => task.role === role);
  if (!task) {
    const funding = role === 'investment' ? input.semanticIntent?.tasks.find(t => t.operation === 'goal_create')?.slots.funding : undefined;
    return funding ? { ...input, message: `查询理财持仓 ${funding.positionId}` } : input;
  }
  const id = task.slots.entityId;
  return { ...input, message: task.canonicalMessage,
    ...((role === 'transfer' || task.operation === 'goal_create') && id ? { payees: input.payees.filter(p => p.id === id) } : {}),
  };
}
function resolvedTransfer(input: PlannerInput) {
  const scoped = inputForRole(input, 'transfer');
  const resolved = resolveTransfer(scoped.message, scoped.payees);
  const memo = input.semanticIntent?.tasks.find(t => t.operation === 'transfer')?.slots.memo;
  return resolved.suggestion && memo !== undefined ? { ...resolved, suggestion: { ...resolved.suggestion, memo } } : resolved;
}
const lifeGoalRequested = (input: PlannerInput) => input.semanticIntent ? input.semanticIntent.tasks.some(t => t.operation === 'goal_create') : isGoalRequest(input.message);
function localContext(originalInput: PlannerInput, role: DomainRole, planVersion: number): LocalContext {
  const input = inputForRole(originalInput, role);
  const subscriptionTasks = originalInput.semanticIntent?.tasks.filter(task => task.role === 'subscription') ?? [];
  const investmentQueryTask = originalInput.semanticIntent?.tasks.find(task=>task.operation==='investment_query');
  const goalFunding = originalInput.semanticIntent?.tasks.find(task=>task.operation==='goal_create')?.slots.funding;
  if (role === 'investment') {
    const queryFacts = investmentQueryTask ? resolveInvestmentQuery(input.investmentContext, investmentQueryTask.slots.entityId) : undefined;
    const fundingFacts = goalFunding ? resolveInvestmentQuery(input.investmentContext, goalFunding.positionId) : undefined;
    // One domain invocation may serve an explicit query and a distinct goal
    // dependency. Preserve both labeled scopes, never let one shadow the other.
    const investment: InvestmentResolution = queryFacts && fundingFacts && investmentQueryTask!.slots.entityId !== goalFunding!.positionId ? {
      investmentSuggestions: [], summary: `持仓查询：${queryFacts.summary}目标筹资来源核对：${fundingFacts.summary}`,
      findings: [...queryFacts.findings,...fundingFacts.findings],
      evidence: [...new Map([...queryFacts.evidence,...fundingFacts.evidence].map(item=>[item.source,item])).values()],
      ...(queryFacts.clarification || fundingFacts.clarification ? { clarification: [queryFacts.clarification,fundingFacts.clarification].filter(Boolean).join('；') } : {}),
    } : queryFacts ?? fundingFacts ?? resolveInvestment(input.message, input.investmentContext);
    return { role, taskId: input.taskId, planVersion, instruction: '仅解释服务端理财持仓与确定性赎回提案。必须完整返回data.investment.investmentSuggestions，保留positionId/amountMinor/expectedVersion；空数组必须保留。收益不可预测，预计到账不是当前现金。生日目标的赎回属于DAG依赖，不独立准备动作。不返回transfer suggestion或goalSuggestion，不执行、不授权。只有data.investment.clarification存在时才返回clarification并表达该缺失信息；否则必须省略clarification。授权提醒、未执行声明和DAG分工仅写summary/findings，不能冒充待用户回答的问题。', data: { investment: investment } };
  }
  if (role === 'goal' && lifeGoalRequested(input)) return { role, taskId: input.taskId, planVersion, instruction: '验证并解释明确的生日/生活目标。data.lifeGoal.goalSuggestion存在时必须完整原样返回该结构，所有字段均为服务端解析，不更改日期/金额/收款人/账户/资金来源。不另行返回立即转账suggestion或investmentSuggestions。仅data.lifeGoal.clarification存在时必须返回clarification；完整goalSuggestion存在时省略clarification，授权提醒写summary/findings。DAG按赎回→确认实际到账→转账；每笔独立授权，日期是截止而非预约自动付款许可。', data: { lifeGoal: resolveLifeGoal(input) } };
  if (role === 'card') return { role, taskId: input.taskId, planVersion, instruction: '仅验证/解释服务端卡片事实和确定性management请求。必须返回managementSuggestions，完整原样复制data.management.managementSuggestions（查询/否定/歧义为[]）。不得更改kind/cardId/expectedVersion，不返回transfer suggestion，不执行挂失/解挂。', data: { management: resolveCard(input.message, input.managementContext), cards: (input.managementContext?.cards ?? []).map(({ accountId: _account, ...card }) => card) } };
  if (role === 'subscription') return { role, taskId: input.taskId, planVersion, instruction: '仅验证/解释确定性订阅管理请求。必须返回managementSuggestions并逐项完整原样复制data.management.managementSuggestions；不改kind/subscriptionId/expectedVersion/queryActionId。SUBSCRIPTION_QUERY本身必须黄色确认；不能跳过查询直接取消/阻止。商户合同取消与银行侧扣款限制是不同操作；不返回transfer suggestion，不执行业务。', data: { management: subscriptionTasks.length > 1 ? resolveSubscriptionBatch(subscriptionTasks, input.managementContext) : resolveSubscription(input.message, input.managementContext) } };
  if (role === 'transfer') return { role, taskId: input.taskId, planVersion, instruction: '返回role、planVersion、summary、findings、evidence。data.resolved.noActionReason存在时为NO_ACTION，只解释原因，禁止suggestion和clarification，不得向用户索取这笔未请求付款的授权。data.resolved.suggestion存在时必须返回结构化suggestion并原样保留其payeeId和整数分amountMinor，不能只在summary里叙述金额和收款人。真实歧义时仅返回clarification。此提案只用于创建待确认草稿；金额需强验证、红档或尚未得到授权不应单独使提案消失。不得自行授权或执行。', data: { resolved: resolvedTransfer(input), allowedPayeeIds: input.payees.map(p => p.id) } };
  if (role === 'bills') return { role, taskId: input.taskId, planVersion, instruction: '解释data.analysis提供的确定性账单答案和原流水证据。保留查询范围、筛选口径、最大值并列、完整性和缺失月份；不得重算、编造或把缺数据当零。analysis.clarification存在时才返回clarification；不返回任何动作suggestion。', data: { currency: 'CNY', analysis: analyzeBills({ request: originalInput.semanticIntent?.tasks.find(task => task.role === 'bills'), report: originalInput.billReport, reports: originalInput.billReports }) } };
  if (role === 'goal') return { role, taskId: input.taskId, planVersion, instruction: '解释服务端资金预演对房租、生活费与最低余额的影响。数值和allowed不可重算或覆盖；不返回suggestion。', data: { ...(input.fundsPreview ? { funds: { ...input.fundsPreview, accountId: undefined } } : {}) } };
  return { role, taskId: input.taskId, planVersion, instruction: '说明该场景尚未实现，不生成执行动作。', data: { implemented: false } };
}
export type EvaluationOrchestrationMode = 'single' | 'parallel' | 'parallel-review';

/** The actual planned roles, shared with evaluation budgets; never read fixture expectations. */
export function evaluationRoles(input: Parameters<Planner['plan']>[0]): DomainRole[] {
  if (input.semanticIntent) {
    const active = [...new Set(input.semanticIntent.tasks.map(t => t.role))];
    if (input.semanticIntent.tasks.some(t => t.operation === 'goal_create' && t.slots.funding) && !active.includes('investment')) active.push('investment');
    return active;
  }
  const active = activeRoles(input.message);
  if (!active.includes('subscription') && subscriptionRequestClauses(input.message).some(clause => /取消|退订|终止|阻止|限制|屏蔽|拦截|cancel|block/i.test(clause) && input.managementContext?.subscriptions?.items.some(item => clause.includes(item.merchant)))) active.push('subscription');
  return active;
}

/** Production always retains the independent reviewer. Ablation is an explicit evaluation factory. */
export function createPlanner(options: PlannerOptions = {}): Planner {
  return createPlannerWithMode('parallel-review', { ...options, semantic: options.semantic ?? true });
}

export function createEvaluationPlanner(mode: EvaluationOrchestrationMode, options: PlannerOptions = {}): Planner {
  if (!['single', 'parallel', 'parallel-review'].includes(mode)) throw new Error('Unknown evaluation orchestration mode');
  // The existing adapter represents one domain invocation, not a joint model call.
  // Silently invoking it N times would mislabel the single-model experiment.
  if (mode === 'single' && options.domainAdapter) throw new Error('single evaluation requires one structured provider call or explicit provider:false; domainAdapter is a per-domain adapter');
  return createPlannerWithMode(mode, options);
}

function requestProvider(provider: OpenAICompatibleConfig | undefined, input: PlannerInput) {
  if (!provider || !input.deadlineAt) return provider;
  const deadline = AbortSignal.timeout(Math.max(0, Math.min(180_000, input.deadlineAt - Date.now())));
  return { ...provider, maxOutputTokens: provider.maxOutputTokens ?? 2048, signal: provider.signal ? AbortSignal.any([provider.signal, deadline]) : deadline };
}
function stageProvider(provider: OpenAICompatibleConfig | undefined, maxOutputTokens: number) {
  return provider ? { ...provider, maxOutputTokens: Math.min(provider.maxOutputTokens ?? maxOutputTokens, maxOutputTokens) } : undefined;
}
function observedProvider(provider: OpenAICompatibleConfig | undefined, context?: PlannerExecutionContext): OpenAICompatibleConfig | undefined {
  if (!provider || !context?.modelAttemptObserver) return provider;
  const durable = context.modelAttemptObserver, existing = provider.attemptObserver;
  return { ...provider, attemptObserver: async (event, observerContext) => {
    await durable(event, observerContext);
    if (existing) await existing(event, observerContext);
  } };
}
function createPlannerWithMode(orchestration: EvaluationOrchestrationMode, options: PlannerOptions): Planner {
  const configuredProvider = options.provider === false ? undefined : options.provider ?? providerFromEnv();
  const provider = configuredProvider;
  const planVersion = options.planVersion ?? 1;
  if (!Number.isSafeInteger(planVersion) || planVersion < 1) throw new Error('planVersion 必须为正整数');
  const interpret = options.semantic && (provider || options.intentAdapter) ? async (input: PlannerInput, executionContext?: PlannerExecutionContext) => interpretSemanticIntent(input, {
    provider: requestProvider(stageProvider(observedProvider(configuredProvider, executionContext), SEMANTIC_OUTPUT_TOKEN_LIMIT), { ...input, deadlineAt: input.deadlineAt ?? Date.now() + 180_000 }) ?? { baseURL: 'http://unused.invalid', model: 'scripted-semantic-adapter' },
    referenceDate: input.referenceDate, adapter: options.intentAdapter,
  }) : undefined;
  return { ...(interpret ? { interpret } : {}), async plan(receivedInput, executionContext) {
    const originalInput = interpret && configuredProvider ? { ...receivedInput, deadlineAt: receivedInput.deadlineAt ?? Date.now() + 180_000 } : receivedInput;
    let provider = requestProvider(observedProvider(configuredProvider, executionContext), originalInput);
    const semanticIntent = originalInput.semanticIntent ?? (interpret ? await interpret(originalInput, executionContext) : undefined);
    const input = { ...originalInput, ...(semanticIntent ? { semanticIntent } : {}) };
    const semanticEvents: AgentEvent[] = semanticIntent ? [event('semantic-intent', 'completed', semanticIntent.status === 'ready' ? '原文意图及槽位证据校验完成；未授权执行。' : semanticIntent.status === 'no_action' ? '当前没有需要办理的操作。' : semanticIntent.status === 'failed' ? '识别服务未完成请求。' : '意图或槽位需要澄清。')] : [];
    const intentDiagnostic = semanticIntent ? { intent: { status: semanticIntent.status, roles: semanticIntent.status === 'ready' ? evaluationRoles(input) : semanticIntent.status === 'no_action' ? [] : semanticIntent.recognizedRoles ?? [], findings: semanticIntent.findings, ...(semanticIntent.issues?.length ? { issues: semanticIntent.issues } : {}) } } : {};
    if (semanticIntent && semanticIntent.status !== 'ready') return {
      taskId: input.taskId, planVersion, mode: provider ? 'model' as const : 'scripted' as const,
      ...(semanticIntent.failure ? { failure: semanticIntent.failure } : {}),
      summary: semanticIntent.failure?.message ?? semanticIntent.clarification ?? '当前内容为引用、历史、否定或未请求办理的事项；未创建操作。',
      events: semanticEvents, suggestions: [], managementSuggestions: [], investmentSuggestions: [],
      ...(semanticIntent.clarification ? { clarification: semanticIntent.clarification } : {}),
      evidence: [], findings: semanticIntent.findings, modelRuns: semanticIntent.modelRuns, diagnostics: { domains: [], ...intentDiagnostic }, ...(input.billReport ? { billReport: input.billReport } : {}), ...(input.fundsPreview ? { fundsPreview: input.fundsPreview } : {}),
    };
    const active = evaluationRoles(input);
    const recovery = createStageRecovery(executionContext?.stageJournal);
    const completedStages = await recovery.completed();
    if (provider && semanticIntent) {
      const budget = createStageOutputPlan({ domainStageCount: options.domainAdapter ? 0 : orchestration === 'single' ? Number(active.length > 0 && !completedStages.includes('single')) : active.filter(role => !completedStages.includes(`domain:${role}`)).length,
        reviewerStageCount: orchestration === 'parallel-review' && active.length && !options.reviewerAdapter && !completedStages.includes('reviewer') ? 1 : 0, maxAttempts: normalizeMaxAttempts(provider.maxAttempts), priorReservedOutputTokens: executionContext?.priorReservedOutputTokens });
      // Count actual model stages, reserve every permitted retry, and never refund from reported usage.
      if (budget.downstreamMaxOutputTokens) provider = requestProvider(stageProvider(observedProvider(configuredProvider, executionContext), budget.downstreamMaxOutputTokens), originalInput);
    }
    const attachments = { ...(input.billReport ? { billReport: input.billReport } : {}), ...(input.billReports ? { billReports: input.billReports } : {}), ...(active.includes('bills') ? { billAnalysis: analyzeBills({ request: semanticIntent?.tasks.find(task => task.role === 'bills'), report: input.billReport, reports: input.billReports }) } : {}), ...(input.fundsPreview ? { fundsPreview: input.fundsPreview } : {}) };
    const deterministicRejected: string[] = [];
    const transfer = active.includes('transfer') ? resolvedTransfer(input) : undefined;
    const funds = input.fundsPreview;
    if (transfer?.suggestion && funds && !funds.allowed) deterministicRejected.push(`FUNDS_NOT_ALLOWED：资金保护策略拒绝，缺口${funds.shortfallMinor}分；${funds.reasons.join('；')}`);
    if (transfer?.suggestion && funds && (funds.amountMinor !== transfer.suggestion.amountMinor || !input.accounts.some(a => a.id === funds.accountId))) deterministicRejected.push('FUNDS_PREVIEW_MISMATCH：资金预演金额或账户与本次转账不一致。');
    if (transfer?.suggestion && active.includes('goal') && !funds) deterministicRejected.push('FUNDS_PREVIEW_MISSING：涉及预算保护的转账需要服务端资金预演。');
    if (!active.length) return { taskId: input.taskId, planVersion, mode: provider ? 'model' : 'scripted', summary: '请说明要办理的银行任务，例如“向林晓转账三百元”。', events: [], suggestions: [], clarification: '尚未识别支持的领域意图。', evidence: [], findings: deterministicRejected, modelRuns: [], diagnostics: { domains: [] }, ...attachments };
    const contexts = new Map(active.map(role => {
      const context = localContext(input, role, planVersion);
      const task = semanticIntent?.tasks.find(t => t.role === role);
      if (task) context.data.semanticRequest = task;
      const sameRoleTasks = semanticIntent?.tasks.filter(task => task.role === role) ?? [];
      if (sameRoleTasks.length > 1) context.data.semanticRequests = sameRoleTasks;
      return [role, context] as const;
    }));
    const domainWork = (role: DomainRole, supplied?: { value: unknown; started: AgentEvent }) => async (): Promise<NodeUpdate> => {
      const started = supplied?.started ?? event(role, 'started', provider ? '模型领域提案开始' : '脚本化验证适配器开始');
      const context = contexts.get(role)!;
      const runs: ModelRun[] = [];
      let diagnostic: DomainDiagnostic = { role, hasSuggestion: false, hasClarification: false, status: 'failed' };
      if (options.branchDelayMs && !supplied) await new Promise(resolve => setTimeout(resolve, options.branchDelayMs));
      try {
        const raw = supplied ? supplied.value : options.domainAdapter ? await options.domainAdapter(context) : provider ? await invokeStructured(provider, context, schemaForLocalContext(context), 'submit_domain_proposal', run => runs.push(run)) : scriptDomain(context);
        let parsed = proposalSchema.parse(raw);
        diagnostic = { role, hasSuggestion: !!parsed.suggestion || !!parsed.managementSuggestions?.length || !!parsed.investmentSuggestions?.length || !!parsed.goalSuggestion, hasClarification: !!parsed.clarification, status: 'accepted' };
        if (parsed.role !== role || parsed.planVersion !== planVersion) return { rejected: [`拒收过期或错领域提案：${role}（期望 planVersion=${planVersion}）`], events: [started, event(role, 'completed', '提案已拒收')], modelRuns: runs, domainDiagnostics: [{ ...diagnostic, status: 'rejected' as const }] };
        if (role === 'transfer' && transfer?.noActionReason && (parsed.suggestion || parsed.clarification)) return { rejected: ['TRANSFER_NO_ACTION_MISMATCH：非执行性转账内容不得产生付款建议或授权追问。'], events: [started, event(role, 'completed', 'NO_ACTION提案已拒收')], modelRuns: runs, domainDiagnostics: [{ ...diagnostic, status: 'rejected' as const }] };
        if (role === 'transfer' && transfer?.suggestion && !parsed.suggestion && !parsed.clarification) return { rejected: ['TRANSFER_STRUCTURED_SUGGESTION_MISSING：transfer仅有叙述而无结构化suggestion，不能创建待授权草稿。'], events: [started, event(role, 'completed', '提案拒收：缺少结构化suggestion')], modelRuns: runs, domainDiagnostics: [{ ...diagnostic, status: 'rejected' as const }] };
        if (parsed.suggestion) {
          const expected = role === 'transfer' ? (context.data.resolved as ReturnType<typeof resolveTransfer>).suggestion : undefined;
          if (!expected || parsed.suggestion.payeeId !== expected.payeeId || parsed.suggestion.amountMinor !== expected.amountMinor) return { rejected: [`拒收与明确转账意图不一致的提案：${role}`], events: [started, event(role, 'completed', '提案已拒收')], modelRuns: runs, domainDiagnostics: [{ ...diagnostic, status: 'rejected' as const }] };
          if (context.data.semanticRequest && parsed.suggestion.memo !== expected.memo) return { rejected: ['TRANSFER_MEMO_MISMATCH：提案更改了已校验的原文备注。'], events: [started, event(role, 'completed', '备注不一致，提案已拒收')], modelRuns: runs, domainDiagnostics: [{ ...diagnostic, status: 'rejected' as const }] };
        }
        if (role === 'card' || role === 'subscription') {
          const management = context.data.management as ManagementResolution;
          const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
          if (!parsed.managementSuggestions || canonical(parsed.managementSuggestions) !== canonical(management.managementSuggestions)) return { rejected: [`MANAGEMENT_SPEC_MISMATCH：${role}未返回确定性管理请求，或更改了目标、类型、版本、查询授权引用。`], events: [started, event(role, 'completed', '管理提案已拒收：确定性spec不匹配')], modelRuns: runs, domainDiagnostics: [{ ...diagnostic, status: 'rejected' as const }] };
        } else if (parsed.managementSuggestions?.length) return { rejected: [`MANAGEMENT_WRONG_DOMAIN：${role}不能生成银行卡或订阅管理操作。`], events: [started, event(role, 'completed', '跨领域管理提案已拒收')], modelRuns: runs, domainDiagnostics: [{ ...diagnostic, status: 'rejected' as const }] };
        const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
        if (role === 'investment') {
          const expected = (context.data.investment as InvestmentResolution).investmentSuggestions;
          if (canonical(parsed.investmentSuggestions) !== canonical(expected)) return { rejected: ['INVESTMENT_SPEC_MISMATCH：赎回结构、目标、金额或持仓版本与可信解析不一致。'], events: [started, event(role, 'completed', '理财提案已拒收')], modelRuns: runs, domainDiagnostics: [{ ...diagnostic, status: 'rejected' as const }] };
        } else if (parsed.investmentSuggestions?.length) return { rejected: ['INVESTMENT_WRONG_DOMAIN：非理财领域不能单独生成赎回建议。'], events: [started, event(role, 'completed', '理财提案已拒收')], modelRuns: runs, domainDiagnostics: [{ ...diagnostic, status: 'rejected' as const }] };
        const expectedGoal = role === 'goal' ? (context.data.lifeGoal as GoalResolution | undefined)?.goalSuggestion : undefined;
        if (canonical(parsed.goalSuggestion) !== canonical(expectedGoal)) return { rejected: ['GOAL_SPEC_MISMATCH：目标提案的日期、金额、收款人、账户或资金来源不匹配。'], events: [started, event(role, 'completed', '目标提案已拒收')], modelRuns: runs, domainDiagnostics: [{ ...diagnostic, status: 'rejected' as const }] };
        // The server owns financial facts and citations. Model narrative never replaces this report/decision.
        if (role === 'bills' || role === 'goal' || role === 'transfer' || role === 'card' || role === 'subscription' || role === 'investment') {
          const narrative = parsed.summary;
          const proposedSuggestion = parsed.suggestion;
          const proposedClarification = parsed.clarification;
          parsed = scriptDomain(context);
          if (role === 'transfer') {
            parsed.suggestion = proposedSuggestion && parsed.suggestion ? { ...parsed.suggestion, memo: proposedSuggestion.memo } : undefined;
            if (proposedClarification) { parsed.clarification = proposedClarification; parsed.suggestion = undefined; }
          }
          if ((role === 'investment' || role === 'goal' && context.data.lifeGoal) && proposedClarification) { parsed.clarification = proposedClarification; parsed.goalSuggestion = undefined; parsed.investmentSuggestions = []; }
          if (provider) parsed.evidence.push({ source: `model-explanation:${role}`, detail: narrative });
        }
        if (role === 'transfer' && transfer?.clarification) parsed = { ...parsed, suggestion: undefined, clarification: transfer.clarification };
        return { proposals: [parsed], events: [started, event(role, 'completed', parsed.summary)], modelRuns: runs, domainDiagnostics: [diagnostic] };
      } catch (error) { throw stageError(error, `domain:${role}`, runs); }
    };
    const domainNode = (role: DomainRole) => () => recovery.run(`domain:${role}`, { protocol: 'g8f-stage-v1', orchestration, planVersion, context: contexts.get(role) }, domainWork(role), validatedNodeUpdate);

    const singleWork = async (): Promise<NodeUpdate> => {
      const local = active.map(role => contexts.get(role)!);
      const starts = active.map(role => event(role, 'started', provider ? '单次联合模型调用中的领域提案开始' : '单次联合脚本化验证开始；非真实LLM'));
      const runs: ModelRun[] = [];
      try {
        if (options.branchDelayMs) await new Promise(resolve => setTimeout(resolve, options.branchDelayMs));
        const schemas = local.map(schemaForLocalContext);
        const jointShape = z.object({ proposals: z.tuple(schemas as [z.ZodType<DomainProposal>, ...z.ZodType<DomainProposal>[]]) }).strict() as z.ZodType<{ proposals: DomainProposal[] }>;
        const jointSchema = jointShape.superRefine((value, ctx) => {
          const found = value.proposals.map(p => p.role);
          if (new Set(found).size !== active.length || active.some(role => !found.includes(role))) ctx.addIssue({ code: 'custom', path: ['proposals'], message: 'Exactly one proposal for every active domain is required; duplicate, missing or extra roles are forbidden.' });
        });
        const task = { role: 'single', taskId: input.taskId, planVersion, instruction: 'This is one joint planning invocation. Read exactly the supplied minimal per-domain contexts. Return strictly {proposals:[...]}, with exactly one proposal for EACH supplied role in the EXACT SAME ORDER as contexts; no reordered, missing, duplicate or extra roles. Each item must follow that domain instruction and exact schema. Do not merge domains, invent facts, authorize, execute, or add a reviewer decision. A future goal must not create immediate transfer/redemption suggestions.', contexts: local };
        const bundle = provider ? await invokeStructured(provider, task, jointSchema, 'submit_joint_proposals', run => runs.push(run)) : jointSchema.parse({ proposals: local.map(scriptDomain) });
        const updates = await Promise.all(active.map((role, i) => domainWork(role, { value: bundle.proposals.find(p => p.role === role)!, started: starts[i]! })()));
        return {
          proposals: updates.flatMap(update => update.proposals ?? []),
          rejected: updates.flatMap(update => update.rejected ?? []),
          events: updates.flatMap(update => update.events ?? []),
          modelRuns: runs,
          domainDiagnostics: updates.flatMap(update => update.domainDiagnostics ?? []),
        };
      } catch (error) { throw stageError(error, 'single', runs); }
    };
    const singleNode = () => recovery.run('single', { protocol: 'g8f-stage-v1', orchestration, planVersion, contexts: [...contexts.values()] }, singleWork, validatedNodeUpdate);

    const builder = new StateGraph(State).addNode('dispatch', () => ({}))
      .addNode('single', singleNode)
      .addNode('transfer', domainNode('transfer')).addNode('bills', domainNode('bills')).addNode('investment', domainNode('investment'))
      .addNode('card', domainNode('card')).addNode('subscription', domainNode('subscription')).addNode('goal', domainNode('goal'));
    const reviewerWork = async (state: typeof State.State): Promise<NodeUpdate> => {
        const started = event('reviewer', 'started', '独立复核开始；不授予资金权限');
        const runs: ModelRun[] = [];
        const reviewProposals = state.proposals.map(p => ({ ...p, evidence: p.evidence.filter(e => !e.source.startsWith('model-explanation:') && !e.source.startsWith('fund-obligation:')) }));
        const context: ReviewContext = { role: 'reviewer', instruction: '你是独立提案复核Agent。approved仅判断提案结构完整、证据一致、无未解决歧义且不违反确定性资金预演，允许后续创建PENDING草稿并进入人工确认/Core鉴权；绝非资金授权或执行许可。正常待确认、红档、金额需要强验证本身都不是拒绝提案的理由。发现真实证据矛盾、transfer缺少其必需的结构化suggestion、拒收记录或allowed=false时应保持可拒绝并说明；非transfer领域不应提供suggestion，不得因此否决。card/subscription使用managementSuggestions，必须与确定性请求一致；card状态只读可为[]，SUBSCRIPTION_QUERY也是待黄色确认请求，尚无查询grant不能仅因此否决查询提案。商户取消合同与银行侧阻止扣款不得混淆。investment使用investmentSuggestions（纯查询可为[]）；goal使用goalSuggestion提出生日/生活目标，或仅解释资金预演。它们均是对应领域合法的待授权提案，没有普通transfer suggestion本身不应被拒绝。目标日期只是截止日期，不是预约自动付款；目标DAG赎回和转账须分别确认/强验证，等待实际到账才能准备后继转账；未来目标无需已经获得当前全部资金或整链授权。生日目标禁止另附立即转账/赎回建议；真实日期/金额/资金来源歧义、结构缺失或证据不一致仍应拒绝。NO_ACTION的transfer提案只解释否定、咨询或引用，没有suggestion或clarification是合法完整结果，不能因此追问付款授权。不得为了通过评测强制approved=true。返回approved/findings/summary。', taskId: input.taskId, planVersion, ...(semanticIntent ? { originalRequest: input.message, groundedIntent: semanticIntent.tasks } : {}), proposals: reviewProposals, rejected: state.rejected, deterministic: {
          ...(funds && !lifeGoalRequested(input) ? { funds: { allowed: funds.allowed, amountMinor: funds.amountMinor, shortfallMinor: funds.shortfallMinor, policyVersion: funds.policyVersion } } : {}),
          ...(attachments.billAnalysis ? { bills: buildBillReviewFacts({ analysis: attachments.billAnalysis, report: input.billReport, reports: input.billReports }) } : {}),
        } };
        const billFacts = context.deterministic?.bills;
        if (billFacts) context.instruction = context.instruction.replace('返回approved/findings/summary。', '') + ' 本次包含账单，返回专用结构 approved/billQueryAligned/bill/concerns，不返回自由金额、商户文案、summary或findings。billQueryAligned独立核对原问题的月份、商户/类别和统计口径是否与analysis一致；商户问题退化为整月汇总时必须为false，正确的缺失/不支持诊断可为true。approved=false且没有明确指向其他领域的concern时，账单结论不会作为答案展示。bill.assessment必须如实对应deterministic.bills.analysis.status；evidenceSources只引用该analysis.evidence已有source。coverage缺失的金额为unknown/null，绝不把它视为零；前期support流水不重计当前消费。concerns用于说明任何领域的复核顾虑，role只能引用本次领域或all，code使用schema枚举；approved仍是你的独立完整性判断，不能因facts存在就强制批准。';
        try {
          let rawApproved: boolean;
          let billAnswerApproved: boolean | undefined;
          let review: ReviewResult;
          if (billFacts) {
            const schema = schemaForBillReview(billFacts, active);
            const expectedAssessment = { complete: 'consistent', partial: 'partial_data', missing_data: 'missing_data', unsupported: 'unsupported' } as const;
            const raw = options.reviewerAdapter ? await options.reviewerAdapter(context) : provider ? await invokeStructured(provider, context, schema, 'submit_review', run => runs.push(run)) : {
              approved: !state.rejected.length && !state.proposals.some(p => p.clarification),
              billQueryAligned: true,
              bill: { assessment: expectedAssessment[billFacts.analysis.status], evidenceSources: [...new Set(billFacts.analysis.evidence.map(item => item.source))].slice(0,64) }, concerns: [],
            };
            const structured = schema.parse(raw), rendered = renderBillReviewAssessment(billFacts, structured.bill);
            rawApproved = structured.approved;
            billAnswerApproved = structured.billQueryAligned && !structured.concerns.some(item => item.role === 'all' || item.role === 'bills') && (structured.approved || structured.concerns.length > 0);
            const billHasAnswer = billFacts.analysis.status === 'complete' || billFacts.analysis.status === 'partial';
            review = { approved: structured.approved && structured.billQueryAligned && structured.concerns.length === 0,
              summary: `${structured.approved && structured.billQueryAligned && !structured.concerns.length ? '独立复核同意提案进入待确认阶段。' : '独立复核未通过，需核对提案。'}${billHasAnswer && !billAnswerApproved ? billAnswerWithheldMessage : rendered.summary}`,
              findings: [...(!structured.billQueryAligned ? ['BILL_QUERY_SCOPE_MISMATCH'] : []), ...(billHasAnswer && !billAnswerApproved ? ['BILL_ANSWER_REVIEW_REJECTED'] : rendered.findings), ...structured.concerns.map(item => `${item.role}: ${reviewConcernText[item.code]}`)],
            };
          } else {
            const raw = options.reviewerAdapter ? await options.reviewerAdapter(context) : provider ? await invokeStructured(provider, context, reviewSchema, 'submit_review', run => runs.push(run)) : { approved: !state.rejected.length && !state.proposals.some(p => p.clarification), findings: [], summary: '脚本化独立复核完成；资金动作仍须执行网关授权。' };
            review = reviewSchema.parse(raw); rawApproved = review.approved;
          }
          const effectiveApproved = review.approved && !state.rejected.length && !state.proposals.some(p => p.clarification);
          return { ...(billFacts ? { billAnswerApproved, billReviewBinding: stageDependencyDigest({ protocol: 'g9c-bill-review-v1', facts: billFacts }) } : {}), review: { ...review, approved: effectiveApproved }, reviewDiagnostic: { rawApproved, summary: review.summary, effectiveApproved }, events: [started, event('reviewer', 'completed', effectiveApproved ? '提案复核通过，可进入人工确认/Core鉴权；未授予资金权限。' : '提案复核未通过，暂不创建资金动作；未授予资金权限。')], modelRuns: runs };
        } catch (error) { throw stageError(error, 'reviewer', runs); }
      };
    const reviewerNode = (state: typeof State.State) => recovery.run('reviewer', { protocol: attachments.billAnalysis ? 'g9c-bill-review-v1' : 'g8f-stage-v1', orchestration, planVersion,
      ...(attachments.billAnalysis ? { bills: buildBillReviewFacts({ analysis: attachments.billAnalysis, report: input.billReport, reports: input.billReports }) } : {}),
      proposals: [...state.proposals].sort((a,b) => roles.indexOf(a.role) - roles.indexOf(b.role)), rejected: [...state.rejected].sort() }, () => reviewerWork(state), validatedNodeUpdate);

    builder.addEdge(START, 'dispatch');
    builder.addConditionalEdges('dispatch', state => orchestration === 'single' ? ['single'] : state.active, [...roles, 'single']);
    builder.addEdge('single', END);
    const initial = { active, proposals: [], events: semanticEvents, rejected: deterministicRejected, modelRuns: semanticIntent?.modelRuns ?? [], domainDiagnostics: [] };
    let result: typeof State.State;
    const checkpointAttempt = executionContext?.checkpointAttempt;
    if (options.checkpointer && !checkpointAttempt) throw new Error('A server checkpoint attempt is required for this planner');
    if (checkpointAttempt?.resume && !options.checkpointer) throw new Error('A checkpoint saver is required to resume this planner attempt');
    const runGraph = async (graph: { invoke: (...args: any[]) => Promise<typeof State.State> }) => graph.invoke(
      checkpointAttempt?.resume ? null : initial,
      options.checkpointer && checkpointAttempt ? {
        configurable: { thread_id: checkpointAttempt.threadId, checkpoint_ns: checkpointAttempt.checkpointNs },
        durability: 'sync' as const,
      } : undefined,
    ).catch((error: unknown) => recovery.settle(error));
    if (orchestration === 'parallel-review') {
      const reviewed = builder.addNode('reviewer', reviewerNode);
      for (const role of roles) reviewed.addEdge(role, 'reviewer');
      reviewed.addEdge('reviewer', END);
      result = await runGraph(reviewed.compile(options.checkpointer ? { checkpointer: options.checkpointer } : undefined));
    } else {
      for (const role of roles) builder.addEdge(role, END);
      result = await runGraph(builder.compile(options.checkpointer ? { checkpointer: options.checkpointer } : undefined));
    }
    if (orchestration === 'parallel-review' && attachments.billAnalysis && (typeof result.billAnswerApproved !== 'boolean' || result.billReviewBinding !== stageDependencyDigest({ protocol: 'g9c-bill-review-v1', facts: buildBillReviewFacts({ analysis: attachments.billAnalysis, report: input.billReport, reports: input.billReports }) }))) {
      throw stageError(Object.assign(new Error('STAGE_DEPENDENCY_MISMATCH'), { code: 'STAGE_DEPENDENCY_MISMATCH' }), 'reviewer');
    }
    const billReviewRejected = orchestration === 'parallel-review' && !!attachments.billAnalysis && !result.billAnswerApproved;
    const billWithheld = billReviewRejected && (attachments.billAnalysis?.status === 'complete' || attachments.billAnalysis?.status === 'partial');
    const billPublicMessage = billWithheld ? billAnswerWithheldMessage : attachments.billAnalysis?.summary;
    const ordered = [...result.proposals].sort((a, b) => roles.indexOf(a.role) - roles.indexOf(b.role)).map(proposal => billReviewRejected && proposal.role === 'bills' ? {
      ...proposal, summary: billPublicMessage!, clarification: billPublicMessage!,
      evidence: [], findings: ['BILL_ANSWER_REVIEW_REJECTED', ...(!billWithheld ? attachments.billAnalysis?.findings ?? [] : [])],
    } : proposal);
    const publicAttachments = billReviewRejected ? { ...(attachments.fundsPreview ? { fundsPreview: attachments.fundsPreview } : {}),
      ...(!billWithheld && attachments.billAnalysis ? { billAnalysis: attachments.billAnalysis } : {}),
      billAnswerReview: billWithheld ? { status: 'withheld' as const, message: billAnswerWithheldMessage } : { status: 'diagnostic' as const, message: attachments.billAnalysis!.summary },
    } : attachments;
    const clarification = transfer?.clarification || ordered.map(p => p.clarification).filter(Boolean).join('；') || undefined;
    const summary = ordered.map(p => p.summary).join(' ') || '未得到有效提案，请查看复核结果后重试或澄清任务。';
    // Identical deterministic gate in all experiments. Disabling the model reviewer
    // never bypasses a failed domain, incomplete role set, stale proposal or funds refusal.
    const complete = ordered.length === active.length && new Set(ordered.map(p => p.role)).size === active.length && active.every(role => ordered.some(p => p.role === role));
    const accepted = complete && !result.rejected.length && !clarification && (orchestration !== 'parallel-review' || result.review?.approved === true);
    return {
      taskId: input.taskId, planVersion, mode: provider ? 'model' : 'scripted', summary: provider ? summary : `【脚本化验证模式，非真实 LLM】${summary}`,
      events: result.events.map(item => billReviewRejected && item.role === 'bills' && item.status === 'completed' ? { ...item, summary: billPublicMessage! } : item).sort((a, b) => a.at.localeCompare(b.at)), suggestions: accepted ? ordered.flatMap(p => p.suggestion ? [p.suggestion] : []) : [],
      managementSuggestions: accepted ? ordered.flatMap(p => p.managementSuggestions ?? []) : [],
      investmentSuggestions: accepted && !lifeGoalRequested(input) ? ordered.flatMap(p => p.investmentSuggestions ?? []) : [],
      ...(accepted && ordered.some(p => p.goalSuggestion) ? { goalSuggestion: ordered.find(p => p.goalSuggestion)!.goalSuggestion } : {}),
      ...(clarification ? { clarification } : {}), evidence: ordered.flatMap(p => p.evidence), findings: [...result.rejected, ...ordered.flatMap(p => p.findings), ...(result.review?.findings ?? [])], modelRuns: executionContext?.stageJournal ? [...(semanticIntent?.modelRuns ?? []), ...(await recovery.history() ?? [])] : result.modelRuns, diagnostics: { ...intentDiagnostic, domains: [...result.domainDiagnostics].sort((a, b) => roles.indexOf(a.role) - roles.indexOf(b.role)), ...(result.reviewDiagnostic ? { review: result.reviewDiagnostic } : {}) }, ...publicAttachments,
    } satisfies PlanResult;
  } };
}
