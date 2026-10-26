/** Test-only dependency composition; signal handling/draining is the production lifecycle. */
import { serve } from '@hono/node-server';
import { Pool } from 'pg';
import { createApp } from '../../apps/api/src/app.js';
import { installApiShutdown } from '../../apps/api/src/lifecycle.js';
import { createCore } from '../../packages/core/src/index.js';
import type { Planner } from '../../packages/contracts/src/index.js';

export type ShutdownChildConfig = { connectionString: string; schema: string; userId: string; applicationName: string };
export type ShutdownChildEvent =
  | { type: 'ready'; port: number; pid: number }
  | { type: 'planner-started'; taskId: string; pid: number }
  | { type: 'planner-released' }
  | { type: 'signal-received'; signal: 'SIGTERM' | 'SIGINT' }
  | { type: 'planning-drained' }
  | { type: 'pool-ending' }
  | { type: 'pool-ended' }
  | { type: 'fatal'; code: string };
const send = (event: ShutdownChildEvent) => process.send?.(event);

process.once('message', (value: ShutdownChildConfig) => {
  void start(value).catch(() => { send({ type: 'fatal', code: 'CHILD_SETUP_FAILED' }); process.exit(1); });
});
async function start(config: ShutdownChildConfig) {
  if (!/^g8stop_[a-f0-9]{24}$/.test(config.schema)) throw new Error('Invalid child configuration');
  const pool = new Pool({ connectionString: config.connectionString, options: `-c search_path=${config.schema}`,
    application_name: config.applicationName, max: 8 });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  process.on('message', value => {
    if (value && typeof value === 'object' && 'type' in value && value.type === 'release-planner') release();
  });
  // IPC must not keep a broken shutdown alive. Only the real HTTP/PG resources may do so.
  process.channel?.unref();
  const planner: Planner = { async plan(input) {
    send({ type: 'planner-started', taskId: input.taskId, pid: process.pid });
    await gate;
    send({ type: 'planner-released' });
    return { taskId: input.taskId, planVersion: 1, mode: 'scripted', summary: '退出排空验收：待本人确认的合成草稿',
      events: [], suggestions: [{ payeeId: 'payee-lin', amountMinor: '30000', memo: 'sigterm-drained-proposal' }], evidence: [], findings: [] };
  } };
  const auth = { api: { async getSession({ headers }: { headers: Headers }) {
    return headers.get('cookie') === `shutdown_test_owner=${config.userId}`
      ? { user: { id: config.userId, email: 'shutdown-test@example.test' }, session: { id: 'shutdown-test-session', userId: config.userId } } : null;
  } } };
  const core = createCore(pool, { schema: config.schema });
  const app = createApp({ pool, auth: auth as never, core, planner, origin: 'http://localhost:5178', rpID: 'localhost', sandbox: false, plannerMode: 'scripted' });
  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 }, info => {
    send({ type: 'ready', port: info.port, pid: process.pid });
  });
  installApiShutdown({ server,
    waitForPlanning: async () => { await app.waitForPlanning(); send({ type: 'planning-drained' }); },
    closePool: async () => { send({ type: 'pool-ending' }); await pool.end(); send({ type: 'pool-ended' }); },
  });
  // Observation only: the production listener above owns all shutdown work.
  process.on('SIGTERM', () => send({ type: 'signal-received', signal: 'SIGTERM' }));
  process.on('SIGINT', () => send({ type: 'signal-received', signal: 'SIGINT' }));
}
