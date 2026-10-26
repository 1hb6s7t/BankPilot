import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCore, startWorker } from '../packages/core/src/index.js';
import type { CoreService, ActionView, TransferInput } from '../packages/contracts/src/index.js';
import type { WorkerHandle } from '../packages/core/src/worker.js';

const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL ?? 'postgres://bankpilot:bankpilot-local@127.0.0.1:55432/bankpilot', max: 15 });
const actor = { userId: 'core-test-user' };
let core: CoreService;
let schema: string;
let now: Date;
let worker: WorkerHandle | undefined;
const input = (amountMinor = '60000', overrides: Partial<TransferInput> = {}): TransferInput => ({
  commandId: randomUUID(), accountId: `acc-main-${actor.userId}`, payeeId: 'payee-lin', amountMinor, memo: '集成测试', ...overrides,
});
const confirm = (action: ActionView, level: 'CONFIRMATION' | 'STRONG' = 'CONFIRMATION', proofId = randomUUID()) =>
  core.authorize(actor, action.id, { level, proofId, actionHash: action.actionHash });

beforeEach(async () => {
  schema = `coretest_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  now = new Date('2026-10-22T07:00:00Z');
  core = createCore(pool, { schema, clock: () => now, reconcileDelayMs: 60_000 });
  await core.migrate();
  await core.seedDemo(actor);
});
afterEach(async () => {
  if (worker) { await worker.stop(); worker = undefined; }
  await pool.query(`DROP SCHEMA IF EXISTS "${schema}_jobs" CASCADE; DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
});
afterAll(async () => { await pool.end(); });

describe('Postgres business invariants and synthetic provider', () => {
  it('drafts do not consume money; concurrent authorizations cannot both accept yellow', async () => {
    const [a, b] = await Promise.all([
      core.createTransfer(actor, input('60000', { taskId: 'task-one' })),
      core.createTransfer(actor, input('60000', { taskId: 'task-two' })),
    ]);
    expect(a.tier).toBe('YELLOW'); expect(b.tier).toBe('YELLOW');
    expect((await core.dashboard(actor)).dailyUsedMinor).toBe('0');
    const results = await Promise.all([confirm(a), confirm(b)]);
    expect(results.map(r => r.status).sort()).toEqual(['AUTHORIZED', 'AWAITING_VERIFICATION']);
    const red = results.find(r => r.tier === 'RED')!;
    const before = red.id === a.id ? a : b;
    expect(red.actionHash).not.toBe(before.actionHash);
    await expect(confirm(before, 'STRONG')).rejects.toMatchObject({ code: 'STALE_ACTION' });
    expect((await core.dashboard(actor)).dailyUsedMinor).toBe('60000');
    await confirm(red, 'STRONG');
    const dashboard = await core.dashboard(actor);
    expect(dashboard.dailyUsedMinor).toBe('120000');
    expect(dashboard.accounts[0].reservedMinor).toBe('120000');
    expect(dashboard.accounts[0].balanceMinor).toBe('800000');
  });

  it('uses exact integer cents and the inclusive 1000-yuan threshold', async () => {
    for (const invalid of ['0', '-1', '0.1', '1e2', '001', '100.00', '9007199254740993']) {
      await expect(core.createTransfer(actor, input(invalid))).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    }
    await expect(core.createTransfer(actor, input(100 as unknown as string))).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    const exact = await core.createTransfer(actor, input('100000'));
    expect(exact.tier).toBe('YELLOW');
    await confirm(exact);
    const plusOne = await core.createTransfer(actor, input('1'));
    expect(plusOne.tier).toBe('RED');
    expect((await confirm(plusOne)).status).toBe('AWAITING_VERIFICATION');
    expect((await core.dashboard(actor)).dailyUsedMinor).toBe('100000');
  });

  it('idempotent command returns one immutable action and rejects changed parameters', async () => {
    const payload = input();
    const [a,b] = await Promise.all([core.createTransfer(actor,payload),core.createTransfer(actor,payload)]);
    expect(a.id).toBe(b.id); expect(a.actionHash).toBe(b.actionHash);
    await expect(core.createTransfer(actor,{ ...payload,amountMinor:'60001' })).rejects.toMatchObject({ code:'IDEMPOTENCY_CONFLICT' });
    expect((await core.dashboard(actor)).actions).toHaveLength(1);
  });

  it('timeout after independent provider commit enters UNKNOWN then query settles only once', async () => {
    const action = await core.createTransfer(actor,input('70000'));
    await confirm(action);
    await core.setNextFault(actor,'TIMEOUT_AFTER_COMMIT');
    const uncertain = await core.execute(action.id);
    expect(uncertain.status).toBe('UNKNOWN');
    const bank = await pool.query(`SELECT balance_minor FROM "${schema}".provider_accounts WHERE id=$1`,[action.accountId]);
    expect(bank.rows[0].balance_minor).toBe('730000');
    let dash = await core.dashboard(actor);
    expect(dash.accounts[0].balanceMinor).toBe('800000');
    expect(dash.accounts[0].reservedMinor).toBe('70000');
    await expect(core.cancel(actor,action.id)).rejects.toMatchObject({ code:'OUTCOME_UNCERTAIN' });
    now = new Date(now.getTime()+60*60_000);
    expect((await core.getAction(actor,action.id)).status).toBe('UNKNOWN');
    // A fresh service simulates process restart; execute must take the query-only path.
    const restarted = createCore(pool,{ schema,clock:()=>now });
    const settled = await restarted.execute(action.id);
    expect(settled.status).toBe('SUCCEEDED');
    expect(settled.receipt?.amountMinor).toBe('70000');
    await Promise.all([restarted.execute(action.id),restarted.reconcile(action.id),restarted.execute(action.id)]);
    const counts = await pool.query(`SELECT (SELECT count(*) FROM "${schema}".provider_transfers)::int AS transfers,(SELECT count(*) FROM "${schema}".provider_entries)::int AS entries,(SELECT sum(CASE WHEN side='DEBIT' THEN amount_minor ELSE -amount_minor END) FROM "${schema}".provider_entries)::text AS net`);
    expect(counts.rows[0]).toEqual({ transfers:1,entries:2,net:'0' });
    dash = await core.dashboard(actor);
    expect(dash.accounts[0].balanceMinor).toBe('730000');
    expect(dash.accounts[0].reservedMinor).toBe('0');
    expect(dash.dailyUsedMinor).toBe('70000');
    expect(dash.audit.filter(e=>e.type==='TRANSFER_SUCCEEDED')).toHaveLength(1);
  });

  it('recovered SUBMITTING with no bank record remains UNKNOWN and cannot resubmit', async () => {
    const action = await core.createTransfer(actor,input()); await confirm(action);
    await pool.query(`UPDATE "${schema}".actions SET status='SUBMITTING' WHERE id=$1`,[action.id]);
    expect((await core.execute(action.id)).status).toBe('UNKNOWN');
    expect((await core.execute(action.id)).status).toBe('UNKNOWN');
    expect((await core.reconcile(action.id)).status).toBe('UNKNOWN');
    expect((await pool.query(`SELECT count(*)::int AS n FROM "${schema}".provider_transfers`)).rows[0].n).toBe(0);
    expect((await core.dashboard(actor)).dailyUsedMinor).toBe('60000');
  });

  it('concurrent dispatch and reconcile cannot double debit', async () => {
    const action = await core.createTransfer(actor,input('40000')); await confirm(action);
    await Promise.all(Array.from({length:6},()=>core.execute(action.id)));
    expect((await core.reconcile(action.id)).status).toBe('SUCCEEDED');
    expect((await core.dashboard(actor)).accounts[0].balanceMinor).toBe('760000');
    expect((await pool.query(`SELECT count(*)::int AS n FROM "${schema}".provider_transfers`)).rows[0].n).toBe(1);
  });

  it('owner isolation, proof reuse, action replay and revoked authorization are rejected', async () => {
    const other = { userId:'another-user' }; await core.seedDemo(other);
    const action = await core.createTransfer(actor,input('10000'));
    await expect(core.getAction(other,action.id)).rejects.toMatchObject({ code:'NOT_FOUND' });
    await expect(core.cancel(other,action.id)).rejects.toMatchObject({ code:'NOT_FOUND' });
    await expect(core.authorize(other,action.id,{ level:'STRONG',proofId:randomUUID(),actionHash:action.actionHash })).rejects.toMatchObject({ code:'NOT_FOUND' });
    await expect(core.createTransfer(other,input())).rejects.toMatchObject({ code:'NOT_FOUND' });
    const proofId = randomUUID(); await confirm(action,'CONFIRMATION',proofId);
    await expect(confirm(action,'CONFIRMATION',proofId)).rejects.toMatchObject({ code:'INVALID_STATE' });
    const second = await core.createTransfer(actor,input('10000'));
    await expect(confirm(second,'CONFIRMATION',proofId)).rejects.toMatchObject({ code:'PROOF_REPLAY' });
    await core.cancel(actor,action.id);
    expect((await core.execute(action.id)).status).toBe('CANCELLED');
    expect((await core.dashboard(actor)).dailyUsedMinor).toBe('0');
    expect((await core.dashboard(other)).actions).toHaveLength(0);
  });

  it('expired accepted actions release reservation and cannot dispatch or approve', async () => {
    const action = await core.createTransfer(actor,input()); await confirm(action);
    now = new Date(now.getTime()+16*60_000);
    expect((await core.execute(action.id)).status).toBe('EXPIRED');
    await expect(confirm(action,'STRONG')).rejects.toMatchObject({ code:'ACTION_EXPIRED' });
    const dash = await core.dashboard(actor);
    expect(dash.dailyUsedMinor).toBe('0'); expect(dash.accounts[0].reservedMinor).toBe('0');
  });

  it('new authorization reclaims expired reservations without requiring a dashboard refresh', async () => {
    const old = await core.createTransfer(actor,input('700000')); await confirm(old,'STRONG');
    now = new Date(now.getTime()+14*60_000);
    const next = await core.createTransfer(actor,input('700000'));
    now = new Date(now.getTime()+2*60_000);
    expect((await confirm(next,'STRONG')).status).toBe('AUTHORIZED');
    expect((await core.getAction(actor,old.id)).status).toBe('EXPIRED');
    expect((await core.dashboard(actor)).accounts[0].reservedMinor).toBe('700000');
  });

  it('a provider receipt with changed amount cannot settle or free the uncertain reservation', async () => {
    const action = await core.createTransfer(actor,input('50000')); await confirm(action);
    await core.setNextFault(actor,'TIMEOUT_AFTER_COMMIT'); await core.execute(action.id);
    await pool.query(`UPDATE "${schema}".provider_transfers SET receipt=jsonb_set(receipt,'{amountMinor}','"1"')`);
    await expect(core.reconcile(action.id)).rejects.toMatchObject({ code:'INVALID_RECEIPT' });
    expect((await core.getAction(actor,action.id)).status).toBe('UNKNOWN');
    expect((await core.dashboard(actor)).accounts[0].reservedMinor).toBe('50000');
    expect((await core.dashboard(actor)).accounts[0].balanceMinor).toBe('800000');
  });

  it('explicit provider rejection releases funds and quota but retains audit', async () => {
    const action = await core.createTransfer(actor,input()); await confirm(action);
    await core.setNextFault(actor,'REJECT');
    expect((await core.execute(action.id)).status).toBe('FAILED');
    const dash = await core.dashboard(actor);
    expect(dash.dailyUsedMinor).toBe('0'); expect(dash.accounts[0].balanceMinor).toBe('800000');
    expect(dash.audit.some(e=>e.type==='TRANSFER_FAILED')).toBe(true);
  });

  it('reservation uses available balance without spending an unconfirmed draft', async () => {
    await core.createTransfer(actor,input('800000'));
    const action = await core.createTransfer(actor,input('700000')); await confirm(action,'STRONG');
    const second = await core.createTransfer(actor,input('100001'));
    await expect(confirm(second,'STRONG')).rejects.toMatchObject({ code:'INSUFFICIENT_FUNDS' });
    expect((await core.dashboard(actor)).accounts[0].reservedMinor).toBe('700000');
  });

  it('execution on a new Shanghai day re-evaluates quota and invalidates weak approval', async () => {
    now = new Date('2026-10-22T15:59:00Z');
    const oldDay = await core.createTransfer(actor,input('60000')); await confirm(oldDay);
    now = new Date('2026-10-22T16:01:00Z');
    const newDay = await core.createTransfer(actor,input('60000')); await confirm(newDay);
    const escalated = await core.execute(oldDay.id);
    expect(escalated.status).toBe('AWAITING_VERIFICATION');
    expect(escalated.actionHash).not.toBe(oldDay.actionHash);
    expect((await core.dashboard(actor)).dailyUsedMinor).toBe('60000');
    await confirm(escalated,'STRONG');
    expect((await core.dashboard(actor)).dailyUsedMinor).toBe('120000');
  });

  it('audit failure rolls back authorization, occupancy, proof and outbox atomically', async () => {
    const action = await core.createTransfer(actor,input());
    await pool.query(`ALTER TABLE "${schema}".audit_events ADD CONSTRAINT fail_authorize CHECK(type <> 'ACTION_AUTHORIZED')`);
    await expect(confirm(action)).rejects.toThrow();
    const dash = await core.dashboard(actor);
    expect(dash.actions[0].status).toBe('AWAITING_CONFIRMATION');
    expect(dash.dailyUsedMinor).toBe('0');
    expect((await pool.query(`SELECT count(*)::int AS n FROM "${schema}".outbox`)).rows[0].n).toBe(0);
    expect((await pool.query(`SELECT count(*)::int AS n FROM "${schema}".authorization_proofs`)).rows[0].n).toBe(0);
  });

  it('real pg-boss drains transactional outbox and durable execution survives worker restart', async () => {
    // Real wall time is needed for the queue scheduler; the database test schema remains isolated.
    now = new Date();
    const action = await core.createTransfer(actor,input('25000')); await confirm(action);
    worker = await startWorker(pool,core);
    for(let i=0;i<100;i++) {
      if ((await core.getAction(actor,action.id)).status==='SUCCEEDED') break;
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    expect((await core.getAction(actor,action.id)).status).toBe('SUCCEEDED');
    expect(worker.errors).toEqual([]);
    await worker.stop(); worker=undefined;
    const next = await core.createTransfer(actor,input('15000')); await confirm(next);
    worker = await startWorker(pool,core);
    for(let i=0;i<100;i++) {
      if ((await core.getAction(actor,next.id)).status==='SUCCEEDED') break;
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    expect((await core.getAction(actor,next.id)).status).toBe('SUCCEEDED');
    expect((await core.dashboard(actor)).accounts[0].balanceMinor).toBe('760000');
  },30_000);
});
