import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest';
import { createConversationService } from '../apps/api/src/conversations';
import { createPlanningJournal, recognitionSnapshotDigest } from '../apps/api/src/planning-journal';
import type { PlanningModelAttemptEvent } from '../packages/contracts/src';
const connectionString = process.env.TEST_DATABASE_URL ?? 'postgres://bankpilot:bankpilot-local@127.0.0.1:55432/bankpilot';
const schema = `g8e_journal_${randomUUID().replaceAll('-', '')}`;
const admin = new Pool({ connectionString });
const pool = new Pool({ connectionString, options: `-c search_path=${schema}`, max: 4 });
const versions = { graphVersion: 'g8e-test', schemaVersion: 'state-v1' };
const actor = { userId: 'independent-journal' };
let lease = randomUUID();
const base = () => ({ taskId: 'task', message: '查询余额', accounts: [], payees: [], referenceDate: '2026-10-23' });
const start = (cap = 4096): PlanningModelAttemptEvent => ({ type: 'attempt_start', attemptId: randomUUID(), invocationId: randomUUID(), role: 'semantic_intent', attempt: 1, requestMaxOutputTokens: cap, startedAtUtc: new Date().toISOString() });
const row = async () => (await pool.query('SELECT * FROM bp_plan_commands')).rows[0];
describe('G8E durable phase and output reservations', () => {
  beforeAll(async () => { await admin.query(`CREATE SCHEMA ${schema}`); await createConversationService(pool).migrate(); });
  beforeEach(async () => { lease = randomUUID(); await pool.query('TRUNCATE bp_subscription_continuations,bp_plan_commands'); await pool.query("INSERT INTO bp_plan_commands(user_id,command_id,message_hash,lease_token) VALUES($1,'command','hash',$2)", [actor.userId, lease]); });
  afterAll(async () => { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
  it('persists input before recognition and preserves it across a new lease', async () => {
    const old = createPlanningJournal(pool, actor, 'command', lease, versions);
    await old.freeze(base()); expect((await row()).recognition_digest).toBe(recognitionSnapshotDigest(base(), versions));
    const next = randomUUID(); await pool.query('UPDATE bp_plan_commands SET lease_token=$1', [next]);
    const fresh = createPlanningJournal(pool, actor, 'command', next, versions);
    expect(await fresh.load(base())).toMatchObject(base());
    await expect(old.saveSemantic(base(), { status: 'no_action', tasks: [], findings: [], modelRuns: [] })).rejects.toMatchObject({ code: 'PLAN_SUPERSEDED' });
  });
  it('saves successful semantic separately, including legitimate empty no_action, and verifies its digest', async () => {
    const journal = createPlanningJournal(pool, actor, 'command', lease, versions); await journal.freeze(base());
    await journal.saveSemantic(base(), { status: 'no_action', tasks: [], findings: [], modelRuns: [] });
    expect(await journal.semantic(base())).toMatchObject({ status: 'no_action' }); expect((await row()).prepared_input).toBeNull();
    await pool.query("UPDATE bp_plan_commands SET semantic_result=jsonb_set(semantic_result,'{status}','\"ready\"')");
    await expect(journal.semantic(base())).rejects.toMatchObject({ code: 'SEMANTIC_SNAPSHOT_INVALID' });
  });
  it('refuses cross-version successful semantic reuse before finance preparation', async () => {
    const journal = createPlanningJournal(pool, actor, 'command', lease, versions); await journal.freeze(base());
    await journal.saveSemantic(base(), { status: 'no_action', tasks: [], findings: [], modelRuns: [] });
    const changed = createPlanningJournal(pool, actor, 'command', lease, { ...versions, graphVersion: 'g8f-test' });
    await expect(changed.load(base())).rejects.toMatchObject({ code: 'RECOGNITION_SNAPSHOT_INCOMPATIBLE' });
    await expect(changed.semantic(base())).rejects.toMatchObject({ code: 'RECOGNITION_SNAPSHOT_INCOMPATIBLE' });
    expect((await row()).semantic_result.status).toBe('no_action');
  });
  it('rejects the previous semantic rule even when graph and state versions match, preserving its saved result', async () => {
    const journal = createPlanningJournal(pool, actor, 'command', lease, versions);
    await journal.freeze(base());
    const semantic = { status: 'no_action' as const, tasks: [], findings: [], modelRuns: [] };
    await journal.saveSemantic(base(), semantic);
    await pool.query("UPDATE bp_plan_commands SET recognition_semantic_version='bankpilot-semantic-g8f-v1'");
    const previous = await row();
    for (const operation of [() => journal.load(base()), () => journal.semantic(base()),
      () => journal.freeze(base()), () => journal.saveSemantic(base(), semantic)]) {
      await expect(operation()).rejects.toMatchObject({ code: 'RECOGNITION_SNAPSHOT_INCOMPATIBLE' });
    }
    const after = await row();
    expect(after.recognition_semantic_version).toBe(previous.recognition_semantic_version);
    expect(after.recognition_digest).toBe(previous.recognition_digest);
    expect(after.semantic_result).toEqual(previous.semantic_result);
    expect(after.semantic_digest).toBe(previous.semantic_digest);
    expect(after.model_attempts).toEqual(previous.model_attempts);
    expect(after.model_output_reserved).toBe(previous.model_output_reserved);
  });
  it('rejects in-memory catalog drift before saving the model result', async () => {
    const journal = createPlanningJournal(pool, actor, 'command', lease, versions); const input = await journal.freeze(base());
    input.referenceDate = '2026-10-24';
    await expect(journal.saveSemantic(input, { status: 'no_action', tasks: [], findings: [], modelRuns: [] })).rejects.toMatchObject({ code: 'RECOGNITION_INPUT_DRIFT' });
    expect((await row()).semantic_result).toBeNull();
  });
  it('keeps failed semantic out of the reusable result and retains its run history', async () => {
    const journal = createPlanningJournal(pool, actor, 'command', lease, versions); await journal.freeze(base());
    const runs = [{ role: 'semantic_intent', model: 'stub', status: 'failed' as const, durationMs: 1, errorCode: 'MODEL_HTTP_502' }];
    await journal.saveSemantic(base(), { status: 'failed', tasks: [], findings: [], modelRuns: runs, failure: { phase: 'semantic_intent', code: 'MODEL_HTTP_502', retryable: true, message: '暂不可用', modelRuns: runs } });
    expect(await journal.semantic(base())).toBeUndefined(); expect((await row()).semantic_model_runs).toEqual(runs);
    const saved = await journal.saveSemantic(base(), { status: 'no_action', tasks: [], findings: [], modelRuns: [] });
    expect(saved.modelRuns).toEqual(runs);
  });
  it('reserves before dispatch and never refunds unknown attempts across takeover', async () => {
    const journal = createPlanningJournal(pool, actor, 'command', lease, versions);
    for (let i = 0; i < 8; i++) await journal.observe(start());
    expect((await journal.observation()).attempts.every(item => item.outcome === 'unknown')).toBe(true);
    const next = randomUUID(); await pool.query('UPDATE bp_plan_commands SET lease_token=$1', [next]);
    const fresh = createPlanningJournal(pool, actor, 'command', next, versions);
    await expect(fresh.observe(start())).rejects.toMatchObject({ code: 'MODEL_OUTPUT_BUDGET_EXHAUSTED' });
    expect((await row()).model_output_reserved).toBe(32768); expect((await row()).model_attempts).toHaveLength(8);
  });
  it('labels downstream budget exhaustion as planning after successful recognition', async () => {
    const journal = createPlanningJournal(pool, actor, 'command', lease, versions); await journal.freeze(base());
    await journal.saveSemantic(base(), { status: 'ready', tasks: [], findings: [], modelRuns: [] });
    await journal.observe(start(32768));
    await expect(journal.observe({ ...start(), role: 'transfer' })).rejects.toMatchObject({ failure: { phase: 'planning', code: 'MODEL_OUTPUT_BUDGET_EXHAUSTED', retryable: false } });
  });
  it('labels a downstream attempt binding failure as planning, not recognition', async () => {
    const journal = createPlanningJournal(pool, actor, 'command', lease, versions);
    await expect(journal.observe({ ...start(), type: 'attempt_end', role: 'reviewer', status: 'success' })).rejects.toMatchObject({ failure: { phase: 'planning', code: 'MODEL_ATTEMPT_BINDING_INVALID', retryable: false } });
  });
  it('atomically prevents parallel reservations from overspending', async () => {
    const journal = createPlanningJournal(pool, actor, 'command', lease, versions); await journal.observe(start(30000));
    const outcomes = await Promise.allSettled([journal.observe(start(2000)), journal.observe(start(2000))]);
    expect(outcomes.filter(item => item.status === 'fulfilled')).toHaveLength(1);
    expect((await row()).model_output_reserved).toBe(32000);
  });
  it('binds ends to starts and preserves unknown outcome when an end cannot be written', async () => {
    const journal = createPlanningJournal(pool, actor, 'command', lease, versions); const event = start(); await journal.observe(event);
    await expect(journal.observe({ ...event, type: 'attempt_end', status: 'success', requestMaxOutputTokens: 10 })).rejects.toMatchObject({ code: 'MODEL_ATTEMPT_BINDING_INVALID' });
    expect((await row()).model_attempts[0].outcome).toBe('unknown');
    await journal.observe({ ...event, type: 'attempt_end', status: 'failed', errorCode: 'MODEL_HTTP_502' });
    expect((await row()).model_output_reserved).toBe(4096);
  });
  it('rejects an expired lease even before takeover and a cancelled observer without mutation', async () => {
    const journal = createPlanningJournal(pool, actor, 'command', lease, versions); const abort = new AbortController(); abort.abort();
    await expect(journal.observe(start(), { signal: abort.signal })).rejects.toMatchObject({ code: 'MODEL_ATTEMPT_PERSIST_CANCELLED' });
    expect((await row()).model_output_reserved).toBe(0);
    await pool.query("UPDATE bp_plan_commands SET updated_at=now()-interval '5 minutes'");
    await expect(journal.observe(start())).rejects.toMatchObject({ code: 'PLAN_SUPERSEDED' });
    expect((await row()).model_output_reserved).toBe(0);
  });
  it('rejects tampered input and budget counters without dispatch', async () => {
    const journal = createPlanningJournal(pool, actor, 'command', lease, versions); await journal.freeze(base());
    await pool.query("UPDATE bp_plan_commands SET recognition_input=jsonb_set(recognition_input,'{message}','\"转账\"')");
    await expect(journal.load(base())).rejects.toMatchObject({ code: 'RECOGNITION_SNAPSHOT_INVALID' });
    await pool.query('UPDATE bp_plan_commands SET model_output_reserved=1');
    await expect(journal.observe(start())).rejects.toMatchObject({ code: 'MODEL_OUTPUT_BUDGET_INVALID' });
  });
});
