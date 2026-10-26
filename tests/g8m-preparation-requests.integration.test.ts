import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../apps/api/src/app.js';
import { createPlanner } from '../packages/agents/src/index.js';
import { createCore, createFinance, createManagement, createInvestment, createGoals } from '../packages/core/src/index.js';
import { observePoolErrors } from '../packages/core/src/database.js';
import type { ManagementInput, PreparationFamily } from '../packages/contracts/src/index.js';

const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL ?? 'postgres://bankpilot:bankpilot-local@127.0.0.1:55432/bankpilot', max: 12 });
const actor = { userId: 'preparation-owner' }, other = { userId: 'preparation-other' }, origin = 'http://localhost:5178';
let schema: string, now: Date;
let core: ReturnType<typeof createCore>, finance: ReturnType<typeof createFinance>, management: ReturnType<typeof createManagement>, investment: ReturnType<typeof createInvestment>, goals: ReturnType<typeof createGoals>, app: ReturnType<typeof createApp>;
const managementInput = (extra: Partial<ManagementInput> = {}): ManagementInput => ({ commandId: randomUUID(), spec: { kind: 'SUBSCRIPTION_QUERY' }, ...extra });
const post = (path: string, body: unknown = {}, user = actor.userId) => app.request(`${origin}${path}`, { method: 'POST', headers: { Origin: origin, Cookie: `owner=${user}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const get = (path: string, user = actor.userId) => app.request(`${origin}${path}`, { headers: { Cookie: `owner=${user}` } });
const base = (family: PreparationFamily, commandId: string) => `/api/preparation-requests/${family}/${commandId}`;
const goalInput = (commandId = randomUUID()) => ({ commandId, title: '准备登记目标', accountId: `acc-main-${actor.userId}`, payeeId: 'payee-lin', amountMinor: '10000', targetDate: '2026-10-30' });
const counts = async () => (await pool.query(`SELECT (SELECT count(*)::int FROM "${schema}".management_actions) AS management,
  (SELECT count(*)::int FROM "${schema}".investment_actions) AS investment,(SELECT count(*)::int FROM "${schema}".goals) AS goals,
  (SELECT count(*)::int FROM "${schema}".goal_commands) AS commands`)).rows[0];
async function snapshot() {
  const tables = (await pool.query('SELECT table_name FROM information_schema.tables WHERE table_schema=$1 ORDER BY table_name', [schema])).rows;
  const contents: Record<string, unknown> = {};
  for (const { table_name: table } of tables) contents[table] = (await pool.query(`SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text),'[]'::jsonb) AS rows FROM "${schema}"."${table}" r`)).rows[0].rows;
  return contents;
}
async function waitUntil(check: () => Promise<boolean>) {
  const until = Date.now() + 5000;
  while (!await check()) { if (Date.now() >= until) throw new Error('Timed out waiting for deterministic database barrier'); await new Promise(resolve => setTimeout(resolve, 10)); }
}
const makeApp = () => {
  const auth = { api: { getSession: async ({ headers }: { headers: Headers }) => {
    const userId = headers.get('cookie')?.match(/^owner=(preparation-owner|preparation-other)$/)?.[1];
    return userId ? { user: { id: userId, email: `${userId}@example.test` } } : null;
  } } };
  return createApp({ pool, auth: auth as never, core, management, investment, goals, finance, planner: createPlanner({ provider: false }), origin, rpID: 'localhost', sandbox: false, plannerMode: 'scripted' });
};

beforeEach(async () => {
  schema = `g8mprep_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  now = new Date('2026-10-22T08:00:00Z');
  core = createCore(pool, { schema, clock: () => now });
  management = createManagement(pool, { schema, clock: () => now });
  investment = createInvestment(pool, { schema, clock: () => now });
  finance = createFinance(pool, { schema, clock: () => now });
  goals = createGoals(pool, core, investment, finance, { schema, clock: () => now });
  await core.migrate(); await management.migrate(); await investment.migrate(); await goals.migrate();
  for (const user of [actor, other]) { await core.seedDemo(user); await management.seedDemo(user); await investment.seedDemo(user); await finance.seedDemo(user); }
  app = makeApp();
});
afterEach(async () => { await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); });
afterAll(async () => { await pool.end(); });

describe('G8M durable preparation requests and transaction abandonment fences', () => {
  it('retains failed acceptance across app recreation and retries the exact original version and normalized input', async () => {
    const input = managementInput({ spec: { kind: 'CONTACT_ALIAS_SAVE', payeeId: 'payee-lin', alias: ' Ａ朋友 ' } });
    await pool.query(`CREATE FUNCTION "${schema}".reject_prepare() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'private payload must never appear in journal'; END $$;
      CREATE TRIGGER fail_prepare BEFORE INSERT ON "${schema}".audit_events FOR EACH ROW WHEN (NEW.type='MANAGEMENT_PREPARED') EXECUTE FUNCTION "${schema}".reject_prepare();`);
    expect((await post('/api/management/actions', input)).status).toBe(500);
    const request = await core.preparations!.get(actor, 'management', input.commandId);
    expect(request.state).toBe('PENDING'); expect(request.input).toEqual({ ...input, spec: { ...input.spec, alias: 'A朋友' } });
    expect(request.lastError).toEqual({ code: 'PREPARATION_FAILED', message: '准备请求未完成，请读取原请求状态后明确重试' });
    expect((await counts()).management).toBe(0);
    await pool.query(`DROP TRIGGER fail_prepare ON "${schema}".audit_events`);
    // A new service instance recovers solely from PostgreSQL, with no browser journal.
    core = createCore(pool, { schema, clock: () => now });
    app = makeApp();
    expect((await core.preparations!.get(actor, 'management', input.commandId)).input).toEqual(request.input);
    const retry = await post(`${base('management', input.commandId)}/retry`);
    expect(retry.status).toBe(200);
    const result = await retry.json(); expect(result.family).toBe('management'); expect(result.result.spec.alias).toBe('A朋友');
    expect((await get(`${base('management', input.commandId)}/result`)).status).toBe(200);
    expect((await core.preparations!.get(actor, 'management', input.commandId)).state).toBe('PREPARED');
    expect((await counts()).management).toBe(1);

    const redemption = { commandId: randomUUID(), positionId: `position:${actor.userId}:synthetic-t0`, amountMinor: '10000', expectedVersion: 99 };
    expect((await post('/api/investments/redemptions', redemption)).status).toBe(409);
    const failed = await core.preparations!.get(actor, 'investment', redemption.commandId);
    expect(failed.input).toEqual(redemption); expect(failed.lastError?.code).toBe('STALE_POSITION');
    expect((await post(`${base('investment', redemption.commandId)}/retry`)).status).toBe(409);
    expect((await counts()).investment).toBe(0);
  });

  it('creates owner-scoped tombstones before delayed POSTs and fences every direct core prepare', async () => {
    const inputs = [managementInput(), { commandId: randomUUID(), positionId: `position:${actor.userId}:synthetic-t0`, amountMinor: '10000', expectedVersion: 1 }, goalInput()];
    const families = ['management', 'investment', 'goal'] as const;
    for (let i = 0; i < families.length; i++) {
      const stopped = await post(`${base(families[i], inputs[i].commandId)}/abandon`);
      expect(stopped.status).toBe(200); expect((await stopped.json()).state).toBe('ABANDONED');
    }
    await expect(management.prepare(actor, inputs[0] as ManagementInput)).rejects.toMatchObject({ code: 'PREPARATION_ABANDONED' });
    await expect(investment.prepare(actor, inputs[1] as never)).rejects.toMatchObject({ code: 'PREPARATION_ABANDONED' });
    await expect(goals.create(actor, inputs[2] as never)).rejects.toMatchObject({ code: 'PREPARATION_ABANDONED' });
    expect(await counts()).toEqual({ management: 0, investment: 0, goals: 0, commands: 0 });
    const commandId = inputs[0].commandId;
    expect((await get(base('management', commandId), other.userId)).status).toBe(404);
    expect((await get(`${base('management', commandId)}/result`, other.userId)).status).toBe(404);
    expect((await post(`${base('management', commandId)}/retry`, {}, other.userId)).status).toBe(404);
    const ownOther = await management.prepare(other, { commandId, spec: { kind: 'SUBSCRIPTION_QUERY' } });
    expect(ownOther.id).toBeTruthy(); expect((await core.preparations!.get(actor, 'management', commandId)).state).toBe('ABANDONED');
  });

  it('lets abandon win while a creator waits for its user lock, without any candidate commit', async () => {
    const input = managementInput();
    await core.preparations!.accept(actor, { family: 'management', operation: 'management', input });
    const blocker = await pool.connect();
    let work: Promise<unknown> | undefined;
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`${schema}:${actor.userId}`]);
      work = management.prepare(actor, input).then(() => 'prepared', error => error.code);
      await waitUntil(async () => (await pool.query(`SELECT count(*)::int AS n FROM pg_locks WHERE locktype='advisory' AND NOT granted`)).rows[0].n > 0);
      expect((await core.preparations!.abandon(actor, 'management', input.commandId)).state).toBe('ABANDONED');
      await blocker.query('COMMIT');
      expect(await work).toBe('PREPARATION_ABANDONED'); expect((await counts()).management).toBe(0);
    } finally { await blocker.query('ROLLBACK'); blocker.release(); if (work) await work; }
  });

  it('lets a candidate holding the fence commit first and makes abandon return its original prepared result', async () => {
    const input = managementInput(), key = parseInt(randomUUID().slice(0, 6), 16);
    await core.preparations!.accept(actor, { family: 'management', operation: 'management', input });
    await pool.query(`CREATE FUNCTION "${schema}".hold_candidate() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(${key},17); RETURN NEW; END $$;
      CREATE TRIGGER hold_candidate BEFORE INSERT ON "${schema}".management_actions FOR EACH ROW EXECUTE FUNCTION "${schema}".hold_candidate();`);
    const blocker = await pool.connect();
    let prepared: ReturnType<typeof management.prepare> | undefined, stop: ReturnType<NonNullable<typeof core.preparations>['abandon']> | undefined;
    try {
      await blocker.query('BEGIN'); await blocker.query('SELECT pg_advisory_xact_lock($1,17)', [key]);
      prepared = management.prepare(actor, input);
      await waitUntil(async () => (await pool.query(`SELECT count(*)::int AS n FROM pg_locks WHERE locktype='advisory' AND classid=$1 AND objid=17 AND NOT granted`, [key])).rows[0].n > 0);
      stop = core.preparations!.abandon(actor, 'management', input.commandId);
      await blocker.query('COMMIT');
      const result = await prepared, stopped = await stop;
      expect(stopped.state).toBe('PREPARED'); expect(stopped.resultId).toBe(result.id);
      expect((await get(`${base('management', input.commandId)}/result`)).status).toBe(200);
      expect((await counts()).management).toBe(1);
    } finally { await blocker.query('ROLLBACK'); blocker.release(); if (prepared) await prepared; if (stop) await stop; }
  });

  it('rolls back a real killed candidate connection and lets abandonment fence the durable pending request', async () => {
    const input = managementInput(), key = parseInt(randomUUID().slice(0, 6), 16);
    await core.preparations!.accept(actor, { family: 'management', operation: 'management', input });
    await pool.query(`CREATE FUNCTION "${schema}".hold_killed_candidate() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(${key},19); RETURN NEW; END $$;
      CREATE TRIGGER hold_killed_candidate BEFORE INSERT ON "${schema}".management_actions FOR EACH ROW EXECUTE FUNCTION "${schema}".hold_killed_candidate();`);
    // This one-connection pool belongs only to this test. Never select a victim
    // by the application user's other sessions or terminate the fixture/admin pool.
    const applicationName = `g8m-victim-${schema}`;
    const victimPool = new Pool({ ...pool.options, max: 1, application_name: applicationName });
    const safeConnectionErrors: string[] = [];
    observePoolErrors(victimPool, code => safeConnectionErrors.push(code));
    const victimManagement = createManagement(victimPool, { schema, clock: () => now });
    const blocker = await pool.connect();
    let work: Promise<{ ok: boolean; error?: unknown }> | undefined;
    try {
      await blocker.query('BEGIN'); await blocker.query('SELECT pg_advisory_xact_lock($1,19)', [key]);
      const before = await snapshot();
      work = victimManagement.prepare(actor, input).then(() => ({ ok: true }), error => ({ ok: false, error }));
      let victim: { pid: number; application_name: string; query: string } | undefined;
      await waitUntil(async () => {
        const candidates = (await pool.query(`SELECT pid,application_name,query FROM pg_stat_activity
          WHERE application_name=$1 AND datname=current_database() AND usename=current_user AND backend_type='client backend'
          AND pid<>pg_backend_pid() AND wait_event_type='Lock' AND query LIKE $2`, [applicationName, `%INSERT INTO "${schema}".management_actions%`])).rows;
        expect(candidates.length).toBeLessThanOrEqual(1);
        victim = candidates[0];
        return !!victim;
      });
      expect(victim!.application_name).toBe(applicationName);
      expect(victim!.query).toContain(`INSERT INTO "${schema}".management_actions`);
      expect((await pool.query(`SELECT count(*)::int AS n FROM pg_locks WHERE pid=$1 AND locktype='advisory' AND classid=$2 AND objid=19 AND NOT granted`, [victim!.pid, key])).rows[0].n).toBe(1);
      // The trigger runs after lockPreparationRequest's SELECT FOR UPDATE. This
      // table lock corroborates that the candidate reached the registry fence.
      expect((await pool.query(`SELECT count(*)::int AS n FROM pg_locks WHERE pid=$1 AND relation=to_regclass($2) AND mode='RowShareLock' AND granted`, [victim!.pid, `"${schema}".preparation_requests`])).rows[0].n).toBe(1);
      const terminated = await pool.query(`SELECT pg_terminate_backend(pid) AS terminated FROM pg_stat_activity
        WHERE pid=$1 AND application_name=$2 AND datname=current_database() AND usename=current_user
        AND backend_type='client backend' AND pid<>pg_backend_pid() AND wait_event_type='Lock' AND query LIKE $3`,
      [victim!.pid, applicationName, `%INSERT INTO "${schema}".management_actions%`]);
      expect(terminated.rows).toEqual([{ terminated: true }]);
      const outcome = await work;
      expect(outcome.ok).toBe(false); expect(outcome.error).toBeInstanceOf(Error);
      expect((outcome.error as Error & { code?: string }).code).toBe('57P01');
      expect(await snapshot()).toEqual(before); // no candidate, proof, provider, reservation, receipt or audit committed
      const pending = await core.preparations!.get(actor, 'management', input.commandId);
      expect(pending).toMatchObject({ state: 'PENDING', input }); expect(pending.resultId).toBeUndefined();
      expect((await core.preparations!.abandon(actor, 'management', input.commandId)).state).toBe('ABANDONED');
      await expect(management.prepare(actor, input)).rejects.toMatchObject({ code: 'PREPARATION_ABANDONED', statusCode: 409 });
      expect((await counts()).management).toBe(0);
      expect(safeConnectionErrors.every(code => /^[0-9A-Z_]+$/.test(code))).toBe(true);
    } finally {
      // Releasing the trigger barrier also settles work if an earlier assertion
      // failed before termination. Every borrowed client and victim pool is closed.
      try { await blocker.query('ROLLBACK'); }
      finally { blocker.release(); if (work) await work; await victimPool.end(); }
    }
  });

  it('keeps a committed goal recoverable after initial advancement fails and never advances through replay', async () => {
    const input = goalInput(), original = core.createTransfer;
    let attempts = 0;
    core.createTransfer = async () => { attempts++; throw new Error('simulated child response failure'); };
    expect((await post('/api/goals', input)).status).toBe(500);
    const request = await core.preparations!.get(actor, 'goal', input.commandId);
    expect(request.state).toBe('PREPARED'); expect(request.lastError).toBeUndefined(); expect(attempts).toBe(1);
    core.createTransfer = original;
    const retry = await post(`${base('goal', input.commandId)}/retry`);
    expect(retry.status).toBe(200); expect((await retry.json()).result.nodes[0].actionRef).toBeUndefined();
    expect((await post('/api/goals', input)).status).toBe(200);
    expect((await goals.create(actor, input)).nodes[0].actionRef).toBeUndefined();
    expect((await pool.query(`SELECT count(*)::int AS n FROM "${schema}".actions`)).rows[0].n).toBe(0);
    const stopped = await post(`${base('goal', input.commandId)}/abandon`);
    expect((await stopped.json()).state).toBe('PREPARED');
    expect((await goals.advance(actor, request.resultId!)).nodes[0].actionRef).toBeTruthy();
  });

  it('fences a goal replan at its final domain commit after validation has already completed', async () => {
    const originalInput = goalInput(), goal = await goals.create(actor, originalInput);
    await core.cancel(actor, goal.nodes[0].actionRef!.actionId);
    const input = { ...originalInput, commandId: randomUUID(), expectedPlanVersion: 1, title: '已验证但已放弃的重规划' };
    const originalDashboard = core.dashboard;
    let reached!: () => void, release!: () => void, calls = 0;
    const barrier = new Promise<void>(resolve => { reached = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    core.dashboard = async user => { const result = await originalDashboard(user); if (++calls === 2) { reached(); await gate; } return result; };
    const replan = post(`/api/goals/${goal.id}/replan`, input);
    try {
      await barrier;
      expect((await core.preparations!.abandon(actor, 'goal', input.commandId)).state).toBe('ABANDONED');
      release(); expect((await replan).status).toBe(409);
      expect((await goals.get(actor, goal.id, { readOnly: true })).planVersion).toBe(1);
      expect((await counts()).commands).toBe(1);
    } finally { release(); core.dashboard = originalDashboard; await replan; }
  });

  it('paginates stable same-time entries, binds cursors to their owner, and preserves immutable input on conflict', async () => {
    const commands: string[] = [];
    for (let i = 0; i < 5; i++) { const input = managementInput(); commands.push(input.commandId); await core.preparations!.accept(actor, { family: 'management', operation: 'management', input }); }
    const first = await core.preparations!.list(actor, { limit: 2 });
    await core.preparations!.abandon(actor, 'management', first.requests[0].commandId);
    now = new Date(now.getTime() + 1000);
    await core.preparations!.accept(actor, { family: 'management', operation: 'management', input: managementInput() });
    const second = await core.preparations!.list(actor, { limit: 2, cursor: first.nextCursor });
    const third = await core.preparations!.list(actor, { limit: 2, cursor: second.nextCursor });
    expect(new Set([...first.requests, ...second.requests, ...third.requests].map(r => r.commandId))).toEqual(new Set(commands));
    await expect(core.preparations!.list(other, { cursor: first.nextCursor })).rejects.toMatchObject({ code: 'INVALID_CURSOR' });
    const input = managementInput(); await management.prepare(actor, input);
    const before = await core.preparations!.get(actor, 'management', input.commandId);
    expect((await post('/api/management/actions', { ...input, spec: { kind: 'CONTACT_ALIAS_SAVE', payeeId: 'payee-lin', alias: '换参数' } })).status).toBe(409);
    expect(await core.preparations!.get(actor, 'management', input.commandId)).toEqual(before);
  });

  it('adopts legacy mappings without treating a conflicting new input as the original request', async () => {
    const input = managementInput(), action = await management.prepare(actor, input);
    await pool.query(`DELETE FROM "${schema}".preparation_requests WHERE command_id=$1`, [input.commandId]);
    expect((await post('/api/management/actions', { ...input, spec: { kind: 'CONTACT_ALIAS_SAVE', payeeId: 'payee-lin', alias: '别名' } })).status).toBe(409);
    await expect(core.preparations!.get(actor, 'management', input.commandId)).rejects.toMatchObject({ code: 'PREPARATION_NOT_FOUND' });
    const adopted = await core.preparations!.abandon(actor, 'management', input.commandId);
    expect(adopted).toMatchObject({ state: 'PREPARED', resultId: action.id, input: null });
    expect((await post('/api/management/actions', input)).status).toBe(200);
    expect((await core.preparations!.get(actor, 'management', input.commandId)).input).toEqual(input);
  });

  it('keeps every new GET and prepared retry read-only across expired grants, reservations and goals', async () => {
    const queryInput = managementInput(), query = await management.prepare(actor, queryInput);
    const queried = await management.authorize(actor, query.id, { level: 'CONFIRMATION', proofId: randomUUID(), actionHash: query.actionHash });
    const sub = queried.receipt!.subscriptions!.items.find(item => item.cancellationSupported)!;
    const mutationInput = managementInput({ spec: { kind: 'SUBSCRIPTION_CANCEL', queryActionId: query.id, subscriptionId: sub.id, expectedVersion: sub.version } });
    const mutation = await management.prepare(actor, mutationInput);
    await management.authorize(actor, mutation.id, { level: 'CONFIRMATION', proofId: randomUUID(), actionHash: mutation.actionHash });
    const redemptionInput = { commandId: randomUUID(), positionId: `position:${actor.userId}:synthetic-t0`, amountMinor: '10000', expectedVersion: 1 };
    const redemption = await investment.prepare(actor, redemptionInput);
    await investment.authorize(actor, redemption.id, { level: 'STRONG', proofId: randomUUID(), actionHash: redemption.actionHash });
    const goalDraft = goalInput(); await goals.create(actor, goalDraft);
    const pending = managementInput(); await core.preparations!.accept(actor, { family: 'management', operation: 'management', input: pending });
    const abandoned = randomUUID(); await core.preparations!.abandon(actor, 'management', abandoned);
    now = new Date(now.getTime() + 20 * 60_000);
    const before = await snapshot();
    const listed = await get('/api/preparation-requests?limit=2'); expect(listed.status).toBe(200);
    const page = await listed.json(); expect(page.requests).toHaveLength(2); expect(page.nextCursor).toBeTruthy();
    expect(JSON.stringify(page)).not.toMatch(/input_hash|user_id|merchant|subscriptions/);
    expect((await get(`/api/preparation-requests?limit=2&cursor=${page.nextCursor}`)).status).toBe(200);
    for (const [family, commandId] of [['management', queryInput.commandId], ['management', mutationInput.commandId], ['investment', redemptionInput.commandId], ['goal', goalDraft.commandId]] as const) {
      expect((await get(base(family, commandId))).status).toBe(200);
      const result = await get(`${base(family, commandId)}/result`); expect(result.status).toBe(200);
      const body = await result.json();
      if (commandId === mutationInput.commandId) { expect(body.result.detailsRedacted).toBe(true); expect(JSON.stringify(body)).not.toContain(sub.merchant); expect(body.result.receipt.subscription).toBeUndefined(); }
      if (commandId === queryInput.commandId) expect(body.result.receipt.subscriptions).toBeUndefined();
      expect((await post(`${base(family, commandId)}/retry`)).status).toBe(200);
      expect((await get(base(family, commandId), other.userId)).status).toBe(404);
    }
    for (const commandId of [pending.commandId, abandoned]) {
      expect((await get(base('management', commandId))).status).toBe(200);
      expect((await get(`${base('management', commandId)}/result`)).status).toBe(409);
    }
    expect(await snapshot()).toEqual(before);
  });
});
