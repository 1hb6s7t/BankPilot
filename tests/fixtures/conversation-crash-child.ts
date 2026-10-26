/** Test-only OS-process fault boundary. Never imported by production. */
import { serve } from '@hono/node-server';
import { Pool } from 'pg';
import { createApp } from '../../apps/api/src/app.js';
import { createCore } from '../../packages/core/src/index.js';
import type { CoreService, Planner } from '../../packages/contracts/src/index.js';

export type CrashChildConfig = { connectionString: string; schema: string; userId: string; mode: 'pause-after-draft' | 'recover-frozen' };
export type CrashChildEvent = { type: 'ready'; port: number; pid: number } | { type: 'draft-committed'; actionId: string; coreCommandId: string; pid: number } | { type: 'fatal'; code: string };
const send = (event: CrashChildEvent) => process.send?.(event);

process.once('message', (value: CrashChildConfig) => {
  void start(value).catch(() => { send({ type: 'fatal', code: 'CHILD_SETUP_FAILED' }); process.exit(1); });
});
async function start(config: CrashChildConfig) {
  if (!/^g8kill_[a-f0-9]{24}$/.test(config.schema) || !['pause-after-draft', 'recover-frozen'].includes(config.mode)) throw new Error('Invalid child configuration');
  const pool = new Pool({ connectionString: config.connectionString, options: `-c search_path=${config.schema}`, max: 8 });
  const actualCore = createCore(pool, { schema: config.schema });
  const event = async (stage: string, payload: Record<string, unknown> = {}) => {
    await pool.query('INSERT INTO process_test_events(stage,pid,payload) VALUES($1,$2,$3)', [stage, process.pid, JSON.stringify(payload)]);
  };
  const core: CoreService = { ...actualCore, async createTransfer(actor, input) {
    await event('core-create-attempt', { coreCommandId: input.commandId });
    const action = await actualCore.createTransfer(actor, input);
    await event('core-draft-returned', { actionId: action.id, coreCommandId: input.commandId });
    if (config.mode === 'pause-after-draft') {
      // createTransfer has committed; withholding its return holds the runner before result persistence.
      send({ type: 'draft-committed', actionId: action.id, coreCommandId: input.commandId, pid: process.pid });
      await new Promise<never>(() => {});
    }
    return action;
  } };
  const planner: Planner = { async plan(input) {
    await event('planner-call', { mode: config.mode });
    if (config.mode === 'recover-frozen') throw new Error('Recovery must reuse the durable proposal without planning');
    return { taskId: input.taskId, planVersion: 1, mode: 'scripted', summary: '物理进程恢复测试：待本人确认的草稿',
      events: [], suggestions: [{ payeeId: 'payee-lin', amountMinor: '30000', memo: 'process-kill-frozen-proposal' }], evidence: [], findings: [] };
  } };
  const auth = { api: { async getSession({ headers }: { headers: Headers }) {
    return headers.get('cookie') === `process_test_owner=${config.userId}`
      ? { user: { id: config.userId, email: 'process-test@example.test' }, session: { id: 'process-test-session', userId: config.userId } } : null;
  } } };
  const app = createApp({ pool, auth: auth as never, core, planner, origin: 'http://localhost:5178', rpID: 'localhost', sandbox: false, plannerMode: 'scripted' });
  serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 }, info => { send({ type: 'ready', port: info.port, pid: process.pid }); });
}
