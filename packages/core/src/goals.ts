import { observePoolErrors, withDatabaseClient, withTransaction } from './database.js';
import { createHash, randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { createGoalInputSchema, replanGoalInputSchema, type Actor, type CoreService, type FinanceService, type GoalDraft, type GoalNode, type GoalsService, type GoalView, type InvestmentService, type InvestmentAction, type ActionView } from '../../contracts/src/index.js';
import { CoreError } from './errors.js';
import { estimateSettlementAt } from './investment.js';
import { readFunds } from './finance.js';
import { lockPreparationRequest, markPreparationPrepared } from './preparations.js';

export type GoalsOptions = { schema?: string; clock?: () => Date };
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const hash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
const day = (date: Date) => new Date(date.getTime() + 8 * 3600_000).toISOString().slice(0, 10);
const busy = new Set(['AUTHORIZED', 'SUBMITTING', 'UNKNOWN', 'SETTLING']);
const dead = new Set(['FAILED', 'CANCELLED', 'EXPIRED']);
const draftOf = ({ title, accountId, payeeId, amountMinor, targetDate, funding }: GoalDraft): GoalDraft => ({ title, accountId, payeeId, amountMinor, targetDate, ...(funding ? { funding } : {}) });
const validDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && !value.startsWith('0000') && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const node = (id: string, kind: GoalNode['kind'], dependsOn: string[]): GoalNode => ({ id, kind, dependsOn, specVersion: 1, status: dependsOn.length ? 'BLOCKED' : 'READY', evidenceRefs: [] });
const nodesFor = (draft: GoalDraft): GoalNode[] => draft.funding ? [node('redeem', 'REDEEM', []), node('settlement', 'WAIT_SETTLEMENT', ['redeem']), node('transfer', 'TRANSFER', ['settlement'])] : [node('transfer', 'TRANSFER', [])];

/** The graph records business dependencies; only the existing action services authorize/execute. */
export function createGoals(pool: Pool, core: CoreService, investment: InvestmentService, finance: FinanceService, options: GoalsOptions = {}): GoalsService {
  const schema = options.schema ?? 'bankpilot_core';
  if (!/^[a-z_][a-z0-9_]{0,47}$/.test(schema)) throw new Error('Invalid goals schema');
  const s = `"${schema}"`, clock = options.clock ?? (() => new Date());
  // Locks have a separate, bounded connection budget: lock waiters must not consume
  // every business connection needed by their winner. Idle lock connections close.
  const lockPool = new Pool({ ...pool.options, max: 4, idleTimeoutMillis: 1000, allowExitOnIdle: true, connectionTimeoutMillis: 5000 });
  observePoolErrors(lockPool);
  const owner = (actor: Actor) => {
    if (!actor?.userId || typeof actor.userId !== 'string') throw new CoreError('UNAUTHENTICATED', '请先登录', 401);
    return actor.userId;
  };
  const transaction = <T>(fn: (tx: PoolClient) => Promise<T>): Promise<T> => withTransaction(pool, fn);
  const read = async (actor: Actor, id: string): Promise<GoalView> => {
    const r = await pool.query(`SELECT state FROM ${s}.goals WHERE id=$1 AND user_id=$2`, [id, owner(actor)]);
    if (!r.rows[0]) throw new CoreError('NOT_FOUND', '未找到生活目标', 404);
    return r.rows[0].state;
  };
  // A session advisory lock serializes goal operations without holding a transaction
  // across Core calls (Core takes its own user lock on another connection).
  const serialize = async <T>(actor: Actor, id: string, fn: () => Promise<T>) => {
    const userId = owner(actor), key = `${schema}:goal:${userId}:${id}`;
    return withDatabaseClient(lockPool, async (connection, state) => {
      let failed = false;
      try { await connection.query('SELECT pg_advisory_lock(hashtextextended($1,0))', [key]); return await fn(); }
      catch (error) { failed = true; throw error; }
      finally {
        if (!state.failure()) {
          try { await connection.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [key]); }
          catch (error) { state.discard(error instanceof Error ? error : new Error('DATABASE_UNLOCK_FAILED')); if (!failed) throw error; }
        }
      }
    });
  };
  const save = async (actor: Actor, view: GoalView, expected: number, type = 'GOAL_ADVANCED') => transaction(async tx => {
    view.updatedAt = clock().toISOString();
    const r = await tx.query(`UPDATE ${s}.goals SET state=$3,updated_at=$4 WHERE id=$1 AND user_id=$2 AND (state->>'planVersion')::int=$5 RETURNING id`, [view.id, owner(actor), JSON.stringify(view), clock(), expected]);
    if (!r.rowCount) throw new CoreError('STALE_PLAN', '目标计划已更新，请刷新后重试');
    await tx.query(`INSERT INTO ${s}.audit_events(id,user_id,action_id,type,detail,created_at) VALUES($1,$2,NULL,$3,$4,$5)`, [randomUUID(), owner(actor), type, JSON.stringify({ goalId: view.id, planVersion: view.planVersion }), clock()]);
  });
  const validate = async (actor: Actor, draft: GoalDraft, settledFunding = false, existingFunding?: InvestmentAction, existingTransfer?: ActionView) => {
    if (!validDate(draft.targetDate)) throw new CoreError('INVALID_INPUT', '目标日期必须是真实的 YYYY-MM-DD', 400);
    const dashboard = await core.dashboard(actor);
    if (!dashboard.accounts.some(a => a.id === draft.accountId)) throw new CoreError('NOT_FOUND', '目标账户不存在', 404);
    if (!dashboard.payees.some(p => p.id === draft.payeeId)) throw new CoreError('INVALID_PAYEE', '目标必须选择已保存收款人', 400);
    const funds = (existingTransfer ? await transaction(async tx => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`${schema}:${owner(actor)}`]);
      return readFunds(tx, schema, owner(actor), draft.accountId, draft.amountMinor, clock(), existingTransfer.id);
    }) : await finance.funds(actor, draft.accountId, draft.amountMinor)).preview;
    const reasons: string[] = [];
    if (draft.targetDate < day(clock())) reasons.push('目标截止日已过，需要重新规划。');
    let expectedSettlementAt: string | undefined;
    if (draft.funding && !settledFunding) {
      const position = (await investment.dashboard(actor)).positions.find(p => p.id === draft.funding!.positionId);
      if (!position || position.accountId !== draft.accountId) throw new CoreError('NOT_FOUND', '赎回持仓或到账账户不匹配', 404);
      const ownReservation = existingFunding && busy.has(existingFunding.status) && existingFunding.positionId === position.id && existingFunding.amountMinor === draft.funding.redemptionAmountMinor;
      if (!ownReservation && BigInt(draft.funding.redemptionAmountMinor) > BigInt(position.availableMinor)) throw new CoreError('INSUFFICIENT_POSITION', '可赎回持仓不足');
      expectedSettlementAt = ownReservation ? existingFunding.expectedSettlementAt : estimateSettlementAt(clock(), position.redemptionBusinessDays);
      if (day(new Date(expectedSettlementAt)) > draft.targetDate) reasons.push('预计赎回到账晚于目标截止日；预计款项不是当前现金。');
      if (BigInt(funds.shortfallMinor) > BigInt(draft.funding.redemptionAmountMinor)) reasons.push('即使预计赎回到账，目标金额仍会突破当前资金保护底线。');
    } else if (!funds.allowed) reasons.push('当前资金不足或受到生活资金保护，需要调整目标；不会准备转账。');
    return { fundsPreview: funds, reasons, ...(expectedSettlementAt ? { expectedSettlementAt } : {}) };
  };
  const recoverIntentRefs = async (actor: Actor, view: GoalView) => {
    for (const n of view.nodes) if (!n.actionRef && n.kind !== 'WAIT_SETTLEMENT') {
      // Read-only lookup closes the child-commit/bind gap even if a user authorized
      // the orphan action through their dashboard. No GET may create a child action.
      const table = n.kind === 'REDEEM' ? 'investment_actions' : 'actions';
      const result = await pool.query(`SELECT a.id FROM ${s}.goal_node_intents i JOIN ${s}.${table} a ON a.command_id=i.command_id AND a.user_id=i.user_id WHERE i.goal_id=$1 AND i.user_id=$2 AND i.node_id=$3 AND i.spec_version=$4`, [view.id, owner(actor), n.id, n.specVersion]);
      if (result.rows[0]) n.actionRef = { service: n.kind === 'REDEEM' ? 'investment' : 'transfer', actionId: result.rows[0].id };
    }
  };
  const actionFor = async (actor: Actor, n: GoalNode, readOnly = false) => n.actionRef?.service === 'investment' ? investment.getAction(actor, n.actionRef.actionId, { readOnly }) : n.actionRef ? core.getAction(actor, n.actionRef.actionId, { readOnly }) : undefined;
  const mapAction = (n: GoalNode, action: InvestmentAction | ActionView) => {
    n.status = action.status === 'SUCCEEDED' ? 'SUCCEEDED' : action.status === 'UNKNOWN' || action.status === 'SUBMITTING' ? 'UNKNOWN' : dead.has(action.status) ? 'FAILED' : busy.has(action.status) ? 'IN_PROGRESS' : 'AWAITING_AUTH';
    n.reason = action.failureReason;
    if ('positionId' in action) n.investmentAction = action; else n.transferAction = action;
    n.evidenceRefs = [action.id, ...(action.receipt ? [action.receipt.providerRequestId, action.receipt.providerTransactionId] : [])];
  };
  const sync = async (actor: Actor, view: GoalView, readOnly = false) => {
    await recoverIntentRefs(actor, view);
    for (const n of view.nodes) if (n.actionRef) {
      const action = (await actionFor(actor, n, readOnly))!;
      const expected = (await pool.query(`SELECT input FROM ${s}.goal_node_intents WHERE goal_id=$1 AND user_id=$2 AND node_id=$3 AND spec_version=$4`, [view.id, owner(actor), n.id, n.specVersion])).rows[0]?.input;
      const matches = expected && action.taskId === view.id && action.accountId === view.accountId && (n.kind === 'REDEEM'
        ? 'positionId' in action && action.positionId === view.funding?.positionId && action.amountMinor === view.funding.redemptionAmountMinor && action.positionId === expected.positionId && action.amountMinor === expected.amountMinor && action.expectedVersion === expected.expectedVersion
        : !('positionId' in action) && action.payeeId === view.payeeId && action.amountMinor === view.amountMinor && action.payeeId === expected.payeeId && action.accountId === expected.accountId && action.amountMinor === expected.amountMinor && action.memo === expected.memo);
      if (!matches) throw new CoreError('GOAL_ACTION_MISMATCH', '原动作与目标及持久化意图不匹配，不能将其回执当作目标完成');
      mapAction(n, action);
    }
    const redeem = view.nodes.find(n => n.kind === 'REDEEM'), wait = view.nodes.find(n => n.kind === 'WAIT_SETTLEMENT');
    if (wait && redeem) {
      const action = redeem.investmentAction, receipt = action?.receipt;
      if (action) view.expectedSettlementAt = action.expectedSettlementAt;
      const actual = action?.status === 'SUCCEEDED' && receipt && receipt.accountId === view.accountId && receipt.positionId === view.funding?.positionId && receipt.amountMinor === view.funding.redemptionAmountMinor && Number.isFinite(Date.parse(receipt.settledAt)) && Date.parse(receipt.settledAt) <= clock().getTime();
      wait.status = actual ? 'SUCCEEDED' : 'BLOCKED';
      wait.reason = actual ? undefined : '等待原赎回动作实际成功且回执确认到账；预计到账不能满足依赖。';
      wait.evidenceRefs = actual ? [...redeem.evidenceRefs] : [];
    }
    for (const n of view.nodes) if (!n.actionRef && n.kind !== 'WAIT_SETTLEMENT') n.status = n.dependsOn.every(id => view.nodes.find(p => p.id === id)?.status === 'SUCCEEDED') ? 'READY' : 'BLOCKED';
    if (view.nodes.find(n => n.kind === 'TRANSFER')?.status === 'SUCCEEDED') { view.status = 'SUCCEEDED'; view.reasons = []; }
    else if (view.nodes.some(n => n.status === 'FAILED')) { view.status = 'NEEDS_REPLAN'; view.reasons = ['原动作已失败、取消或过期；不会自动重试，需明确重新规划。']; }
    else if (view.targetDate < day(clock())) { view.status = 'NEEDS_REPLAN'; view.reasons = ['目标截止日已过；原在途或未知动作仍保留，不能换单重做。']; }
  };
  const prepare = async (actor: Actor, view: GoalView, n: GoalNode) => {
    const userId = owner(actor), commandId = `goal:${view.id}:${n.id}:${n.specVersion}`;
    // Persist the exact command before any external service call; retries must not
    // refresh expectedVersion or silently create a replacement after a lost response.
    const prior = await pool.query(`SELECT input FROM ${s}.goal_node_intents WHERE goal_id=$1 AND node_id=$2 AND spec_version=$3`, [view.id, n.id, n.specVersion]);
    let input = prior.rows[0]?.input;
    if (!input) {
      if (n.kind === 'REDEEM') {
        const p = (await investment.dashboard(actor)).positions.find(p => p.id === view.funding?.positionId && p.accountId === view.accountId);
        if (!p) throw new CoreError('NOT_FOUND', '赎回持仓不存在', 404);
        input = { commandId, taskId: view.id, positionId: p.id, amountMinor: view.funding!.redemptionAmountMinor, expectedVersion: p.version };
      } else input = { commandId, taskId: view.id, accountId: view.accountId, payeeId: view.payeeId, amountMinor: view.amountMinor, memo: `生活目标：${view.title}`.slice(0, 120) };
      await pool.query(`INSERT INTO ${s}.goal_node_intents(goal_id,user_id,node_id,spec_version,command_id,input) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`, [view.id, userId, n.id, n.specVersion, commandId, JSON.stringify(input)]);
      input = (await pool.query(`SELECT input FROM ${s}.goal_node_intents WHERE goal_id=$1 AND node_id=$2 AND spec_version=$3`, [view.id, n.id, n.specVersion])).rows[0].input;
    }
    const action = n.kind === 'REDEEM' ? await investment.prepare(actor, input) : await core.createTransfer(actor, input);
    n.actionRef = { service: n.kind === 'REDEEM' ? 'investment' : 'transfer', actionId: action.id };
    mapAction(n, action);
    await save(actor, view, view.planVersion);
  };
  const advance = async (actor: Actor, id: string): Promise<GoalView> => serialize(actor, id, async () => {
    const view = await read(actor, id);
    await sync(actor, view);
    if (view.status === 'ACTIVE') {
      const ready = view.nodes.find(n => n.status === 'READY' && !n.actionRef);
      if (ready) {
        if (ready.kind === 'TRANSFER') {
          view.fundsPreview = (await finance.funds(actor, view.accountId, view.amountMinor)).preview;
          if (!view.fundsPreview.allowed) { view.status = 'NEEDS_REPLAN'; view.reasons = ['实际到账后的最新资金预演未通过；不会准备转账。']; }
          else await prepare(actor, view, ready);
        } else await prepare(actor, view, ready);
      }
    }
    await save(actor, view, view.planVersion);
    return view;
  });
  const service: GoalsService = {
    async migrate() {
      await pool.query(`CREATE SCHEMA IF NOT EXISTS ${s};
        CREATE TABLE IF NOT EXISTS ${s}.goals(id text PRIMARY KEY,user_id text NOT NULL,state jsonb NOT NULL,created_at timestamptz NOT NULL,updated_at timestamptz NOT NULL);
        CREATE INDEX IF NOT EXISTS goals_user_idx ON ${s}.goals(user_id,created_at);
        CREATE TABLE IF NOT EXISTS ${s}.goal_commands(user_id text NOT NULL,command_id text NOT NULL,input_hash text NOT NULL,goal_id text NOT NULL REFERENCES ${s}.goals(id),PRIMARY KEY(user_id,command_id));
        CREATE TABLE IF NOT EXISTS ${s}.goal_node_intents(goal_id text NOT NULL REFERENCES ${s}.goals(id),user_id text NOT NULL,node_id text NOT NULL,spec_version int NOT NULL,command_id text NOT NULL UNIQUE,input jsonb NOT NULL,PRIMARY KEY(goal_id,node_id,spec_version));`);
    },
    async create(actor, input) {
      const userId = owner(actor), parsed = createGoalInputSchema.safeParse(input);
      if (!parsed.success) throw new CoreError('INVALID_INPUT', '目标需要标题、已保存收款人、金额和明确日期', 400);
      const data = parsed.data, fingerprint = hash(data), prior = await pool.query(`SELECT * FROM ${s}.goal_commands WHERE user_id=$1 AND command_id=$2`, [userId, data.commandId]);
      if (prior.rows[0]) {
        await transaction(async tx => {
          await lockPreparationRequest(tx, schema, userId, 'goal', 'goal-create', data, clock());
          if (prior.rows[0].input_hash !== fingerprint) throw new CoreError('IDEMPOTENCY_CONFLICT', '同一目标指令不能修改参数');
          await markPreparationPrepared(tx, schema, userId, 'goal', data.commandId, prior.rows[0].goal_id, clock());
        });
        return service.getByCommand(actor, data.commandId);
      }
      const draft = draftOf(data), checked = await validate(actor, draft);
      const view: GoalView = { ...draft, id: `goal-${randomUUID()}`, planVersion: 1, status: checked.reasons.length ? 'NEEDS_REPLAN' : 'ACTIVE', nodes: nodesFor(draft), ...checked, revisionDiff: [], createdAt: clock().toISOString(), updatedAt: clock().toISOString() };
      const prepared = await transaction(async tx => {
        await lockPreparationRequest(tx, schema, userId, 'goal', 'goal-create', data, clock());
        const existing = (await tx.query(`SELECT * FROM ${s}.goal_commands WHERE user_id=$1 AND command_id=$2`, [userId, data.commandId])).rows[0];
        if (existing) {
          if (existing.input_hash !== fingerprint) throw new CoreError('IDEMPOTENCY_CONFLICT', '同一目标指令不能修改参数');
          await markPreparationPrepared(tx, schema, userId, 'goal', data.commandId, existing.goal_id, clock());
          return { id: existing.goal_id as string, replayed: true };
        }
        await tx.query(`INSERT INTO ${s}.goals VALUES($1,$2,$3,$4,$4)`, [view.id, userId, JSON.stringify(view), clock()]);
        await tx.query(`INSERT INTO ${s}.goal_commands VALUES($1,$2,$3,$4)`, [userId, data.commandId, fingerprint, view.id]);
        await markPreparationPrepared(tx, schema, userId, 'goal', data.commandId, view.id, clock());
        return { id: view.id, replayed: false };
      });
      return prepared.replayed ? service.getByCommand(actor, data.commandId) : advance(actor, prepared.id);
    },
    async list(actor) {
      const views: GoalView[] = (await pool.query(`SELECT state FROM ${s}.goals WHERE user_id=$1 ORDER BY created_at DESC,id DESC`, [owner(actor)])).rows.map(r => r.state);
      for (const view of views) await sync(actor, view);
      return views;
    },
    async get(actor, id, options) { const view = await read(actor, id); await sync(actor, view, options?.readOnly); return view; },
    async getByCommand(actor, commandId) {
      const userId = owner(actor);
      const result = await pool.query(`SELECT g.state FROM ${s}.goal_commands c JOIN ${s}.goals g ON g.id=c.goal_id AND g.user_id=c.user_id WHERE c.user_id=$1 AND c.command_id=$2`, [userId, commandId]);
      if (!result.rows[0]) throw new CoreError('COMMAND_NOT_FOUND', '生活目标指令记录不存在', 404);
      const view: GoalView = result.rows[0].state;
      await sync(actor, view, true);
      return view;
    },
    advance,
    async replan(actor, id, input) {
      owner(actor);
      const parsed = replanGoalInputSchema.safeParse(input);
      if (!parsed.success) throw new CoreError('INVALID_INPUT', '重规划字段不完整', 400);
      return serialize(actor, id, async () => {
        const view = await read(actor, id), data = parsed.data, fingerprint = hash({ id, ...data });
        const prior = (await pool.query(`SELECT * FROM ${s}.goal_commands WHERE user_id=$1 AND command_id=$2`, [owner(actor), data.commandId])).rows[0];
        if (prior) {
          await transaction(async tx => {
            await lockPreparationRequest(tx, schema, owner(actor), 'goal', 'goal-replan', { goalId: id, ...data }, clock());
            if (prior.input_hash !== fingerprint || prior.goal_id !== id) throw new CoreError('IDEMPOTENCY_CONFLICT', '重规划指令已用于其他参数');
            await markPreparationPrepared(tx, schema, owner(actor), 'goal', data.commandId, id, clock());
          });
          return service.getByCommand(actor, data.commandId);
        }
        if (view.planVersion !== data.expectedPlanVersion) throw new CoreError('STALE_PLAN', '目标计划已变化，请刷新');
        await sync(actor, view);
        if (view.status === 'SUCCEEDED') throw new CoreError('GOAL_COMPLETED', '目标已经完成，不能修改已完成转账');
        const draft = draftOf(data), old = draftOf(view);
        const fundingChanged = canonical(old.funding) !== canonical(draft.funding) || old.accountId !== draft.accountId;
        const transferChanged = old.accountId !== draft.accountId || old.payeeId !== draft.payeeId || old.amountMinor !== draft.amountMinor || old.title !== draft.title;
        if (old.targetDate !== draft.targetDate && view.nodes.some(n => n.investmentAction && busy.has(n.investmentAction.status) || n.transferAction && busy.has(n.transferAction.status))) throw new CoreError('ACTION_IN_PROGRESS', '目标存在已授权或未知动作，截止日期变更须等待原单终态');
        const redeemed = view.nodes.find(n => n.kind === 'REDEEM')?.status === 'SUCCEEDED';
        if (redeemed && fundingChanged) throw new CoreError('COMPLETED_NODE_IMMUTABLE', '已到账赎回必须保留，不能改写为另一笔资金来源');
        const checked = await validate(actor, draft, redeemed, !fundingChanged ? view.nodes.find(n => n.kind === 'REDEEM')?.investmentAction : undefined, !transferChanged && !fundingChanged ? view.nodes.find(n => n.kind === 'TRANSFER')?.transferAction : undefined);
        const next = nodesFor(draft);
        for (const n of next) {
          const previous = view.nodes.find(p => p.id === n.id);
          if (!previous) {
            const historical = (await pool.query(`SELECT COALESCE(max(spec_version),0)::int AS version FROM ${s}.goal_node_intents WHERE goal_id=$1 AND node_id=$2`, [id, n.id])).rows[0].version;
            n.specVersion = historical + 1;
            continue;
          }
          const changed = n.kind === 'TRANSFER' ? transferChanged || fundingChanged : fundingChanged;
          const unusedIntent = !previous.actionRef && (await pool.query(`SELECT 1 FROM ${s}.goal_node_intents WHERE goal_id=$1 AND node_id=$2 AND spec_version=$3`, [id, previous.id, previous.specVersion])).rowCount;
          const expired = previous.status === 'FAILED' || !!unusedIntent;
          if (previous.status === 'SUCCEEDED' && !changed) { Object.assign(n, previous); continue; }
          if (!changed && !expired) { Object.assign(n, previous); continue; }
          const action = await actionFor(actor, previous);
          if (action && (busy.has(action.status) || action.status === 'SUCCEEDED')) throw new CoreError('ACTION_IN_PROGRESS', '受影响动作已经授权、派发或结果未知；须先确认原单终态，不可换单');
          if (action && !dead.has(action.status)) throw new CoreError('ACTION_CANCEL_REQUIRED', '请先明确取消原待确认动作，再修改其关键字段；重规划不会暗中取消动作');
          n.specVersion = previous.specVersion + 1;
        }
        // Removed funding nodes are also subject to the same immutable in-flight rule.
        for (const previous of view.nodes.filter(p => !next.some(n => n.id === p.id))) {
          const action = await actionFor(actor, previous);
          if (action && (busy.has(action.status) || action.status === 'SUCCEEDED')) throw new CoreError('ACTION_IN_PROGRESS', '不能移除已授权或未知的赎回动作');
          if (action && !dead.has(action.status)) throw new CoreError('ACTION_CANCEL_REQUIRED', '请先取消原待确认赎回，再移除该依赖');
        }
        const changedKeys = (['title', 'accountId', 'payeeId', 'amountMinor', 'targetDate', 'funding'] as const).filter(k => canonical(old[k]) !== canonical(draft[k]));
        const names = await core.dashboard(actor), positions = (await investment.dashboard(actor)).positions;
        const yuan = (value: string) => `${BigInt(value) / 100n}.${(BigInt(value) % 100n).toString().padStart(2, '0')}元`;
        const labels = { title: '目标标题', accountId: '付款账户', payeeId: '收款人', amountMinor: '目标金额', targetDate: '截止日期', funding: '赎回资金来源' };
        const display = (key: keyof GoalDraft, value: GoalDraft[keyof GoalDraft]): string => {
          if (key === 'amountMinor') return yuan(value as string);
          if (key === 'payeeId') { const p = names.payees.find(p => p.id === value); return p ? `${p.name}（${p.bank} ${p.maskedNumber}）` : '原已保存收款人'; }
          if (key === 'accountId') { const a = names.accounts.find(a => a.id === value); return a ? `${a.name}（${a.maskedNumber}）` : '原付款账户'; }
          if (key === 'funding') { const f = value as GoalDraft['funding']; return f ? `${positions.find(p => p.id === f.positionId)?.productName ?? '原理财持仓'}，${yuan(f.redemptionAmountMinor)}` : '当前账户资金'; }
          return String(value);
        };
        const diff = changedKeys.map(k => `${labels[k]}：${display(k, old[k])} → ${display(k, draft[k])}`);
        const revised: GoalView = { ...draft, id, planVersion: view.planVersion + 1, status: checked.reasons.length ? 'NEEDS_REPLAN' : 'ACTIVE', nodes: next, ...checked, ...(draft.funding && view.expectedSettlementAt && !fundingChanged ? { expectedSettlementAt: view.expectedSettlementAt } : {}), revisionDiff: diff.length ? diff : ['显式重规划：保留未变化动作，仅重建已失败节点。'], createdAt: view.createdAt, updatedAt: clock().toISOString() };
        await transaction(async tx => {
          await lockPreparationRequest(tx, schema, owner(actor), 'goal', 'goal-replan', { goalId: id, ...data }, clock());
          await tx.query(`INSERT INTO ${s}.goal_commands VALUES($1,$2,$3,$4)`, [owner(actor), data.commandId, fingerprint, id]);
          const r = await tx.query(`UPDATE ${s}.goals SET state=$3,updated_at=$4 WHERE id=$1 AND user_id=$2 AND (state->>'planVersion')::int=$5 RETURNING id`, [id, owner(actor), JSON.stringify(revised), clock(), view.planVersion]);
          if (!r.rowCount) throw new CoreError('STALE_PLAN', '目标计划已变化');
          await tx.query(`INSERT INTO ${s}.audit_events(id,user_id,action_id,type,detail,created_at) VALUES($1,$2,NULL,'GOAL_REPLANNED',$3,$4)`, [randomUUID(), owner(actor), JSON.stringify({ goalId: id, planVersion: revised.planVersion, diff: revised.revisionDiff }), clock()]);
          await markPreparationPrepared(tx, schema, owner(actor), 'goal', data.commandId, id, clock());
        });
        return revised;
      });
    },
  };
  return service;
}
