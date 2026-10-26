import pg from 'pg';
import { transferCheckpointAttempt, type CheckpointJournalIdentity, type CheckpointSchemaOptions } from '../../packages/agents/src/checkpoint-fencing.js';

const connectionString = process.env.BANKPILOT_TEST_DATABASE_URL ?? 'postgres://bankpilot:bankpilot-local@127.0.0.1:55432/bankpilot';
const [serializedOptions] = process.argv.slice(2);
if (!serializedOptions) throw new Error('Missing checkpoint transfer worker options');
const input = JSON.parse(serializedOptions) as {
  options: CheckpointSchemaOptions;
  targetThreadId: string;
  identity: CheckpointJournalIdentity;
  applicationName: string;
  pauseAt?: 'before-pointer' | 'before-commit';
};
const pool = new pg.Pool({ connectionString, max: 1 });
try {
  await pool.query(`SELECT set_config('application_name',$1,false)`, [input.applicationName]);
  await transferCheckpointAttempt(pool, input.options, input.targetThreadId, input.identity,
    input.pauseAt ? {
      beforePointerUpdate: input.pauseAt === 'before-pointer' ? () => waitAtBarrier('copied-before-pointer') : undefined,
      beforeCommit: input.pauseAt === 'before-commit' ? () => waitAtBarrier('pointer-switched-before-commit') : undefined,
    } : undefined);
} catch (error) {
  console.error(error instanceof Error ? error.message : 'CHECKPOINT_TRANSFER_WORKER_FAILED');
  process.exitCode = 1;
} finally {
  await pool.end();
}

async function waitAtBarrier(type: 'copied-before-pointer' | 'pointer-switched-before-commit') {
  if (!process.send) throw new Error('CHECKPOINT_TRANSFER_WORKER_IPC_UNAVAILABLE');
  process.send({ type });
  await new Promise<void>(resolve => process.once('message', () => resolve()));
}
