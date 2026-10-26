import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { createConnection } from 'node:net';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { expect, it } from 'vitest';
import { migrateApi } from '../apps/api/src/app.js';
import { createCore } from '../packages/core/src/index.js';
import type { AcceptedConversationMessage, Conversation } from '../packages/contracts/src/conversations.js';
import type { ShutdownChildConfig, ShutdownChildEvent } from './fixtures/api-shutdown-child.js';

const fixture = fileURLToPath(new URL('./fixtures/api-shutdown-child.ts', import.meta.url));
const connectionString = process.env.TEST_DATABASE_URL ?? 'postgres://bankpilot:bankpilot-local@127.0.0.1:55432/bankpilot';
type EventOf<T extends ShutdownChildEvent['type']> = Extract<ShutdownChildEvent, { type: T }>;
type Exit = { code: number | null; signal: NodeJS.Signals | null };
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function startChild(config: ShutdownChildConfig) {
  // Signal the actual Node child, never the tsx CLI wrapper.
  const child = spawn(process.execPath, ['--import', 'tsx', fixture], { cwd: process.cwd(), stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  child.stderr?.resume();
  const events: ShutdownChildEvent[] = [];
  const waiters = new Set<() => void>();
  let exit: Exit | undefined;
  const wake = () => { for (const waiter of [...waiters]) waiter(); };
  child.on('message', value => { events.push(value as ShutdownChildEvent); wake(); });
  child.on('exit', (code, signal) => { exit = { code, signal }; wake(); });
  child.on('error', () => { events.push({ type: 'fatal', code: 'CHILD_SPAWN_FAILED' }); wake(); });
  async function wait<T extends ShutdownChildEvent['type']>(type: T, predicate: (event: EventOf<T>) => boolean = () => true): Promise<EventOf<T>> {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error(`Shutdown child timed out: ${type}`)), 15_000);
      const finish = (error?: Error, event?: EventOf<T>) => { clearTimeout(timer); waiters.delete(check); if (error) reject(error); else resolve(event!); };
      const check = () => {
        const event = events.find(item => item.type === type && predicate(item as EventOf<T>)) as EventOf<T> | undefined;
        if (event) finish(undefined, event);
        else if (exit || events.some(item => item.type === 'fatal')) finish(new Error(`Shutdown child stopped before ${type}`));
      };
      waiters.add(check); check();
    });
  }
  child.send(config);
  return { child, events, wait, get exit() { return exit; } };
}

async function waitForExit(child: ChildProcess): Promise<Exit> {
  if (child.exitCode !== null || child.signalCode !== null) return { code: child.exitCode, signal: child.signalCode };
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.removeListener('exit', exited); reject(new Error('Drained API child did not exit naturally')); }, 10_000);
    const exited = (code: number | null, signal: NodeJS.Signals | null) => { clearTimeout(timer); resolve({ code, signal }); };
    child.once('exit', exited);
  });
}
async function cleanupChild(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const terminated = waitForExit(child);
  child.kill('SIGKILL');
  await terminated;
}

function post(port: number, path: string, body: unknown, userId: string) {
  const request = httpRequest({ hostname: '127.0.0.1', port, path, method: 'POST', agent: false,
    headers: { origin: 'http://localhost:5178', cookie: `shutdown_test_owner=${userId}`, 'content-type': 'application/json', connection: 'close' } });
  const closed = new Promise<void>(resolve => request.once('close', resolve));
  const response = new Promise<{ status: number; body: string }>((resolve, reject) => {
    request.once('error', reject);
    request.once('response', incoming => {
      let body = '';
      incoming.setEncoding('utf8');
      incoming.on('data', chunk => { body += chunk; });
      incoming.once('error', reject);
      incoming.once('end', () => resolve({ status: incoming.statusCode!, body }));
    });
  });
  // The direct-plan case intentionally closes its client without reading a response.
  void response.catch(() => {});
  request.setTimeout(10_000, () => request.destroy(new Error('HTTP fixture timed out')));
  request.end(JSON.stringify(body));
  return { request, response, closed };
}

async function connectionRefused(port: number) {
  return await new Promise<boolean>((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    socket.setTimeout(1000, () => { socket.destroy(); reject(new Error('New TCP connection hung during shutdown')); });
    socket.once('connect', () => { socket.destroy(); resolve(false); });
    socket.once('error', error => {
      if ('code' in error && error.code === 'ECONNREFUSED') resolve(true);
      else reject(new Error('New TCP connection failed without a connection-refused result'));
    });
  });
}
async function waitUntilRefused(port: number) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await connectionRefused(port)) return;
    await pause(20);
  }
  throw new Error('API kept accepting new TCP connections after SIGTERM');
}

it.each(['direct-disconnected', 'chat-background'] as const)('drains %s through the production SIGTERM lifecycle before closing PostgreSQL and exiting', async mode => {
  const schema = `g8stop_${randomUUID().replaceAll('-', '').slice(0, 24)}`;
  const owner = { userId: `shutdown-owner-${randomUUID()}` };
  const applicationName = `bpstop_${randomUUID().replaceAll('-', '').slice(0, 24)}`;
  const admin = new Pool({ connectionString, max: 2 });
  const pool = new Pool({ connectionString, options: `-c search_path=${schema}`, max: 8 });
  let process: ReturnType<typeof startChild> | undefined;
  let schemaCreated = false;
  const clients: ReturnType<typeof post>[] = [];
  const request = (port: number, path: string, body: unknown) => {
    const client = post(port, path, body, owner.userId); clients.push(client); return client;
  };
  const count = async (table: string) => Number((await pool.query(`SELECT count(*) FROM ${table}`)).rows[0].count);
  const command = async () => (await pool.query('SELECT * FROM bp_plan_commands WHERE user_id=$1', [owner.userId])).rows[0];
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`); schemaCreated = true;
    await migrateApi(pool);
    const core = createCore(pool, { schema }); await core.migrate(); await core.seedDemo(owner);
    const balances = (await pool.query('SELECT id,balance_minor::text FROM accounts ORDER BY id')).rows;
    const providerBalances = (await pool.query('SELECT id,balance_minor::text FROM provider_accounts ORDER BY id')).rows;
    process = startChild({ connectionString, schema, userId: owner.userId, applicationName });
    const ready = await process.wait('ready');
    expect(ready.pid).toBe(process.child.pid);
    let accepted: AcceptedConversationMessage | undefined;
    const text = '给林晓转300元，备注sigterm-drained-proposal';
    const directCommandId = `shutdown-${randomUUID()}`;
    let activeClient: ReturnType<typeof post>;
    if (mode === 'direct-disconnected') {
      activeClient = request(ready.port, '/api/plan', { commandId: directCommandId, message: text });
    } else {
      const creation = request(ready.port, '/api/conversations', { title: '真实进程退出排空' });
      const created = await creation.response; expect(created.status).toBe(201); await creation.closed;
      const conversation = JSON.parse(created.body) as Conversation;
      activeClient = request(ready.port, `/api/conversations/${conversation.id}/messages`, { clientMessageId: `shutdown-client-${randomUUID()}`, text });
      const response = await activeClient.response; expect(response.status).toBe(202);
      accepted = JSON.parse(response.body) as AcceptedConversationMessage;
      // The request has already finished: only the production background job tracks this plan.
      await activeClient.closed;
    }
    const started = await process.wait('planner-started');
    expect(started.pid).toBe(ready.pid);
    activeClient.request.destroy();
    await activeClient.closed;
    const before = await command();
    expect(before).toMatchObject({ status: 'running', result: null, proposal: null, prepared_input: { taskId: started.taskId, message: text } });
    expect(before.command_id).toBe(accepted?.command.commandId ?? directCommandId);
    expect(await count('actions')).toBe(0);

    expect(process.child.kill('SIGTERM')).toBe(true);
    await process.wait('signal-received', event => event.signal === 'SIGTERM');
    await waitUntilRefused(ready.port);
    // Repeat SIGTERM and also exercise the shared SIGINT listener while the same drain is pending.
    expect(process.child.kill('SIGTERM')).toBe(true);
    expect(process.child.kill('SIGINT')).toBe(true);
    await process.wait('signal-received', event => event.signal === 'SIGINT');
    await pause(300);
    expect(process.exit).toBeUndefined();
    expect(process.child.exitCode).toBeNull(); expect(process.child.signalCode).toBeNull();
    expect(process.events.some(event => event.type === 'planning-drained' || event.type === 'pool-ending')).toBe(false);
    expect((await command()).status).toBe('running');
    expect(await count('actions')).toBe(0);
    expect(Number((await admin.query('SELECT count(*) FROM pg_stat_activity WHERE application_name=$1', [applicationName])).rows[0].count)).toBeGreaterThan(0);
    expect(await connectionRefused(ready.port)).toBe(true);

    process.child.send({ type: 'release-planner' });
    await process.wait('pool-ended');
    expect(await waitForExit(process.child)).toEqual({ code: 0, signal: null });
    const final = await command();
    expect(final).toMatchObject({ command_id: before.command_id, status: 'complete', last_error_code: null,
      result: { actions: [{ amountMinor: '30000', memo: 'sigterm-drained-proposal', status: 'AWAITING_CONFIRMATION' }] } });
    expect(final.result.actions).toHaveLength(1);
    expect(final.proposal.suggestions).toEqual([{ payeeId: 'payee-lin', amountMinor: '30000', memo: 'sigterm-drained-proposal' }]);
    expect(await count('actions')).toBe(1);
    expect(await count("audit_events WHERE type='ACTION_PREPARED'")).toBe(1);
    expect(await count('authorization_proofs')).toBe(0); expect(await count('outbox')).toBe(0);
    expect(await count('provider_transfers')).toBe(0); expect(await count('provider_entries')).toBe(0);
    expect((await pool.query('SELECT id,balance_minor::text FROM accounts ORDER BY id')).rows).toEqual(balances);
    expect((await pool.query('SELECT id,balance_minor::text FROM provider_accounts ORDER BY id')).rows).toEqual(providerBalances);
    expect((await pool.query('SELECT used_minor::text FROM daily_usage')).rows.every(row => row.used_minor === '0')).toBe(true);
    expect(await count('bp_plan_commands')).toBe(1);
    expect(await count("bp_chat_messages WHERE kind='failure'")).toBe(0);
    expect(await count("bp_chat_messages WHERE kind='result'")).toBe(mode === 'chat-background' ? 1 : 0);
    if (accepted) {
      const messages = (await pool.query('SELECT role,kind,command_id,sequence::int AS sequence FROM bp_chat_messages ORDER BY sequence')).rows;
      expect(messages).toHaveLength(2);
      expect(messages[0]).toMatchObject({ role: 'user', command_id: accepted.command.commandId, sequence: 1 });
      expect(messages[1]).toMatchObject({ role: 'assistant', kind: 'result', command_id: accepted.command.commandId, sequence: 2 });
    }
    const stages = process.events.map(event => event.type);
    expect(stages.filter(type => type === 'planner-started')).toHaveLength(1);
    expect(stages.filter(type => type === 'pool-ending')).toHaveLength(1);
    expect(stages.filter(type => type === 'pool-ended')).toHaveLength(1);
    expect(stages.indexOf('planner-released')).toBeLessThan(stages.indexOf('planning-drained'));
    expect(stages.indexOf('planning-drained')).toBeLessThan(stages.indexOf('pool-ending'));
    expect(stages.indexOf('pool-ending')).toBeLessThan(stages.indexOf('pool-ended'));
    expect(Number((await admin.query('SELECT count(*) FROM pg_stat_activity WHERE application_name=$1', [applicationName])).rows[0].count)).toBe(0);
  } finally {
    for (const client of clients) client.request.destroy();
    try { if (process) await cleanupChild(process.child); }
    finally {
      await pool.end();
      try { if (schemaCreated) await admin.query(`DROP SCHEMA "${schema}" CASCADE`); }
      finally { await admin.end(); }
    }
  }
}, 60_000);
