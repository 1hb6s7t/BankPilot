import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import pg from 'pg';
import type { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { assertCheckpointFencingReady, currentJournalSchema, registerCheckpointAttempt, setupCheckpointFencing, transferCheckpointAttempt, type CheckpointJournalIdentity } from '../packages/agents/src/checkpoint-fencing';

const connectionString = process.env.BANKPILOT_TEST_DATABASE_URL ?? 'postgres://bankpilot:bankpilot-local@127.0.0.1:55432/bankpilot';
const pool = new pg.Pool({ connectionString, max: 8 });
const suffix = `${process.pid}_${randomUUID().replaceAll('-', '').slice(0, 8)}`;
const journalSchema = `bankpilot_g8b_j_${suffix}`;
const checkpointSchema = `bankpilot_g8b_c_${suffix}`;
const shadowSchema = `bankpilot_g8b_s_${suffix}`;
const foreignJournalSchema = `bankpilot_g8b_f_${suffix}`;
const incompleteJournalSchema = `bankpilot_g8b_i_${suffix}`;
const incompleteCheckpointSchema = `bankpilot_g8b_ic_${suffix}`;
const digest = 'a'.repeat(64);
const identity = (leaseToken: string, commandId = 'command-1', rootCommandId = 'root-1'): CheckpointJournalIdentity => ({
  userId: 'owner-1', commandId, rootCommandId, revision: 0,
  leaseToken, graphVersion: 'planner-g8b-test', graphSchemaVersion: 'state-v1', inputDigest: digest,
});

describe('G8B PostgresSaver journal-row fencing foundation', () => {
  beforeAll(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS "${checkpointSchema}" CASCADE`);
    await pool.query(`DROP SCHEMA IF EXISTS "${journalSchema}" CASCADE`);
    await pool.query(`CREATE SCHEMA "${journalSchema}"`);
    await pool.query(`CREATE TABLE "${journalSchema}".bp_plan_commands (
      user_id text NOT NULL, command_id text NOT NULL, root_command_id text, revision integer NOT NULL,
      lease_token uuid NOT NULL, status text NOT NULL,
      graph_version text NOT NULL, graph_schema_version text NOT NULL, graph_input_digest text NOT NULL,
      graph_checkpoint_thread_id text, graph_checkpoint_ns text, graph_checkpoint_id text,
      PRIMARY KEY(user_id,command_id)
    )`);
    const lease = randomUUID();
    await pool.query(
      `INSERT INTO "${journalSchema}".bp_plan_commands(user_id,command_id,root_command_id,revision,lease_token,status,graph_version,graph_schema_version,graph_input_digest)
       VALUES($1,$2,$3,0,$4,'running',$5,$6,$7)`,
      ['owner-1', 'command-1', 'root-1', lease, 'planner-g8b-test', 'state-v1', digest],
    );
    await setupCheckpointFencing(pool, { checkpointSchema, journalSchema });
    await registerCheckpointAttempt(pool, { checkpointSchema, journalSchema }, `attempt-${randomUUID()}`, identity(lease));
  }, 30000);

  afterAll(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS "${checkpointSchema}" CASCADE`);
    await pool.query(`DROP SCHEMA IF EXISTS "${journalSchema}" CASCADE`);
    await pool.query(`DROP SCHEMA IF EXISTS "${shadowSchema}" CASCADE`);
    await pool.query(`DROP SCHEMA IF EXISTS "${foreignJournalSchema}" CASCADE`);
    await pool.query(`DROP SCHEMA IF EXISTS "${incompleteCheckpointSchema}" CASCADE`);
    await pool.query(`DROP SCHEMA IF EXISTS "${incompleteJournalSchema}" CASCADE`);
    await pool.end();
  });

  it('checks the active journal schema and refuses startup when fencing migrations are missing', async () => {
    await pool.query(`CREATE SCHEMA "${shadowSchema}"`);
    await pool.query(`CREATE SCHEMA "${foreignJournalSchema}"`);
    await pool.query(`CREATE TABLE "${foreignJournalSchema}".bp_plan_commands (LIKE "${journalSchema}".bp_plan_commands INCLUDING ALL)`);
    const singleConnectionPool = new pg.Pool({ connectionString, max: 1 });
    try {
      await expect(setupCheckpointFencing(singleConnectionPool, { checkpointSchema, journalSchema }))
        .rejects.toThrow('Checkpoint setup requires a PostgreSQL pool with max >= 2');
    } finally {
      await singleConnectionPool.end();
    }
    const routedPool = new pg.Pool({ connectionString, options: `-c search_path=${shadowSchema},${journalSchema},public`, max: 2 });
    try {
      // The first schema exists but has no journal; the second contains the table that an unqualified runner query resolves.
      expect(await currentJournalSchema(routedPool)).toBe(journalSchema);
      await expect(assertCheckpointFencingReady(routedPool, { checkpointSchema, journalSchema })).resolves.toBeUndefined();
      await expect(assertCheckpointFencingReady(routedPool, { checkpointSchema, journalSchema: foreignJournalSchema }))
        .rejects.toThrow('Checkpoint fencing is not ready');
      await expect(assertCheckpointFencingReady(routedPool, { checkpointSchema: `missing_${suffix}`, journalSchema }))
        .rejects.toThrow('Checkpoint fencing is not ready');
      await pool.query(`ALTER TABLE "${checkpointSchema}".checkpoints DISABLE TRIGGER bp_fence_checkpoint_write`);
      await expect(assertCheckpointFencingReady(routedPool, { checkpointSchema, journalSchema }))
        .rejects.toThrow('Checkpoint fencing is not ready');
      await pool.query(`ALTER TABLE "${checkpointSchema}".checkpoints ENABLE TRIGGER bp_fence_checkpoint_write`);
      await pool.query(`ALTER TABLE "${checkpointSchema}".checkpoint_blobs DISABLE TRIGGER bp_fence_checkpoint_blob_write`);
      await expect(assertCheckpointFencingReady(routedPool, { checkpointSchema, journalSchema }))
        .rejects.toThrow('Checkpoint fencing is not ready');
      await pool.query(`ALTER TABLE "${checkpointSchema}".checkpoint_blobs ENABLE TRIGGER bp_fence_checkpoint_blob_write`);
      await pool.query(`UPDATE "${checkpointSchema}".bp_checkpoint_fencing_config SET journal_schema=$1 WHERE singleton`, [foreignJournalSchema]);
      await expect(setupCheckpointFencing(routedPool, { checkpointSchema, journalSchema }))
        .rejects.toThrow('BP_CHECKPOINT_JOURNAL_SCHEMA_MISMATCH');
      expect((await pool.query(`SELECT journal_schema FROM "${checkpointSchema}".bp_checkpoint_fencing_config WHERE singleton`)).rows[0].journal_schema)
        .toBe(foreignJournalSchema);
      await pool.query(`UPDATE "${checkpointSchema}".bp_checkpoint_fencing_config SET journal_schema=$1 WHERE singleton`, [journalSchema]);
      await pool.query(`ALTER TABLE "${checkpointSchema}".checkpoint_blobs DISABLE TRIGGER bp_block_checkpoint_blob_delete`);
      await expect(assertCheckpointFencingReady(routedPool, { checkpointSchema, journalSchema }))
        .rejects.toThrow('Checkpoint fencing is not ready');
      await pool.query(`ALTER TABLE "${checkpointSchema}".checkpoint_blobs ENABLE TRIGGER bp_block_checkpoint_blob_delete`);
      await pool.query(`ALTER TABLE "${checkpointSchema}".checkpoint_blobs DISABLE TRIGGER bp_fence_checkpoint_blob_write`);
      await pool.query(`UPDATE "${checkpointSchema}".bp_checkpoint_fencing_config SET migration_version=6 WHERE singleton`);
      await expect(setupCheckpointFencing(routedPool, { checkpointSchema, journalSchema }))
        .rejects.toThrow('BP_CHECKPOINT_SCHEMA_NEWER_THAN_CODE');
      expect((await pool.query(`SELECT migration_version FROM "${checkpointSchema}".bp_checkpoint_fencing_config WHERE singleton`)).rows[0].migration_version).toBe(6);
      expect((await pool.query(`SELECT tgenabled FROM pg_trigger WHERE tgrelid='"${checkpointSchema}".checkpoint_blobs'::regclass AND tgname='bp_fence_checkpoint_blob_write'`)).rows[0].tgenabled).toBe('D');
      await expect(assertCheckpointFencingReady(routedPool, { checkpointSchema, journalSchema }))
        .rejects.toThrow('Checkpoint fencing is not ready');
      await pool.query(`UPDATE "${checkpointSchema}".bp_checkpoint_fencing_config SET migration_version=5 WHERE singleton`);
      await pool.query(`ALTER TABLE "${checkpointSchema}".checkpoint_blobs ENABLE TRIGGER bp_fence_checkpoint_blob_write`);
      await pool.query(`DROP INDEX "${checkpointSchema}".bp_checkpoint_attempts_one_thread_per_lease`);
      await expect(assertCheckpointFencingReady(routedPool, { checkpointSchema, journalSchema }))
        .rejects.toThrow('Checkpoint fencing is not ready');
      await setupCheckpointFencing(routedPool, { checkpointSchema, journalSchema });
      await expect(assertCheckpointFencingReady(routedPool, { checkpointSchema, journalSchema })).resolves.toBeUndefined();

      await pool.query(`CREATE SCHEMA "${incompleteJournalSchema}"`);
      await pool.query(`CREATE SCHEMA "${incompleteCheckpointSchema}"`);
      await pool.query(`CREATE TABLE "${incompleteJournalSchema}".bp_plan_commands (LIKE "${journalSchema}".bp_plan_commands INCLUDING ALL)`);
      await pool.query(`ALTER TABLE "${incompleteJournalSchema}".bp_plan_commands DROP COLUMN graph_checkpoint_id`);
      await setupCheckpointFencing(routedPool, { checkpointSchema: incompleteCheckpointSchema, journalSchema: incompleteJournalSchema });
      await expect(assertCheckpointFencingReady(routedPool, { checkpointSchema: incompleteCheckpointSchema, journalSchema: incompleteJournalSchema }))
        .rejects.toThrow('Checkpoint fencing is not ready');
    } finally {
      await routedPool.end();
      await pool.query(`DROP SCHEMA IF EXISTS "${shadowSchema}" CASCADE`);
      await pool.query(`DROP SCHEMA IF EXISTS "${foreignJournalSchema}" CASCADE`);
      await pool.query(`DROP SCHEMA IF EXISTS "${incompleteCheckpointSchema}" CASCADE`);
      await pool.query(`DROP SCHEMA IF EXISTS "${incompleteJournalSchema}" CASCADE`);
    }
  });

  it('serializes cold schema setup and coalesces matching requests on a two-connection pool', async () => {
    const concurrentCheckpointSchema = `bankpilot_g8b_cc_${suffix}`;
    const otherCheckpointSchema = `bankpilot_g8b_co_${suffix}`;
    const conflictingCheckpointSchema = `bankpilot_g8b_cf_${suffix}`;
    const concurrentPool = new pg.Pool({ connectionString, max: 2 });
    try {
      const savers = await Promise.all([
        setupCheckpointFencing(concurrentPool, { checkpointSchema: concurrentCheckpointSchema, journalSchema }),
        setupCheckpointFencing(concurrentPool, { checkpointSchema: concurrentCheckpointSchema, journalSchema }),
        setupCheckpointFencing(concurrentPool, { checkpointSchema: otherCheckpointSchema, journalSchema }),
      ]);
      expect(savers[0]).toBe(savers[1]);
      expect(savers[0]).not.toBe(savers[2]);
      await expect(assertCheckpointFencingReady(concurrentPool, { checkpointSchema: otherCheckpointSchema, journalSchema })).resolves.toBeUndefined();
      const migrationVersion = (await concurrentPool.query(
        `SELECT migration_version FROM "${concurrentCheckpointSchema}".bp_checkpoint_fencing_config WHERE singleton`,
      )).rows[0]?.migration_version;
      expect(migrationVersion).toBe(5);

      const conflictingResults = await Promise.allSettled([
        setupCheckpointFencing(concurrentPool, { checkpointSchema: conflictingCheckpointSchema, journalSchema }),
        setupCheckpointFencing(concurrentPool, { checkpointSchema: conflictingCheckpointSchema, journalSchema: foreignJournalSchema }),
      ]);
      expect(conflictingResults.filter(result => result.status === 'fulfilled')).toHaveLength(1);
      const rejected = conflictingResults.find(result => result.status === 'rejected');
      expect(rejected?.status === 'rejected' && rejected.reason.message).toBe('BP_CHECKPOINT_JOURNAL_SCHEMA_MISMATCH');
      // A rejected queued binding must not poison the next setup or cache a failed promise.
      await setupCheckpointFencing(concurrentPool, { checkpointSchema: conflictingCheckpointSchema, journalSchema });
      await expect(assertCheckpointFencingReady(concurrentPool, { checkpointSchema: conflictingCheckpointSchema, journalSchema })).resolves.toBeUndefined();
    } finally {
      await concurrentPool.query(`DROP SCHEMA IF EXISTS "${concurrentCheckpointSchema}" CASCADE`);
      await concurrentPool.query(`DROP SCHEMA IF EXISTS "${otherCheckpointSchema}" CASCADE`);
      await concurrentPool.query(`DROP SCHEMA IF EXISTS "${conflictingCheckpointSchema}" CASCADE`);
      await concurrentPool.end();
    }
  });

  it('rejects both stale put and stale putWrites after a lease takeover, leaving the trusted tuple unchanged', async () => {
    const saver = await setupCheckpointFencing(pool, { checkpointSchema, journalSchema });
    const threadId = (await pool.query(`SELECT thread_id FROM "${checkpointSchema}".bp_checkpoint_attempts LIMIT 1`)).rows[0].thread_id as string;
    const checkpoint: Parameters<PostgresSaver['put']>[1] = {
      v: 4, id: randomUUID(), ts: new Date().toISOString(),
      channel_values: { plan: { proposals: ['transfer'] } }, channel_versions: { plan: 1 },
      versions_seen: {},
    };
    const baseConfig = { configurable: { thread_id: threadId, checkpoint_ns: '' } };
    const first = await saver.put(baseConfig, checkpoint, { source: 'loop', step: 0, parents: {} }, { plan: 1 });
    await saver.putWrites(first, [['__interrupt__', { reason: 'safe-pending-write' }]], 'task-safe', 'node-path');

    const beforeFirst = await saver.getTuple(first);
    expect(beforeFirst?.pendingWrites).toContainEqual(['task-safe', '__interrupt__', { reason: 'safe-pending-write' }]);
    const trustedBefore = (await pool.query(`SELECT graph_checkpoint_thread_id,graph_checkpoint_ns,graph_checkpoint_id FROM "${journalSchema}".bp_plan_commands WHERE command_id='command-1'`)).rows[0];
    expect(trustedBefore).toMatchObject({ graph_checkpoint_thread_id: threadId, graph_checkpoint_ns: '', graph_checkpoint_id: checkpoint.id });

    const laterCheckpoint: Parameters<PostgresSaver['put']>[1] = {
      ...checkpoint, id: `${checkpoint.id}~later`, ts: new Date().toISOString(),
      channel_values: { plan: { proposals: ['later'] } }, channel_versions: { plan: 2 },
    };
    const later = await saver.put(first, laterCheckpoint, { source: 'loop', step: 1, parents: {} }, { plan: 2 });
    const idempotentNext = await saver.put(later, laterCheckpoint, { source: 'loop', step: 1, parents: {} }, { plan: 2 });
    expect(idempotentNext.configurable?.checkpoint_id).toBe(laterCheckpoint.id);
    await expect(saver.put(later, { ...laterCheckpoint, ts: new Date().toISOString() },
      { source: 'loop', step: 2, parents: {} }, { plan: 99 })).rejects.toThrow('BP_CHECKPOINT_CONTENT_CONFLICT');
    await expect(saver.put(later, checkpoint, { source: 'loop', step: 0, parents: {} }, { plan: 1 }))
      .rejects.toThrow('BP_CHECKPOINT_LINEAGE_CONFLICT');
    await expect(saver.put(baseConfig, checkpoint, { source: 'loop', step: 0, parents: {} }, { plan: 1 }))
      .rejects.toThrow('BP_CHECKPOINT_LINEAGE_CONFLICT');
    const before = await saver.getTuple(idempotentNext);
    const trustedAtLater = (await pool.query(`SELECT graph_checkpoint_thread_id,graph_checkpoint_ns,graph_checkpoint_id FROM "${journalSchema}".bp_plan_commands WHERE command_id='command-1'`)).rows[0];
    expect(trustedAtLater).toMatchObject({ graph_checkpoint_thread_id: threadId, graph_checkpoint_ns: '', graph_checkpoint_id: laterCheckpoint.id });

    const newLease = randomUUID();
    await pool.query(`UPDATE "${journalSchema}".bp_plan_commands SET lease_token=$1 WHERE command_id='command-1'`, [newLease]);
    const staleCheckpoint = { ...laterCheckpoint, id: `${laterCheckpoint.id}~stale`, ts: new Date().toISOString(), channel_values: { plan: { proposals: ['laundered'] } }, channel_versions: { plan: 3 } };
    await expect(saver.put(later, staleCheckpoint, { source: 'loop', step: 2, parents: {} }, { plan: 3 })).rejects.toThrow('BP_CHECKPOINT_FENCED');
    await expect(saver.putWrites(later, [['__interrupt__', { reason: 'laundered' }]], 'task-safe', 'node-path')).rejects.toThrow('BP_CHECKPOINT_FENCED');
    await expect(saver.putWrites(later, [['model_result', { proposals: ['laundered'] }]], 'late-task', 'node-path')).rejects.toThrow('BP_CHECKPOINT_FENCED');

    const after = await saver.getTuple(later);
    expect(after?.checkpoint.channel_values.plan).toEqual({ proposals: ['later'] });
    expect(after?.pendingWrites).toEqual(before?.pendingWrites ?? []);
    expect((await saver.getTuple(first))?.pendingWrites).toEqual(beforeFirst?.pendingWrites);
    const trustedAfter = (await pool.query(`SELECT graph_checkpoint_thread_id,graph_checkpoint_ns,graph_checkpoint_id FROM "${journalSchema}".bp_plan_commands WHERE command_id='command-1'`)).rows[0];
    expect(trustedAfter).toEqual(trustedAtLater);
    expect((await pool.query(`SELECT count(*)::int AS count FROM "${checkpointSchema}".checkpoints WHERE thread_id=$1`, [threadId])).rows[0].count).toBe(2);
    expect((await pool.query(`SELECT count(*)::int AS count FROM "${checkpointSchema}".checkpoint_blobs WHERE thread_id=$1 AND channel='plan' AND version='99'`, [threadId])).rows[0].count).toBe(0);
    expect((await pool.query(`SELECT count(*)::int AS count FROM "${checkpointSchema}".checkpoint_blobs WHERE thread_id=$1 AND channel='plan' AND version='3'`, [threadId])).rows[0].count).toBe(0);
    await expect(saver.put({ configurable: { thread_id: threadId, checkpoint_ns: 'nested:child' } },
      { ...checkpoint, id: randomUUID() }, { source: 'loop', step: 2, parents: {} }, { plan: 4 }))
      .rejects.toThrow('BP_CHECKPOINT_NAMESPACE_NOT_ALLOWED');
  }, 30000);

  it('moves a trusted checkpoint lineage to a fresh attempt without changing blobs or pending-write ordering metadata', async () => {
    const commandId = 'transfer-command';
    const rootCommandId = 'transfer-root';
    const oldLease = randomUUID();
    const newLease = randomUUID();
    await pool.query(
      `INSERT INTO "${journalSchema}".bp_plan_commands(user_id,command_id,root_command_id,revision,lease_token,status,graph_version,graph_schema_version,graph_input_digest)
       VALUES($1,$2,$3,0,$4,'running',$5,$6,$7)`,
      ['owner-1', commandId, rootCommandId, oldLease, 'planner-g8b-test', 'state-v1', digest],
    );
    const sourceThread = `source-${randomUUID()}`;
    const targetThread = `target-${randomUUID()}`;
    const sourceIdentity = identity(oldLease, commandId, rootCommandId);
    await registerCheckpointAttempt(pool, { checkpointSchema, journalSchema }, sourceThread, sourceIdentity);
    const saver = await setupCheckpointFencing(pool, { checkpointSchema, journalSchema });

    const now = Date.now();
    const rootCheckpoint: Parameters<PostgresSaver['put']>[1] = {
      v: 4, id: `checkpoint-${now}-01`, ts: new Date(now).toISOString(),
      channel_values: { state: { stage: 'domain-complete' } }, channel_versions: { state: 1 }, versions_seen: {},
    };
    const rootConfig = await saver.put({ configurable: { thread_id: sourceThread, checkpoint_ns: '' } }, rootCheckpoint,
      { source: 'loop', step: 0, parents: {} }, { state: 1 });
    await saver.putWrites(rootConfig, [['domain_result', { complete: true }]], 'task-domain', 'branches.transfer');

    const headCheckpoint: Parameters<PostgresSaver['put']>[1] = {
      ...rootCheckpoint, id: `checkpoint-${now + 1}-02`, ts: new Date(now + 1).toISOString(),
      channel_values: { state: { stage: 'review-interrupted' } }, channel_versions: { state: 2 },
    };
    const headConfig = await saver.put(rootConfig, headCheckpoint,
      { source: 'loop', step: 1, parents: { domain: 'v1' } }, { state: 2 });
    await saver.putWrites(headConfig, [
      ['__interrupt__', { kind: 'review', actionHash: 'stable-hash' }],
      ['review_evidence', { checked: true }],
    ], 'task-review', 'reviewer.interrupt');
    await expect(saver.deleteThread(sourceThread)).rejects.toThrow('BP_CHECKPOINT_DELETE_DISABLED');

    // Preserve arbitrary but valid stored order/path metadata that the public
    // pendingWrites tuple deliberately does not expose.
    await pool.query(`UPDATE "${checkpointSchema}".checkpoint_writes
      SET task_path='reviewer.interrupt/0',idx=17
      WHERE thread_id=$1 AND checkpoint_ns='' AND checkpoint_id=$2 AND task_id='task-review' AND channel='review_evidence'`,
    [sourceThread, headCheckpoint.id]);
    const beforeTuple = await saver.getTuple(headConfig);
    const beforeRows = (await pool.query(`SELECT checkpoint_id,task_id,task_path,idx,channel,type,encode(blob,'hex') AS blob
      FROM "${checkpointSchema}".checkpoint_writes WHERE thread_id=$1 AND checkpoint_ns=''
      ORDER BY checkpoint_id,task_path,task_id,idx`, [sourceThread])).rows;

    await pool.query(`UPDATE "${journalSchema}".bp_plan_commands SET lease_token=$1 WHERE command_id=$2`, [newLease, commandId]);
    const targetIdentity = identity(newLease, commandId, rootCommandId);
    await registerCheckpointAttempt(pool, { checkpointSchema, journalSchema }, targetThread, targetIdentity);
    const copiedHead = await transferCheckpointAttempt(pool, { checkpointSchema, journalSchema }, targetThread, targetIdentity);
    expect(copiedHead).toBe(headCheckpoint.id);

    const pointer = (await pool.query(`SELECT graph_checkpoint_thread_id,graph_checkpoint_ns,graph_checkpoint_id
      FROM "${journalSchema}".bp_plan_commands WHERE command_id=$1`, [commandId])).rows[0];
    expect(pointer).toEqual({ graph_checkpoint_thread_id: targetThread, graph_checkpoint_ns: '', graph_checkpoint_id: headCheckpoint.id });
    const restored = await saver.getTuple({ configurable: { thread_id: targetThread, checkpoint_ns: '' } });
    expect(restored?.checkpoint).toEqual(beforeTuple?.checkpoint);
    expect(restored?.metadata).toEqual(beforeTuple?.metadata);
    expect(restored?.parentConfig).toEqual({ configurable: { thread_id: targetThread, checkpoint_ns: '', checkpoint_id: rootCheckpoint.id } });
    expect(restored?.pendingWrites).toEqual(beforeTuple?.pendingWrites);
    const afterRows = (await pool.query(`SELECT checkpoint_id,task_id,task_path,idx,channel,type,encode(blob,'hex') AS blob
      FROM "${checkpointSchema}".checkpoint_writes WHERE thread_id=$1 AND checkpoint_ns=''
      ORDER BY checkpoint_id,task_path,task_id,idx`, [targetThread])).rows;
    expect(afterRows).toEqual(beforeRows);

    const nextCheckpoint: Parameters<PostgresSaver['put']>[1] = {
      ...headCheckpoint, id: `checkpoint-${now + 2}-03`, ts: new Date(now + 2).toISOString(),
      channel_values: { state: { stage: 'review-complete' } }, channel_versions: { state: 3 },
    };
    const advanced = await saver.put({ configurable: { thread_id: targetThread, checkpoint_ns: '', checkpoint_id: headCheckpoint.id } },
      nextCheckpoint, { source: 'loop', step: 2, parents: {} }, { state: 3 });
    expect(advanced.configurable?.checkpoint_id).toBe(nextCheckpoint.id);
    await expect(saver.putWrites(headConfig, [['late', true]], 'old-task', 'late-node')).rejects.toThrow('BP_CHECKPOINT_FENCED');
    await pool.query(`DELETE FROM "${checkpointSchema}".bp_checkpoint_attempts WHERE thread_id=$1`, [targetThread]);
    await expect(saver.deleteThread(targetThread)).rejects.toThrow('BP_CHECKPOINT_DELETE_DISABLED');
  }, 30000);

  it('resumes a real LangGraph superstep on a new attempt without rerunning its completed sibling', async () => {
    const commandId = 'graph-transfer-command';
    const rootCommandId = 'graph-transfer-root';
    const oldLease = randomUUID();
    const newLease = randomUUID();
    await pool.query(
      `INSERT INTO "${journalSchema}".bp_plan_commands(user_id,command_id,root_command_id,revision,lease_token,status,graph_version,graph_schema_version,graph_input_digest)
       VALUES($1,$2,$3,0,$4,'running',$5,$6,$7)`,
      ['owner-1', commandId, rootCommandId, oldLease, 'planner-g8b-test', 'state-v1', digest],
    );
    const sourceThread = `graph-source-${randomUUID()}`;
    const targetThread = `graph-target-${randomUUID()}`;
    await registerCheckpointAttempt(pool, { checkpointSchema, journalSchema }, sourceThread, identity(oldLease, commandId, rootCommandId));
    const saver = await setupCheckpointFencing(pool, { checkpointSchema, journalSchema });
    const GraphState = Annotation.Root({ a: Annotation<string>(), b: Annotation<string>(), joined: Annotation<string>() });
    const runs = { a: 0, b: 0, join: 0 };
    let failBOnce = true;
    const buildGraph = (checkpointer: PostgresSaver) => new StateGraph(GraphState)
      .addNode('A', async () => { runs.a += 1; await new Promise(resolve => setTimeout(resolve, 5)); return { a: 'A-complete' }; })
      .addNode('B', async () => {
        runs.b += 1;
        await new Promise(resolve => setTimeout(resolve, 35));
        if (failBOnce) { failBOnce = false; throw new Error('INJECTED_BRANCH_FAILURE'); }
        return { b: 'B-complete' };
      })
      .addNode('join', state => { runs.join += 1; return { joined: `${state.a}:${state.b}` }; })
      .addEdge(START, 'A').addEdge(START, 'B').addEdge(['A', 'B'], 'join').addEdge('join', END)
      .compile({ checkpointer });

    await expect(buildGraph(saver).invoke({}, { configurable: { thread_id: sourceThread }, durability: 'sync' }))
      .rejects.toThrow('INJECTED_BRANCH_FAILURE');
    expect(runs).toEqual({ a: 1, b: 1, join: 0 });
    const sourcePointer = (await pool.query(`SELECT graph_checkpoint_id FROM "${journalSchema}".bp_plan_commands WHERE command_id=$1`, [commandId])).rows[0].graph_checkpoint_id as string;
    const failedTuple = await saver.getTuple({ configurable: { thread_id: sourceThread, checkpoint_ns: '', checkpoint_id: sourcePointer } });
    expect(failedTuple?.pendingWrites).toContainEqual([expect.any(String), 'a', 'A-complete']);

    const recoveryPool = new pg.Pool({ connectionString, max: 4 });
    try {
      await recoveryPool.query(`UPDATE "${journalSchema}".bp_plan_commands SET lease_token=$1 WHERE command_id=$2`, [newLease, commandId]);
      const nextIdentity = identity(newLease, commandId, rootCommandId);
      await registerCheckpointAttempt(recoveryPool, { checkpointSchema, journalSchema }, targetThread, nextIdentity);
      expect(await transferCheckpointAttempt(recoveryPool, { checkpointSchema, journalSchema }, targetThread, nextIdentity)).toBe(sourcePointer);

      const recoverySaver = await setupCheckpointFencing(recoveryPool, { checkpointSchema, journalSchema });
      const completed = await buildGraph(recoverySaver).invoke(null, { configurable: { thread_id: targetThread }, durability: 'sync' });
      expect(completed).toMatchObject({ a: 'A-complete', b: 'B-complete', joined: 'A-complete:B-complete' });
      expect(runs).toEqual({ a: 1, b: 2, join: 1 });
    } finally {
      await recoveryPool.end();
    }
  }, 30000);

  it('preserves the installed saver legacy v3 pending-send migration across attempt transfer', async () => {
    const commandId = 'legacy-transfer-command';
    const rootCommandId = 'legacy-transfer-root';
    const oldLease = randomUUID();
    const newLease = randomUUID();
    await pool.query(
      `INSERT INTO "${journalSchema}".bp_plan_commands(user_id,command_id,root_command_id,revision,lease_token,status,graph_version,graph_schema_version,graph_input_digest)
       VALUES($1,$2,$3,0,$4,'running',$5,$6,$7)`,
      ['owner-1', commandId, rootCommandId, oldLease, 'planner-g8b-test', 'state-v1', digest],
    );
    const sourceThread = `legacy-source-${randomUUID()}`;
    const targetThread = `legacy-target-${randomUUID()}`;
    await registerCheckpointAttempt(pool, { checkpointSchema, journalSchema }, sourceThread, identity(oldLease, commandId, rootCommandId));
    const saver = await setupCheckpointFencing(pool, { checkpointSchema, journalSchema });
    const now = Date.now();
    const parent = await saver.put({ configurable: { thread_id: sourceThread, checkpoint_ns: '' } }, {
      v: 3, id: `legacy-${now}-01`, ts: new Date(now).toISOString(),
      channel_values: { state: { ready: true } }, channel_versions: { state: 1 }, versions_seen: {},
    }, { source: 'loop', step: 0, parents: {} }, { state: 1 });
    const pendingSend = { node: 'next', input: { reference: 'durable' } };
    await saver.putWrites(parent, [['__pregel_tasks', pendingSend]], 'task-send', 'branches.next');
    const head = await saver.put(parent, {
      v: 3, id: `legacy-${now + 1}-02`, ts: new Date(now + 1).toISOString(),
      channel_values: { state: { ready: true, joined: true } }, channel_versions: { state: 2 }, versions_seen: {},
    }, { source: 'loop', step: 1, parents: {} }, { state: 2 });
    const before = await saver.getTuple(head);
    expect(before?.checkpoint.channel_values.__pregel_tasks).toEqual([pendingSend]);

    await pool.query(`UPDATE "${journalSchema}".bp_plan_commands SET lease_token=$1 WHERE command_id=$2`, [newLease, commandId]);
    const nextIdentity = identity(newLease, commandId, rootCommandId);
    await registerCheckpointAttempt(pool, { checkpointSchema, journalSchema }, targetThread, nextIdentity);
    expect(await transferCheckpointAttempt(pool, { checkpointSchema, journalSchema }, targetThread, nextIdentity)).toBe(head.configurable?.checkpoint_id);
    const after = await saver.getTuple({ configurable: { thread_id: targetThread, checkpoint_ns: '' } });
    expect(after?.checkpoint.channel_values.__pregel_tasks).toEqual([pendingSend]);
    expect(after?.checkpoint).toEqual(before?.checkpoint);
  }, 30000);

  it('independently checks every registration identity field and allows only one attempt per lease', async () => {
    const lease = randomUUID();
    const valid = identity(lease, 'identity-command', 'identity-root');
    await pool.query(
      `INSERT INTO "${journalSchema}".bp_plan_commands(user_id,command_id,root_command_id,revision,lease_token,status,graph_version,graph_schema_version,graph_input_digest)
       VALUES($1,$2,$3,$4,$5,'running',$6,$7,$8)`,
      [valid.userId, valid.commandId, valid.rootCommandId, valid.revision, valid.leaseToken,
        valid.graphVersion, valid.graphSchemaVersion, valid.inputDigest],
    );
    const mismatches: CheckpointJournalIdentity[] = [
      { ...valid, userId: 'other-owner' },
      { ...valid, commandId: 'other-command' },
      { ...valid, rootCommandId: 'other-root' },
      { ...valid, revision: valid.revision + 1 },
      { ...valid, leaseToken: randomUUID() },
      { ...valid, graphVersion: 'other-graph' },
      { ...valid, graphSchemaVersion: 'other-state' },
      { ...valid, inputDigest: 'b'.repeat(64) },
    ];
    for (const wrong of mismatches) {
      await expect(registerCheckpointAttempt(pool, { checkpointSchema, journalSchema }, `invalid-${randomUUID()}`, wrong))
        .rejects.toThrow('BP_CHECKPOINT_ATTEMPT_NOT_CURRENT');
    }
    await pool.query(`UPDATE "${journalSchema}".bp_plan_commands SET status='succeeded' WHERE command_id=$1`, [valid.commandId]);
    await expect(registerCheckpointAttempt(pool, { checkpointSchema, journalSchema }, `invalid-${randomUUID()}`, valid))
      .rejects.toThrow('BP_CHECKPOINT_ATTEMPT_NOT_CURRENT');
    await pool.query(`UPDATE "${journalSchema}".bp_plan_commands SET status='running' WHERE command_id=$1`, [valid.commandId]);
    const validThread = `valid-${randomUUID()}`;
    await registerCheckpointAttempt(pool, { checkpointSchema, journalSchema }, validThread, valid);
    await pool.query(`DROP INDEX "${checkpointSchema}".bp_checkpoint_attempts_one_thread_per_lease`);
    const duplicateLegacyThread = `legacy-duplicate-${randomUUID()}`;
    await pool.query(
      `INSERT INTO "${checkpointSchema}".bp_checkpoint_attempts
       (thread_id,user_id,command_id,root_command_id,revision,lease_token,graph_version,graph_schema_version,input_digest)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [duplicateLegacyThread, valid.userId, valid.commandId, valid.rootCommandId, valid.revision,
        valid.leaseToken, valid.graphVersion, valid.graphSchemaVersion, valid.inputDigest],
    );
    await expect(setupCheckpointFencing(pool, { checkpointSchema, journalSchema }))
      .rejects.toThrow('bp_checkpoint_attempts_one_thread_per_lease');
    await pool.query(`DELETE FROM "${checkpointSchema}".bp_checkpoint_attempts WHERE thread_id=$1`, [duplicateLegacyThread]);
    await setupCheckpointFencing(pool, { checkpointSchema, journalSchema });
    await expect(registerCheckpointAttempt(pool, { checkpointSchema, journalSchema }, `duplicate-${randomUUID()}`, valid)).rejects.toThrow();
    const count = await pool.query(`SELECT count(*)::int AS count FROM "${checkpointSchema}".bp_checkpoint_attempts WHERE command_id=$1`, [valid.commandId]);
    expect(count.rows[0].count).toBe(1);
  });

  it('serializes a saver put ahead of lease takeover when the saver acquired the journal row first', async () => {
    const oldLease = randomUUID(), newLease = randomUUID();
    await pool.query(
      `INSERT INTO "${journalSchema}".bp_plan_commands(user_id,command_id,root_command_id,revision,lease_token,status,graph_version,graph_schema_version,graph_input_digest)
       VALUES($1,$2,$3,0,$4,'running',$5,$6,$7)`,
      ['owner-1', 'command-2', 'root-2', oldLease, 'planner-g8b-test', 'state-v1', digest],
    );
    const attempt = identity(oldLease, 'command-2', 'root-2');
    const threadId = `attempt-${randomUUID()}`;
    await registerCheckpointAttempt(pool, { checkpointSchema, journalSchema }, threadId, attempt);
    const saver = await setupCheckpointFencing(pool, { checkpointSchema, journalSchema, testLockDelayMs: 250 });
    const checkpoint: Parameters<PostgresSaver['put']>[1] = {
      v: 4, id: randomUUID(), ts: new Date().toISOString(),
      channel_values: { branch: { completed: true } }, channel_versions: { branch: 1 }, versions_seen: {},
    };
    const save = saver.put({ configurable: { thread_id: threadId, checkpoint_ns: '' } }, checkpoint,
      { source: 'loop', step: 0, parents: {} }, { branch: 1 });
    const waitUntilSaverOwnsLock = async () => {
      const until = Date.now() + 5000;
      while (Date.now() < until) {
        const result = await pool.query(
          `SELECT count(*)::int AS count FROM pg_stat_activity
           WHERE wait_event='PgSleep' AND position('checkpoints' in query)>0`,
        );
        if (result.rows[0].count >= 1) return;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      throw new Error('Checkpoint trigger did not reach its post-lock race barrier');
    };
    await waitUntilSaverOwnsLock();
    const pendingWrites = saver.putWrites(
      { configurable: { thread_id: threadId, checkpoint_ns: '', checkpoint_id: checkpoint.id } },
      [['branch_result', { completed: true }]], 'task-before-claim', 'branch-node',
    );
    const waitUntilWritesOwnsQueue = async () => {
      const until = Date.now() + 5000;
      while (Date.now() < until) {
        const result = await pool.query(
          `SELECT count(*)::int AS count FROM pg_stat_activity
           WHERE wait_event_type='Lock' AND position($1 in query)>0`,
          [`"${checkpointSchema}".checkpoint_writes`],
        );
        if (result.rows[0].count >= 1) return;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      throw new Error('PostgresSaver.putWrites did not queue behind the checkpoint put');
    };
    await waitUntilWritesOwnsQueue();
    const takeoverStarted = Date.now();
    const takeover = pool.query(`UPDATE "${journalSchema}".bp_plan_commands SET lease_token=$1 WHERE command_id='command-2'`, [newLease]);
    await Promise.all([save, pendingWrites, takeover]);
    expect(Date.now() - takeoverStarted).toBeGreaterThanOrEqual(150);

    const journal = (await pool.query(
      `SELECT lease_token,graph_checkpoint_thread_id,graph_checkpoint_id FROM "${journalSchema}".bp_plan_commands WHERE command_id='command-2'`,
    )).rows[0];
    expect(journal.lease_token).toBe(newLease);
    expect(journal.graph_checkpoint_thread_id).toBe(threadId);
    expect(journal.graph_checkpoint_id).toBe(checkpoint.id);
    const trusted = await saver.getTuple({ configurable: { thread_id: threadId, checkpoint_ns: '', checkpoint_id: checkpoint.id } });
    expect(trusted?.checkpoint.channel_values.branch).toEqual({ completed: true });
    expect(trusted?.pendingWrites).toContainEqual(['task-before-claim', 'branch_result', { completed: true }]);
  }, 30000);

  it('allows only one concurrent child of a trusted checkpoint to advance the pointer', async () => {
    const lease = randomUUID();
    await pool.query(
      `INSERT INTO "${journalSchema}".bp_plan_commands(user_id,command_id,root_command_id,revision,lease_token,status,graph_version,graph_schema_version,graph_input_digest)
       VALUES($1,$2,$3,0,$4,'running',$5,$6,$7)`,
      ['owner-1', 'command-4', 'root-4', lease, 'planner-g8b-test', 'state-v1', digest],
    );
    const threadId = `attempt-${randomUUID()}`;
    await registerCheckpointAttempt(pool, { checkpointSchema, journalSchema }, threadId, identity(lease, 'command-4', 'root-4'));
    const saver = await setupCheckpointFencing(pool, { checkpointSchema, journalSchema });
    const root: Parameters<PostgresSaver['put']>[1] = {
      v: 4, id: randomUUID(), ts: new Date().toISOString(),
      channel_values: { root: { ready: true } }, channel_versions: { root: 1 }, versions_seen: {},
    };
    const rootConfig = await saver.put({ configurable: { thread_id: threadId, checkpoint_ns: '' } }, root,
      { source: 'loop', step: 0, parents: {} }, { root: 1 });
    const child = (name: string, value: unknown): Parameters<PostgresSaver['put']>[1] => ({
      ...root, id: `${root.id}~${name}`, ts: new Date().toISOString(),
      channel_values: { [name]: value }, channel_versions: { [name]: 1 },
    });
    const left = child('left_blob', { branch: 'left' });
    const right = child('right_blob', { branch: 'right' });
    const results = await Promise.allSettled([
      saver.put(rootConfig, left, { source: 'loop', step: 1, parents: {} }, { left_blob: 1 }),
      saver.put(rootConfig, right, { source: 'loop', step: 1, parents: {} }, { right_blob: 1 }),
    ]);
    const winners = results.filter(result => result.status === 'fulfilled');
    const losers = results.filter(result => result.status === 'rejected');
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    if (losers[0].status === 'rejected') expect(String(losers[0].reason)).toContain('BP_CHECKPOINT_LINEAGE_CONFLICT');
    const winner = winners[0];
    if (winner.status !== 'fulfilled') throw new Error('Expected one child checkpoint winner');
    const winnerId = winner.value.configurable?.checkpoint_id;
    const pointer = (await pool.query(
      `SELECT graph_checkpoint_thread_id,graph_checkpoint_ns,graph_checkpoint_id FROM "${journalSchema}".bp_plan_commands WHERE command_id='command-4'`,
    )).rows[0];
    expect(pointer).toEqual({ graph_checkpoint_thread_id: threadId, graph_checkpoint_ns: '', graph_checkpoint_id: winnerId });
    const winnerTuple = await saver.getTuple({ configurable: { thread_id: threadId, checkpoint_ns: '', checkpoint_id: winnerId } });
    expect(winnerTuple).toBeDefined();
    const blobCounts = await pool.query(
      `SELECT channel,count(*)::int AS count FROM "${checkpointSchema}".checkpoint_blobs
       WHERE thread_id=$1 AND channel IN ('left_blob','right_blob') GROUP BY channel`,
      [threadId],
    );
    expect(blobCounts.rows).toHaveLength(1);
    expect(blobCounts.rows[0].count).toBe(1);
  }, 30000);

  it('rejects both old put and putWrites when lease takeover locks the journal row first', async () => {
    const oldLease = randomUUID(), newLease = randomUUID();
    await pool.query(
      `INSERT INTO "${journalSchema}".bp_plan_commands(user_id,command_id,root_command_id,revision,lease_token,status,graph_version,graph_schema_version,graph_input_digest)
       VALUES($1,$2,$3,0,$4,'running',$5,$6,$7)`,
      ['owner-1', 'command-3', 'root-3', oldLease, 'planner-g8b-test', 'state-v1', digest],
    );
    const threadId = `attempt-${randomUUID()}`;
    await registerCheckpointAttempt(pool, { checkpointSchema, journalSchema }, threadId, identity(oldLease, 'command-3', 'root-3'));
    const saver = await setupCheckpointFencing(pool, { checkpointSchema, journalSchema });
    const checkpoint: Parameters<PostgresSaver['put']>[1] = {
      v: 4, id: randomUUID(), ts: new Date().toISOString(),
      channel_values: { stable: { value: 1 } }, channel_versions: { stable: 1 }, versions_seen: {},
    };
    const initial = await saver.put({ configurable: { thread_id: threadId, checkpoint_ns: '' } }, checkpoint,
      { source: 'loop', step: 0, parents: {} }, { stable: 1 });
    await saver.putWrites(initial, [['__interrupt__', { reason: 'stable-before-takeover' }]], 'stable-task', 'node');
    const baselineTuple = await saver.getTuple(initial);
    const baselinePointer = (await pool.query(
      `SELECT graph_checkpoint_thread_id,graph_checkpoint_ns,graph_checkpoint_id FROM "${journalSchema}".bp_plan_commands WHERE command_id='command-3'`,
    )).rows[0];

    const barrier = await pool.connect();
    await barrier.query('BEGIN');
    await barrier.query(`UPDATE "${journalSchema}".bp_plan_commands SET lease_token=$1 WHERE command_id='command-3'`, [newLease]);
    const blockedCheckpoint: Parameters<PostgresSaver['put']>[1] = {
      ...checkpoint, id: `${checkpoint.id}~blocked`, ts: new Date().toISOString(),
      channel_values: { uncommitted_channel: { value: 'must rollback' } }, channel_versions: { uncommitted_channel: 1 },
    };
    const oldPut = saver.put(initial, blockedCheckpoint, { source: 'loop', step: 1, parents: {} }, { uncommitted_channel: 1 });
    const oldWrites = saver.putWrites(initial, [['__interrupt__', { reason: 'must-not-replace' }]], 'stable-task', 'node');
    const settling = Promise.allSettled([oldPut, oldWrites]);
    try {
      const until = Date.now() + 5000;
      let waiting = 0;
      while (Date.now() < until) {
        const result = await pool.query(
          `SELECT count(*)::int AS count FROM pg_stat_activity
           WHERE datname=current_database() AND wait_event_type='Lock'
             AND (position($1 in query)>0 OR position($2 in query)>0 OR position($3 in query)>0)`,
          [`"${checkpointSchema}".checkpoint_blobs`, `"${checkpointSchema}".checkpoints`, `"${checkpointSchema}".checkpoint_writes`],
        );
        waiting = result.rows[0].count;
        if (waiting >= 2) break;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(waiting).toBeGreaterThanOrEqual(2);
      await barrier.query('COMMIT');
    } catch (error) {
      await barrier.query('ROLLBACK');
      await settling;
      throw error;
    } finally {
      barrier.release();
    }
    const outcomes = await settling;
    expect(outcomes).toHaveLength(2);
    for (const outcome of outcomes) {
      expect(outcome.status).toBe('rejected');
      if (outcome.status === 'rejected') expect(String(outcome.reason)).toContain('BP_CHECKPOINT_FENCED');
    }
    expect(await saver.getTuple(initial)).toEqual(baselineTuple);
    expect((await pool.query(
      `SELECT graph_checkpoint_thread_id,graph_checkpoint_ns,graph_checkpoint_id FROM "${journalSchema}".bp_plan_commands WHERE command_id='command-3'`,
    )).rows[0]).toEqual(baselinePointer);
    expect((await pool.query(
      `SELECT count(*)::int AS count FROM "${checkpointSchema}".checkpoint_blobs WHERE thread_id=$1 AND channel='uncommitted_channel'`,
      [threadId],
    )).rows[0].count).toBe(0);
  }, 30000);
});
