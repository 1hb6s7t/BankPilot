import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import pg, { type Pool, type PoolClient } from 'pg';
import {
  assertCheckpointFencingReady,
  setupCheckpointFencing,
  type CheckpointSchemaOptions,
} from '../packages/agents/src/checkpoint-fencing';

const connectionString = process.env.BANKPILOT_TEST_DATABASE_URL ?? 'postgres://bankpilot:bankpilot-local@127.0.0.1:55432/bankpilot';
const observerPool = new pg.Pool({ connectionString, max: 2 });
const suffix = `${process.pid}_${randomUUID().replaceAll('-', '').slice(0, 8)}`;

// These are deterministic return-point fault injections around real PostgreSQL
// calls; they do not simulate a TCP reset, process crash, or host power loss.

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };
type FaultMode = 'acquire-response-lost' | 'unlock-not-sent';

type FaultState = {
  lockAcquired: Deferred<number>;
  unlockIntercepted: Deferred<number>;
  continueFault: Deferred<void>;
  lockQueriesForwarded: number;
  unlockQueriesIntercepted: number;
  unlockQueriesForwarded: number;
  releaseArgument: Error | boolean | undefined;
  backendPid: number | undefined;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function makeFaultState(): FaultState {
  return {
    lockAcquired: deferred<number>(),
    unlockIntercepted: deferred<number>(),
    continueFault: deferred<void>(),
    lockQueriesForwarded: 0,
    unlockQueriesIntercepted: 0,
    unlockQueriesForwarded: 0,
    releaseArgument: undefined,
    backendPid: undefined,
  };
}

function faultInjectingPool(realPool: Pool, mode: FaultMode, state: FaultState): Pool {
  return new Proxy(realPool, {
    get(target, property) {
      if (property === 'connect') {
        return async () => instrumentClient(await target.connect(), mode, state);
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as Pool;
}

function instrumentClient(client: PoolClient, mode: FaultMode, state: FaultState): PoolClient {
  return new Proxy(client, {
    get(target, property) {
      if (property === 'query') {
        return async (...args: any[]) => {
          const queryText = typeof args[0] === 'string' ? args[0] : String(args[0]?.text ?? '');
          const normalized = queryText.toLowerCase();
          const rawQuery = Reflect.get(target, 'query', target) as (...queryArgs: any[]) => Promise<any>;

          if (normalized.includes('pg_advisory_lock(') && !normalized.includes('pg_advisory_unlock(')) {
            const pid = Number((await rawQuery.call(target, 'SELECT pg_backend_pid() AS pid')).rows[0]?.pid);
            state.backendPid = pid;
            const result = await rawQuery.apply(target, args);
            state.lockQueriesForwarded += 1;
            if (mode === 'acquire-response-lost') {
              // The real server acquired the session lock; inject a client-side lost-response failure at return.
              state.lockAcquired.resolve(pid);
              await state.continueFault.promise;
              throw new Error('CHECKPOINT_TEST_LOCK_ACQUIRE_RESPONSE_LOST');
            }
            return result;
          }

          if (normalized.includes('pg_advisory_unlock(') && mode === 'unlock-not-sent') {
            state.unlockQueriesIntercepted += 1;
            state.unlockIntercepted.resolve(state.backendPid ?? -1);
            await state.continueFault.promise;
            throw new Error('CHECKPOINT_TEST_UNLOCK_NOT_SENT');
          }

          if (normalized.includes('pg_advisory_unlock(')) state.unlockQueriesForwarded += 1;
          return rawQuery.apply(target, args);
        };
      }
      if (property === 'release') {
        return (error?: Error | boolean) => {
          state.releaseArgument = error;
          const release = Reflect.get(target, 'release', target) as (releaseError?: Error | boolean) => void;
          return release.call(target, error);
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as PoolClient;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs = 8_000): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timeout = setTimeout(() => reject(new Error('CHECKPOINT_TEST_BARRIER_TIMEOUT')), timeoutMs);
    }),
  ]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
}

async function createJournalSchema(pool: Pool, schema: string): Promise<void> {
  await pool.query(`CREATE SCHEMA "${schema}"`);
  await pool.query(`CREATE TABLE "${schema}".bp_plan_commands (
    user_id text NOT NULL, command_id text NOT NULL, root_command_id text, revision integer NOT NULL,
    lease_token uuid NOT NULL, status text NOT NULL, graph_version text NOT NULL,
    graph_schema_version text NOT NULL, graph_input_digest text NOT NULL,
    graph_checkpoint_thread_id text, graph_checkpoint_ns text, graph_checkpoint_id text,
    PRIMARY KEY(user_id,command_id)
  )`);
}

async function trySetupLock(observer: Pool, lockKey: string): Promise<boolean> {
  const client = await observer.connect();
  try {
    const result = await client.query<{ acquired: boolean }>(
      'SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS acquired', [lockKey],
    );
    const acquired = result.rows[0]?.acquired === true;
    if (acquired) await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [lockKey]);
    return acquired;
  } finally {
    client.release();
  }
}

async function waitForBackendExit(observer: Pool, pid: number, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await observer.query<{ present: boolean }>(
      'SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE pid=$1) AS present', [pid],
    );
    if (result.rows[0]?.present !== true) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`CHECKPOINT_TEST_BACKEND_STILL_PRESENT:${pid}`);
}

async function expectLockReleased(observer: Pool, pid: number, lockKey: string): Promise<void> {
  await waitForBackendExit(observer, pid);
  expect(await trySetupLock(observer, lockKey)).toBe(true);
}

describe('checkpoint setup lock-failure connection disposal', () => {
  afterAll(async () => {
    await observerPool.end();
  });

  it('discards the backend after PostgreSQL acquires the lock but the client loses the acquire response, then setup recovers', async () => {
    const schemaSuffix = `${suffix}_acq`;
    const options: CheckpointSchemaOptions = {
      checkpointSchema: `bankpilot_setup_fault_c_${schemaSuffix}`,
      journalSchema: `bankpilot_setup_fault_j_${schemaSuffix}`,
    };
    const lockKey = `bankpilot_checkpoint_setup:${options.checkpointSchema}`;
    const realPool = new pg.Pool({ connectionString, max: 4 });
    const state = makeFaultState();
    const injectedPool = faultInjectingPool(realPool, 'acquire-response-lost', state);
    let setupPromise: Promise<unknown> | undefined;
    try {
      await createJournalSchema(realPool, options.journalSchema);
      setupPromise = setupCheckpointFencing(injectedPool, options);

      const pid = await withTimeout(state.lockAcquired.promise);
      expect(state.lockQueriesForwarded).toBe(1);
      expect(await trySetupLock(observerPool, lockKey)).toBe(false);

      state.continueFault.resolve();
      await expect(setupPromise).rejects.toThrow('CHECKPOINT_TEST_LOCK_ACQUIRE_RESPONSE_LOST');
      expect(state.releaseArgument).toBeInstanceOf(Error);
      await expectLockReleased(observerPool, pid, lockKey);

      await expect(setupCheckpointFencing(realPool, options)).resolves.toBeDefined();
      await expect(assertCheckpointFencingReady(realPool, options)).resolves.toBeUndefined();
    } finally {
      state.continueFault.resolve();
      await setupPromise?.catch(() => undefined);
      await realPool.query(`DROP SCHEMA IF EXISTS "${options.checkpointSchema}" CASCADE`);
      await realPool.query(`DROP SCHEMA IF EXISTS "${options.journalSchema}" CASCADE`);
      await realPool.end();
    }
  }, 30000);

  it('discards the backend when the unlock command is intercepted before reaching PostgreSQL, then setup recovers', async () => {
    const schemaSuffix = `${suffix}_unl`;
    const options: CheckpointSchemaOptions = {
      checkpointSchema: `bankpilot_setup_fault_c_${schemaSuffix}`,
      journalSchema: `bankpilot_setup_fault_j_${schemaSuffix}`,
    };
    const lockKey = `bankpilot_checkpoint_setup:${options.checkpointSchema}`;
    const realPool = new pg.Pool({ connectionString, max: 4 });
    const state = makeFaultState();
    const injectedPool = faultInjectingPool(realPool, 'unlock-not-sent', state);
    let setupPromise: Promise<unknown> | undefined;
    try {
      await createJournalSchema(realPool, options.journalSchema);
      setupPromise = setupCheckpointFencing(injectedPool, options);

      const pid = await withTimeout(state.unlockIntercepted.promise);
      expect(state.lockQueriesForwarded).toBe(1);
      expect(state.unlockQueriesIntercepted).toBe(1);
      expect(state.unlockQueriesForwarded).toBe(0);
      expect(await trySetupLock(observerPool, lockKey)).toBe(false);

      state.continueFault.resolve();
      await expect(setupPromise).rejects.toThrow('CHECKPOINT_TEST_UNLOCK_NOT_SENT');
      expect(state.releaseArgument).toBeInstanceOf(Error);
      await expectLockReleased(observerPool, pid, lockKey);

      await expect(setupCheckpointFencing(realPool, options)).resolves.toBeDefined();
      await expect(assertCheckpointFencingReady(realPool, options)).resolves.toBeUndefined();
    } finally {
      state.continueFault.resolve();
      await setupPromise?.catch(() => undefined);
      await realPool.query(`DROP SCHEMA IF EXISTS "${options.checkpointSchema}" CASCADE`);
      await realPool.query(`DROP SCHEMA IF EXISTS "${options.journalSchema}" CASCADE`);
      await realPool.end();
    }
  }, 30000);
});
