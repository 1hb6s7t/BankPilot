import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCore, createFinance, createGoals } from '../packages/core/src/index.js';
import { createInvestment } from '../packages/core/src/investment.js';
import type { CoreService, CreateGoalInput, FinanceService, GoalsService, GoalView, InvestmentAction, InvestmentService } from '../packages/contracts/src/index.js';

const connectionString = process.env.TEST_DATABASE_URL ?? 'postgres://bankpilot:bankpilot-local@127.0.0.1:55432/bankpilot';
const pool = new Pool({ connectionString, max: 12 });
const actor = { userId: 'goal-owner' }, other = { userId: 'goal-other' };
let schema: string, now: Date, core: CoreService, investment: InvestmentService, finance: FinanceService, goals: GoalsService;
const draft = (extra: Partial<CreateGoalInput> = {}): CreateGoalInput => ({ commandId: randomUUID(), title: '林晓生日目标', accountId: `acc-main-${actor.userId}`, payeeId: 'payee-lin', amountMinor: '600000', targetDate: '2026-10-30', funding: { positionId: `position:${actor.userId}:synthetic-t0`, redemptionAmountMinor: '300000' }, ...extra });
const revise = (view: GoalView, extra: Partial<CreateGoalInput> = {}) => ({ ...draft({ title: view.title, accountId: view.accountId, payeeId: view.payeeId, amountMinor: view.amountMinor, targetDate: view.targetDate, funding: view.funding, ...extra }), expectedPlanVersion: view.planVersion });
const child = (view: GoalView, kind: 'REDEEM' | 'TRANSFER') => view.nodes.find(n => n.kind === kind)!;
const approveRedemption = async (action: InvestmentAction) => investment.authorize(actor, action.id, { level: 'STRONG', proofId: randomUUID(), actionHash: action.actionHash });
const totals = async () => (await pool.query(`SELECT (SELECT count(*) FROM "${schema}".actions)::int AS transfers,(SELECT count(*) FROM "${schema}".investment_actions)::int AS redemptions,(SELECT count(*) FROM "${schema}".provider_transfers)::int AS paid,(SELECT count(*) FROM "${schema}".provider_redemptions)::int AS redeemed`)).rows[0];

beforeEach(async () => {
  schema = `goaltest_${randomUUID().replaceAll('-', '').slice(0, 12)}`; now = new Date('2026-10-22T08:00:00Z');
  core = createCore(pool, { schema, clock: () => now });
  investment = createInvestment(pool, { schema, clock: () => now });
  finance = createFinance(pool, { schema, clock: () => now });
  goals = createGoals(pool, core, investment, finance, { schema, clock: () => now });
  await core.migrate(); await core.seedDemo(actor); await core.seedDemo(other);
  await investment.migrate(); await investment.seedDemo(actor); await investment.seedDemo(other);
  await finance.seedDemo(actor);
  await goals.migrate();
});
afterEach(async () => { await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); });
afterAll(async () => { await pool.end(); });

describe('persisted goal DAG with independent action authorization', () => {
  it('prepares only redemption first; actual settlement unlocks a separately unauthorized transfer', async () => {
    let goal = await goals.create(actor, draft());
    expect(goal.nodes.map(n => [n.kind, n.status])).toEqual([['REDEEM', 'AWAITING_AUTH'], ['WAIT_SETTLEMENT', 'BLOCKED'], ['TRANSFER', 'BLOCKED']]);
    expect(await totals()).toEqual({ transfers: 0, redemptions: 1, paid: 0, redeemed: 0 });
    const redeem = child(goal, 'REDEEM').investmentAction!;
    await approveRedemption(redeem);
    expect((await goals.get(actor, goal.id)).nodes[0]!.status).toBe('IN_PROGRESS');
    await investment.execute(redeem.id);
    const hydrated = await goals.get(actor, goal.id);
    expect(hydrated.nodes[1]!.status).toBe('SUCCEEDED');
    expect(child(hydrated, 'TRANSFER').actionRef).toBeUndefined(); // GET never prepares.
    goal = await goals.advance(actor, goal.id);
    const transfer = child(goal, 'TRANSFER').transferAction!;
    expect(transfer.status).toBe('AWAITING_VERIFICATION');
    expect(transfer.amountMinor).toBe('600000');
    expect((await core.dashboard(actor)).accounts[0]!.balanceMinor).toBe('1100000');
    expect((await core.execute(transfer.id)).status).toBe('AWAITING_VERIFICATION');
    await core.authorize(actor, transfer.id, { level: 'STRONG', proofId: randomUUID(), actionHash: transfer.actionHash });
    await core.execute(transfer.id);
    expect((await goals.get(actor, goal.id)).status).toBe('SUCCEEDED');
    expect((await goals.list(actor))[0]!.status).toBe('SUCCEEDED');
    const counts = await totals();
    await Promise.all([goals.advance(actor, goal.id), goals.advance(actor, goal.id)]);
    expect(await totals()).toEqual(counts);
  });

  it('never treats an expected T+2 payout or a known due time as actual settled cash', async () => {
    const goal = await goals.create(actor, draft({ funding: { positionId: `position:${actor.userId}:synthetic-t2`, redemptionAmountMinor: '300000' } }));
    const redeem = child(goal, 'REDEEM').investmentAction!;
    await approveRedemption(redeem);
    expect((await investment.execute(redeem.id)).status).toBe('SETTLING');
    expect(child(await goals.advance(actor, goal.id), 'TRANSFER').actionRef).toBeUndefined();
    now = new Date(redeem.expectedSettlementAt);
    // Clock moving beyond ETA alone is still insufficient: provider processing and original receipt are required.
    expect(child(await goals.advance(actor, goal.id), 'TRANSFER').actionRef).toBeUndefined();
    await investment.processDue(); await investment.reconcile(redeem.id);
    expect(child(await goals.advance(actor, goal.id), 'TRANSFER').transferAction?.status).toBe('AWAITING_VERIFICATION');
  });

  it('reports late arrival, invalid date, unknown payee and protected cash without preparing unsafe actions', async () => {
    const late = await goals.create(actor, draft({ targetDate: '2026-10-23', funding: { positionId: `position:${actor.userId}:synthetic-t2`, redemptionAmountMinor: '300000' } }));
    expect(late.status).toBe('NEEDS_REPLAN'); expect(late.reasons.join()).toContain('晚于');
    const protectedGoal = await goals.create(actor, draft({ funding: undefined }));
    expect(protectedGoal.status).toBe('NEEDS_REPLAN'); expect(child(protectedGoal, 'TRANSFER').actionRef).toBeUndefined();
    await expect(goals.create(actor, draft({ targetDate: '2026-02-30' }))).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(goals.create(actor, draft({ payeeId: 'mallory' }))).rejects.toMatchObject({ code: 'INVALID_PAYEE' });
    expect(await totals()).toEqual({ transfers: 0, redemptions: 0, paid: 0, redeemed: 0 });
  });

  it('rejects cross-owner access and changed duplicate commands while concurrent identical commands deduplicate', async () => {
    const input = draft({ amountMinor: '30000', funding: undefined });
    const originalPrepare = core.createTransfer;
    let preparationCalls = 0;
    core.createTransfer = async (...args) => { preparationCalls++; return originalPrepare(...args); };
    const [first, second] = await Promise.all([goals.create(actor, input), goals.create(actor, input)]);
    expect(first.id).toBe(second.id);
    // The duplicate is a read of the committed goal. It may arrive before the
    // original creator binds its child; every visible child must still be that
    // one action, and the settled goal must recover the same binding.
    const visibleRefs = [first, second].flatMap(view => child(view, 'TRANSFER').actionRef ? [child(view, 'TRANSFER').actionRef!] : []);
    expect(visibleRefs.length).toBeGreaterThanOrEqual(1);
    expect(new Set(visibleRefs.map(ref => ref.actionId)).size).toBe(1);
    const current = await goals.get(actor, first.id, { readOnly: true });
    expect(child(current, 'TRANSFER').actionRef).toEqual(visibleRefs[0]);
    expect(child(await goals.create(actor, input), 'TRANSFER').actionRef).toEqual(visibleRefs[0]);
    expect(preparationCalls).toBe(1); // Reading/replaying the command never advances it.
    core.createTransfer = originalPrepare;
    await expect(goals.create(actor, { ...input, amountMinor: '40000' })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    await expect(goals.get(other, first.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(goals.advance(other, first.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(goals.replan(other, first.id, revise(first))).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await goals.list(other)).toEqual([]);
    expect((await totals()).transfers).toBe(1);
  });

  it('rechecks funds after actual settlement rather than letting a projected goal bypass changed protection', async () => {
    const goal = await goals.create(actor, draft()), redeem = child(goal, 'REDEEM').investmentAction!;
    await approveRedemption(redeem); await investment.execute(redeem.id);
    const policy = (await finance.funds(actor)).policy;
    await finance.updatePolicy(actor, { expectedVersion: policy.version, minimumBalanceMinor: '1000000', obligations: [] });
    const blocked = await goals.advance(actor, goal.id);
    expect(blocked.status).toBe('NEEDS_REPLAN'); expect(child(blocked, 'TRANSFER').actionRef).toBeUndefined();
    expect(child(blocked, 'REDEEM').investmentAction?.receipt).toBeDefined();
  });

  it('preserves completed redemption and original receipt on local transfer replanning', async () => {
    const goal = await goals.create(actor, draft()), redeem = child(goal, 'REDEEM').investmentAction!;
    await approveRedemption(redeem); const settled = await investment.execute(redeem.id);
    const revised = await goals.replan(actor, goal.id, revise(goal, { amountMinor: '500000', targetDate: '2026-10-31' }));
    expect(revised.planVersion).toBe(2); expect(revised.revisionDiff.join()).toContain('目标金额：6000.00元 → 5000.00元');
    expect(revised.expectedSettlementAt).toBe(settled.expectedSettlementAt);
    expect(child(revised, 'REDEEM').actionRef?.actionId).toBe(redeem.id);
    expect(child(revised, 'REDEEM').investmentAction?.receipt).toEqual(settled.receipt);
    const advanced = await goals.advance(actor, goal.id);
    expect(child(advanced, 'TRANSFER').transferAction?.amountMinor).toBe('500000');
    expect((await totals()).redemptions).toBe(1);
    await expect(goals.replan(actor, goal.id, revise(goal, { amountMinor: '400000' }))).rejects.toMatchObject({ code: 'STALE_PLAN' });
  });

  it('requires explicit cancellation for affected pending actions and does not partially cancel on failed replan', async () => {
    const goal = await goals.create(actor, draft({ amountMinor: '30000', funding: undefined })), action = child(goal, 'TRANSFER').transferAction!;
    await expect(goals.replan(actor, goal.id, revise(goal, { amountMinor: '40000' }))).rejects.toMatchObject({ code: 'ACTION_CANCEL_REQUIRED' });
    expect((await core.getAction(actor, action.id)).status).toBe('AWAITING_CONFIRMATION');
    await core.cancel(actor, action.id);
    const revised = await goals.replan(actor, goal.id, revise(goal, { amountMinor: '40000' }));
    expect(child(revised, 'TRANSFER').specVersion).toBe(2);
    const replacement = child(await goals.advance(actor, goal.id), 'TRANSFER').transferAction!;
    expect(replacement.id).not.toBe(action.id); expect(replacement.amountMinor).toBe('40000');
  });

  it('keeps unchanged action hash/authorization across unrelated plan edits, but blocks an affected authorized action', async () => {
    const goal = await goals.create(actor, draft({ amountMinor: '30000', funding: undefined })), action = child(goal, 'TRANSFER').transferAction!;
    const authorized = await core.authorize(actor, action.id, { level: 'CONFIRMATION', proofId: randomUUID(), actionHash: action.actionHash });
    const unchanged = await goals.replan(actor, goal.id, revise(goal));
    expect(unchanged.planVersion).toBe(2); expect(child(unchanged, 'TRANSFER').transferAction?.actionHash).toBe(authorized.actionHash);
    await expect(goals.replan(actor, goal.id, revise(unchanged, { amountMinor: '40000' }))).rejects.toMatchObject({ code: 'ACTION_IN_PROGRESS' });
    expect((await core.execute(action.id)).status).toBe('SUCCEEDED');
  });
  it('excludes an unchanged transfer own reservation when checking a plan-only revision', async () => {
    const goal = await goals.create(actor, draft({ amountMinor: '300000', funding: undefined })), action = child(goal, 'TRANSFER').transferAction!;
    await core.authorize(actor, action.id, { level: 'STRONG', proofId: randomUUID(), actionHash: action.actionHash });
    const revised = await goals.replan(actor, goal.id, revise(goal));
    expect(revised.status).toBe('ACTIVE'); expect(revised.fundsPreview?.allowed).toBe(true);
    expect(child(revised, 'TRANSFER').transferAction?.actionHash).toBe(action.actionHash);
  });

  it('does not count an unchanged full-position redemption reservation twice during replanning', async () => {
    const goal = await goals.create(actor, draft({ funding: { positionId: `position:${actor.userId}:synthetic-t0`, redemptionAmountMinor: '500000' } }));
    const redeem = child(goal, 'REDEEM').investmentAction!; await approveRedemption(redeem);
    const revised = await goals.replan(actor, goal.id, revise(goal, { title: '新的生日说明' }));
    expect(child(revised, 'REDEEM').investmentAction?.id).toBe(redeem.id); expect(revised.status).toBe('ACTIVE');
  });

  it.each(['AUTHORIZED', 'UNKNOWN'] as const)('recovers orphan transfer intent before replan, including a dashboard-authorized %s original', async status => {
    let loseBind = true;
    const failingCore: CoreService = { ...core, async createTransfer(actor, input) { const action = await core.createTransfer(actor, input); if (loseBind) { loseBind = false; throw new Error('simulated process death after child commit'); } return action; } };
    const crashed = createGoals(pool, failingCore, investment, finance, { schema, clock: () => now });
    await expect(crashed.create(actor, draft({ amountMinor: '30000', funding: undefined }))).rejects.toThrow('simulated process death');
    const action = (await core.dashboard(actor)).actions[0]!;
    await core.authorize(actor, action.id, { level: 'CONFIRMATION', proofId: randomUUID(), actionHash: action.actionHash });
    if (status === 'UNKNOWN') { await core.setNextFault(actor, 'TIMEOUT_AFTER_COMMIT'); expect((await core.execute(action.id)).status).toBe('UNKNOWN'); }
    const restarted = createGoals(pool, core, investment, finance, { schema, clock: () => now });
    const recovered = (await restarted.list(actor))[0]!;
    expect(child(recovered, 'TRANSFER').actionRef?.actionId).toBe(action.id);
    expect(child(await restarted.get(actor, recovered.id), 'TRANSFER').transferAction?.status).toBe(status);
    await expect(restarted.replan(actor, recovered.id, revise(recovered, { amountMinor: '40000' }))).rejects.toMatchObject({ code: 'ACTION_IN_PROGRESS' });
    // A newly failed funds check cannot hide an already prepared action on recovery.
    const policy = (await finance.funds(actor)).policy;
    await finance.updatePolicy(actor, { expectedVersion: policy.version, minimumBalanceMinor: '800000', obligations: [] });
    expect(child(await restarted.advance(actor, recovered.id), 'TRANSFER').actionRef?.actionId).toBe(action.id);
    expect((await totals()).transfers).toBe(1);
    if (status === 'UNKNOWN') { await core.reconcile(action.id); expect((await restarted.get(actor, recovered.id)).status).toBe('SUCCEEDED'); }
  });

  it('recovers an orphan authorized redemption and refuses replacing it with a different source or amount', async () => {
    let once = true;
    const crashing: InvestmentService = { ...investment, async prepare(actor, input) { const action = await investment.prepare(actor, input); if (once) { once = false; throw new Error('redemption bind lost'); } return action; } };
    const crashed = createGoals(pool, core, crashing, finance, { schema, clock: () => now });
    await expect(crashed.create(actor, draft())).rejects.toThrow('redemption bind lost');
    const original = (await investment.dashboard(actor)).actions[0]!; await approveRedemption(original);
    const recovered = (await goals.list(actor))[0]!;
    expect(child(recovered, 'REDEEM').actionRef?.actionId).toBe(original.id);
    await expect(goals.replan(actor, recovered.id, revise(recovered, { funding: undefined }))).rejects.toMatchObject({ code: 'ACTION_IN_PROGRESS' });
    await goals.advance(actor, recovered.id); expect((await totals()).redemptions).toBe(1);
  });

  it('does not accept a same-command action with a different recipient or amount as goal completion', async () => {
    const interrupted: CoreService = { ...core, async createTransfer() { throw new Error('crashed before child create'); } };
    const crashed = createGoals(pool, interrupted, investment, finance, { schema, clock: () => now });
    await expect(crashed.create(actor, draft({ amountMinor: '30000', funding: undefined }))).rejects.toThrow('crashed before child create');
    const persisted = (await pool.query(`SELECT state FROM "${schema}".goals WHERE user_id=$1`, [actor.userId])).rows[0].state as GoalView;
    const wrong = await core.createTransfer(actor, { commandId: `goal:${persisted.id}:transfer:1`, taskId: persisted.id, accountId: persisted.accountId, payeeId: 'payee-chen', amountMinor: '10000', memo: 'unrelated action occupying predictable command' });
    await core.authorize(actor, wrong.id, { level: 'CONFIRMATION', proofId: randomUUID(), actionHash: wrong.actionHash }); await core.execute(wrong.id);
    await expect(goals.get(actor, persisted.id)).rejects.toMatchObject({ code: 'GOAL_ACTION_MISMATCH' });
    await expect(goals.advance(actor, persisted.id)).rejects.toMatchObject({ code: 'GOAL_ACTION_MISMATCH' });
    await expect(goals.replan(actor, persisted.id, revise(persisted))).rejects.toMatchObject({ code: 'GOAL_ACTION_MISMATCH' });
    expect((await totals()).transfers).toBe(1);
    expect((await pool.query(`SELECT state->>'status' AS status FROM "${schema}".goals WHERE id=$1`, [persisted.id])).rows[0].status).not.toBe('SUCCEEDED');
  });

  it('does not automatically replace a failed or unknown action', async () => {
    const goal = await goals.create(actor, draft({ amountMinor: '30000', funding: undefined })), action = child(goal, 'TRANSFER').transferAction!;
    await core.authorize(actor, action.id, { level: 'CONFIRMATION', proofId: randomUUID(), actionHash: action.actionHash });
    await core.setNextFault(actor, 'REJECT'); await core.execute(action.id);
    const failed = await goals.advance(actor, goal.id); expect(failed.status).toBe('NEEDS_REPLAN');
    await goals.advance(actor, goal.id); expect((await totals()).transfers).toBe(1);
    await goals.replan(actor, goal.id, revise(failed));
    expect(child(await goals.advance(actor, goal.id), 'TRANSFER').actionRef?.actionId).not.toBe(action.id);
  });

  it('does not exhaust a single business connection with twelve concurrent independent goals', async () => {
    const constrained = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 3000 });
    try {
      const smallCore = createCore(constrained, { schema, clock: () => now });
      const smallInvestment = createInvestment(constrained, { schema, clock: () => now });
      const smallFinance = createFinance(constrained, { schema, clock: () => now });
      const smallGoals = createGoals(constrained, smallCore, smallInvestment, smallFinance, { schema, clock: () => now });
      const ids: string[] = [];
      for (let i = 0; i < 12; i++) ids.push((await smallGoals.create(actor, draft({ amountMinor: '10000', funding: undefined }))).id);
      const results = await Promise.all(ids.map(id => smallGoals.advance(actor, id)));
      expect(results).toHaveLength(12); expect(results.every(v => child(v, 'TRANSFER').actionRef)).toBe(true);
      expect((await totals()).transfers).toBe(12);
    } finally { await constrained.end(); }
  });
});
