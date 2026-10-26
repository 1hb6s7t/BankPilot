import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createConversationService } from '../apps/api/src/conversations';
import { createPlanningJournal, recognitionInputDigest } from '../apps/api/src/planning-journal';
import { stageDependencyDigest } from '../packages/agents/src/stage-recovery';
const connectionString = process.env.TEST_DATABASE_URL ?? 'postgres://bankpilot:bankpilot-local@127.0.0.1:55432/bankpilot';
const schema = `g8f_stage_${randomUUID().replaceAll('-', '').slice(0,20)}`;
const admin = new Pool({ connectionString, max: 2 }), pool = new Pool({ connectionString, options: `-c search_path=${schema}`, max: 6 });
const actor = { userId: 'stage-owner' }, versions = { graphVersion: 'g8f-test', schemaVersion: 'g8f-state' };
const input = { taskId: 'stage-task', message: '查询账单', accounts: [], payees: [], referenceDate: '2026-10-23', billReport: { source: 'synthetic', period: '2026-10' } } as any;
const digest = recognitionInputDigest(input), dependency = stageDependencyDigest({ role: 'bills', input });
let lease: string;
const stages = () => createPlanningJournal(pool, actor, 'command', lease, versions).stages(digest);
const success = { modelRuns: [{ role: 'bills', model: 'stub', status: 'success', durationMs: 1 }], proposals: [] };
const failure = { phase: 'planning' as const, stage: 'domain:bills' as const, code: 'MODEL_HTTP_502', retryable: true, message: '暂不可用', modelRuns: [{ role: 'bills', model: 'stub', status: 'failed' as const, durationMs: 1, errorCode: 'MODEL_HTTP_502' }] };
describe('G8F stage journal binds reusable results and retains fenced failure history', () => {
  beforeAll(async () => { await admin.query(`CREATE SCHEMA "${schema}"`); await createConversationService(pool).migrate(); }, 30000);
  beforeEach(async () => { lease = randomUUID(); await pool.query('TRUNCATE bp_subscription_continuations,bp_plan_commands'); await pool.query(`INSERT INTO bp_plan_commands(user_id,command_id,message_hash,lease_token,prepared_input,prepared_input_version,graph_version,graph_schema_version,graph_input_digest) VALUES($1,'command','hash',$2,$3,1,$4,$5,$6)`, [actor.userId, lease, JSON.stringify(input), versions.graphVersion, versions.schemaVersion, digest]); });
  afterAll(async () => { await pool.end(); await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await admin.end(); });
  it('reuses a normalized success after a failed attempt and preserves both histories once', async () => {
    await stages().recordFailure('domain:bills', failure, 'failed-1');
    expect(await stages().completed()).toEqual([]);
    await stages().save('domain:bills', dependency, success, 'success-1');
    await stages().save('domain:bills', dependency, success, 'duplicate-save');
    expect(await stages().load('domain:bills', dependency)).toEqual(success);
    expect((await stages().history()).map(run => run.status)).toEqual(['failed','success']);
  });
  for (const mutation of [
    "stage_results=jsonb_set(stage_results,'{domain:bills,value,proposals}','[{}]')",
    "stage_results='{}'::jsonb",
    "stage_history='[]'::jsonb",
    "stage_history='[null]'::jsonb",
    "prepared_input=jsonb_set(prepared_input,'{referenceDate}','\"2026-10-24\"')",
    "graph_schema_version='different'",
  ]) it(`permanently refuses altered state (${mutation.split('=')[0]})`, async () => {
    await stages().save('domain:bills', dependency, success, 'success-1');
    await pool.query(`UPDATE bp_plan_commands SET ${mutation}`);
    await expect(stages().completed()).rejects.toMatchObject({ code: expect.stringMatching(/^STAGE_/) });
  });
  it('detects deletion of all failed attempts or the complete saved stage collection', async () => {
    await stages().recordFailure('domain:bills', failure, 'failed-1');
    await pool.query("UPDATE bp_plan_commands SET stage_history='[]'::jsonb,stage_results='{}'::jsonb");
    await expect(stages().history()).rejects.toMatchObject({ code: 'STAGE_SNAPSHOT_DIGEST_MISMATCH' });
  });
  it('rejects different dependencies and a conflicting second result', async () => {
    await stages().save('domain:bills', dependency, success, 'success-1');
    await expect(stages().load('domain:bills', stageDependencyDigest({ different: true }))).rejects.toMatchObject({ code: 'STAGE_DEPENDENCY_MISMATCH' });
    await expect(stages().save('domain:bills', dependency, { ...success, proposals: [{}] }, 'success-2')).rejects.toMatchObject({ code: 'STAGE_RESULT_CONFLICT' });
    expect(await stages().load('domain:bills', dependency)).toEqual(success);
  });
  it('fences expired and replaced leases from saving or recording an obsolete branch', async () => {
    const stale = stages(); await pool.query("UPDATE bp_plan_commands SET updated_at=now()-interval '5 minutes'");
    await expect(stale.save('domain:bills', dependency, success, 'old-save')).rejects.toMatchObject({ code: 'PLAN_SUPERSEDED' });
    lease = randomUUID(); await pool.query('UPDATE bp_plan_commands SET lease_token=$1,updated_at=now()', [lease]);
    await stages().save('domain:bills', dependency, success, 'new-save');
    await expect(stale.recordFailure('domain:bills', failure, 'old-failure')).rejects.toMatchObject({ code: 'PLAN_SUPERSEDED' });
    expect((await stages().history()).map(run => run.status)).toEqual(['success']);
  });
});
