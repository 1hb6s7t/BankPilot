import { withTransaction } from './database.js';
import { PgBoss } from "pg-boss";
import type { Pool } from "pg";
import type {
  CoreService,
  InvestmentService,
} from "../../contracts/src/index.js";
import { coreRuntime } from "./index.js";
import { investmentRuntime } from "./investment.js";

export type WorkerHandle = {
  stop(): Promise<void>;
  flushOutbox(): Promise<void>;
  errors: Error[];
};

/** Outbox and pg-boss insertion share one connection/transaction; bank execution never does. */
export async function startWorker(
  pool: Pool,
  core: CoreService,
  investment?: InvestmentService,
): Promise<WorkerHandle> {
  const config = coreRuntime.get(core);
  if (!config)
    throw new Error("Worker requires a service created by createCore");
  const schema = config.schema;
  if (investment && investmentRuntime.get(investment)?.schema !== schema)
    throw new Error("Investment worker requires the same core schema");
  const queue = "bankpilot-actions";
  const investmentQueue = "bankpilot-investments";
  const errors: Error[] = [];
  // Use the caller's connection settings without copying secrets into logs.
  const boss = new PgBoss({ ...pool.options, schema: `${schema}_jobs` });
  boss.on("error", (error) => {
    errors.push(error);
  });
  let stopping = false;
  let active: Promise<void> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  try {
    await boss.start();
    await boss.createQueue(queue, {
      retryLimit: 3,
      retryDelay: 1,
      expireInSeconds: 60,
    });
    await boss.work<{ actionId: string; kind: string }>(
      queue,
      { pollingIntervalSeconds: 0.5, localConcurrency: 2 },
      async (jobs) => {
        for (const job of jobs) {
          if (job.data.kind === "execute") await core.execute(job.data.actionId);
          else await core.reconcile(job.data.actionId);
        }
      },
    );
    if (investment) {
      await boss.createQueue(investmentQueue, {
        retryLimit: 3,
        retryDelay: 1,
        expireInSeconds: 60,
      });
      await boss.work<{ actionId: string; kind: string }>(
        investmentQueue,
        { pollingIntervalSeconds: 0.5, localConcurrency: 2 },
        async (jobs) => {
          for (const job of jobs) {
            if (job.data.kind === "execute")
              await investment.execute(job.data.actionId);
            else await investment.reconcile(job.data.actionId);
          }
        },
      );
    }
    const flushOutbox = (): Promise<void> => {
      if (active) return active;
      if (stopping) return Promise.resolve();
      active = (async () => {
        // The synthetic provider settles independently; reconciliation only observes original requests.
        if (investment) await investment.processDue();
        await withTransaction(pool, async tx => {
          const result = await tx.query(
            `SELECT * FROM "${schema}".outbox WHERE sent_at IS NULL AND available_at<=now() ORDER BY id LIMIT 25 FOR UPDATE SKIP LOCKED`,
          );
          for (const item of result.rows) {
            await boss.send(
              queue,
              { actionId: item.action_id, kind: item.kind },
              {
                db: {
                  executeSql: (sql: string, values?: unknown[]) =>
                    tx.query(sql, values),
                },
              },
            );
            await tx.query(
              `UPDATE "${schema}".outbox SET sent_at=now() WHERE id=$1`,
              [item.id],
            );
          }
          if (investment) {
            const pending = await tx.query(
              `SELECT * FROM "${schema}".investment_outbox WHERE sent_at IS NULL AND available_at<=now() ORDER BY id LIMIT 25 FOR UPDATE SKIP LOCKED`,
            );
            for (const item of pending.rows) {
              await boss.send(
                investmentQueue,
                { actionId: item.action_id, kind: item.kind },
                {
                  db: {
                    executeSql: (sql: string, values?: unknown[]) =>
                      tx.query(sql, values),
                  },
                },
              );
              await tx.query(
                `UPDATE "${schema}".investment_outbox SET sent_at=now() WHERE id=$1`,
                [item.id],
              );
            }
          }
        });
      })().finally(() => {
        active = undefined;
      });
      return active;
    };
    timer = setInterval(() => {
      void flushOutbox().catch((error) => errors.push(error));
    }, 250);
    timer.unref();
    await flushOutbox();
    return {
      errors,
      flushOutbox,
      async stop() {
        stopping = true;
        if (timer) clearInterval(timer);
        try {
          await active;
        } finally {
          await boss.stop({ graceful: true, timeout: 10_000 });
        }
      },
    };
  } catch (error) {
    // No handle escapes on partial startup. Stop every initialized consumer and
    // release the boss pool even when queue registration or first flush fails.
    stopping = true;
    if (timer) clearInterval(timer);
    try { await active; } catch { /* Preserve the original startup error. */ }
    try { await boss.stop({ graceful: true, timeout: 10_000 }); }
    catch { /* A cleanup error must not replace the initialization failure. */ }
    throw error;
  }
}
