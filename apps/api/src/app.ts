import { withTransaction } from '../../../packages/core/src/database.js';
import { createSubscriptionContinuationStore } from './subscription-continuations.js';
import { createHash, randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z, ZodError } from 'zod';
import type { Pool } from 'pg';
import { CoreError } from '../../../packages/core/src/index.js';
import { transferInputSchema, managementInputSchema, redemptionInputSchema, createGoalInputSchema, replanGoalInputSchema, type Actor, type CoreService, type Planner, type FinanceService, type ManagementService, type InvestmentService, type GoalsService, type PreparationFamily, type PreparationOperation, type PreparationResult } from '../../../packages/contracts/src/index.js';
import { normalizedPreparationInput, preparationFamilySchema } from '../../../packages/core/src/preparations.js';
import { createPlanRunner } from './plan-runner.js';
import { createConversationService } from './conversations.js';
import { conversationMessageSchema, type ConversationCommand } from '../../../packages/contracts/src/conversations.js';
import type { Auth } from './config.js';
import { createPasskeys, migrateWebAuthn } from './webauthn.js';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import type { CheckpointJournalIdentity } from '../../../packages/agents/src/checkpoint-fencing.js';

export async function migrateApi(pool: Pool) {
  await migrateWebAuthn(pool);
  await pool.query(`CREATE TABLE IF NOT EXISTS bp_plan_commands (
    user_id text NOT NULL, command_id text NOT NULL, message_hash text NOT NULL,
    status text NOT NULL DEFAULT 'running', result jsonb, updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY(user_id,command_id)
  );
  ALTER TABLE bp_plan_commands ADD COLUMN IF NOT EXISTS proposal jsonb;
  ALTER TABLE bp_plan_commands ADD COLUMN IF NOT EXISTS lease_token uuid;`);
  await createConversationService(pool).migrate();
}
type Options = { pool: Pool; auth: Auth; core: CoreService; planner: Planner; finance?: FinanceService; management?: ManagementService; investment?: InvestmentService; goals?: GoalsService; checkpointAttempts?: { register(threadId: string, identity: CheckpointJournalIdentity): Promise<void>; transfer?(threadId: string, identity: CheckpointJournalIdentity): Promise<string | undefined> }; origin: string; rpID: string; sandbox: boolean; plannerMode: string };
const planInput = z.object({ message: z.string().trim().min(1).max(2000), commandId: z.string().min(8).max(128) }).strict();
const responseInput = z.object({ response: z.object({
  id: z.string(), rawId: z.string(), type: z.literal('public-key'),
  clientExtensionResults: z.record(z.string(), z.unknown()),
  response: z.object({ clientDataJSON: z.string().max(20000) }).passthrough(),
}).passthrough() }).strict();

export function createApp(options: Options) {
  const { pool, auth, core, planner, origin, rpID } = options;
  const passkeys = createPasskeys(pool, core, origin, rpID);
  const managementPasskeys = options.management ? createPasskeys(pool, options.management, origin, rpID, 'management') : undefined;
  const investmentPasskeys = options.investment ? createPasskeys(pool, options.investment, origin, rpID, 'investment') : undefined;
  const investment = () => {
    if (!options.investment) throw new CoreError('INVESTMENT_UNAVAILABLE', '理财与到账时间线模块尚未初始化', 503);
    return options.investment;
  };
  const goals = () => {
    if (!options.goals) throw new CoreError('GOALS_UNAVAILABLE', '生活目标模块尚未初始化', 503);
    return options.goals;
  };
  const management = () => {
    if (!options.management) throw new CoreError('MANAGEMENT_UNAVAILABLE', '联系人、卡片及订阅模块尚未初始化', 503);
    return options.management;
  };
  const preparations = () => {
    if (!core.preparations) throw new CoreError('PREPARATIONS_UNAVAILABLE', '准备请求登记尚未初始化', 503);
    return core.preparations;
  };
  const preparationResult = async (actor: Actor, family: PreparationFamily, commandId: string): Promise<PreparationResult> => {
    const request = await preparations().get(actor, family, commandId);
    if (request.state !== 'PREPARED') throw new CoreError('PREPARATION_NOT_READY', request.state === 'ABANDONED' ? '准备请求已放弃' : '准备请求尚未生成结果', 409);
    if (family === 'management') return { family, result: await management().getByCommand(actor, commandId) };
    if (family === 'investment') return { family, result: await investment().getByCommand(actor, commandId) };
    return { family, result: await goals().getByCommand(actor, commandId) };
  };
  const runPreparation = async (actor: Actor, family: PreparationFamily, operation: PreparationOperation, raw: unknown): Promise<PreparationResult> => {
    const input = normalizedPreparationInput(operation, raw), commandId = String(input.commandId);
    // Persist acceptance in its own short transaction, before a business call may
    // fail or the HTTP response may disappear. Mock services retain old test contracts.
    if (core.preparations) {
      const accepted = await core.preparations.accept(actor, { family, operation, input });
      if (accepted.state === 'PREPARED') return preparationResult(actor, family, commandId);
    }
    try {
      if (operation === 'management') return { family: 'management', result: await management().prepare(actor, managementInputSchema.parse(input)) };
      if (operation === 'redemption') return { family: 'investment', result: await investment().prepare(actor, redemptionInputSchema.parse(input)) };
      if (operation === 'goal-create') return { family: 'goal', result: await goals().create(actor, createGoalInputSchema.parse(input)) };
      const { goalId, ...replan } = input;
      return { family: 'goal', result: await goals().replan(actor, String(goalId), replanGoalInputSchema.parse(replan)) };
    } catch (error) {
      if (core.preparations) {
        // Raw database/provider exceptions may contain connection data or payloads.
        // Only bounded domain errors are suitable for the public recovery record.
        const failure = error instanceof CoreError ? { code: error.code, message: error.message }
          : { code: 'PREPARATION_FAILED', message: '准备请求未完成，请读取原请求状态后明确重试' };
        try { await core.preparations.recordFailure(actor, family, commandId, failure); } catch { /* keep the original failure; acceptance is already durable */ }
      }
      throw error;
    }
  };
  const dashboardFor = async (actor: Actor) => {
    const dashboard = await core.dashboard(actor);
    if (options.management) dashboard.payees = await options.management.contacts(actor);
    return dashboard;
  };
  const conversations = createConversationService(pool, { getPayees: async actor => (await dashboardFor(actor)).payees });
  const subscriptionContinuations = createSubscriptionContinuationStore(pool);
  const planRunner = createPlanRunner({ ...options, continuations: subscriptionContinuations, onComplete: conversations.onComplete, onFailure: conversations.onFailure });
  const { refreshPlanActions } = planRunner;
  const backgroundPlans = new Set<Promise<unknown>>();
  const activeRequests = new Set<Promise<void>>();
  const launchPlan = (actor: Actor, command: ConversationCommand) => {
    if (command.status === 'complete' || !command.retryable) return;
    const job = planRunner.execute(actor, { commandId: command.commandId, conversationId: command.conversationId, message: command.planningInput.message })
      .catch(error => {
        // Failure details are projected by the fenced command transaction, not by the HTTP response.
        // A DB outage leaves the same durable command available for lease-based recovery.
        if (!(error instanceof CoreError && ['PLAN_RUNNING', 'PLAN_SUPERSEDED'].includes(error.code))) console.error('Conversation planning failed:', error instanceof CoreError ? error.code : 'PLAN_FAILED');
      });
    backgroundPlans.add(job);
    void job.finally(() => backgroundPlans.delete(job));
  };
  const continuationOwners = new Set<string>();
  const continuationSourceCursors = new Map<string, string>();
  const pendingExplicitContinuations = new Map<string, Set<string>>();
  const resumeSubscriptions = async (actor: Actor, explicit = false, sourceCommandId?: string) => {
    if (!options.management) return;
    if (continuationOwners.has(actor.userId)) {
      if (explicit && sourceCommandId) {
        const pending = pendingExplicitContinuations.get(actor.userId) ?? new Set<string>();
        pending.add(sourceCommandId); pendingExplicitContinuations.set(actor.userId, pending);
      }
      return;
    }
    continuationOwners.add(actor.userId);
    try {
      const selected = sourceCommandId ? await subscriptionContinuations.get(actor, sourceCommandId) : undefined;
      const rows = sourceCommandId ? (selected ? [selected] : []) : await subscriptionContinuations.listForUser(actor, {
        states: explicit ? ['WAITING_QUERY','PLANNING','FAILED_RECOVERABLE'] : ['WAITING_QUERY','PLANNING'],
        afterSourceCommandId: continuationSourceCursors.get(actor.userId) ?? '', limit: 100,
      });
      if (!sourceCommandId) {
        if (rows.length === 100) continuationSourceCursors.set(actor.userId, rows[99]!.sourceCommandId);
        else continuationSourceCursors.delete(actor.userId);
      }
      for (const row of rows) {
        if (sourceCommandId && row.sourceCommandId !== sourceCommandId) continue;
        if (!['WAITING_QUERY','PLANNING', ...(explicit ? ['FAILED_RECOVERABLE'] : [])].includes(row.state)) continue;
        if (row.successorCommandId) {
          const child = await conversations.getCommand(actor, row.conversationId, row.successorCommandId);
          if (child.status === 'running') {
            if (child.retryable) {
              try { await planRunner.execute(actor, { commandId: child.commandId, conversationId: child.conversationId, message: child.planningInput.message }); }
              catch (error) { console.error('Subscription continuation lease recovery:', error instanceof CoreError ? error.code : 'PLAN_FAILED'); }
            }
            continue;
          }
        }
        const query = await management().getAction(actor, row.queryActionId);
        if (query.status !== 'SUCCEEDED') {
          if (query.status === 'CANCELLED' || Date.parse(query.expiresAt) <= Date.now()) await subscriptionContinuations.markNeedsQuery(actor, { sourceCommandId: row.sourceCommandId, queryActionId: row.queryActionId, expectedStateVersion: row.stateVersion, lastErrorCode: 'QUERY_AUTHORIZATION_REQUIRED' });
          continue;
        }
        let grant;
        try { grant = await management().subscriptions(actor, row.queryActionId); }
        catch (error) {
          if (!(error instanceof CoreError) || !['QUERY_ACCESS_EXPIRED','QUERY_AUTHORIZATION_REQUIRED'].includes(error.code)) throw error;
          await subscriptionContinuations.markNeedsQuery(actor, { sourceCommandId: row.sourceCommandId, queryActionId: row.queryActionId, expectedStateVersion: row.stateVersion, lastErrorCode: error.code });
          continue;
        }
        if (row.successorCommandId) {
          const child = await conversations.getCommand(actor, row.conversationId, row.successorCommandId);
          if (child.status === 'running' && !child.retryable) continue;
          if (child.status === 'complete') continue;
        }
        const claim = await subscriptionContinuations.claimGranted(actor, { sourceCommandId: row.sourceCommandId, queryActionId: row.queryActionId, expectedStateVersion: row.stateVersion, grantExpiresAt: grant.accessExpiresAt });
        if (!claim?.leaseToken) continue;
        const created = await subscriptionContinuations.createSuccessor(actor, { sourceCommandId: row.sourceCommandId, leaseToken: claim.leaseToken });
        if (!created.commandId || created.continuation.state !== 'PLANNING') continue;
        const child = await conversations.getCommand(actor, row.conversationId, created.commandId);
        // Execute only the durable child, using the original user message bytes.
        try { await planRunner.execute(actor, { commandId: child.commandId, conversationId: child.conversationId, message: child.planningInput.message }); }
        catch (error) { console.error('Subscription continuation failed:', error instanceof CoreError ? error.code : 'PLAN_FAILED'); }
      }
    } finally {
      continuationOwners.delete(actor.userId);
      const pending = pendingExplicitContinuations.get(actor.userId);
      const next = pending?.values().next().value;
      if (next) {
        pending!.delete(next);
        if (!pending!.size) pendingExplicitContinuations.delete(actor.userId);
        launchSubscriptions(actor, true, next);
      }
    }
  };
  const launchSubscriptions = (actor: Actor, explicit = false, sourceCommandId?: string) => {
    const job = resumeSubscriptions(actor, explicit, sourceCommandId).catch(error => console.error('Subscription continuation recovery failed:', error instanceof CoreError ? error.code : 'RECOVERY_FAILED'));
    backgroundPlans.add(job); void job.finally(() => backgroundPlans.delete(job));
  };
  const decorateContinuation = async (actor: Actor, command: ConversationCommand) => {
    if (!command.result?.subscriptionContinuation) return command;
    const row = await subscriptionContinuations.get(actor, command.commandId);
    if (row) command.result.subscriptionContinuation = { sourceCommandId: row.sourceCommandId, queryActionId: row.queryActionId, taskCount: row.prerequisite.tasks.length, state: row.state, ...(row.successorCommandId ? { successorCommandId: row.successorCommandId } : {}) };
    return command;
  };
  let continuationTimer: ReturnType<typeof setTimeout> | undefined;
  let continuationScanning = false;
  let continuationOwnerCursor = '';
  const startContinuations = () => {
    if (continuationScanning) return;
    continuationScanning = true;
    const tick = async () => {
      try {
        const owners = (await pool.query("SELECT DISTINCT user_id FROM bp_subscription_continuations WHERE is_current AND state IN ('WAITING_QUERY','PLANNING') AND user_id>$1 ORDER BY user_id LIMIT 100", [continuationOwnerCursor])).rows;
        continuationOwnerCursor = owners.at(-1)?.user_id ?? '';
        for (const row of owners) if (continuationScanning) launchSubscriptions({ userId: row.user_id });
      } catch { /* Durable rows remain available; no inferred success on a DB outage. */ }
      finally { if (continuationScanning) { continuationTimer = setTimeout(tick, 3000); continuationTimer.unref(); } }
    };
    void tick();
  };
  const stopContinuations = () => { continuationScanning = false; if (continuationTimer) clearTimeout(continuationTimer); };
  const finance = () => {
    if (!options.finance) throw new CoreError('FINANCE_UNAVAILABLE', '账单与资金模块尚未初始化', 503);
    return options.finance;
  };
  const app = new Hono<{ Variables: { actor: Actor; email: string } }>();
  app.use('*', bodyLimit({ maxSize: 64 * 1024 }));
  app.use('*', async (c, next) => {
    let resolveRequest!: () => void;
    const settled = new Promise<void>(resolve => { resolveRequest = resolve; });
    activeRequests.add(settled);
    c.header('Cache-Control', 'no-store');
    c.header('X-Content-Type-Options', 'nosniff');
    try {
      if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method) && c.req.header('origin') !== origin) {
        return c.json({ error: { code: 'ORIGIN_REJECTED', message: '请求来源不匹配' } }, 403);
      }
      await next();
    } finally {
      activeRequests.delete(settled);
      resolveRequest();
    }
  });
  app.get('/api/health', c => c.json({ status: 'ok', mode: options.plannerMode, sandbox: options.sandbox }));
  // The demo account is created by setup. Public account enrollment is outside this phase.
  app.post('/api/auth/sign-up/email', c => c.json({ error: { code: 'REGISTRATION_DISABLED', message: '请使用初始化的演示账户' } }, 403));
  app.on(['POST', 'GET'], '/api/auth/*', c => auth.handler(c.req.raw));
  app.use('/api/*', async (c, next) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) return c.json({ error: { code: 'UNAUTHENTICATED', message: '请先登录演示账户' } }, 401);
    c.set('actor', { userId: session.user.id });
    c.set('email', session.user.email);
    await next();
  });
  app.get('/api/dashboard', async c => {
    const actor = c.get('actor');
    const dashboard = await dashboardFor(actor);
    const record = (await pool.query(`SELECT result FROM bp_plan_commands WHERE user_id=$1 AND status='complete' AND result IS NOT NULL ORDER BY updated_at DESC LIMIT 1`, [actor.userId])).rows[0];
    const latestPlan = record?.result;
    if (latestPlan) await refreshPlanActions(actor, latestPlan);
    return c.json({ ...dashboard, passkeyCount: await passkeys.count(actor), plannerMode: options.plannerMode, ...(latestPlan ? { latestPlan } : {}) });
  });
  app.get('/api/session', c => c.json({ userId: c.get('actor').userId, email: c.get('email') }));
  app.get('/api/preparation-requests', async c => {
    const query = z.object({ limit: z.coerce.number().int().min(1).max(100).optional(), cursor: z.string().min(1).max(2048).optional() }).strict().parse(c.req.query());
    return c.json(await preparations().list(c.get('actor'), query));
  });
  app.get('/api/preparation-requests/:family/:commandId', async c => c.json(await preparations().get(c.get('actor'), preparationFamilySchema.parse(c.req.param('family')), c.req.param('commandId'))));
  app.get('/api/preparation-requests/:family/:commandId/result', async c => c.json(await preparationResult(c.get('actor'), preparationFamilySchema.parse(c.req.param('family')), c.req.param('commandId'))));
  app.post('/api/preparation-requests/:family/:commandId/retry', async c => {
    z.object({}).strict().parse(await c.req.json());
    const actor = c.get('actor'), family = preparationFamilySchema.parse(c.req.param('family')), commandId = c.req.param('commandId');
    const request = await preparations().get(actor, family, commandId);
    if (request.state === 'PREPARED') return c.json(await preparationResult(actor, family, commandId));
    if (request.state === 'ABANDONED') throw new CoreError('PREPARATION_ABANDONED', '此准备请求已放弃，请使用新的指令编号', 409);
    if (!request.operation || !request.input) throw new CoreError('PREPARATION_NOT_RETRYABLE', '准备请求缺少可重试参数', 409);
    return c.json(await runPreparation(actor, family, request.operation, request.input));
  });
  app.post('/api/preparation-requests/:family/:commandId/abandon', async c => {
    z.object({}).strict().parse(await c.req.json());
    return c.json(await preparations().abandon(c.get('actor'), preparationFamilySchema.parse(c.req.param('family')), c.req.param('commandId')));
  });
  app.get('/api/conversations', async c => {
    const query = z.object({ cursor: z.string().min(1).max(2048).optional(), limit: z.coerce.number().int().min(1).max(100).optional() }).strict().parse(c.req.query());
    return c.json(await conversations.list(c.get('actor'), query));
  });
  app.get('/api/conversations/:id', async c => c.json(await conversations.get(c.get('actor'), c.req.param('id'))));
  app.get('/api/conversations/:id/recovery', async c => {
    const query = z.object({ cursor: z.string().min(1).max(2048).optional(), limit: z.coerce.number().int().min(1).max(100).optional() }).strict().parse(c.req.query());
    return c.json(await conversations.recovery(c.get('actor'), c.req.param('id'), query));
  });
  app.post('/api/conversations', async c => {
    const input = z.object({ title: z.string().trim().min(1).max(100).optional() }).strict().parse(await c.req.json());
    return c.json(await conversations.create(c.get('actor'), input), 201);
  });
  app.get('/api/conversations/:id/messages', async c => {
    const query = z.object({ beforeSequence: z.coerce.number().int().positive().optional(), limit: z.coerce.number().int().min(1).max(100).optional() }).strict().parse(c.req.query());
    const history = await conversations.history(c.get('actor'), c.req.param('id'), query);
    history.commands = await Promise.all(history.commands.map(async command => {
      // Stored continuation cards are deliberately neutral. Resolve their current
      // disclosure through Core before they become a UI observation; otherwise
      // the neutral stored copy suppresses a concurrently fetched authorized card.
      const result = command.result as Parameters<typeof refreshPlanActions>[1] | undefined;
      if (result?.managementActions?.some(action => action.detailsRedacted === true)) {
        await refreshPlanActions(c.get('actor'), result);
      }
      return decorateContinuation(c.get('actor'), command);
    }));
    return c.json(history);
  });
  app.post('/api/conversations/:id/messages', async c => {
    const input = conversationMessageSchema.parse(await c.req.json());
    const accepted = await conversations.accept(c.get('actor'), c.req.param('id'), input);
    // A replay is only an idempotent read of the original acceptance. In
    // particular, it must not implicitly take over an expired running lease;
    // recovery is initiated only through the explicit command retry route.
    if (!accepted.replayed) launchPlan(c.get('actor'), accepted.command);
    return c.json(accepted, 202);
  });
  app.get('/api/conversations/:id/commands/:commandId', async c => {
    const command = await conversations.getCommand(c.get('actor'), c.req.param('id'), c.req.param('commandId'));
    if (command.result) await refreshPlanActions(c.get('actor'), command.result as Parameters<typeof refreshPlanActions>[1]);
    return c.json(await decorateContinuation(c.get('actor'), command));
  });
  app.post('/api/conversations/:id/commands/:commandId/retry', async c => {
    z.object({}).strict().parse(await c.req.json());
    const command = await conversations.getCommand(c.get('actor'), c.req.param('id'), c.req.param('commandId'));
    if (command.result) await refreshPlanActions(c.get('actor'), command.result as Parameters<typeof refreshPlanActions>[1]);
    if (command.status === 'failed' && !command.retryable) throw new CoreError(command.failure?.code ?? 'PLAN_NOT_RETRYABLE', command.failure?.message ?? '此请求当前不能重试', 409);
    const continuation = await subscriptionContinuations.getBySuccessor(c.get('actor'), command.commandId);
    if (continuation) launchSubscriptions(c.get('actor'), true, continuation.sourceCommandId);
    else launchPlan(c.get('actor'), command);
    return c.json(command, command.status === 'complete' ? 200 : 202);
  });
  app.post('/api/conversations/:id/subscription-continuations/:sourceCommandId/resume', async c => {
    z.object({}).strict().parse(await c.req.json());
    const command = await conversations.getCommand(c.get('actor'), c.req.param('id'), c.req.param('sourceCommandId'));
    launchSubscriptions(c.get('actor'), true, command.commandId);
    return c.json(await decorateContinuation(c.get('actor'), command), 202);
  });
  app.post('/api/conversations/:id/subscription-continuations/:sourceCommandId/requery', async c => {
    z.object({}).strict().parse(await c.req.json());
    const actor = c.get('actor'), command = await conversations.getCommand(actor, c.req.param('id'), c.req.param('sourceCommandId'));
    const row = await subscriptionContinuations.get(actor, command.commandId);
    if (!row || row.state !== 'NEEDS_QUERY_REAUTH') throw new CoreError('QUERY_REAUTH_NOT_REQUIRED', '当前请求不需要重新查询，请刷新状态', 409);
    const id = createHash('sha256').update(`${actor.userId}:${command.commandId}:${row.grantCycle + 1}`).digest('hex');
    const action = await management().prepare(actor, { commandId: `continuation-query:${id}`, taskId: command.result?.taskId, spec: { kind: 'SUBSCRIPTION_QUERY' } });
    await withTransaction(pool, async tx => {
      const fresh = await subscriptionContinuations.registerWaitingTx(tx, actor, { sourceCommandId: command.commandId, queryActionId: action.id, prerequisite: row.prerequisite });
      const result = { ...command.result!, summary: '原请求已保留。请重新确认查询授权，随后按原请求核对；原有过期提案不会改绑到新授权。', managementActions: [action],
        subscriptionContinuation: { sourceCommandId: command.commandId, queryActionId: action.id, taskCount: row.prerequisite.tasks.length, state: fresh.state } };
      await tx.query('UPDATE bp_plan_commands SET result=$3,updated_at=now() WHERE user_id=$1 AND command_id=$2', [actor.userId, command.commandId, JSON.stringify(result)]);
    });
    return c.json(await decorateContinuation(actor, await conversations.getCommand(actor, command.conversationId, command.commandId)), 201);
  });
  app.post('/api/conversations/:id/subscription-continuations/:sourceCommandId/stop', async c => {
    const { expectedStateVersion } = z.object({ expectedStateVersion: z.string().regex(/^\d+$/).optional() }).strict().parse(await c.req.json());
    await conversations.getCommand(c.get('actor'), c.req.param('id'), c.req.param('sourceCommandId'));
    const row = await subscriptionContinuations.stop(c.get('actor'), { sourceCommandId: c.req.param('sourceCommandId'), expectedStateVersion });
    return c.json({ state: row.state });
  });
  app.post('/api/conversations/:id/clarifications/:clarificationId/cancel', async c => {
    const { expectedVersion } = z.object({ expectedVersion: z.number().int().positive() }).strict().parse(await c.req.json());
    return c.json(await conversations.cancelClarification(c.get('actor'), c.req.param('id'), c.req.param('clarificationId'), expectedVersion));
  });
  app.get('/api/bills', async c => {
    const period = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional().parse(c.req.query('period'));
    return c.json(await finance().billReport(c.get('actor'), period));
  });
  app.get('/api/funds', async c => {
    const input = z.object({ accountId: z.string().min(1).optional(), amountMinor: z.string().regex(/^(0|[1-9]\d{0,11})$/).optional() }).strict().parse(c.req.query());
    return c.json(await finance().funds(c.get('actor'), input.accountId, input.amountMinor));
  });
  app.post('/api/funds/policy', async c => {
    const input = z.object({
      expectedVersion: z.number().int().nonnegative(), minimumBalanceMinor: z.string().regex(/^(0|[1-9]\d{0,11})$/),
      obligations: z.array(z.object({ id: z.string().min(1).max(100), title: z.string().trim().min(1).max(100), amountMinor: z.string().regex(/^[1-9]\d{0,11}$/), dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).strict()).max(50),
      confirmed: z.literal(true),
    }).strict().parse(await c.req.json());
    return c.json(await finance().updatePolicy(c.get('actor'), { expectedVersion: input.expectedVersion, minimumBalanceMinor: input.minimumBalanceMinor, obligations: input.obligations }));
  });
  app.post('/api/transfers', async c => c.json(await core.createTransfer(c.get('actor'), transferInputSchema.parse(await c.req.json()))));
  app.get('/api/investments', async c => c.json(await investment().dashboard(c.get('actor'))));
  app.get('/api/investments/commands/:commandId', async c => c.json(await investment().getByCommand(c.get('actor'), c.req.param('commandId'))));
  app.get('/api/investments/actions/:id', async c => c.json(await investment().getAction(c.get('actor'), c.req.param('id'), { readOnly: true })));
  app.get('/api/investments/timeline', async c => {
    const input = z.object({ accountId: z.string().min(1).optional(), days: z.coerce.number().int().min(1).max(90).optional() }).strict().parse(c.req.query());
    return c.json(await investment().timeline(c.get('actor'), input));
  });
  app.post('/api/investments/redemptions', async c => c.json((await runPreparation(c.get('actor'), 'investment', 'redemption', redemptionInputSchema.parse(await c.req.json()))).result));
  app.post('/api/investments/actions/:id/confirm', async c => {
    const { actionHash } = z.object({ actionHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(await c.req.json());
    return c.json(await investment().authorize(c.get('actor'), c.req.param('id'), { level: 'CONFIRMATION', proofId: randomUUID(), actionHash }));
  });
  app.post('/api/investments/actions/:id/cancel', async c => c.json(await investment().cancel(c.get('actor'), c.req.param('id'))));
  app.post('/api/investments/actions/:id/reconcile', async c => {
    await investment().getAction(c.get('actor'), c.req.param('id'));
    return c.json(await investment().reconcile(c.req.param('id')));
  });
  app.post('/api/investments/actions/:id/authentication/options', async c => {
    investment();
    return c.json(await investmentPasskeys!.authenticationOptions(c.get('actor'), c.req.param('id')));
  });
  app.post('/api/investments/actions/:id/authentication/verify', async c => {
    investment();
    const { response } = responseInput.parse(await c.req.json());
    return c.json(await investmentPasskeys!.authenticate(c.get('actor'), c.req.param('id'), response as unknown as AuthenticationResponseJSON));
  });
  app.get('/api/goals', async c => c.json({ goals: await goals().list(c.get('actor')) }));
  app.get('/api/goal-commands/:commandId', async c => c.json(await goals().getByCommand(c.get('actor'), c.req.param('commandId'))));
  app.post('/api/goals', async c => c.json((await runPreparation(c.get('actor'), 'goal', 'goal-create', createGoalInputSchema.parse(await c.req.json()))).result));
  app.get('/api/goals/:id', async c => c.json(await goals().get(c.get('actor'), c.req.param('id'), { readOnly: true })));
  app.post('/api/goals/:id/advance', async c => c.json(await goals().advance(c.get('actor'), c.req.param('id'))));
  app.post('/api/goals/:id/replan', async c => c.json((await runPreparation(c.get('actor'), 'goal', 'goal-replan', { goalId: c.req.param('id'), ...replanGoalInputSchema.parse(await c.req.json()) })).result));
  app.get('/api/management', async c => c.json(await management().dashboard(c.get('actor'))));
  app.get('/api/management/commands/:commandId', async c => c.json(await management().getByCommand(c.get('actor'), c.req.param('commandId'))));
  app.get('/api/management/actions/:id', async c => c.json(await management().getAction(c.get('actor'), c.req.param('id'))));
  app.get('/api/subscriptions', async c => {
    const { queryActionId } = z.object({ queryActionId: z.string().min(1) }).strict().parse(c.req.query());
    return c.json(await management().subscriptions(c.get('actor'), queryActionId));
  });
  app.post('/api/management/actions', async c => c.json((await runPreparation(c.get('actor'), 'management', 'management', managementInputSchema.parse(await c.req.json()))).result));
  app.post('/api/management/actions/:id/confirm', async c => {
    const { actionHash } = z.object({ actionHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(await c.req.json());
    const result = await management().authorize(c.get('actor'), c.req.param('id'), { level: 'CONFIRMATION', proofId: randomUUID(), actionHash });
    if (result.spec.kind === 'SUBSCRIPTION_QUERY' && result.status === 'SUCCEEDED') launchSubscriptions(c.get('actor'));
    return c.json(result);
  });
  app.post('/api/management/actions/:id/cancel', async c => c.json(await management().cancel(c.get('actor'), c.req.param('id'))));
  app.post('/api/management/actions/:id/authentication/options', async c => {
    management();
    return c.json(await managementPasskeys!.authenticationOptions(c.get('actor'), c.req.param('id')));
  });
  app.post('/api/management/actions/:id/authentication/verify', async c => {
    management();
    const { response } = responseInput.parse(await c.req.json());
    return c.json(await managementPasskeys!.authenticate(c.get('actor'), c.req.param('id'), response as unknown as AuthenticationResponseJSON));
  });
  app.post('/api/plan', async c => c.json(await planRunner.execute(c.get('actor'), planInput.parse(await c.req.json()))));
  app.get('/api/actions/:id', async c => c.json(await core.getAction(c.get('actor'), c.req.param('id'), { readOnly: true })));
  app.post('/api/actions/:id/confirm', async c => {
    const input = z.object({ actionHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(await c.req.json());
    return c.json(await core.authorize(c.get('actor'), c.req.param('id'), { level: 'CONFIRMATION', proofId: randomUUID(), actionHash: input.actionHash }));
  });
  app.post('/api/actions/:id/cancel', async c => c.json(await core.cancel(c.get('actor'), c.req.param('id'))));
  app.post('/api/actions/:id/reconcile', async c => {
    await core.getAction(c.get('actor'), c.req.param('id'));
    return c.json(await core.reconcile(c.req.param('id')));
  });
  app.post('/api/webauthn/register/options', async c => c.json(await passkeys.registrationOptions(c.get('actor'), c.get('email'))));
  app.post('/api/webauthn/register/verify', async c => {
    const { response } = responseInput.parse(await c.req.json());
    return c.json(await passkeys.register(c.get('actor'), response as unknown as RegistrationResponseJSON));
  });
  app.post('/api/actions/:id/authentication/options', async c => c.json(await passkeys.authenticationOptions(c.get('actor'), c.req.param('id'))));
  app.post('/api/actions/:id/authentication/verify', async c => {
    const { response } = responseInput.parse(await c.req.json());
    return c.json(await passkeys.authenticate(c.get('actor'), c.req.param('id'), response as unknown as AuthenticationResponseJSON));
  });
  app.post('/api/sandbox/fault', async c => {
    if (!options.sandbox) throw new CoreError('SANDBOX_DISABLED', '故障注入未启用', 404);
    const { mode } = z.object({ mode: z.enum(['NORMAL', 'TIMEOUT_AFTER_COMMIT', 'REJECT']) }).strict().parse(await c.req.json());
    await core.setNextFault(c.get('actor'), mode);
    return c.json({ mode });
  });
  app.post('/api/sandbox/investment-fault', async c => {
    if (!options.sandbox) throw new CoreError('SANDBOX_DISABLED', '故障注入未启用', 404);
    const { mode } = z.object({ mode: z.enum(['NORMAL', 'TIMEOUT_AFTER_COMMIT', 'REJECT']) }).strict().parse(await c.req.json());
    await investment().setNextFault(c.get('actor'), mode);
    return c.json({ mode });
  });
  app.onError((error, c) => {
    if (error instanceof CoreError) return c.json({ error: { code: error.code, message: error.message } }, error.statusCode as 400);
    if (error instanceof ZodError || error instanceof SyntaxError) return c.json({ error: { code: 'INVALID_INPUT', message: '输入格式不正确' } }, 400);
    console.error('API error:', error.name, error.message);
    return c.json({ error: { code: 'INTERNAL_ERROR', message: '服务暂时无法完成请求，请稍后重试' } }, 500);
  });
  return Object.assign(app, { startContinuations, stopContinuations, waitForPlanning: async () => {
    while (backgroundPlans.size || activeRequests.size) {
      await Promise.allSettled([...backgroundPlans, ...activeRequests]);
    }
  } });
}
