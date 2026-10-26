import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { expect, it, vi } from 'vitest';
import { createCore, startWorker } from '../packages/core/src/index.js';
import type { WorkerHandle } from '../packages/core/src/worker.js';

/** Real PgBoss, local isolated SQL schemas. Only the business pool's first
 * outbox connection acquisition fails; this is not a physical DB outage. */
it('releases real PgBoss after a controlled first-flush connect error and restarts in the same schema', async () => {
  const connectionString = process.env.TEST_DATABASE_URL
    ?? 'postgres://bankpilot:bankpilot-local@127.0.0.1:55432/bankpilot';
  if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(connectionString).hostname)) {
    throw new Error('G8H_STARTUP_DATABASE_MUST_BE_LOCAL');
  }
  const id = randomUUID().replaceAll('-', '').slice(0, 16);
  const schema = `g8h_startup_${id}`, jobsSchema = `${schema}_jobs`, applicationName = `g8h_startup_worker_${id}`;
  // Migrations use a separate connection identity. The business pool stays empty
  // until its first (injected) connect, so every observed worker connection is PgBoss.
  const admin = new Pool({ connectionString, max: 2, application_name: `g8h_startup_admin_${id}` });
  const pool = new Pool({ connectionString, max: 4, application_name: applicationName });
  const startupError = new Error('G8H_CONTROLLED_INITIAL_OUTBOX_CONNECT_FAILED');
  let worker: WorkerHandle | undefined;
  let poolClosed = false;
  let connectSpy: ReturnType<typeof vi.spyOn> | undefined;
  const workerConnections = async () => (await admin.query(
    'SELECT count(*)::int AS count FROM pg_stat_activity WHERE application_name=$1', [applicationName],
  )).rows[0].count as number;
  try {
    await createCore(admin, { schema }).migrate();
    const core = createCore(pool, { schema });
    const firstConnect = vi.spyOn(pool, 'connect').mockRejectedValueOnce(startupError);
    connectSpy = firstConnect;
    await expect(startWorker(pool, core)).rejects.toBe(startupError);
    expect(firstConnect).toHaveBeenCalledTimes(1);
    expect(pool.totalCount).toBe(0);
    // PgBoss startup and queue/consumer registration were real: the durable queue exists.
    const queues = await admin.query(`SELECT name FROM "${jobsSchema}".queue WHERE name=$1`, ['bankpilot-actions']);
    expect(queues.rows).toEqual([{ name: 'bankpilot-actions' }]);
    await expect.poll(workerConnections, { timeout: 5000, interval: 100 }).toBe(0);
    // Four timer intervals pass with no subsequent business flush or PgBoss reconnect.
    await new Promise(resolve => setTimeout(resolve, 1100));
    expect(firstConnect).toHaveBeenCalledTimes(1);
    expect(await workerConnections()).toBe(0);
    firstConnect.mockRestore(); connectSpy = undefined;

    worker = await startWorker(pool, core);
    expect(await workerConnections()).toBeGreaterThan(0);
    await worker.flushOutbox();
    expect(worker.errors).toEqual([]);
    await worker.stop(); worker = undefined;
    await pool.end(); poolClosed = true;
    await expect.poll(workerConnections, { timeout: 5000, interval: 100 }).toBe(0);
    // No actor/auth user or financial action was created for this startup-only test.
    expect((await admin.query(`SELECT count(*)::int AS count FROM "${schema}".accounts`)).rows[0].count).toBe(0);
    expect((await admin.query(`SELECT count(*)::int AS count FROM "${schema}".actions`)).rows[0].count).toBe(0);
  } finally {
    connectSpy?.mockRestore();
    try { await worker?.stop(); }
    finally {
      try { if (!poolClosed) await pool.end(); }
      finally {
        try {
          await admin.query(`DROP SCHEMA IF EXISTS "${jobsSchema}" CASCADE`);
          await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
          const cleaned = await admin.query('SELECT to_regnamespace($1) IS NULL AS business_gone, to_regnamespace($2) IS NULL AS jobs_gone', [schema, jobsSchema]);
          expect(cleaned.rows[0]).toEqual({ business_gone: true, jobs_gone: true });
          expect(await workerConnections()).toBe(0);
        } finally { await admin.end(); }
      }
    }
  }
}, 30_000);
