import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import type { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import pg from 'pg';
import {
  registerCheckpointAttempt,
  setupCheckpointFencing,
  transferCheckpointAttempt,
  type CheckpointJournalIdentity,
} from '../packages/agents/src/checkpoint-fencing';

const connectionString = process.env.BANKPILOT_TEST_DATABASE_URL ?? 'postgres://bankpilot:bankpilot-local@127.0.0.1:55432/bankpilot';
const pool = new pg.Pool({ connectionString, max: 8 });
const suffix = `${process.pid}_${randomUUID().replaceAll('-', '').slice(0, 8)}`;
const journalSchema = `bankpilot_cp_kill_j_${suffix}`;
const checkpointSchema = `bankpilot_cp_kill_c_${suffix}`;
const digest = 'b'.repeat(64);
const schemaOptions = { checkpointSchema, journalSchema };
const identity = (leaseToken: string, commandId: string, rootCommandId: string): CheckpointJournalIdentity => ({
  userId: 'owner-1', commandId, rootCommandId, revision: 0,
  leaseToken, graphVersion: 'planner-g8b-test', graphSchemaVersion: 'state-v1', inputDigest: digest,
});

async function waitForWorkerBackend(applicationName: string, timeoutMs = 10_000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let count = 1;
  while (Date.now() < deadline && count !== 0) {
    const result = await pool.query(`SELECT count(*)::int AS count FROM pg_stat_activity WHERE application_name=$1`, [applicationName]);
    count = result.rows[0].count;
    if (count !== 0) await new Promise(resolve => setTimeout(resolve, 25));
  }
  return count;
}

async function killTransferAt(pauseAt: 'before-pointer' | 'before-commit', saver: PostgresSaver) {
  const suffixId = randomUUID();
  const commandId = `process-killed-transfer-${pauseAt}-${suffixId}`;
  const rootCommandId = `process-killed-transfer-root-${suffixId}`;
  const oldLease = randomUUID();
  const killedLease = randomUUID();
  await pool.query(
    `INSERT INTO "${journalSchema}".bp_plan_commands(user_id,command_id,root_command_id,revision,lease_token,status,graph_version,graph_schema_version,graph_input_digest)
     VALUES($1,$2,$3,0,$4,'running',$5,$6,$7)`,
    ['owner-1', commandId, rootCommandId, oldLease, 'planner-g8b-test', 'state-v1', digest],
  );
  const sourceThread = `kill-source-${suffixId}`;
  const killedTargetThread = `kill-target-${suffixId}`;
  await registerCheckpointAttempt(pool, schemaOptions, sourceThread, identity(oldLease, commandId, rootCommandId));
  const now = Date.now();
  const rootConfig = await saver.put({ configurable: { thread_id: sourceThread, checkpoint_ns: '' } }, {
    v: 4, id: `killed-${suffixId}-01`, ts: new Date(now).toISOString(),
    channel_values: { state: { stage: 'root' } }, channel_versions: { state: 1 }, versions_seen: {},
  }, { source: 'loop', step: 0, parents: {} }, { state: 1 });
  const head = await saver.put(rootConfig, {
    v: 4, id: `killed-${suffixId}-02`, ts: new Date(now + 1).toISOString(),
    channel_values: { state: { stage: 'head' } }, channel_versions: { state: 2 }, versions_seen: {},
  }, { source: 'loop', step: 1, parents: {} }, { state: 2 });
  await saver.putWrites(head, [['completed', { stable: true }]], 'task-done', 'branches.completed');
  const sourceHead = head.configurable?.checkpoint_id;
  expect(sourceHead).toBeTruthy();

  await pool.query(`UPDATE "${journalSchema}".bp_plan_commands SET lease_token=$1 WHERE command_id=$2`, [killedLease, commandId]);
  const killedIdentity = identity(killedLease, commandId, rootCommandId);
  await registerCheckpointAttempt(pool, schemaOptions, killedTargetThread, killedIdentity);

  const applicationName = `bp_transfer_kill_${suffix}_${pauseAt}`;
  const workerPath = fileURLToPath(new URL('./fixtures/checkpoint-transfer-worker.ts', import.meta.url));
  const worker = spawn(process.execPath, ['--import', 'tsx', workerPath, JSON.stringify({
    options: schemaOptions, targetThreadId: killedTargetThread, identity: killedIdentity,
    applicationName, pauseAt,
  })], {
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    env: { ...process.env, BANKPILOT_TEST_DATABASE_URL: connectionString },
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
    worker.once('exit', (code, signal) => resolve({ code, signal }));
  });
  try {
    const expectedMessage = pauseAt === 'before-pointer' ? 'copied-before-pointer' : 'pointer-switched-before-commit';
    const reachedBarrier = await new Promise<boolean>(resolve => {
      const timeout = setTimeout(() => resolve(false), 15_000);
      worker.once('message', message => {
        clearTimeout(timeout);
        resolve(typeof message === 'object' && message !== null && 'type' in message && message.type === expectedMessage);
      });
    });
    expect(reachedBarrier).toBe(true);

    const beforeKill = await pool.query(`SELECT
        (SELECT graph_checkpoint_thread_id FROM "${journalSchema}".bp_plan_commands WHERE command_id=$1) AS pointer,
        (SELECT count(*)::int FROM "${checkpointSchema}".checkpoints WHERE thread_id=$2) AS target_checkpoints,
        (SELECT count(*)::int FROM "${checkpointSchema}".checkpoint_blobs WHERE thread_id=$2) AS target_blobs,
        (SELECT count(*)::int FROM "${checkpointSchema}".checkpoint_writes WHERE thread_id=$2) AS target_writes,
        (SELECT count(*)::int FROM "${checkpointSchema}".bp_checkpoint_transfers WHERE target_thread_id=$2) AS target_transfers,
        (SELECT count(*)::int FROM "${checkpointSchema}".checkpoints WHERE thread_id=$3) AS source_checkpoints,
        (SELECT count(*)::int FROM "${checkpointSchema}".checkpoint_blobs WHERE thread_id=$3) AS source_blobs,
        (SELECT count(*)::int FROM "${checkpointSchema}".checkpoint_writes WHERE thread_id=$3) AS source_writes`,
    [commandId, killedTargetThread, sourceThread]);
    expect(beforeKill.rows[0]).toMatchObject({
      pointer: sourceThread, target_checkpoints: 0, target_blobs: 0, target_writes: 0, target_transfers: 0,
      source_checkpoints: 2, source_writes: 1,
    });
    expect(beforeKill.rows[0].source_blobs).toBeGreaterThan(0);
    expect((await pool.query(`SELECT count(*)::int AS count FROM pg_stat_activity WHERE application_name=$1`, [applicationName])).rows[0].count).toBe(1);

    worker.kill('SIGKILL');
    const exit = await exited;
    expect(exit.signal).toBe('SIGKILL');
    expect(await waitForWorkerBackend(applicationName)).toBe(0);

    const journal = (await pool.query(`SELECT graph_checkpoint_thread_id,graph_checkpoint_id
      FROM "${journalSchema}".bp_plan_commands WHERE command_id=$1`, [commandId])).rows[0];
    expect(journal).toEqual({ graph_checkpoint_thread_id: sourceThread, graph_checkpoint_id: sourceHead });
    const remnants = await pool.query(`SELECT
      (SELECT count(*)::int FROM "${checkpointSchema}".checkpoints WHERE thread_id=$1) AS checkpoints,
      (SELECT count(*)::int FROM "${checkpointSchema}".checkpoint_blobs WHERE thread_id=$1) AS blobs,
      (SELECT count(*)::int FROM "${checkpointSchema}".checkpoint_writes WHERE thread_id=$1) AS writes,
      (SELECT count(*)::int FROM "${checkpointSchema}".bp_checkpoint_transfers WHERE target_thread_id=$1) AS transfers`, [killedTargetThread]);
    expect(remnants.rows[0]).toEqual({ checkpoints: 0, blobs: 0, writes: 0, transfers: 0 });

    const recoveryLease = randomUUID();
    const recoveryThread = `kill-recovery-${suffixId}`;
    await pool.query(`UPDATE "${journalSchema}".bp_plan_commands SET lease_token=$1 WHERE command_id=$2`, [recoveryLease, commandId]);
    const recoveryIdentity = identity(recoveryLease, commandId, rootCommandId);
    await registerCheckpointAttempt(pool, schemaOptions, recoveryThread, recoveryIdentity);
    expect(await transferCheckpointAttempt(pool, schemaOptions, recoveryThread, recoveryIdentity)).toBe(sourceHead);
    const recovered = (await pool.query(`SELECT graph_checkpoint_thread_id,graph_checkpoint_id
      FROM "${journalSchema}".bp_plan_commands WHERE command_id=$1`, [commandId])).rows[0];
    expect(recovered).toEqual({ graph_checkpoint_thread_id: recoveryThread, graph_checkpoint_id: sourceHead });
  } finally {
    if (worker.exitCode === null && worker.signalCode === null) worker.kill('SIGKILL');
    await exited;
    await waitForWorkerBackend(applicationName);
  }
}

describe('checkpoint transfer process-crash atomicity', () => {
  afterAll(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS "${checkpointSchema}" CASCADE`);
    await pool.query(`DROP SCHEMA IF EXISTS "${journalSchema}" CASCADE`);
    await pool.end();
  });

  it('rolls back the copied lineage when killed before or after the uncommitted pointer switch', async () => {
    await pool.query(`CREATE SCHEMA "${journalSchema}"`);
    await pool.query(`CREATE TABLE "${journalSchema}".bp_plan_commands (
      user_id text NOT NULL, command_id text NOT NULL, root_command_id text, revision integer NOT NULL,
      lease_token uuid NOT NULL, status text NOT NULL, graph_version text NOT NULL,
      graph_schema_version text NOT NULL, graph_input_digest text NOT NULL,
      graph_checkpoint_thread_id text, graph_checkpoint_ns text, graph_checkpoint_id text,
      PRIMARY KEY(user_id,command_id)
    )`);
    const concurrentPool = new pg.Pool({ connectionString, max: 2 });
    let saver: PostgresSaver;
    try {
      [saver] = await Promise.all([
        setupCheckpointFencing(pool, schemaOptions),
        setupCheckpointFencing(concurrentPool, schemaOptions),
      ]);
    } finally {
      await concurrentPool.end();
    }
    await killTransferAt('before-pointer', saver);
    await killTransferAt('before-commit', saver);
  }, 90000);
});
