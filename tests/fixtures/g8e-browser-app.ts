import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { betterAuth } from 'better-auth';
import { serve } from '@hono/node-server';
import { createServer, type ViteDevServer } from 'vite';
import react from '@vitejs/plugin-react';
import { createApp, migrateApi } from '../../apps/api/src/app.js';
import { createCore, createFinance, createManagement, createInvestment } from '../../packages/core/src/index.js';
import { createGoals } from '../../packages/core/src/goals.js';
import { createPlanner } from '../../packages/agents/src/index.js';

export type ControlledModelCall = { role: string; taskId?: string; status: number; requestMaxOutputTokens: number; responseKind: 'valid' | 'unavailable' | 'schema' | 'malformed_json' };
const modelResponse = (value: unknown) => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value) } }] }), { status: 200 });

/** Real local UI/API/PG, with only model.invalid replaced inside this test worker.
 * No production port, environment variable or auth migration is changed.
 */
export async function startG8eBrowserApp() {
  const connectionString = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL
    ?? 'postgres://bankpilot:bankpilot-local@127.0.0.1:55432/bankpilot';
  const schema = `g8e_browser_${randomUUID().replaceAll('-', '').slice(0, 18)}`;
  const admin = new Pool({ connectionString, max: 2 });
  const authPool = new Pool({ connectionString, options: '-c search_path=public', max: 4 });
  const pool = new Pool({ connectionString, options: `-c search_path=${schema}`, max: 12 });
  const email = `g8e-browser-${randomUUID()}@example.test`;
  const password = `G8e-${randomBytes(20).toString('hex')}!`;
  const calls: ControlledModelCall[] = [];
  const originalFetch = globalThis.fetch;
  let schemaCreated = false;
  let userId: string | undefined;
  let app: ReturnType<typeof createApp> | undefined;
  let apiServer: ReturnType<typeof serve> | undefined;
  let vite: ViteDevServer | undefined;
  let temporaryEnvDirectory: string | undefined;
  let failuresRemaining = 0;
  let failureRole = 'semantic_intent';
  let invalidSemantic: 'schema' | 'malformed_json' | undefined;
  let controlledFetch: typeof fetch | undefined;

  async function close() {
    await vite?.close();
    if (apiServer) await new Promise<void>((done, reject) => apiServer!.close(error => error ? reject(error) : done()));
    await app?.waitForPlanning();
    if (controlledFetch && globalThis.fetch === controlledFetch) globalThis.fetch = originalFetch;
    await pool.end();
    if (schemaCreated) await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    if (userId) {
      // Only this fixture's random owner is removed; no shared auth DDL.
      await authPool.query('DELETE FROM public.session WHERE "userId"=$1', [userId]);
      await authPool.query('DELETE FROM public.account WHERE "userId"=$1', [userId]);
      await authPool.query('DELETE FROM public."user" WHERE id=$1', [userId]);
    }
    await authPool.end(); await admin.end();
    if (temporaryEnvDirectory) await rm(temporaryEnvDirectory, { recursive: true, force: true });
  }

  try {
    await admin.query(`CREATE SCHEMA "${schema}"`); schemaCreated = true;
    await migrateApi(pool);
    const core = createCore(pool, { schema }); await core.migrate();
    const finance = createFinance(pool, { schema });
    const management = createManagement(pool, { schema }); await management.migrate();
    const investment = createInvestment(pool, { schema }); await investment.migrate();
    const goals = createGoals(pool, core, investment, finance, { schema }); await goals.migrate();

    const apiPort = await new Promise<number>(done => {
      apiServer = serve({ port: 0, hostname: '127.0.0.1', fetch: request => app ? app.fetch(request) : new Response('Starting isolated fixture', { status: 503 }) }, info => done(info.port));
    });
    const apiOrigin = `http://127.0.0.1:${apiPort}`;
    temporaryEnvDirectory = await mkdtemp(resolve(tmpdir(), 'bankpilot-g8e-web-'));
    vite = await createServer({ configFile: false, root: resolve('apps/web'), envDir: temporaryEnvDirectory, plugins: [react()],
      server: { host: '127.0.0.1', port: 0, strictPort: true, proxy: { '/api': { target: apiOrigin, changeOrigin: false } } },
      logLevel: 'error',
    });
    await vite.listen();
    const address = vite.httpServer?.address();
    if (!address || typeof address === 'string') throw new Error('G8E isolated web address unavailable');
    const origin = `http://127.0.0.1:${address.port}`;
    if ([apiPort, address.port].some(port => port === 8787 || port === 5178)) throw new Error('G8E fixture selected a production port');

    const auth = betterAuth({ appName: 'BankPilot G8E controlled browser', database: authPool,
      secret: randomBytes(48).toString('hex'), baseURL: origin, trustedOrigins: [origin],
      emailAndPassword: { enabled: true }, session: { expiresIn: 8 * 60 * 60, cookieCache: { enabled: false } },
      advanced: { cookiePrefix: `g8e-${randomUUID()}` },
    });
    const signup = await auth.api.signUpEmail({ body: { email, password, name: 'G8E独立浏览器恢复验收' } });
    userId = signup.user.id;
    const actor = { userId };
    await core.seedDemo(actor); await finance.seedDemo(actor); await management.seedDemo(actor); await investment.seedDemo(actor);

    controlledFetch = async (input, init) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input.toString() : input.url);
      if (url.hostname !== 'model.invalid') return originalFetch(input, init);
      const body = JSON.parse(String(init?.body));
      const task = JSON.parse(body.messages.find((message: { role: string }) => message.role === 'user').content);
      const failed = task.role === failureRole && failuresRemaining > 0;
      if (failed) failuresRemaining--;
      const responseKind = failed ? 'unavailable' : task.role === 'semantic_intent' && invalidSemantic ? invalidSemantic : 'valid';
      calls.push({ role: task.role, taskId: task.taskId, status: failed ? 502 : 200, requestMaxOutputTokens: body.max_tokens, responseKind });
      if (failed) return new Response('Controlled temporary service outage', { status: 502 });
      if (task.role === 'semantic_intent') {
        if (invalidSemantic === 'schema') return modelResponse({ tasks: 'Controlled structurally invalid output' });
        if (invalidSemantic === 'malformed_json') return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '{controlled invalid JSON' } }] }), { status: 200 });
        const amount = task.message.match(/转账([0-9]+\.[0-9]{2}元)/)?.[1];
        if (!amount) throw new Error('G8E controlled fixture requires an explicit synthetic amount');
        return modelResponse({ tasks: [{ operation: 'transfer', disposition: 'request', scope: { source: 'whole_message' },
          entity: { kind: 'payee', id: 'payee-lin', mention: { text: '林晓' } }, amount: { text: amount } }] });
      }
      if (task.role === 'transfer') return modelResponse({ role: 'transfer', planVersion: 1, summary: '合成转账草稿待本人确认', suggestion: task.data.resolved.suggestion, findings: [], evidence: [] });
      if (task.role === 'reviewer') return modelResponse({ approved: true, findings: [], summary: '仅同意创建待确认草稿，未授权或执行' });
      throw new Error('Unexpected G8E controlled model role');
    };
    globalThis.fetch = controlledFetch;
    const planner = createPlanner({ provider: { baseURL: 'https://model.invalid', model: 'g8e-controlled-browser', outputMode: 'json_object', maxAttempts: 2, retryDelayMs: 1 } });
    app = createApp({ pool, core, finance, management, investment, goals, auth, planner, origin, rpID: '127.0.0.1', sandbox: false, plannerMode: 'model' });

    return { origin, apiOrigin, schema, userId, email, password, calls,
      failNextSemanticPair() { failureRole = 'semantic_intent'; failuresRemaining = 2; },
      failNextRolePair(role: 'semantic_intent' | 'transfer' | 'reviewer') { failureRole = role; failuresRemaining = 2; },
      invalidSemanticOutput(mode: 'schema' | 'malformed_json' | undefined) { invalidSemantic = mode; },
      async saved(commandId: string) {
        return (await pool.query('SELECT command_id,status,recognition_digest,planning_failure,planning_failures,model_attempts,model_output_reserved,stage_results,stage_history,stage_state_digest,graph_restart_required,graph_attempt_history FROM bp_plan_commands WHERE user_id=$1 AND command_id=$2', [userId, commandId])).rows[0];
      },
      async funds() {
        const dashboard = await core.dashboard(actor);
        const transfers = await pool.query(`SELECT count(*)::int AS n FROM "${schema}".provider_transfers WHERE account_id=$1`, [`acc-main-${userId}`]);
        return { accounts: dashboard.accounts, actions: dashboard.actions, providerTransfers: transfers.rows[0].n };
      }, close,
    };
  } catch (error) { await close(); throw error; }
}
