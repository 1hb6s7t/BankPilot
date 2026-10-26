import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { expect, it } from 'vitest';
import { migrateApi } from '../apps/api/src/app.js';
import { createConversationService } from '../apps/api/src/conversations.js';
import { setupCheckpointFencing } from '../packages/agents/src/checkpoint-fencing.js';
import type { PlannerCrashChildConfig, PlannerCrashChildEvent } from './fixtures/planner-checkpoint-crash-child.js';

const worker = fileURLToPath(new URL('./fixtures/planner-checkpoint-crash-child.ts', import.meta.url));
const connectionString = process.env.TEST_DATABASE_URL ?? 'postgres://bankpilot:bankpilot-local@127.0.0.1:55432/bankpilot';
type EventOf<T extends PlannerCrashChildEvent['type']> = Extract<PlannerCrashChildEvent, { type: T }>;

function startChild(config: PlannerCrashChildConfig) {
  const child = spawn(process.execPath, ['--import', 'tsx', worker], {
    cwd: process.cwd(), stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  child.stderr?.resume();
  const events: PlannerCrashChildEvent[] = [];
  const waiters = new Set<() => void>();
  let exited = false;
  child.on('message', value => { events.push(value as PlannerCrashChildEvent); for (const wake of [...waiters]) wake(); });
  child.on('exit', () => { exited = true; for (const wake of [...waiters]) wake(); });
  child.on('error', () => { events.push({ type: 'fatal', code: 'CHILD_SPAWN_FAILED' }); for (const wake of [...waiters]) wake(); });
  async function wait<T extends PlannerCrashChildEvent['type']>(type: T): Promise<EventOf<T>> {
    return await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => finish(new Error(`Planner child timed out: ${type}`)), 20_000);
      const finish = (error?: Error, event?: EventOf<T>) => { clearTimeout(timeout); waiters.delete(check); if (error) reject(error); else resolve(event!); };
      const check = () => {
        const event = events.find(item => item.type === type) as EventOf<T> | undefined;
        const fatal = events.find(item => item.type === 'fatal');
        if (event) finish(undefined, event);
        else if (fatal || exited) finish(new Error(`Planner child exited before ${type}`));
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
    const timer = setTimeout(() => reject(new Error('Planner child did not terminate after SIGKILL')), 5000);
    child.once('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
    child.kill('SIGKILL');
  });
}

async function waitForExit(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) return { code: child.exitCode, signal: child.signalCode };
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Completed Planner child did not exit')), 10_000);
    child.once('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
  });
}

async function waitForBackendToClose(admin: Pool, appName: string) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const active = Number((await admin.query('SELECT count(*) FROM pg_stat_activity WHERE application_name=$1', [appName])).rows[0].count);
    if (active === 0) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('SIGKILLed Planner child still owns a PostgreSQL backend');
}

it('resumes the production Planner across SIGKILL during reviewer, without rerunning its completed transfer node', async () => {
  const schema = `planner_kill_${randomUUID().replaceAll('-', '')}`;
  const checkpointSchema = `${schema}_checkpoints`;
  const userId = `planner-kill-${randomUUID()}`;
  const commandId = `planner-kill-command-${randomUUID()}`;
  const admin = new Pool({ connectionString, max: 2 });
  const pool = new Pool({ connectionString, options: `-c search_path=${schema},public`, max: 8 });
  const children = new Set<ChildProcess>();
  const appName = `bpplanner_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
  let schemaCreated = false;
  const launch = (mode: PlannerCrashChildConfig['mode'], name = `${appName}_${mode === 'interrupt-reviewer' ? 'one' : 'two'}`, transport?: PlannerCrashChildConfig['transport']) => {
    const process = startChild({ connectionString, schema, checkpointSchema, userId, commandId, appName: name, mode, transport });
    children.add(process.child);
    return { ...process, appName: name };
  };
  const command = async () => (await pool.query('SELECT * FROM bp_plan_commands WHERE user_id=$1 AND command_id=$2', [userId, commandId])).rows[0];
  const count = async (table: string) => Number((await pool.query(`SELECT count(*) FROM ${table}`)).rows[0].count);
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    schemaCreated = true;
    await createConversationService(pool).migrate();
    await pool.query(`CREATE TABLE planner_process_events(id bigserial PRIMARY KEY,stage text NOT NULL,pid integer NOT NULL,payload jsonb NOT NULL);
      CREATE TABLE planner_process_proposals(id bigserial PRIMARY KEY,command_id text NOT NULL,account_id text NOT NULL,payee_id text NOT NULL,amount_minor text NOT NULL,memo text NOT NULL)`);
    await setupCheckpointFencing(pool, { checkpointSchema, journalSchema: schema });

    const first = launch('interrupt-reviewer');
    const interruptedEvent = await first.wait('reviewer-started');
    expect(interruptedEvent.pid).toBe(first.child.pid);
    const interrupted = await command();
    expect(interrupted.status).toBe('running');
    expect(interrupted.proposal).toBeNull();
    expect(interrupted.graph_checkpoint_thread_id).toBeTruthy();
    expect(interrupted.graph_checkpoint_ns).toBe('');
    expect(interrupted.graph_checkpoint_id).toBeTruthy();
    expect(await count('planner_process_events WHERE stage=\'transfer-domain-completed\'')).toBe(1);
    expect(await count('planner_process_proposals')).toBe(0);

    // The real OS process is killed while its reviewer node is in flight; no catch/finally in the runner can persist failure.
    expect(await kill(first.child)).toEqual({ code: null, signal: 'SIGKILL' });
    await waitForBackendToClose(admin, first.appName);
    expect((await command()).status).toBe('running');
    await pool.query("UPDATE bp_plan_commands SET updated_at=now()-interval '5 minutes' WHERE user_id=$1 AND command_id=$2", [userId, commandId]);

    const second = launch('resume-reviewer', `${appName}_recovery`);
    const completedEvent = await second.wait('completed');
    expect(completedEvent.pid).toBe(second.child.pid);
    expect(completedEvent).toMatchObject({ suggestions: 1, actions: 1 });
    const completedProcess = await waitForExit(second.child);
    expect(completedProcess).toEqual({ code: 0, signal: null });
    await waitForBackendToClose(admin, second.appName);

    const completed = await command();
    expect(completed.status).toBe('complete');
    expect(completed.proposal.suggestions).toEqual([{ payeeId: 'payee-1', amountMinor: '10000', memo: 'BankPilot 合成银行沙箱转账' }]);
    expect(completed.result.actions).toHaveLength(1);
    expect(completed.result.actions[0]).toMatchObject({ payeeId: 'payee-1', amountMinor: '10000', status: 'AWAITING_CONFIRMATION' });
    expect(await count('planner_process_events WHERE stage=\'transfer-domain-completed\'')).toBe(1);
    expect(await count('planner_process_events WHERE stage=\'reviewer-started\'')).toBe(2);
    expect(await count('planner_process_proposals')).toBe(1);
    expect(completed.graph_checkpoint_thread_id).not.toBe(interrupted.graph_checkpoint_thread_id);
    const copiedHead = (await pool.query(`SELECT EXISTS (SELECT 1 FROM "${checkpointSchema}".checkpoints
      WHERE thread_id=$1 AND checkpoint_ns='' AND checkpoint_id=$2) AS present`,
    [completed.graph_checkpoint_thread_id, interrupted.graph_checkpoint_id])).rows[0].present;
    expect(copiedHead).toBe(true);
  } finally {
    const terminations = await Promise.allSettled([...children].map(kill));
    await pool.end();
    try { if (schemaCreated) await admin.query(`DROP SCHEMA "${checkpointSchema}" CASCADE; DROP SCHEMA "${schema}" CASCADE`); }
    finally { await admin.end(); }
    for (const termination of terminations) if (termination.status === 'rejected') throw termination.reason;
  }
}, 90_000);

it('resumes a real parallel-domain superstep after SIGKILL, preserving completed pending writes and rerunning only the interrupted branch', async () => {
  const schema = `planner_kill_${randomUUID().replaceAll('-', '')}`;
  const checkpointSchema = `${schema}_checkpoints`;
  const userId = `planner-superstep-kill-${randomUUID()}`;
  const commandId = `planner-superstep-command-${randomUUID()}`;
  const admin = new Pool({ connectionString, max: 2 });
  const pool = new Pool({ connectionString, options: `-c search_path=${schema},public`, max: 8 });
  const children = new Set<ChildProcess>();
  const appName = `bpsuperstep_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
  let schemaCreated = false;
  const launch = (mode: PlannerCrashChildConfig['mode'], name: string, transport?: PlannerCrashChildConfig['transport']) => {
    const process = startChild({ connectionString, schema, checkpointSchema, userId, commandId, appName: name, mode, transport });
    children.add(process.child);
    return { ...process, appName: name };
  };
  const eventCount = async (stage: string, role?: string, mode?: string) => Number((await pool.query(`SELECT count(*) FROM planner_process_events
    WHERE stage=$1 AND ($2::text IS NULL OR payload->>'role'=$2) AND ($3::text IS NULL OR payload->>'mode'=$3)`,
  [stage, role ?? null, mode ?? null])).rows[0].count);
  const waitForTransferProposalPendingWrite = async (threadId: string, checkpointId: string) => {
    const saver = new PostgresSaver(pool, undefined, { schema: checkpointSchema });
    const config = { configurable: { thread_id: threadId, checkpoint_ns: '', checkpoint_id: checkpointId } };
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const tuple = await saver.getTuple(config);
      const transferWrite = tuple?.pendingWrites?.find(([, channel, value]) => {
        if (channel !== 'proposals') return false;
        const proposals = Array.isArray(value) ? value : [value];
        return proposals.some(proposal => !!proposal && typeof proposal === 'object'
          && 'role' in proposal && proposal.role === 'transfer'
          && 'suggestion' in proposal && !!proposal.suggestion && typeof proposal.suggestion === 'object'
          && 'payeeId' in proposal.suggestion && proposal.suggestion.payeeId === 'payee-1'
          && 'amountMinor' in proposal.suggestion && proposal.suggestion.amountMinor === '10000');
      });
      if (transferWrite) return transferWrite;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error('The interrupted checkpoint did not contain the completed transfer proposal pending write');
  };
  const request = async (port: number, path: string, body?: unknown) => await fetch(`http://127.0.0.1:${port}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { origin: 'http://localhost:5178', cookie: `planner_process_owner=${userId}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10_000),
  });
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    schemaCreated = true;
    await migrateApi(pool);
    await pool.query(`CREATE TABLE planner_process_events(id bigserial PRIMARY KEY,stage text NOT NULL,pid integer NOT NULL,payload jsonb NOT NULL);
      CREATE TABLE planner_process_proposals(id bigserial PRIMARY KEY,command_id text NOT NULL,account_id text NOT NULL,payee_id text NOT NULL,amount_minor text NOT NULL,memo text NOT NULL)`);
    await setupCheckpointFencing(pool, { checkpointSchema, journalSchema: schema });

    const firstName = `${appName}_one`;
    const first = launch('interrupt-domain', firstName, 'http');
    const firstReady = await first.wait('ready');
    expect(firstReady.pid).toBe(first.child.pid);
    const created = await request(firstReady.port, '/api/conversations', { title: '并行领域恢复验收' });
    expect(created.status).toBe(201);
    const conversation = await created.json() as { id: string };
    const message = { clientMessageId: `parallel-client-${randomUUID()}`, text: '给林晓转100元并查询2026年9月账单' };
    const acceptedResponse = await request(firstReady.port, `/api/conversations/${conversation.id}/messages`, message);
    expect(acceptedResponse.status).toBe(202);
    const accepted = await acceptedResponse.json() as { command: { commandId: string } };
    const activeCommandId = accepted.command.commandId;
    const blocked = await first.wait('domain-blocked');
    expect(blocked).toMatchObject({ pid: first.child.pid, role: 'bills', mode: 'interrupt-domain' });
    const interrupted = (await pool.query('SELECT * FROM bp_plan_commands WHERE user_id=$1 AND command_id=$2', [userId, activeCommandId])).rows[0];
    expect(interrupted.status).toBe('running');
    expect(interrupted.proposal).toBeNull();
    expect(interrupted.graph_checkpoint_thread_id).toBeTruthy();
    expect(interrupted.graph_checkpoint_ns).toBe('');
    expect(interrupted.graph_checkpoint_id).toBeTruthy();
    // The transfer node returned while its bills sibling is still parked in its adapter.
    // Wait for the actual LangGraph pending write, not just the adapter's IPC/log event.
    const transferPendingWrite = await waitForTransferProposalPendingWrite(interrupted.graph_checkpoint_thread_id, interrupted.graph_checkpoint_id);
    expect(transferPendingWrite).toBeTruthy();
    expect(await eventCount('domain-returned', 'transfer', 'interrupt-domain')).toBe(1);
    expect(await eventCount('domain-started', 'bills', 'interrupt-domain')).toBe(1);
    expect(await eventCount('domain-returned', 'bills', 'interrupt-domain')).toBe(0);
    expect(await eventCount('reviewer-started')).toBe(0);
    expect(Number((await pool.query('SELECT count(*) FROM planner_process_proposals')).rows[0].count)).toBe(0);

    expect(await kill(first.child)).toEqual({ code: null, signal: 'SIGKILL' });
    await waitForBackendToClose(admin, firstName);
    expect((await pool.query('SELECT status FROM bp_plan_commands WHERE user_id=$1 AND command_id=$2', [userId, activeCommandId])).rows[0].status).toBe('running');
    await pool.query("UPDATE bp_plan_commands SET updated_at=now()-interval '5 minutes' WHERE user_id=$1 AND command_id=$2", [userId, activeCommandId]);

    const secondName = `${appName}_recovery`;
    const second = launch('resume-domain', secondName, 'http');
    const secondReady = await second.wait('ready');
    expect(secondReady.pid).toBe(second.child.pid);
    expect(await eventCount('domain-started', 'bills')).toBe(1);
    const staleCommandResponse = await request(secondReady.port, `/api/conversations/${conversation.id}/commands/${activeCommandId}`);
    expect(staleCommandResponse.status).toBe(200);
    expect(await staleCommandResponse.json()).toMatchObject({ status: 'running', retryable: true });
    const retry = await request(secondReady.port, `/api/conversations/${conversation.id}/commands/${activeCommandId}/retry`, {});
    expect(retry.status).toBe(202);
    const completedEvent = await second.wait('completed');
    expect(completedEvent.pid).toBe(second.child.pid);
    expect(completedEvent).toMatchObject({ suggestions: 1, actions: 1 });
    const exit = waitForExit(second.child);
    second.child.send({ type: 'shutdown' });
    expect(await exit).toEqual({ code: 0, signal: null });
    await waitForBackendToClose(admin, secondName);

    const completed = (await pool.query('SELECT * FROM bp_plan_commands WHERE user_id=$1 AND command_id=$2', [userId, activeCommandId])).rows[0];
    expect(completed.status).toBe('complete');
    expect(completed.proposal.suggestions).toHaveLength(1);
    expect(Number((await pool.query('SELECT count(*) FROM bp_plan_commands WHERE user_id=$1 AND proposal IS NOT NULL', [userId])).rows[0].count)).toBe(1);
    expect(completed.result.actions).toHaveLength(1);
    expect(completed.result.actions[0]).toMatchObject({ payeeId: 'payee-1', amountMinor: '10000', status: 'AWAITING_CONFIRMATION' });
    expect(await eventCount('domain-started', 'transfer')).toBe(1);
    expect(await eventCount('transfer-domain-completed')).toBe(1);
    expect(await eventCount('domain-started', 'bills')).toBe(2);
    expect(await eventCount('domain-returned', 'bills', 'interrupt-domain')).toBe(0);
    expect(await eventCount('domain-returned', 'bills', 'resume-domain')).toBe(1);
    expect(await eventCount('reviewer-started')).toBe(1);
    expect(Number((await pool.query('SELECT count(*) FROM planner_process_proposals')).rows[0].count)).toBe(1);
    expect(completed.graph_checkpoint_thread_id).not.toBe(interrupted.graph_checkpoint_thread_id);
    const resultMessages = Number((await pool.query(`SELECT count(*) FROM bp_chat_messages WHERE user_id=$1 AND conversation_id=$2 AND kind='result'`, [userId, conversation.id])).rows[0].count);
    expect(resultMessages).toBe(1);
    const copiedHead = (await pool.query(`SELECT EXISTS (SELECT 1 FROM "${checkpointSchema}".checkpoints
      WHERE thread_id=$1 AND checkpoint_ns='' AND checkpoint_id=$2) AS present`,
    [completed.graph_checkpoint_thread_id, interrupted.graph_checkpoint_id])).rows[0].present;
    expect(copiedHead).toBe(true);
  } finally {
    const terminations = await Promise.allSettled([...children].map(kill));
    await pool.end();
    try { if (schemaCreated) await admin.query(`DROP SCHEMA "${checkpointSchema}" CASCADE; DROP SCHEMA "${schema}" CASCADE`); }
    finally { await admin.end(); }
    for (const termination of terminations) if (termination.status === 'rejected') throw termination.reason;
  }
}, 90_000);
