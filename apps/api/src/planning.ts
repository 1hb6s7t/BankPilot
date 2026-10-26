import type { Actor, CoreService, FinanceService, InvestmentService, ManagementContext, ManagementService, Planner, PlannerInput, SemanticPlan } from '../../../packages/contracts/src/index.js';
import { activeRoles, isGoalRequest, resolveTransfer } from '../../../packages/agents/src/index.js';
import { CoreError } from '../../../packages/core/src/index.js';
import { billPeriods } from '../../../packages/agents/src/bills.js';

export type PlanningServices = { planner: Planner; finance?: FinanceService; management?: ManagementService; investment?: InvestmentService };

/** Read-only preparation. Semantic extraction runs once, before period/funds queries. */
export async function prepareRecognitionInput(services: PlanningServices, actor: Actor, request: { taskId: string; message: string; subscriptionQueryActionId?: string }, dashboard: Awaited<ReturnType<CoreService['dashboard']>>, now = new Date()): Promise<PlannerInput> {
  const { planner, finance, management, investment } = services;
  const referenceDate = new Date(now.valueOf() + 8 * 3600_000).toISOString().slice(0, 10);
  const lexicalRoles = activeRoles(request.message);
  const [managementState, investmentContext] = await Promise.all([
    management && (planner.interpret || lexicalRoles.some(r => r === 'card' || r === 'subscription')) ? management.dashboard(actor) : undefined,
    investment && (planner.interpret || lexicalRoles.some(r => r === 'investment' || r === 'goal')) ? investment.dashboard(actor) : undefined,
  ]);
  let managementContext: ManagementContext | undefined;
  if (managementState) {
    managementContext = { cards: managementState.cards };
    const queryActionId = request.subscriptionQueryActionId ?? managementState.subscriptionQueryActionId;
    if (queryActionId && (request.subscriptionQueryActionId || planner.interpret || lexicalRoles.includes('subscription'))) {
      try { managementContext.subscriptions = await management!.subscriptions(actor, queryActionId); }
      catch (error) {
        if (request.subscriptionQueryActionId || !(error instanceof CoreError) || !['QUERY_AUTHORIZATION_REQUIRED', 'QUERY_ACCESS_EXPIRED'].includes(error.code)) throw error;
      }
    }
  }
  const input: PlannerInput = { taskId: request.taskId, message: request.message, accounts: dashboard.accounts, payees: dashboard.payees, referenceDate, deadlineAt: now.valueOf() + 180_000,
    ...(managementContext ? { managementContext } : {}), ...(investmentContext ? { investmentContext } : {}) };
  return input;
}

/** Financial reads happen only after a successful semantic phase is durably saved. */
export async function completePlannerInput(services: PlanningServices, actor: Actor, input: PlannerInput): Promise<PlannerInput> {
  const { finance } = services;
  const request = input;
  const referenceDate = input.referenceDate!;
  const lexicalRoles = activeRoles(input.message);
  const semantic = input.semanticIntent;
  const roles = semantic ? semantic.tasks.map(t => t.role) : lexicalRoles;
  const transfer = semantic?.tasks.find(t => t.operation === 'transfer');
  const lifeGoal = semantic ? semantic.tasks.some(t => t.operation === 'goal_create') : isGoalRequest(request.message);
  const resolved = !semantic && roles.includes('transfer') ? resolveTransfer(request.message, input.payees) : undefined;
  const period = semantic?.tasks.find(t => t.operation === 'bills_query')?.slots.billPeriod;
  const explicitPeriod = request.message.match(/(\d{4})\s*(?:年|[-/])\s*(0?[1-9]|1[0-2])(?:月|(?=[^\d]|$))/);
  const previousMonth = new Date(`${referenceDate.slice(0, 7)}-01T00:00:00Z`);
  previousMonth.setUTCMonth(previousMonth.getUTCMonth() - 1);
  const requestedPeriod = semantic ? period?.startPeriod : explicitPeriod ? `${explicitPeriod[1]}-${explicitPeriod[2]!.padStart(2, '0')}` : /上(?:个)?月/.test(request.message) ? previousMonth.toISOString().slice(0, 7) : undefined;
  const periods = billPeriods(period);
  const [billReports, funds] = await Promise.all([
    finance && roles.includes('bills') ? Promise.all((periods ?? [requestedPeriod]).map(month => finance.billReport(actor, month))) : undefined,
    finance && roles.some(r => r === 'transfer' || r === 'goal') ? finance.funds(actor, input.accounts[0]?.id, lifeGoal ? '0' : transfer?.slots.amountMinor ?? resolved?.suggestion?.amountMinor ?? '0') : undefined,
  ]);
  return { ...input, ...(billReports?.length ? { billReport: billReports[0], billReports } : {}), ...(funds ? { fundsPreview: funds.preview } : {}) };
}

/** Backward-compatible read-only adapter; the runner persists phases separately. */
export async function preparePlannerInput(services: PlanningServices, actor: Actor, request: { taskId: string; message: string; subscriptionQueryActionId?: string }, dashboard: Awaited<ReturnType<CoreService['dashboard']>>, now = new Date(), trustedSemantic?: SemanticPlan): Promise<PlannerInput> {
  const input = await prepareRecognitionInput(services, actor, request, dashboard, now);
  if (trustedSemantic) input.semanticIntent = trustedSemantic;
  else if (services.planner.interpret) input.semanticIntent = await services.planner.interpret(input);
  if (input.semanticIntent?.status === 'failed') return input;
  return completePlannerInput(services, actor, input);
}
