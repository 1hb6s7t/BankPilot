import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { expect, it } from 'vitest';
import { migrateApi } from '../apps/api/src/app.js';
import { createConversationService } from '../apps/api/src/conversations.js';
import { createCore } from '../packages/core/src/index.js';
import type { AcceptedConversationMessage, Conversation, ConversationCommand, ConversationHistory } from '../packages/contracts/src/conversations.js';
import type { CrashChildConfig, CrashChildEvent } from './fixtures/conversation-crash-child.js';

const helper = fileURLToPath(new URL('./fixtures/conversation-crash-child.ts', import.meta.url));
const connectionString = process.env.TEST_DATABASE_URL ?? 'postgres://bankpilot:bankpilot-local@127.0.0.1:55432/bankpilot';

type EventOf<T extends CrashChildEvent['type']> = Extract<CrashChildEvent, { type: T }>;
function startChild(config: CrashChildConfig) {
  // process.execPath is the same Node runtime as the test; no shell, cloud, or shared server.
  const child = spawn(process.execPath, ['--import', 'tsx', helper], { cwd: process.cwd(), stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  // Consume stderr without exposing environment or connection credentials on test failures.
  child.stderr?.resume();
  const events: CrashChildEvent[] = [];
  const waiters = new Set<() => void>();
  let exited = false;
  child.on('message', message => { events.push(message as CrashChildEvent); for (const wake of [...waiters]) wake(); });
  child.on('exit', () => { exited = true; for (const wake of [...waiters]) wake(); });
  child.on('error', () => { events.push({ type: 'fatal', code: 'CHILD_SPAWN_FAILED' }); for (const wake of [...waiters]) wake(); });
  async function wait<T extends CrashChildEvent['type']>(type: T): Promise<EventOf<T>> {
    return await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => finish(new Error(`Child checkpoint timed out: ${type}`)), 15_000);
      const finish = (error?: Error, event?: EventOf<T>) => { clearTimeout(timeout); waiters.delete(check); if (error) reject(error); else resolve(event!); };
      const check = () => {
        const event = events.find(item => item.type === type) as EventOf<T> | undefined;
        const fatal = events.find(item => item.type === 'fatal');
        if (event) finish(undefined, event);
        else if (fatal || exited) finish(new Error(`Child exited before ${type}`));
      };
      waiters.add(check); check();
    });
  }
  child.send(config);
  return { child, wait };
}
async function kill(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) return { code: child.exitCode, signal: child.signalCode };
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Child did not terminate after SIGKILL')), 5000);
    child.once('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
    child.kill('SIGKILL');
  });
}

it('recovers a frozen proposal after a real SIGKILL between committed Core draft and final result, without planning or executing again', async () => {
  const schema = `g8kill_${randomUUID().replaceAll('-', '').slice(0, 24)}`;
  const owner = { userId: `physical-kill-${randomUUID()}` };
  const admin = new Pool({ connectionString, max: 2 });
  const pool = new Pool({ connectionString, options: `-c search_path=${schema}`, max: 8 });
  const children = new Set<ChildProcess>();
  let createdSchema = false;
  const launch = (mode: CrashChildConfig['mode']) => {
    const process = startChild({ connectionString, schema, userId: owner.userId, mode }); children.add(process.child); return process;
  };
  const readCommand = async () => (await pool.query('SELECT * FROM bp_plan_commands WHERE user_id=$1', [owner.userId])).rows[0];
  const count = async (table: string, where = '') => Number((await pool.query(`SELECT count(*) FROM "${schema}".${table} ${where}`)).rows[0].count);
  const request = async (port: number, path: string, body?: unknown) => await fetch(`http://127.0.0.1:${port}${path}`, {
    method: body === undefined ? 'GET' : 'POST', headers: { origin: 'http://localhost:5178', cookie: `process_test_owner=${owner.userId}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10_000),
  });
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`); createdSchema = true;
    await migrateApi(pool);
    const core = createCore(pool, { schema }); await core.migrate(); await core.seedDemo(owner);
    await pool.query('CREATE TABLE process_test_events(id bigserial PRIMARY KEY,stage text NOT NULL,pid integer NOT NULL,payload jsonb NOT NULL)');
    const baselineAccounts = (await pool.query('SELECT id,balance_minor::text FROM accounts ORDER BY id')).rows;
    const baselineProvider = (await pool.query('SELECT id,balance_minor::text FROM provider_accounts ORDER BY id')).rows;

    const first = launch('pause-after-draft'); const ready = await first.wait('ready');
    expect(ready.pid).toBe(first.child.pid);
    const created = await request(ready.port, '/api/conversations', { title: '真实进程终止恢复' }); expect(created.status).toBe(201);
    const conversation = await created.json() as Conversation;
    const input = { clientMessageId: `physical-client-${randomUUID()}`, text: '给林晓转300元，备注process-kill-frozen-proposal' };
    const response = await request(ready.port, `/api/conversations/${conversation.id}/messages`, input); expect(response.status).toBe(202);
    const accepted = await response.json() as AcceptedConversationMessage;
    const committed = await first.wait('draft-committed');
    const frozen = await readCommand();
    expect(frozen.status).toBe('running'); expect(frozen.result).toBeNull();
    expect(frozen.proposal).toMatchObject({ taskId: frozen.prepared_input.taskId, suggestions: [{ payeeId: 'payee-lin', amountMinor: '30000', memo: 'process-kill-frozen-proposal' }] });
    expect(frozen.prepared_input.message).toBe(input.text);
    expect(await count('actions')).toBe(1); expect(await count('bp_chat_messages', "WHERE kind='result'")).toBe(0);
    const draftBefore = (await pool.query('SELECT id,command_id,task_id,status,action_hash,amount_minor::text,memo FROM actions')).rows[0];
    expect(draftBefore).toMatchObject({ id: committed.actionId, command_id: committed.coreCommandId, task_id: frozen.proposal.taskId, status: 'AWAITING_CONFIRMATION', amount_minor: '30000', memo: 'process-kill-frozen-proposal' });
    const beforeHistory = await (await request(ready.port, `/api/conversations/${conversation.id}/messages`)).json() as ConversationHistory;
    expect(beforeHistory.messages).toEqual([accepted.message]);

    // Physical OS kill, not a thrown exception/recreated in-process app. No runner finally can execute.
    expect(await kill(first.child)).toEqual({ code: null, signal: 'SIGKILL' });
    expect((await readCommand()).status).toBe('running'); expect((await readCommand()).result).toBeNull();
    expect(await count('bp_chat_messages', "WHERE kind='failure'")).toBe(0);
    const service = createConversationService(pool);
    expect((await service.getCommand(owner, conversation.id, accepted.command.commandId)).retryable).toBe(false);
    // Test acceleration ONLY: age this isolated journal row beyond the production four-minute lease.
    await pool.query("UPDATE bp_plan_commands SET updated_at=now()-interval '5 minutes' WHERE user_id=$1 AND command_id=$2", [owner.userId, accepted.command.commandId]);
    const expired = await service.getCommand(owner, conversation.id, accepted.command.commandId);
    expect(expired.retryable).toBe(true); expect(Date.parse(expired.leaseExpiresAt!)).toBeLessThan(Date.now());

    const second = launch('recover-frozen'); const restarted = await second.wait('ready'); expect(restarted.pid).not.toBe(ready.pid);
    // Read-only restoration does not restart planning or create the result by itself.
    const restored = await (await request(restarted.port, `/api/conversations/${conversation.id}/messages`)).json() as ConversationHistory;
    expect(restored.messages).toEqual(beforeHistory.messages); expect(restored.commands[0]?.status).toBe('running');
    expect(await count('process_test_events', "WHERE stage='planner-call'")).toBe(1);
    const retried = await request(restarted.port, `/api/conversations/${conversation.id}/commands/${accepted.command.commandId}/retry`, {}); expect(retried.status).toBe(202);
    let completed: ConversationCommand | undefined;
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const currentResponse = await request(restarted.port, `/api/conversations/${conversation.id}/commands/${accepted.command.commandId}`); expect(currentResponse.status).toBe(200);
      const current = await currentResponse.json() as ConversationCommand;
      if (current.status === 'complete' || current.status === 'failed') { completed = current; break; }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    expect(completed?.status).toBe('complete');
    expect(completed).toMatchObject({ commandId: accepted.command.commandId, rootCommandId: accepted.command.rootCommandId, revision: accepted.command.revision, originalMessage: input.text, planningInput: accepted.command.planningInput });
    expect(completed?.result?.actions).toEqual([expect.objectContaining({ id: draftBefore.id, actionHash: draftBefore.action_hash, amountMinor: '30000', memo: draftBefore.memo, status: 'AWAITING_CONFIRMATION' })]);
    expect((await readCommand()).proposal).toEqual(frozen.proposal);
    expect((await readCommand()).lease_token).not.toBe(frozen.lease_token);
    const finalHistory = await (await request(restarted.port, `/api/conversations/${conversation.id}/messages`)).json() as ConversationHistory;
    expect(finalHistory.messages.filter(message => message.role === 'user')).toEqual([accepted.message]);
    expect(finalHistory.messages.filter(message => message.kind === 'result')).toHaveLength(1);
    expect(finalHistory.messages.map(message => message.sequence)).toEqual([1, 2]);
    expect(finalHistory.messages[1]).toMatchObject({ commandId: accepted.command.commandId, rootCommandId: accepted.command.rootCommandId, revision: accepted.command.revision });
    expect(finalHistory.commands).toHaveLength(1);
    // A completed retry/replayed original client key remains the same result and never re-enters planning.
    expect((await request(restarted.port, `/api/conversations/${conversation.id}/commands/${accepted.command.commandId}/retry`, {})).status).toBe(200);
    const replayed = await (await request(restarted.port, `/api/conversations/${conversation.id}/messages`, input)).json() as AcceptedConversationMessage;
    expect(replayed.replayed).toBe(true); expect(replayed.message).toEqual(accepted.message); expect(replayed.command.commandId).toBe(accepted.command.commandId);
    expect(await count('process_test_events', "WHERE stage='planner-call'")).toBe(1);
    expect(await count('process_test_events', `WHERE stage='planner-call' AND pid=${restarted.pid}`)).toBe(0);
    const attempts = (await pool.query("SELECT payload FROM process_test_events WHERE stage='core-create-attempt' ORDER BY id")).rows;
    expect(attempts).toHaveLength(2); expect(attempts[0].payload.coreCommandId).toBe(draftBefore.command_id); expect(attempts[1].payload.coreCommandId).toBe(draftBefore.command_id);
    expect(await count('actions')).toBe(1); expect(await count('bp_chat_messages', "WHERE kind='result'")).toBe(1);
    expect(await count('audit_events', "WHERE type='ACTION_PREPARED'")).toBe(1);
    expect(await count('authorization_proofs')).toBe(0); expect(await count('outbox')).toBe(0);
    expect(await count('provider_transfers')).toBe(0); expect(await count('provider_entries')).toBe(0);
    expect((await pool.query('SELECT id,balance_minor::text FROM accounts ORDER BY id')).rows).toEqual(baselineAccounts);
    expect((await pool.query('SELECT id,balance_minor::text FROM provider_accounts ORDER BY id')).rows).toEqual(baselineProvider);
    expect((await pool.query('SELECT used_minor::text FROM daily_usage')).rows.every(row => row.used_minor === '0')).toBe(true);
  } finally {
    const terminations = await Promise.allSettled([...children].map(kill));
    await pool.end();
    try { if (createdSchema) await admin.query(`DROP SCHEMA "${schema}" CASCADE`); } finally { await admin.end(); }
    for (const termination of terminations) if (termination.status === 'rejected') throw termination.reason;
  }
}, 90_000);
