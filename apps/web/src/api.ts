import type {
  ActionView,
  BillReport,
  Dashboard,
  FaultMode,
  FundsOverview,
  FundsPolicy,
  PlanResult,
  InvestmentDashboard,
  FundsTimeline,
  RedemptionInput,
  InvestmentAction,
  GoalView,
  CreateGoalInput,
  ReplanGoalInput,
} from '../../../packages/contracts/src';
import type { AcceptedConversationMessage, Clarification, Conversation, ConversationCommand, ConversationHistory, ConversationMessageInput, ConversationPage, ConversationRecoveryPage } from '../../../packages/contracts/src/conversations';
import type { ManagementAction, ManagementDashboard, ManagementInput, SubscriptionSnapshot } from '../../../packages/contracts/src/management';
import type { PreparationFamily, PreparationRequest, PreparationRequestPage, PreparationResult } from '../../../packages/contracts/src/preparations';

export type EnrichedPlan = PlanResult & { actions?: ActionView[]; managementActions?: ManagementAction[]; investmentActions?: InvestmentAction[]; goal?: GoalView };
export type PlanEnvelope = PlanResult & { actions: ActionView[]; managementActions?: ManagementAction[]; investmentActions?: InvestmentAction[]; goal?: GoalView; plan?: EnrichedPlan };
export type DashboardData = Dashboard & {
  plannerMode?: PlanResult['mode'];
  passkeyCount?: number;
  latestPlan?: PlanResult & { actions: ActionView[]; managementActions?: ManagementAction[]; investmentActions?: InvestmentAction[]; goal?: GoalView };
};

export class ApiError extends Error {
  code?: string;
  status?: number;

  constructor(message: string, code?: string, status?: number) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}

let sessionSignal: AbortSignal | undefined;
/** App rotates this signal before changing identity, aborting every old API request. */
export function setApiSessionSignal(signal?: AbortSignal): void { sessionSignal = signal; }
export function getApiSessionSignal(): AbortSignal | undefined { return sessionSignal; }

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const signal = init.signal && sessionSignal ? AbortSignal.any([init.signal, sessionSignal]) : init.signal ?? sessionSignal;
  signal?.throwIfAborted();
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      ...init,
      credentials: 'include',
      signal,
      headers: {
        ...(init.body ? { 'content-type': 'application/json' } : {}),
        ...init.headers,
      },
    });
  } catch {
    signal?.throwIfAborted();
    throw new ApiError('无法连接本地 API，请确认服务运行在 localhost:8787。');
  }

  signal?.throwIfAborted();
  const text = await response.text();
  signal?.throwIfAborted();
  let payload: unknown = undefined;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      throw new ApiError(`API 返回了无法读取的响应（${response.status}）。`, undefined, response.status);
    }
  }

  if (!response.ok) {
    const error = payload && typeof payload === 'object' && 'error' in payload
      ? (payload as { error?: { code?: string; message?: string } }).error
      : undefined;
    throw new ApiError(error?.message || `请求失败（${response.status}）。`, error?.code, response.status);
  }
  return payload as T;
}

export const api = {
  preparationRequests: (cursor?: string, signal?: AbortSignal) => request<PreparationRequestPage>(`/preparation-requests?limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, { signal }),
  preparationRequest: (family: PreparationFamily, id: string, signal?: AbortSignal) => request<PreparationRequest>(`/preparation-requests/${family}/${encodeURIComponent(id)}`, { signal }),
  preparationResult: (family: PreparationFamily, id: string, signal?: AbortSignal) => request<PreparationResult>(`/preparation-requests/${family}/${encodeURIComponent(id)}/result`, { signal }),
  retryPreparation: (family: PreparationFamily, id: string) => request<PreparationResult>(`/preparation-requests/${family}/${encodeURIComponent(id)}/retry`, { method: 'POST', body: '{}' }),
  abandonPreparation: (family: PreparationFamily, id: string) => request<PreparationRequest>(`/preparation-requests/${family}/${encodeURIComponent(id)}/abandon`, { method: 'POST', body: '{}' }),
  session: () => request<{ userId: string; email: string }>('/session'),
  conversations: (signal?: AbortSignal, cursor?: string) => request<ConversationPage>(`/conversations?limit=30${cursor === undefined ? '' : `&cursor=${encodeURIComponent(cursor)}`}`, { signal }),
  conversation: (id: string, signal?: AbortSignal) => request<Conversation>(`/conversations/${encodeURIComponent(id)}`, { signal }),
  conversationRecovery: (id: string, cursor?: string, signal?: AbortSignal) => request<ConversationRecoveryPage>(`/conversations/${encodeURIComponent(id)}/recovery?limit=20${cursor === undefined ? '' : `&cursor=${encodeURIComponent(cursor)}`}`, { signal }),
  createConversation: (signal?: AbortSignal) => request<Conversation>('/conversations', { method: 'POST', body: JSON.stringify({}), signal }),
  conversationHistory: (id: string, beforeSequence?: number, signal?: AbortSignal) => request<ConversationHistory>(`/conversations/${encodeURIComponent(id)}/messages?limit=50${beforeSequence === undefined ? '' : `&beforeSequence=${beforeSequence}`}`, { signal }),
  sendConversationMessage: (id: string, input: ConversationMessageInput, signal?: AbortSignal) => request<AcceptedConversationMessage>(`/conversations/${encodeURIComponent(id)}/messages`, { method: 'POST', body: JSON.stringify(input), signal }),
  subscriptionContinuation: (id: string, commandId: string, action: 'resume' | 'requery' | 'stop', signal?: AbortSignal) => request<ConversationCommand | { state: string }>(`/conversations/${encodeURIComponent(id)}/subscription-continuations/${encodeURIComponent(commandId)}/${action}`, { method: 'POST', body: '{}', signal }),
  conversationCommand: (id: string, commandId: string, signal?: AbortSignal) => request<ConversationCommand>(`/conversations/${encodeURIComponent(id)}/commands/${encodeURIComponent(commandId)}`, { signal }),
  retryConversationCommand: (id: string, commandId: string, signal?: AbortSignal) => request<ConversationCommand>(`/conversations/${encodeURIComponent(id)}/commands/${encodeURIComponent(commandId)}/retry`, { method: 'POST', body: '{}', signal }),
  cancelConversationClarification: (id: string, clarificationId: string, expectedVersion: number, signal?: AbortSignal) => request<Clarification>(`/conversations/${encodeURIComponent(id)}/clarifications/${encodeURIComponent(clarificationId)}/cancel`, { method: 'POST', body: JSON.stringify({ expectedVersion }), signal }),
  health: () => request<{ status?: string; mode?: string; plannerMode?: PlanResult['mode'] }>('/health'),
  dashboard: () => request<DashboardData>('/dashboard'),
  management: () => request<ManagementDashboard>('/management'),
  managementCommand: (id: string) => request<ManagementAction>(`/management/commands/${encodeURIComponent(id)}`),
  managementAction: (id: string) => request<ManagementAction>(`/management/actions/${encodeURIComponent(id)}`),
  investmentCommand: (id: string) => request<InvestmentAction>(`/investments/commands/${encodeURIComponent(id)}`),
  investmentAction: (id: string) => request<InvestmentAction>(`/investments/actions/${encodeURIComponent(id)}`),
  goalCommand: (id: string) => request<GoalView>(`/goal-commands/${encodeURIComponent(id)}`),
  action: (id: string) => request<ActionView>(`/actions/${encodeURIComponent(id)}`),
  prepareManagement: (input: ManagementInput) => request<ManagementAction>('/management/actions', {
    method: 'POST',
    body: JSON.stringify(input),
  }),
  confirmManagement: (id: string, actionHash: string) => request<ManagementAction>(`/management/actions/${encodeURIComponent(id)}/confirm`, {
    method: 'POST',
    body: JSON.stringify({ actionHash }),
  }),
  cancelManagement: (id: string) => request<ManagementAction>(`/management/actions/${encodeURIComponent(id)}/cancel`, { method: 'POST' }),
  managementAuthenticationOptions: (id: string) => request<unknown>(`/management/actions/${encodeURIComponent(id)}/authentication/options`, { method: 'POST' }),
  managementAuthenticationVerify: (id: string, response: unknown) => request<ManagementAction>(`/management/actions/${encodeURIComponent(id)}/authentication/verify`, {
    method: 'POST',
    body: JSON.stringify({ response }),
  }),
  subscriptions: (queryActionId: string) => request<SubscriptionSnapshot>(`/subscriptions?queryActionId=${encodeURIComponent(queryActionId)}`),
  investments: () => request<InvestmentDashboard>('/investments'),
  investmentTimeline: (accountId?: string, days = 30) => {
    const query = new URLSearchParams({ days: String(days) });
    if (accountId) query.set('accountId', accountId);
    return request<FundsTimeline>(`/investments/timeline?${query.toString()}`);
  },
  prepareRedemption: (input: RedemptionInput) => request<InvestmentAction>('/investments/redemptions', { method: 'POST', body: JSON.stringify(input) }),
  confirmInvestment: (id: string, actionHash: string) => request<InvestmentAction>(`/investments/actions/${encodeURIComponent(id)}/confirm`, { method: 'POST', body: JSON.stringify({ actionHash }) }),
  cancelInvestment: (id: string) => request<InvestmentAction>(`/investments/actions/${encodeURIComponent(id)}/cancel`, { method: 'POST' }),
  reconcileInvestment: (id: string) => request<InvestmentAction>(`/investments/actions/${encodeURIComponent(id)}/reconcile`, { method: 'POST' }),
  investmentAuthenticationOptions: (id: string) => request<unknown>(`/investments/actions/${encodeURIComponent(id)}/authentication/options`, { method: 'POST' }),
  investmentAuthenticationVerify: (id: string, response: unknown) => request<InvestmentAction>(`/investments/actions/${encodeURIComponent(id)}/authentication/verify`, { method: 'POST', body: JSON.stringify({ response }) }),
  goals: () => request<{ goals: GoalView[] }>('/goals'),
  createGoal: (input: CreateGoalInput) => request<GoalView>('/goals', { method: 'POST', body: JSON.stringify(input) }),
  goal: (id: string) => request<GoalView>(`/goals/${encodeURIComponent(id)}`),
  advanceGoal: (id: string) => request<GoalView>(`/goals/${encodeURIComponent(id)}/advance`, { method: 'POST' }),
  replanGoal: (id: string, input: ReplanGoalInput) => request<GoalView>(`/goals/${encodeURIComponent(id)}/replan`, { method: 'POST', body: JSON.stringify(input) }),
  setInvestmentFault: (mode: FaultMode) => request<unknown>('/sandbox/investment-fault', { method: 'POST', body: JSON.stringify({ mode }) }),
  bills: (period: string) => request<BillReport>(`/bills?period=${encodeURIComponent(period)}`),
  funds: (accountId?: string, amountMinor?: string) => {
    const query = new URLSearchParams();
    if (accountId) query.set('accountId', accountId);
    if (amountMinor) query.set('amountMinor', amountMinor);
    return request<FundsOverview>(`/funds?${query.toString()}`);
  },
  updateFundsPolicy: (input: { expectedVersion: number; minimumBalanceMinor: string; obligations: FundsPolicy['obligations']; confirmed: true }) => request<FundsPolicy>('/funds/policy', {
    method: 'POST',
    body: JSON.stringify(input),
  }),
  signIn: (email: string, password: string) => request<unknown>('/auth/sign-in/email', {
    method: 'POST',
    body: JSON.stringify({ email, password, rememberMe: false }),
  }),
  signOut: () => request<unknown>('/auth/sign-out', { method: 'POST', body: JSON.stringify({}) }),
  plan: (message: string, commandId: string) => request<PlanEnvelope>('/plan', {
    method: 'POST',
    body: JSON.stringify({ message, commandId }),
  }),
  confirm: (id: string, actionHash: string) => request<ActionView>(`/actions/${encodeURIComponent(id)}/confirm`, {
    method: 'POST',
    body: JSON.stringify({ actionHash }),
  }),
  cancel: (id: string) => request<ActionView>(`/actions/${encodeURIComponent(id)}/cancel`, { method: 'POST' }),
  reconcile: (id: string) => request<ActionView>(`/actions/${encodeURIComponent(id)}/reconcile`, { method: 'POST' }),
  setFault: (mode: FaultMode) => request<unknown>('/sandbox/fault', {
    method: 'POST',
    body: JSON.stringify({ mode }),
  }),
  registerOptions: () => request<unknown>('/webauthn/register/options', { method: 'POST' }),
  registerVerify: (response: unknown) => request<unknown>('/webauthn/register/verify', {
    method: 'POST',
    body: JSON.stringify({ response }),
  }),
  authenticationOptions: (id: string) => request<unknown>(`/actions/${encodeURIComponent(id)}/authentication/options`, {
    method: 'POST',
  }),
  authenticationVerify: (id: string, response: unknown) => request<ActionView>(`/actions/${encodeURIComponent(id)}/authentication/verify`, {
    method: 'POST',
    body: JSON.stringify({ response }),
  }),
};

export function unwrapPublicKeyOptions(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== 'object') throw new ApiError('安全验证服务返回了无效的 WebAuthn 参数。');
  const root = payload as Record<string, unknown>;
  const options = root.optionsJSON ?? root.options ?? payload;
  if (!options || typeof options !== 'object') throw new ApiError('安全验证服务返回了无效的 WebAuthn 参数。');
  return options as Record<string, unknown>;
}

export function mergeActions(...groups: (ActionView[] | undefined)[]): ActionView[] {
  const byId = new Map<string, ActionView>();
  for (const group of groups) {
    for (const action of group ?? []) byId.set(action.id, action);
  }
  return [...byId.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

