import { getMigrations } from 'better-auth/db/migration';
import { createAuth, createPool } from '../apps/api/src/config.js';
import { migrateApi } from '../apps/api/src/app.js';
import { createCore } from '../packages/core/src/index.js';
import { createFinance } from '../packages/core/src/finance.js';
import { createManagement } from '../packages/core/src/management.js';
import { createInvestment } from '../packages/core/src/investment.js';
import { createGoals } from '../packages/core/src/goals.js';
import { currentJournalSchema, setupCheckpointFencing } from '../packages/agents/src/checkpoint-fencing.js';

const pool = createPool();
try {
  const auth = createAuth(pool);
  const migration = await getMigrations(auth.options);
  await migration.runMigrations();
  await migrateApi(pool);
  const journalSchema = await currentJournalSchema(pool);
  await setupCheckpointFencing(pool, {
    checkpointSchema: process.env.BANKPILOT_CHECKPOINT_SCHEMA ?? 'bankpilot_checkpoints',
    journalSchema,
  });
  const core = createCore(pool);
  await core.migrate();
  const management = createManagement(pool);
  await management.migrate();
  const finance = createFinance(pool);
  const investment = createInvestment(pool);
  await investment.migrate();
  await createGoals(pool, core, investment, finance).migrate();
  const email = 'bankpilot@example.test';
  let user = (await pool.query('SELECT id FROM "user" WHERE email=$1', [email])).rows[0];
  if (!user) {
    const result = await auth.api.signUpEmail({ body: { email, password: 'BankPilot-demo-2026!', name: '林小安' } });
    user = result.user;
  }
  await core.seedDemo({ userId: user.id });
  await finance.seedDemo({ userId: user.id });
  await management.seedDemo({ userId: user.id });
  await investment.seedDemo({ userId: user.id });
  console.log('BankPilot database and synthetic demo account ready. Existing balances are preserved.');
} finally { await pool.end(); }
