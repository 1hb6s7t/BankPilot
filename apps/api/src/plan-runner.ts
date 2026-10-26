import { recognizeSubscriptionPrerequisite, verifySubscriptionContinuation, type SubscriptionPrerequisite } from '../../../packages/agents/src/subscription-prerequisite.js';
import type { createSubscriptionContinuationStore } from './subscription-continuations.js';
import { continuationProposalMatches, publicContinuationResult, redactStoredContinuationActions } from './subscription-continuation-plan.js';
import { withTransaction } from '../../../packages/core/src/database.js';
import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { CoreError } from '../../../packages/core/src/index.js';
import type { Actor, CoreService, Planner, PlannerExecutionContext, FinanceService, ManagementService, InvestmentService, GoalsService, PlanResult, PlannerInput, ActionView, ManagementAction, InvestmentAction, GoalView, SemanticPlan, PlanningFailure } from '../../../packages/contracts/src/index.js';
import type { ConversationPlanningInput } from '../../../packages/contracts/src/conversations.js';
import type { CheckpointJournalIdentity } from '../../../packages/agents/src/checkpoint-fencing.js';
import { prepareRecognitionInput, completePlannerInput } from './planning.js';
import { PlanningStageFailure } from '../../../packages/agents/src/planning-failures.js';
import { createPlanningJournal, PlanningServiceFailure, planningFailure, permanentPlanningSnapshotFailure } from './planning-journal.js';

export type PlanEnvelope = PlanResult & { actions: ActionView[]; managementActions?: ManagementAction[]; investmentActions?: InvestmentAction[]; goal?: GoalView };
export type PlanRunnerOptions = { pool: Pool; core: CoreService; planner: Planner; finance?: FinanceService; management?: ManagementService; investment?: InvestmentService; goals?: GoalsService;
  continuations?: ReturnType<typeof createSubscriptionContinuationStore>;
  checkpointAttempts?: {
    register(threadId: string, identity: CheckpointJournalIdentity): Promise<void>;
    transfer?(threadId: string, identity: CheckpointJournalIdentity): Promise<string | undefined>;
  };
  onComplete?(tx: PoolClient, actor: Actor, commandId: string, leaseToken: string, result: PlanEnvelope, preparedInput?: PlannerInput): Promise<void>;
  onFailure?(tx: PoolClient, actor: Actor, commandId: string, leaseToken: string, errorCode: string): Promise<void>;
};
const digest = (data: string) => createHash('sha256').update(data).digest('hex');
const stable = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
// This value also pins the checkpoint wire protocol to the installed package versions.
// Update it together with state/graph migrations before accepting older checkpoints.
export const PLANNER_GRAPH_VERSION = 'bankpilot-planner-g9i-v1-lg1.5.2-cp1.2.1-pg1.1.2';
export const PLANNER_STATE_SCHEMA_VERSION = 'bankpilot-planner-state-v5';
export const PLANNER_INPUT_SNAPSHOT_VERSION = 1;

/** A grant is checked immediately before each model dispatch, including a
 * provider retry. End records must still close already-dispatched attempts.
 * Provider masks observer exceptions, so retain this server-side cause. */
export function guardContinuationModelAttempts(
  observer: NonNullable<PlannerExecutionContext['modelAttemptObserver']>,
  assertGrant: () => Promise<void>,
) {
  let grantError: unknown;
  return {
    async observe(...args: Parameters<NonNullable<PlannerExecutionContext['modelAttemptObserver']>>) {
      if (args[0].type === 'attempt_start') {
        try { await assertGrant(); }
        catch (error) { grantError ??= error; throw error; }
      }
      await observer(...args);
    },
    check() { if (grantError) throw grantError; },
  };
}

export function plannerInputDigest(input: PlannerInput): string {
  const { deadlineAt: _deadlineAt, ...immutableInput } = input;
  return digest(stable(immutableInput));
}

function restoreFrozenPlannerInput(row: Record<string, any>, requireCurrentGraph = true, expected?: { taskId: string; message: string }): { input: PlannerInput; digest: string } | undefined {
  const version = row.prepared_input_version;
  const digestValue = row.graph_input_digest;
  const graphVersion = row.graph_version;
  const schemaVersion = row.graph_schema_version;
  if (version == null && digestValue == null && graphVersion == null && schemaVersion == null) return undefined;
  if (version !== PLANNER_INPUT_SNAPSHOT_VERSION || typeof graphVersion !== 'string' || !graphVersion
    || typeof schemaVersion !== 'string' || !schemaVersion
    || (requireCurrentGraph && (graphVersion !== PLANNER_GRAPH_VERSION || schemaVersion !== PLANNER_STATE_SCHEMA_VERSION))
    || typeof digestValue !== 'string' || !/^[a-f0-9]{64}$/.test(digestValue)) {
    throw new CoreError('PLANNER_SNAPSHOT_INCOMPATIBLE', '已冻结的规划输入版本不兼容，未重新解释原请求');
  }
  const value = row.prepared_input;
  if (!value || typeof value !== 'object' || typeof value.taskId !== 'string' || typeof value.message !== 'string'
    || !Array.isArray(value.accounts) || !Array.isArray(value.payees) || typeof value.referenceDate !== 'string') {
    throw new CoreError('PLANNER_SNAPSHOT_INVALID', '已冻结的规划输入不完整，未继续规划');
  }
  if (plannerInputDigest(value as PlannerInput) !== digestValue) {
    throw new CoreError('PLANNER_SNAPSHOT_DIGEST_MISMATCH', '已冻结的规划输入摘要不匹配，未继续规划');
  }
  if (expected && (value.taskId !== expected.taskId || value.message !== expected.message)) {
    throw new CoreError('PLANNER_SNAPSHOT_BINDING_MISMATCH', '已冻结的规划输入与当前命令不匹配，未继续规划');
  }
  return { input: { ...value, deadlineAt: Date.now() + 180_000 } as PlannerInput, digest: digestValue };
}

async function freezePlannerInput(pool: Pool, actor: Actor, commandId: string, leaseToken: string, input: PlannerInput): Promise<string> {
  const inputDigest = plannerInputDigest(input);
  const frozen = await pool.query(`UPDATE bp_plan_commands SET prepared_input=$4,prepared_input_version=$5,
      graph_version=$6,graph_schema_version=$7,graph_input_digest=$8,updated_at=now()
    WHERE user_id=$1 AND command_id=$2 AND lease_token=$3 AND status='running' AND updated_at>now()-interval '4 minutes' AND result IS NULL AND proposal IS NULL
      AND prepared_input_version IS NULL AND graph_input_digest IS NULL RETURNING command_id`,
  [actor.userId, commandId, leaseToken, JSON.stringify(input), PLANNER_INPUT_SNAPSHOT_VERSION,
    PLANNER_GRAPH_VERSION, PLANNER_STATE_SCHEMA_VERSION, inputDigest]);
  if (!frozen.rowCount) throw new CoreError('PLAN_SUPERSEDED', '此规划已由新的恢复请求接管');
  return inputDigest;
}

export function createPlanRunner(options: PlanRunnerOptions) {
  const { pool, core, planner } = options;
  const management = () => { if (!options.management) throw new CoreError('MANAGEMENT_UNAVAILABLE', '联系人、卡片及订阅模块尚未初始化', 503); return options.management; };
  const investment = () => { if (!options.investment) throw new CoreError('INVESTMENT_UNAVAILABLE', '理财与到账时间线模块尚未初始化', 503); return options.investment; };
  const goals = () => { if (!options.goals) throw new CoreError('GOALS_UNAVAILABLE', '生活目标模块尚未初始化', 503); return options.goals; };
  const dashboardFor = async (actor: Actor) => {
    const dashboard = await core.dashboard(actor);
    if (options.management) dashboard.payees = await management().contacts(actor);
    return dashboard;
  };
  const refreshPlanActions = async (actor: Actor, result: PlanEnvelope) => {
    result.actions = await Promise.all(result.actions.map(a => core.getAction(actor, a.id)));
    if (result.managementActions?.length && options.management) result.managementActions = await Promise.all(result.managementActions.map(a => management().getAction(actor, a.id)));
    if (result.investmentActions?.length && options.investment) result.investmentActions = await Promise.all(result.investmentActions.map(a => investment().getAction(actor, a.id)));
    if (result.goal && options.goals) result.goal = await goals().get(actor, result.goal.id);
    return result;
  };
  async function execute(actor: Actor, input: { message: string; commandId: string; conversationId?: string }): Promise<PlanEnvelope> {
    const messageHash = digest(input.message);
    const leaseToken = randomUUID();
    let proposal: Awaited<ReturnType<Planner['plan']>> | undefined;
    let prepared: PlannerInput | undefined;
    let planningInput: ConversationPlanningInput | undefined;
    let claimSnapshot: Record<string, any> = {};
    // A conversation command must already exist from atomic message acceptance.
    const inserted = input.conversationId ? { rowCount: 0, rows: [] as Record<string, any>[] } : await pool.query(`INSERT INTO bp_plan_commands(user_id,command_id,message_hash,lease_token,original_message,planning_input) VALUES($1,$2,$3,$4,$5,$6)
      ON CONFLICT DO NOTHING RETURNING command_id,root_command_id,revision,prepared_input,prepared_input_version,graph_version,graph_schema_version,graph_input_digest`, [actor.userId, input.commandId, messageHash, leaseToken, input.message, JSON.stringify({ version: 1, message: input.message, originalMessage: input.message })]);
    if (inserted.rowCount) claimSnapshot = inserted.rows[0]!;
    if (!inserted.rowCount) {
      const existing = (await pool.query('SELECT * FROM bp_plan_commands WHERE user_id=$1 AND command_id=$2', [actor.userId, input.commandId])).rows[0];
      if (!existing || (existing.conversation_id ?? undefined) !== input.conversationId) throw new CoreError('COMMAND_NOT_FOUND', '此对话中没有该请求', 404);
      if (existing.message_hash !== messageHash) throw new CoreError('COMMAND_CONFLICT', '同一请求编号不能用于不同指令');
      planningInput = existing.planning_input ?? undefined;
      prepared = existing.prepared_input ?? undefined;
      if (existing.result) {
        // Replays return current action states, never replay a transfer side effect.
        const result = existing.result;
        await refreshPlanActions(actor, result);
        return result;
      }
      if (existing.status === 'failed' && existing.planning_failure?.retryable === false) throw new PlanningServiceFailure(existing.planning_failure);
      // A crashed planner owns only proposals. A lease allows retrying with stable core command IDs.
      const retry = await pool.query(`UPDATE bp_plan_commands SET status='running',updated_at=now(),lease_token=$3,last_error_code=NULL
        WHERE user_id=$1 AND command_id=$2 AND result IS NULL
          AND (status<>'failed' OR planning_failure IS NULL OR planning_failure->>'retryable' IS DISTINCT FROM 'false')
          AND (status IN ('pending','failed') OR updated_at<now()-interval '4 minutes') RETURNING *`, [actor.userId, input.commandId, leaseToken]);
      if (!retry.rowCount) throw new CoreError('PLAN_RUNNING', '该指令正在规划，请稍后重试');
      proposal = retry.rows[0].proposal ?? undefined;
      prepared = retry.rows[0].prepared_input ?? undefined;
      planningInput = retry.rows[0].planning_input ?? undefined;
      claimSnapshot = retry.rows[0];
    }
    const journal = createPlanningJournal(pool, actor, input.commandId, leaseToken, { graphVersion: PLANNER_GRAPH_VERSION, schemaVersion: PLANNER_STATE_SCHEMA_VERSION });
    let frozenInputDigest: string | undefined;
    let graphAttemptSettled = false;
    let pendingPrerequisite: SubscriptionPrerequisite | undefined;
    const continuation = await options.continuations?.getBySuccessor(actor, input.commandId);
    const assertContinuationGrant = async () => {
      if (!continuation) return;
      const latest = await options.continuations!.getBySuccessor(actor, input.commandId);
      if (!latest || latest.state !== 'PLANNING' || latest.queryActionId !== continuation.queryActionId) throw new CoreError('CONTINUATION_STOPPED', '原请求续办已停止或状态已变化');
      await management().subscriptions(actor, continuation.queryActionId);
    };
    const guardedAttempts = guardContinuationModelAttempts(journal.observe, assertContinuationGrant);
    const checkObserver = () => { guardedAttempts.check(); journal.checkObserver(); };
    try {
      await assertContinuationGrant();
      const dashboard = await dashboardFor(actor);
      const taskId = `task-${digest(`${actor.userId}:${input.commandId}`).slice(0, 24)}`;
      let result = proposal;
      if (proposal) {
        const frozenProposalInput = restoreFrozenPlannerInput(claimSnapshot, false, { taskId, message: input.message });
        if (frozenProposalInput) prepared = frozenProposalInput.input;
        else if (prepared && (typeof prepared !== 'object' || prepared.taskId !== taskId || prepared.message !== input.message)) {
          throw new CoreError('PLANNER_SNAPSHOT_BINDING_MISMATCH', '旧规划提案与当前命令不匹配，未继续生成动作');
        }
      }
      if (!result && input.conversationId && !continuation && !planningInput?.typed) {
        const frozen = restoreFrozenPlannerInput(claimSnapshot, true, { taskId, message: input.message });
        const recognition = frozen?.input ?? await journal.load({ taskId, message: input.message })
          ?? await journal.freeze(await prepareRecognitionInput(options, actor, { taskId, message: input.message }, dashboard));
        if (!recognition.managementContext?.subscriptions) pendingPrerequisite = recognizeSubscriptionPrerequisite(input.message);
        if (pendingPrerequisite) {
          prepared = recognition;
          frozenInputDigest = frozen?.digest ?? await freezePlannerInput(pool, actor, input.commandId, leaseToken, recognition);
          result = { taskId, planVersion: 1, mode: 'scripted', summary: '原订阅请求已保存。请先确认查询授权；确认后会继续核对原请求，取消和拦截仍需分别确认。', events: [], suggestions: [], findings: [], evidence: [], managementSuggestions: [{ kind: 'SUBSCRIPTION_QUERY' }] };
        }
      }
      if (!result) {
        const typed = planningInput?.typed;
        let trustedSemantic: SemanticPlan | undefined;
        if (typed) {
          const { payeeId, amountMinor, targetDate, memo } = typed.slots;
          if (!payeeId || !dashboard.payees.some(p => p.id === payeeId) || !amountMinor || !/^[1-9]\d{0,11}$/.test(amountMinor) || (typed.operation === 'goal_create' && !targetDate)) {
            throw new CoreError('CLARIFICATION_CONTEXT_STALE', '补充请求的收款人或字段已不可用，请重新核对');
          }
          trustedSemantic = { status: 'ready', tasks: [{ operation: typed.operation, role: typed.operation === 'transfer' ? 'transfer' : 'goal', source: { text: planningInput!.originalMessage }, canonicalMessage: input.message, slots: { entityId: payeeId, amountMinor, ...(typed.operation === 'transfer' ? { memo: memo ?? '' } : {}), ...(targetDate ? { targetDate } : {}) } }], findings: [], modelRuns: [] };
        }
        const frozenInput = restoreFrozenPlannerInput(claimSnapshot, true, { taskId, message: input.message });
        if (frozenInput) {
          prepared = frozenInput.input;
          frozenInputDigest = frozenInput.digest;
        } else {
          let recognition = await journal.load({ taskId, message: input.message });
          if (!recognition) recognition = await journal.freeze(await prepareRecognitionInput(options, actor, { taskId, message: input.message, ...(continuation ? { subscriptionQueryActionId: continuation.queryActionId } : {}) }, dashboard));
          let semantic = await journal.semantic(recognition);
          if (!semantic && (trustedSemantic || planner.interpret)) {
            await journal.assertCurrent();
            semantic = trustedSemantic ?? await planner.interpret!(recognition, { modelAttemptObserver: guardedAttempts.observe });
            checkObserver();
            semantic = await journal.saveSemantic(recognition, semantic);
          }
          if (semantic?.status === 'failed') throw new PlanningServiceFailure(semantic.failure ?? planningFailure('SEMANTIC_PROVIDER_FAILED', semantic.modelRuns));
          await journal.assertCurrent();
          prepared = await completePlannerInput(options, actor, { ...recognition, ...(semantic ? { semanticIntent: semantic } : {}) });
          await journal.assertCurrent();
          frozenInputDigest = await freezePlannerInput(pool, actor, input.commandId, leaseToken, prepared);
        }
        if (continuation && (!prepared.semanticIntent || !verifySubscriptionContinuation(continuation.prerequisite, prepared.semanticIntent))) {
          throw new CoreError('CONTINUATION_SCOPE_MISMATCH', '未能完整核对原请求中的全部事项，未创建写入提案');
        }
        await assertContinuationGrant();
        const observation = await journal.observation();
        let executionContext: PlannerExecutionContext = { stageJournal: journal.stages(frozenInputDigest!), modelAttemptObserver: guardedAttempts.observe, priorReservedOutputTokens: observation.reserved };
        Object.assign(claimSnapshot, await journal.prepareGraphAttempt());
        if (options.checkpointAttempts) {
          const threadId = randomUUID();
          const checkpointIdentity: CheckpointJournalIdentity = {
            userId: actor.userId,
            commandId: input.commandId,
            rootCommandId: claimSnapshot.root_command_id ?? null,
            revision: Number(claimSnapshot.revision ?? 0),
            leaseToken,
            graphVersion: PLANNER_GRAPH_VERSION,
            graphSchemaVersion: PLANNER_STATE_SCHEMA_VERSION,
            inputDigest: frozenInputDigest!,
          };
          let resume = false;
          try {
            await options.checkpointAttempts.register(threadId, checkpointIdentity);
            const checkpointPointer = {
              threadId: claimSnapshot.graph_checkpoint_thread_id,
              checkpointNs: claimSnapshot.graph_checkpoint_ns,
              checkpointId: claimSnapshot.graph_checkpoint_id,
            };
            const hasCheckpointPointer = checkpointPointer.threadId != null || checkpointPointer.checkpointNs != null || checkpointPointer.checkpointId != null;
            if (hasCheckpointPointer) {
              if (!checkpointPointer.threadId || checkpointPointer.checkpointNs !== '' || !checkpointPointer.checkpointId || !options.checkpointAttempts.transfer) {
                throw new CoreError('CHECKPOINT_RESUME_UNAVAILABLE', '恢复快照不完整或恢复服务未配置，已安全停止');
              }
              const transferredHead = await options.checkpointAttempts.transfer(threadId, checkpointIdentity);
              if (transferredHead !== checkpointPointer.checkpointId) {
                throw new CoreError('CHECKPOINT_RESUME_FAILED', '恢复快照与可信检查点指针不一致，已安全停止');
              }
              resume = true;
            }
          } catch (error) {
            if (error instanceof Error && error.message === 'BP_CHECKPOINT_ATTEMPT_NOT_CURRENT') {
              throw new CoreError('PLAN_SUPERSEDED', '此规划已由新的恢复请求接管');
            }
            throw error;
          }
          executionContext = { ...executionContext, checkpointAttempt: { threadId, checkpointNs: '', resume } };
        }
        await journal.assertCurrent();
        try { result = await planner.plan(prepared, executionContext); } finally { graphAttemptSettled = true; }
        checkObserver();
        await journal.assertCurrent();
        if (result.failure) throw new PlanningServiceFailure(result.failure);
        result.modelAttempts = (await journal.observation()).attempts;
        if (typed) result.evidence.push({ source: 'clarification-fields', detail: JSON.stringify(typed.sources) });
        // A trusted raw report is not necessarily an answer to the user's
        // requested scope. Do not restore evidence withheld by bill review.
        if (result.billAnswerReview) {
          delete result.billReport;
          delete result.billReports;
          if (result.billAnswerReview.status === 'withheld') delete result.billAnalysis;
        } else {
          if (prepared.billReport) result.billReport = prepared.billReport;
          if (prepared.billReports) result.billReports = prepared.billReports;
        }
        if (prepared.fundsPreview) {
          result.fundsPreview = prepared.fundsPreview;
          if (!prepared.fundsPreview.allowed) {
            result.suggestions = [];
            result.findings = [...new Set([...result.findings, ...prepared.fundsPreview.reasons])];
          }
        }
      }
      if (continuation) {
        await assertContinuationGrant();
        if (!prepared || prepared.managementContext?.subscriptions?.queryActionId !== continuation.queryActionId) throw new CoreError('CONTINUATION_GRANT_MISMATCH', '续办未绑定原查询授权');
        result = publicContinuationResult(result, continuationProposalMatches(continuation.prerequisite, prepared, result));
      }
      if (!pendingPrerequisite && !continuation && result.managementSuggestions?.length === 1 && result.managementSuggestions[0]?.kind === 'SUBSCRIPTION_QUERY' && input.conversationId) {
        pendingPrerequisite = recognizeSubscriptionPrerequisite(input.message);
      }
      if (result.goalSuggestion && (result.suggestions.length || result.investmentSuggestions?.length || result.managementSuggestions?.length)) {
        throw new CoreError('INVALID_PROPOSAL', '目标计划不能同时创建绕过依赖的独立动作', 400);
      }
      // The domain model may propose or decline, but cannot change a merged field.
      const typed = planningInput?.typed;
      if (typed) {
        const slots = typed.slots;
        const extra = result.managementSuggestions?.length || result.investmentSuggestions?.length;
        const invalidTransfer = typed.operation === 'transfer' && (result.goalSuggestion || result.suggestions.length > 1 || result.suggestions.some(s => s.payeeId !== slots.payeeId || s.amountMinor !== slots.amountMinor || s.memo !== (slots.memo ?? '')));
        const invalidGoal = typed.operation === 'goal_create' && (result.suggestions.length || (result.goalSuggestion && (result.goalSuggestion.payeeId !== slots.payeeId || result.goalSuggestion.amountMinor !== slots.amountMinor || result.goalSuggestion.targetDate !== slots.targetDate || result.goalSuggestion.funding)));
        if (extra || invalidTransfer || invalidGoal) throw new CoreError('CLARIFICATION_PROPOSAL_MISMATCH', '规划结果改变了已核对的补充字段，未创建动作');
      }
      // Freeze the normalized proposal before any draft side effect. A retry must not ask a model to regenerate it.
      if (!proposal) {
        if (!prepared || !frozenInputDigest) throw new CoreError('PLANNER_SNAPSHOT_INVALID', '完整规划输入没有在规划前冻结');
        const snapshot = await pool.query(`UPDATE bp_plan_commands SET proposal=$4,updated_at=now()
          WHERE user_id=$1 AND command_id=$2 AND lease_token=$3 AND status='running' AND updated_at>now()-interval '4 minutes' AND result IS NULL AND proposal IS NULL
            AND prepared_input_version=$5 AND graph_version=$6 AND graph_schema_version=$7 AND graph_input_digest=$8 RETURNING command_id`,
        [actor.userId, input.commandId, leaseToken, JSON.stringify(result), PLANNER_INPUT_SNAPSHOT_VERSION,
          PLANNER_GRAPH_VERSION, PLANNER_STATE_SCHEMA_VERSION, frozenInputDigest]);
        if (!snapshot.rowCount) throw new CoreError('PLAN_SUPERSEDED', '此规划已由新的恢复请求接管');
      }
      await journal.assertCurrent();
      const actions = [];
      for (const [index, suggestion] of result.suggestions.entries()) {
        await journal.assertCurrent();
        const frozenAccountId = Array.isArray(prepared?.accounts) ? prepared.accounts[0]?.id : undefined;
        if (!frozenAccountId) throw new CoreError('LEGACY_PROPOSAL_ACCOUNT_UNRECOVERABLE', '这条旧提案没有可验证的原转出账户，已安全停止；请重新提交请求');
        if (!dashboard.payees.some(p => p.id === suggestion.payeeId) || !dashboard.accounts.some(account => account.id === frozenAccountId)) throw new CoreError('INVALID_PROPOSAL', '规划结果引用了已不可用的账户或收款人');
        actions.push(await core.createTransfer(actor, {
          commandId: `plan:${digest(`${actor.userId}:${input.commandId}:${index}`)}`, taskId,
          accountId: frozenAccountId, ...suggestion,
        }));
      }
      const managementActions: ManagementAction[] = [];
      const managementInputs = (result.managementSuggestions ?? []).map((spec, index) => ({ commandId: `mgmt-plan:${digest(`${actor.userId}:${input.commandId}:${index}`)}`, taskId, spec }));
      if (continuation && managementInputs.length) {
        await journal.assertCurrent(); await assertContinuationGrant();
        managementActions.push(...await management().prepareBatch(actor, managementInputs));
      } else for (const item of managementInputs) {
        await journal.assertCurrent();
        managementActions.push(await management().prepare(actor, item));
      }
      const investmentActions = [];
      for (const [index, spec] of (result.investmentSuggestions ?? []).entries()) {
        await journal.assertCurrent();
        investmentActions.push(await investment().prepare(actor, { commandId: `invest-plan:${digest(`${actor.userId}:${input.commandId}:${index}`)}`, taskId, ...spec }));
      }
      await journal.assertCurrent();
      const goal = result.goalSuggestion ? await goals().create(actor, { ...result.goalSuggestion, commandId: `goal-plan:${digest(`${actor.userId}:${input.commandId}`)}` }) : undefined;
      if (continuation) managementActions.splice(0, managementActions.length, ...redactStoredContinuationActions(managementActions));
      const envelope: PlanEnvelope = { ...result, actions, ...(managementActions.length ? { managementActions } : {}), ...(investmentActions.length ? { investmentActions } : {}), ...(goal ? { goal } : {}) };
      await withTransaction(pool, async tx => {
        const completed = await tx.query(`UPDATE bp_plan_commands SET status='complete',result=$3,updated_at=now(),last_error_code=NULL,planning_failure=NULL
          WHERE user_id=$1 AND command_id=$2 AND lease_token=$4 AND status='running' AND updated_at>now()-interval '4 minutes' AND result IS NULL RETURNING command_id`, [actor.userId, input.commandId, JSON.stringify(envelope), leaseToken]);
        if (!completed.rowCount) throw new CoreError('PLAN_SUPERSEDED', '此规划已由新的恢复请求接管');
        if (pendingPrerequisite && options.continuations && managementActions[0]) {
          await options.continuations.registerWaitingTx(tx, actor, { sourceCommandId: input.commandId, queryActionId: managementActions[0].id, prerequisite: pendingPrerequisite });
          envelope.subscriptionContinuation = { sourceCommandId: input.commandId, queryActionId: managementActions[0].id, taskCount: pendingPrerequisite.tasks.length, state: 'WAITING_QUERY' };
          await tx.query('UPDATE bp_plan_commands SET result=$3 WHERE user_id=$1 AND command_id=$2', [actor.userId, input.commandId, JSON.stringify(envelope)]);
        }
        if (continuation) await options.continuations!.completeTx(tx, actor, { successorCommandId: input.commandId, commandLeaseToken: leaseToken, state: result.clarification ? 'NEEDS_CLARIFICATION' : 'WRITE_PREPARED' });
        await options.onComplete?.(tx, actor, input.commandId, leaseToken, envelope, prepared);
      });
      return envelope;
    } catch (error) {
      // Provider deliberately masks sink exceptions; retain our trusted budget/lease cause.
      try { checkObserver(); } catch (observedError) { error = observedError; }
      const code = error instanceof CoreError || error instanceof PlanningStageFailure ? error.code : error instanceof Error && 'code' in error && ['MODEL_OUTPUT_BUDGET_EXHAUSTED', 'MODEL_OUTPUT_BUDGET_INVALID', 'MODEL_ATTEMPT_START_PERSIST_FAILED', 'MODEL_ATTEMPT_END_PERSIST_FAILED'].includes(String(error.code)) ? String(error.code) : 'PLAN_FAILED';
      const phase: PlanningFailure['phase'] = prepared?.semanticIntent && prepared.semanticIntent.status !== 'failed' || proposal || permanentPlanningSnapshotFailure(code) ? 'planning' : 'semantic_intent';
      let failure: PlanningFailure | undefined = error instanceof PlanningServiceFailure || error instanceof PlanningStageFailure ? error.failure
        : /^MODEL_(?:OUTPUT_BUDGET_|ATTEMPT_)/.test(code) || permanentPlanningSnapshotFailure(code) ? planningFailure(code, prepared?.semanticIntent?.modelRuns, false, phase) : undefined;
      if (failure?.phase === 'planning' && frozenInputDigest && code !== 'PLAN_SUPERSEDED') {
        // The graph has settled all in-flight siblings before reaching this catch.
        // Replace the selected stage's subset, rather than append and duplicate it.
        // A stale lease or invalid journal must never mask the original failure.
        try {
          const history = await journal.stages(frozenInputDigest).history();
          failure = { ...failure, modelRuns: [...(prepared?.semanticIntent?.modelRuns ?? []), ...history] };
        } catch { /* Keep the original failure when its history cannot be trusted. */ }
      }
      try {
        await withTransaction(pool, async tx => {
        const failed = await tx.query(`UPDATE bp_plan_commands SET status='failed',last_error_code=$4,updated_at=now(),planning_failure=$5,
          graph_restart_required=$6,planning_failures=planning_failures || CASE WHEN $5::jsonb IS NULL THEN '[]'::jsonb ELSE jsonb_build_array($5::jsonb) END
          WHERE user_id=$1 AND command_id=$2 AND lease_token=$3 AND status='running' AND updated_at>now()-interval '4 minutes' AND result IS NULL RETURNING command_id`, [actor.userId, input.commandId, leaseToken, code, failure ? JSON.stringify(failure) : null, graphAttemptSettled && failure?.phase === 'planning']);
        if (failed.rowCount && continuation) await options.continuations!.completeTx(tx, actor, { successorCommandId: input.commandId, commandLeaseToken: leaseToken,
          state: ['QUERY_ACCESS_EXPIRED','QUERY_AUTHORIZATION_REQUIRED'].includes(code) ? 'NEEDS_QUERY_REAUTH' : code === 'CONTINUATION_SCOPE_MISMATCH' || failure?.retryable === false ? 'NEEDS_CLARIFICATION' : 'FAILED_RECOVERABLE', lastErrorCode: code });
        if (failed.rowCount) await options.onFailure?.(tx, actor, input.commandId, leaseToken, code);
        });
      } catch { /* Preserve the original failure, including when checkout/COMMIT fails. The fenced journal remains recoverable. */ }
      throw error;
    }
  }
  return { execute, refreshPlanActions };
}
