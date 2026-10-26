import { serve } from '@hono/node-server';
import { createCore } from '../../../packages/core/src/index.js';
import { createFinance } from '../../../packages/core/src/finance.js';
import { createManagement } from '../../../packages/core/src/management.js';
import { createInvestment } from '../../../packages/core/src/investment.js';
import { createGoals } from '../../../packages/core/src/goals.js';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { createPlanner, providerFromEnv } from '../../../packages/agents/src/index.js';
import { assertCheckpointFencingReady, currentJournalSchema, registerCheckpointAttempt, transferCheckpointAttempt } from '../../../packages/agents/src/checkpoint-fencing.js';
import { createApp } from './app.js';
import { createAuth, createPool, rpID, sandboxEnabled, webOrigin } from './config.js';
import { installApiShutdown } from './lifecycle.js';

async function startApi() {
  const pool = createPool();
  try {
    const checkpointOptions = {
      checkpointSchema: process.env.BANKPILOT_CHECKPOINT_SCHEMA ?? 'bankpilot_checkpoints',
      journalSchema: await currentJournalSchema(pool),
    };
    // DDL remains owned by `pnpm setup`; the API refuses traffic when that migration is missing.
    await assertCheckpointFencingReady(pool, checkpointOptions);
    const core = createCore(pool, { reconcileDelayMs: 15_000 });
    // Preparation fencing must exist before any delayed or new writer is accepted.
    await core.preparations!.assertReady();
    const finance = createFinance(pool);
    const investment = createInvestment(pool, { reconcileDelayMs: 15_000 });
    const goals = createGoals(pool, core, investment, finance);
    const checkpointRecoveryEnabled = process.env.BANKPILOT_CHECKPOINT_RECOVERY === 'true';
    const checkpointer = checkpointRecoveryEnabled
      ? new PostgresSaver(pool, undefined, { schema: checkpointOptions.checkpointSchema })
      : undefined;
    const planner = createPlanner(checkpointer ? { checkpointer } : {});
    const mode = providerFromEnv() ? 'model' : 'scripted';
    const app = createApp({ pool, core, finance, investment, goals, management: createManagement(pool), auth: createAuth(pool), planner,
      ...(checkpointRecoveryEnabled ? { checkpointAttempts: {
        register: (threadId: string, identity: Parameters<typeof registerCheckpointAttempt>[3]) => registerCheckpointAttempt(pool, checkpointOptions, threadId, identity),
        transfer: (threadId: string, identity: Parameters<typeof transferCheckpointAttempt>[3]) => transferCheckpointAttempt(pool, checkpointOptions, threadId, identity),
      } } : {}),
      origin: webOrigin, rpID, sandbox: sandboxEnabled, plannerMode: mode });
    app.startContinuations();
    const port = Number(process.env.API_PORT ?? 8787);
    const server = serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }, () => console.log(`BankPilot API http://127.0.0.1:${port} (${mode} planner)`));
    installApiShutdown({ server, waitForPlanning: () => { app.stopContinuations(); return app.waitForPlanning(); }, closePool: () => pool.end() });
  } catch (error) {
    await pool.end();
    throw error;
  }
}

void startApi().catch(error => {
  console.error('BankPilot API startup failed:', error instanceof Error ? error.message : 'API_STARTUP_FAILED');
  process.exitCode = 1;
});
