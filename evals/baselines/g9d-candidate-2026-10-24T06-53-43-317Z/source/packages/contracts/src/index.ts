import { z } from 'zod';
import type { ManagementContext, ManagementSpec } from './management';
import type { InvestmentDashboard, RedemptionSpec } from './investment';
import type { GoalDraft } from './goals';
import type { PreparationService } from './preparations';
export * from './management';
export * from './investment';
export * from './goals';
export * from './preparations';

export const minorUnits = z.string().regex(/^[1-9]\d{0,11}$/, '金额必须为正整数分');
export const transferInputSchema = z.object({
  commandId: z.string().min(8).max(128),
  accountId: z.string().min(1),
  payeeId: z.string().min(1),
  amountMinor: minorUnits,
  memo: z.string().max(120).default(''),
  taskId: z.string().optional(),
}).strict();
export type TransferInput = z.infer<typeof transferInputSchema>;
export type Actor = { userId: string };
export type RiskTier = 'YELLOW' | 'RED';
export type ActionStatus = 'AWAITING_CONFIRMATION' | 'AWAITING_VERIFICATION' | 'AUTHORIZED' | 'SUBMITTING' | 'UNKNOWN' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED' | 'EXPIRED';
export type AccountView = { id: string; name: string; maskedNumber: string; balanceMinor: string; reservedMinor: string; currency: 'CNY' };
export type PayeeView = { id: string; name: string; bank: string; maskedNumber: string; aliases: string[] };
export type Receipt = { providerRequestId: string; providerTransactionId: string; amountMinor: string; currency: 'CNY'; payeeId: string; settledAt: string };
export type ActionView = {
  id: string; taskId: string; accountId: string; payeeId: string; payeeName: string;
  amountMinor: string; currency: 'CNY'; memo: string; status: ActionStatus; tier: RiskTier;
  actionVersion: number; actionHash: string; expiresAt: string; createdAt: string; updatedAt: string;
  receipt?: Receipt; failureReason?: string;
};
export type AuditEvent = { id: string; actionId: string | null; type: string; createdAt: string; detail: Record<string, unknown> };
export type BillCategory = '餐饮' | '购物' | '交通' | '住房' | '订阅' | '收入' | '转账' | '其他';
export type BillTransaction = {
  id: string; accountId: string; bookedAt: string; merchant: string; amountMinor: string;
  direction: 'IN' | 'OUT'; category: BillCategory; source: 'SYNTHETIC_STATEMENT' | 'SANDBOX_TRANSFER';
};
export type BillFinding = { id: string; kind: 'LARGE_EXPENSE' | 'POSSIBLE_DUPLICATE' | 'RECURRING'; summary: string; transactionIds: string[] };
export type BillReport = {
  period: string; source: 'SYNTHETIC'; incomeMinor: string; expenseMinor: string; netMinor: string;
  /** Coverage of the supplied synthetic statement, not a claim about an external bank. */
  coverage?: { status: 'complete' | 'partial' | 'missing'; through?: string };
  previousExpenseMinor: string; categories: { category: BillCategory; amountMinor: string; count: number; transactionIds: string[] }[];
  transactions: BillTransaction[]; evidenceTransactions?: BillTransaction[]; findings: BillFinding[]; generatedAt: string;
};
export type BillAnalysis = {
  status: 'complete' | 'partial' | 'missing_data' | 'unsupported';
  kind: 'summary' | 'largest_expense' | 'filtered_expense' | 'category_comparison';
  periods: string[]; missingPeriods: string[];
  /** terms records an explicit merchant-name synonym expansion, never an inferred industry. */
  filter?: { kind: 'category' | 'merchant_contains'; value: string; terms?: string[] };
  amountMinor?: string; transactionIds: string[];
  categoryChanges?: { category: BillCategory; beforeMinor: string; afterMinor: string; changeMinor: string; transactionIds: string[] }[];
  largestIncreaseCategories?: BillCategory[];
  summary: string; clarification?: string; findings: string[]; evidence: { source: string; detail: string }[];
};
export type FundObligation = { id: string; title: string; amountMinor: string; dueDate: string };
export type FundsPolicy = { version: number; minimumBalanceMinor: string; obligations: FundObligation[]; updatedAt: string };
export type FundsPreview = {
  accountId: string; amountMinor: string; balanceMinor: string; reservedMinor: string; availableBeforeMinor: string;
  availableAfterMinor: string; protectedMinor: string; spendableMinor: string; shortfallMinor: string;
  allowed: boolean; policyVersion: number; horizonEnd: string; obligations: FundObligation[]; reasons: string[];
};
export type FundsOverview = { policy: FundsPolicy; preview: FundsPreview };
export type FinanceService = {
  seedDemo(actor: Actor): Promise<void>;
  billReport(actor: Actor, period?: string): Promise<BillReport>;
  funds(actor: Actor, accountId?: string, amountMinor?: string): Promise<FundsOverview>;
  updatePolicy(actor: Actor, input: { expectedVersion: number; minimumBalanceMinor: string; obligations: FundObligation[] }): Promise<FundsPolicy>;
};
export type Dashboard = { accounts: AccountView[]; payees: PayeeView[]; actions: ActionView[]; audit: AuditEvent[]; dailyUsedMinor: string };
export type AuthorizationProof = { level: 'CONFIRMATION' | 'STRONG'; proofId: string; actionHash: string };
export type FaultMode = 'NORMAL' | 'TIMEOUT_AFTER_COMMIT' | 'REJECT';
export type CoreService = {
  preparations?: PreparationService;
  migrate(): Promise<void>;
  seedDemo(actor: Actor): Promise<void>;
  dashboard(actor: Actor): Promise<Dashboard>;
  createTransfer(actor: Actor, input: TransferInput): Promise<ActionView>;
  getAction(actor: Actor, id: string, options?: { readOnly?: boolean }): Promise<ActionView>;
  authorize(actor: Actor, id: string, proof: AuthorizationProof): Promise<ActionView>;
  cancel(actor: Actor, id: string): Promise<ActionView>;
  execute(id: string): Promise<ActionView>;
  reconcile(id: string): Promise<ActionView>;
  setNextFault(actor: Actor, mode: FaultMode): Promise<void>;
};

export type DomainRole = 'transfer' | 'bills' | 'investment' | 'card' | 'subscription' | 'goal';
export type AgentEvent = { role: string; status: 'started' | 'completed'; at: string; summary: string };
export type TransferSuggestion = { payeeId: string; amountMinor: string; memo: string };
export type PlanResult = {
  taskId: string; planVersion: number; mode: 'scripted' | 'model'; summary: string;
  events: AgentEvent[]; suggestions: TransferSuggestion[]; clarification?: string;
  evidence: { source: string; detail: string }[]; findings: string[];
  billReport?: BillReport; billReports?: BillReport[]; billAnalysis?: BillAnalysis; fundsPreview?: FundsPreview;
  billAnswerReview?: { status: 'withheld' | 'diagnostic'; message: string };
  managementSuggestions?: ManagementSpec[];
  investmentSuggestions?: RedemptionSpec[];
  goalSuggestion?: GoalDraft;
  modelRuns?: ModelRun[]; failure?: PlanningFailure; modelAttempts?: PlanningModelAttempt[];
  diagnostics?: {
    intent?: { status: SemanticPlan['status']; roles: DomainRole[]; findings: string[]; issues?: SemanticPlan['issues'] };
    domains: { role: DomainRole; hasSuggestion: boolean; hasClarification: boolean; status: 'accepted' | 'rejected' | 'failed' }[];
    review?: { rawApproved: boolean | null; summary: string; effectiveApproved: boolean };
  };
};
export type ModelRun = {
  role: string; model: string; status: 'success' | 'failed'; durationMs: number;
  inputTokens?: number; outputTokens?: number; errorCode?: string;
  attempt?: number;
  failureStage?: 'request' | 'response_json' | 'tool_output' | 'output_json' | 'schema';
  issues?: { path: string[]; code: string; expectedType?: string }[];
  finishReason?: 'stop' | 'length' | 'tool_calls' | 'function_call' | 'content_filter' | 'other';
  outputLength?: number; outputDigest?: string;
  requestMaxOutputTokens?: number; reasoningLength?: number; reasoningTokens?: number;
};
/** Service failures carry no user clarification or executable proposal. */
export type PlanningFailure = { phase: 'semantic_intent' | 'planning'; stage?: PlanningStageKey; findings?: string[]; code: string; retryable: boolean; message: string; modelRuns: ModelRun[] };
export type PlanningStageKey = `domain:${DomainRole}` | 'reviewer' | 'single';
/** Server-only callbacks. Values are normalized, validated node results, never raw completions. */
export type PlanningStageJournal = {
  completed(): Promise<PlanningStageKey[]>;
  load(key: PlanningStageKey, dependencyDigest: string): Promise<unknown | undefined>;
  save(key: PlanningStageKey, dependencyDigest: string, value: unknown, eventId: string): Promise<void>;
  recordFailure(key: PlanningStageKey, failure: PlanningFailure, eventId: string): Promise<void>;
  history(): Promise<ModelRun[]>;
};
/** Starts consume budget even when their eventual remote outcome is unknown. */
export type PlanningModelAttempt = { attemptId: string; invocationId: string; role: string; attempt: number; requestMaxOutputTokens: number; startedAtUtc: string; outcome: 'unknown' | 'success' | 'failed'; endedAtUtc?: string; errorCode?: string; inputTokens?: number; outputTokens?: number };
export type PlanningModelAttemptEvent = { type: 'attempt_start' | 'attempt_end'; attemptId: string; invocationId: string; role: string; attempt: number; requestMaxOutputTokens: number | null; startedAtUtc: string; endedAtUtc?: string; status?: 'success' | 'failed'; errorCode?: string; inputTokens?: number; outputTokens?: number };
// Internal server handoff only; the public plan endpoint never accepts semantic slots.
export type SemanticSource = { text: string; start?: number; end?: number };
export type SemanticTask = {
  operation: string; role: DomainRole; source: SemanticSource; canonicalMessage: string;
  slots: { entityId?: string; amountMinor?: string; memo?: string; purpose?: string; targetDate?: string;
    funding?: { positionId: string; amountMinor: string };
    billPeriod?: { kind: 'month' | 'range' | 'selection'; startPeriod: string; endPeriod: string; periods?: string[]; source: SemanticSource } };
};
export type SemanticPlan = { status: 'ready' | 'clarification' | 'no_action' | 'failed'; failure?: PlanningFailure; tasks: SemanticTask[]; recognizedRoles?: DomainRole[]; clarification?: string; findings: string[]; issues?: { path: string[]; category: string; code: string }[]; modelRuns: ModelRun[] };
export type PlannerInput = { taskId: string; message: string; accounts: AccountView[]; payees: PayeeView[]; billReport?: BillReport; billReports?: BillReport[]; fundsPreview?: FundsPreview; managementContext?: ManagementContext; investmentContext?: InvestmentDashboard; referenceDate?: string; deadlineAt?: number; semanticIntent?: SemanticPlan };
/** Server-only planner metadata. It is deliberately separate from PlannerInput so it never enters model context. */
export type PlannerExecutionContext = { stageJournal?: PlanningStageJournal; modelAttemptObserver?: (event: Readonly<PlanningModelAttemptEvent>, context?: { signal: AbortSignal }) => Promise<void>; priorReservedOutputTokens?: number; checkpointAttempt?: { threadId: string; checkpointNs: ''; resume: boolean } };
export type Planner = { interpret?(input: PlannerInput, executionContext?: PlannerExecutionContext): Promise<SemanticPlan>; plan(input: PlannerInput, executionContext?: PlannerExecutionContext): Promise<PlanResult> };
