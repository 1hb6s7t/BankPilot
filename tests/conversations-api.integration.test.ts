import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp, migrateApi } from '../apps/api/src/app.js';
import { createCore, createFinance } from '../packages/core/src/index.js';
import { createInvestment } from '../packages/core/src/investment.js';
import { createGoals } from '../packages/core/src/goals.js';
import { createPlanner } from '../packages/agents/src/index.js';
import { registerCheckpointAttempt, setupCheckpointFencing, type CheckpointJournalIdentity } from '../packages/agents/src/checkpoint-fencing.js';
import type { Planner, PlannerExecutionContext, PlanResult } from '../packages/contracts/src/index.js';
import type { Conversation, ConversationCommand, ConversationHistory } from '../packages/contracts/src/conversations.js';

const connectionString = process.env.TEST_DATABASE_URL ?? 'postgres://bankpilot:bankpilot-local@127.0.0.1:55432/bankpilot';
const origin = 'http://localhost:5178';
const admin = new Pool({ connectionString, max: 2 });
const owners = [
  { id: `g8-owner-a-${randomUUID()}`, cookie: '' },
  { id: `g8-owner-b-${randomUUID()}`, cookie: '' },
];
for (const owner of owners) owner.cookie = `bp_test_owner=${owner.id}`;
let pool: Pool;
let schema = '';
let checkpointSchema = '';
let core: ReturnType<typeof createCore>;
let app: ReturnType<typeof createApp>;
let finance: ReturnType<typeof createFinance>;
let investment: ReturnType<typeof createInvestment>;
let goals: ReturnType<typeof createGoals>;
let plannerCalls = 0;
let plannerBehavior: (message: string, call: number) => Promise<PlanResult>;

function makePlanner(): Planner {
  return { async plan(input) { plannerCalls++; return plannerBehavior(input.message, plannerCalls); } };
}
function rebuild(planner: Planner = makePlanner(), register: (threadId: string, identity: CheckpointJournalIdentity) => Promise<void> = (threadId, identity) => registerCheckpointAttempt(pool, { checkpointSchema, journalSchema: schema }, threadId, identity)) {
  const auth = { api: { async getSession({ headers }: { headers: Headers }) {
    const token = headers.get('cookie')?.match(/(?:^|;\s*)bp_test_owner=([^;]+)/)?.[1];
    const owner = owners.find(item => item.id === token);
    return owner ? { user: { id: owner.id, email: `${owner.id}@example.test` }, session: { id: `session-${owner.id}`, userId: owner.id } } : null;
  } } };
  app = createApp({ pool, auth: auth as never, core, planner, finance, investment, goals, checkpointAttempts: { register }, origin, rpID: 'localhost', sandbox: false, plannerMode: 'scripted' });
}
function countedSemanticPlanner(): Planner {
  const planner = createPlanner({ provider: false });
  return { ...planner, async plan(input) { plannerCalls++; return planner.plan(input); } };
}
async function request(path: string, body?: unknown, owner = owners[0]!) {
  return app.request(`${origin}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Cookie: owner.cookie, Origin: origin, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function createConversation(owner = owners[0]!) {
  const response = await request('/api/conversations', { title: '验收聊天' }, owner);
  expect(response.status).toBe(201);
  return await response.json() as Conversation;
}
function defaultPlan(message: string, call: number): Promise<PlanResult> {
  return Promise.resolve({ taskId: `g8-task-${call}`, planVersion: 1, mode: 'scripted', summary: `已处理：${message}`, events: [], suggestions: [], evidence: [], findings: [] });
}
async function submit(conversationId: string, clientMessageId = `client-${randomUUID()}`, text = '请帮我看一下账户情况', owner = owners[0]!) {
  const response = await request(`/api/conversations/${conversationId}/messages`, { clientMessageId, text }, owner);
  return { response, body: await response.json() };
}
async function answer(conversationId: string, clarificationId: string, expectedClarificationVersion: number, text: string, clientMessageId = `client-${randomUUID()}`) {
  const response = await request(`/api/conversations/${conversationId}/messages`, { clientMessageId, text, clarificationId, expectedClarificationVersion });
  return { response, body: await response.json() };
}
async function history(conversationId: string, owner = owners[0]!, query = '') {
  const response = await request(`/api/conversations/${conversationId}/messages${query}`, undefined, owner);
  expect(response.status).toBe(200);
  return await response.json() as ConversationHistory;
}
async function command(conversationId: string, commandId: string) {
  const response = await request(`/api/conversations/${conversationId}/commands/${commandId}`);
  expect(response.status).toBe(200);
  return await response.json() as ConversationCommand;
}

beforeAll(async () => {
  schema = `g8api_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  checkpointSchema = `${schema}_checkpoints`;
  await admin.query(`CREATE SCHEMA "${schema}"`);
  pool = new Pool({ connectionString, options: `-c search_path=${schema},public`, max: 12 });
  await migrateApi(pool);
  await setupCheckpointFencing(pool, { checkpointSchema, journalSchema: schema });
  core = createCore(pool, { schema });
  await core.migrate();
  for (const owner of owners) await core.seedDemo({ userId: owner.id });
  await pool.query(`INSERT INTO "${schema}".payees(id,name,bank,masked_number,aliases) VALUES
    ('payee-zhang-a','张伟','甲合成银行','****3361','[]'::jsonb),
    ('payee-zhang-b','张伟','乙合成银行','****7788','[]'::jsonb) ON CONFLICT(id) DO NOTHING`);
  finance = createFinance(pool, { schema });
  investment = createInvestment(pool, { schema }); await investment.migrate();
  goals = createGoals(pool, core, investment, finance, { schema }); await goals.migrate();
  for (const owner of owners) { await finance.seedDemo({ userId: owner.id }); await investment.seedDemo({ userId: owner.id }); }
}, 30000);
beforeEach(() => {
  plannerCalls = 0;
  plannerBehavior = defaultPlan;
  rebuild();
});
afterAll(async () => {
  await app?.waitForPlanning();
  await pool?.end();
  if (checkpointSchema) await admin.query(`DROP SCHEMA IF EXISTS "${checkpointSchema}" CASCADE`);
  if (schema) await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await admin.end();
}, 30000);

describe('conversation API integration', () => {
  it('registers a frozen direct-plan attempt before Planner.plan and keeps the NULL root identity', async () => {
    let executionContext: PlannerExecutionContext | undefined;
    const planner: Planner = { async plan(_input, context) {
      executionContext = context;
      const rows = (await pool.query(`SELECT a.thread_id,a.user_id,a.command_id,a.root_command_id,a.revision,a.lease_token,a.graph_version,a.graph_schema_version,a.input_digest,
          c.graph_input_digest,c.lease_token AS current_lease,c.status
        FROM "${checkpointSchema}".bp_checkpoint_attempts a
        JOIN "${schema}".bp_plan_commands c ON c.user_id=a.user_id AND c.command_id=a.command_id
        WHERE a.thread_id=$1`, [context?.checkpointAttempt?.threadId])).rows;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ user_id: owners[0]!.id, root_command_id: null, revision: 0, graph_input_digest: rows[0].input_digest, current_lease: rows[0].lease_token, status: 'running' });
      return defaultPlan('direct', 1);
    } };
    rebuild(planner);
    const commandId = randomUUID();
    const response = await request('/api/plan', { commandId, message: '请检查账户情况' });
    expect(response.status).toBe(200);
    expect(executionContext?.checkpointAttempt).toMatchObject({ threadId: expect.any(String), checkpointNs: '' });
    const saved = (await pool.query(`SELECT graph_checkpoint_thread_id,graph_checkpoint_ns FROM "${schema}".bp_plan_commands WHERE user_id=$1 AND command_id=$2`, [owners[0]!.id, commandId])).rows[0];
    expect(saved).toEqual({ graph_checkpoint_thread_id: null, graph_checkpoint_ns: null });
    expect((await pool.query(`SELECT count(*)::int AS count FROM "${checkpointSchema}".bp_checkpoint_attempts WHERE command_id=$1`, [commandId])).rows[0].count).toBe(1);
    expect((await request('/api/plan', { commandId, message: '请检查账户情况' })).status).toBe(200);
    expect((await pool.query(`SELECT count(*)::int AS count FROM "${checkpointSchema}".bp_checkpoint_attempts WHERE command_id=$1`, [commandId])).rows[0].count).toBe(1);
  }, 30000);

  it('blocks a stale lease taken over after input freeze but before attempt registration', async () => {
    let plannerCalls = 0;
    const planner: Planner = { async plan() { plannerCalls++; return defaultPlan('stale', plannerCalls); } };
    const register = async (threadId: string, identity: CheckpointJournalIdentity) => {
      await pool.query(`UPDATE "${schema}".bp_plan_commands SET lease_token=$3,updated_at=now() WHERE user_id=$1 AND command_id=$2`, [identity.userId, identity.commandId, randomUUID()]);
      await registerCheckpointAttempt(pool, { checkpointSchema, journalSchema: schema }, threadId, identity);
    };
    rebuild(planner, register);
    const commandId = randomUUID();
    const response = await request('/api/plan', { commandId, message: '请检查账户情况' });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: 'PLAN_SUPERSEDED' } });
    expect(plannerCalls).toBe(0);
    expect((await pool.query(`SELECT count(*)::int AS count FROM "${checkpointSchema}".bp_checkpoint_attempts WHERE command_id=$1`, [commandId])).rows[0].count).toBe(0);
  }, 30000);

  it('drains a direct plan request even though it is not a background conversation job', async () => {
    let release!: () => void, started!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const reachedPlanner = new Promise<void>(resolve => { started = resolve; });
    plannerBehavior = async (message, call) => { started(); await gate; return defaultPlan(message, call); };
    rebuild();
    let drained = false;
    try {
      const responsePromise = request('/api/plan', { commandId: randomUUID(), message: '请检查账户情况' });
      await reachedPlanner;
      const drainPromise = app.waitForPlanning().then(() => { drained = true; });
      await Promise.resolve();
      expect(drained).toBe(false);
      release();
      expect((await responsePromise).status).toBe(200);
      await drainPromise;
      expect(drained).toBe(true);
    } finally { release(); await app.waitForPlanning(); }
  }, 30000);

  it('keeps one running command across duplicate accepts and history reads while the planner is held', async () => {
    let release!: () => void, started!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const reachedPlanner = new Promise<void>(resolve => { started = resolve; });
    plannerBehavior = async (message, call) => { started(); await gate; return defaultPlan(message, call); };
    const conversation = await createConversation();
    const key = `client-flight-${randomUUID()}`, text = '保留这条尚在规划中的请求';
    try {
      const first = await submit(conversation.id, key, text);
      expect(first.response.status).toBe(202);
      await reachedPlanner;
      const repeats = await Promise.all([submit(conversation.id, key, text), submit(conversation.id, key, text)]);
      for (const replay of repeats) {
        expect(replay.response.status).toBe(202);
        expect(replay.body.replayed).toBe(true);
        expect(replay.body.command.commandId).toBe(first.body.command.commandId);
        expect(replay.body.message.id).toBe(first.body.message.id);
      }
      const during = await history(conversation.id);
      expect(during.messages).toHaveLength(1);
      expect(during.commands).toHaveLength(1);
      expect(during.commands[0]?.status).toBe('running');
      expect(plannerCalls).toBe(1);
      release(); await app.waitForPlanning();
      const after = await history(conversation.id);
      expect(after.messages.filter(message => message.kind === 'result')).toHaveLength(1);
      expect(after.messages.filter(message => message.kind === 'failure')).toHaveLength(0);
      expect(after.commands[0]?.status).toBe('complete');
      expect(plannerCalls).toBe(1);
    } finally { release(); await app.waitForPlanning(); }
  });

  it('does not take over an expired lease when replaying a message; explicit retry still does', async () => {
    let releaseOld!: () => void, releaseNew!: () => void;
    let signalOldStarted!: () => void, signalNewStarted!: () => void, signalOldFinished!: () => void;
    const oldStarted = new Promise<void>(resolve => { signalOldStarted = resolve; });
    const newStarted = new Promise<void>(resolve => { signalNewStarted = resolve; });
    const oldFinished = new Promise<void>(resolve => { signalOldFinished = resolve; });
    const oldGate = new Promise<void>(resolve => { releaseOld = resolve; });
    const newGate = new Promise<void>(resolve => { releaseNew = resolve; });
    plannerBehavior = async (message, call) => {
      if (call === 1) {
        signalOldStarted();
        await oldGate;
        signalOldFinished();
      } else {
        signalNewStarted();
        await newGate;
      }
      return { ...await defaultPlan(message, call), summary: `attempt-${call}` };
    };
    const conversation = await createConversation();
    const key = `client-expired-replay-${randomUUID()}`;
    try {
      const first = await submit(conversation.id, key, '保持原请求并明确重试');
      expect(first.response.status).toBe(202);
      await oldStarted;
      const commandId = first.body.command.commandId as string;
      const ownerId = owners[0]!.id;
      const before = (await pool.query('SELECT lease_token FROM bp_plan_commands WHERE user_id=$1 AND command_id=$2', [ownerId, commandId])).rows[0];
      await pool.query("UPDATE bp_plan_commands SET updated_at=now()-interval '5 minutes' WHERE user_id=$1 AND command_id=$2", [ownerId, commandId]);
      expect((await command(conversation.id, commandId)).retryable).toBe(true);

      const replay = await submit(conversation.id, key, '保持原请求并明确重试');
      expect(replay.response.status).toBe(202);
      expect(replay.body.replayed).toBe(true);
      expect(replay.body.message).toEqual(first.body.message);
      expect(replay.body.command.commandId).toBe(commandId);
      // Let any wrongly scheduled background claim reach PostgreSQL before
      // asserting that the idempotent replay left the running lease untouched.
      await new Promise(resolve => setTimeout(resolve, 50));
      const afterReplay = (await pool.query('SELECT lease_token FROM bp_plan_commands WHERE user_id=$1 AND command_id=$2', [ownerId, commandId])).rows[0];
      expect(afterReplay.lease_token).toBe(before.lease_token);
      expect(plannerCalls).toBe(1);

      const retry = await request(`/api/conversations/${conversation.id}/commands/${commandId}/retry`, {});
      expect(retry.status).toBe(202);
      await newStarted;
      const afterExplicitRetry = (await pool.query('SELECT lease_token FROM bp_plan_commands WHERE user_id=$1 AND command_id=$2', [ownerId, commandId])).rows[0];
      expect(afterExplicitRetry.lease_token).not.toBe(before.lease_token);

      releaseOld();
      await oldFinished;
      expect((await command(conversation.id, commandId)).status).toBe('running');
      releaseNew();
      await app.waitForPlanning();
      const completed = await command(conversation.id, commandId);
      expect(completed.status).toBe('complete');
      expect(completed.result?.summary).toBe('attempt-2');
      expect(plannerCalls).toBe(2);
    } finally {
      releaseOld();
      releaseNew();
      await app.waitForPlanning();
    }
  });

  it('does not attach a new request to a waiting clarification or inherit its amount and recipient', async () => {
    rebuild(countedSemanticPlanner());
    const conversation = await createConversation();
    const first = await submit(conversation.id, `client-topic-a-${randomUUID()}`, '给张伟转账300元');
    await app.waitForPlanning();
    const parent = await command(conversation.id, first.body.command.commandId);
    expect(parent.clarification?.status).toBe('waiting');
    const second = await submit(conversation.id, `client-topic-b-${randomUUID()}`, '给林晓转账');
    await app.waitForPlanning();
    const next = await command(conversation.id, second.body.command.commandId);
    expect(next.rootCommandId).toBe(next.commandId);
    expect(next.parentCommandId).toBeUndefined();
    expect(next.revision).toBe(0);
    expect(next.planningInput.typed).toBeUndefined();
    expect(next.clarification).toMatchObject({ status: 'waiting', requestedSlots: ['amount'], values: { payeeId: 'payee-lin' } });
    expect(next.clarification?.values.amountMinor).toBeUndefined();
    expect(next.result?.actions).toEqual([]);
    expect((await command(conversation.id, parent.commandId)).clarification).toEqual(parent.clarification);
    expect((await history(conversation.id)).commands).toHaveLength(2);
  });

  it('rolls back a pre-commit message failure and accepts the identical client key exactly once on retry', async () => {
    const conversation = await createConversation();
    const key = `client-rollback-${randomUUID()}`, text = '消息提交失败后保留相同编号';
    await pool.query(`CREATE FUNCTION "${schema}".reject_user_message() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.role='user' THEN RAISE EXCEPTION 'synthetic pre-commit rejection'; END IF; RETURN NEW; END $$`);
    await pool.query(`CREATE TRIGGER reject_user_message BEFORE INSERT ON bp_chat_messages FOR EACH ROW EXECUTE FUNCTION "${schema}".reject_user_message()`);
    try {
      expect((await submit(conversation.id, key, text)).response.status).toBe(500);
      const failed = await history(conversation.id);
      expect(failed.messages).toEqual([]); expect(failed.commands).toEqual([]);
      expect(plannerCalls).toBe(0);
    } finally {
      await pool.query('DROP TRIGGER reject_user_message ON bp_chat_messages');
      await pool.query(`DROP FUNCTION "${schema}".reject_user_message()`);
    }
    const accepted = await submit(conversation.id, key, text);
    expect(accepted.response.status).toBe(202);
    await app.waitForPlanning();
    const replay = await submit(conversation.id, key, text);
    expect(replay.body.message.id).toBe(accepted.body.message.id);
    const saved = await history(conversation.id);
    expect(saved.messages.filter(message => message.role === 'user')).toHaveLength(1);
    expect(saved.commands).toHaveLength(1);
    expect(plannerCalls).toBe(1);
  });

  it('restores stable full history through exclusive cursor pages without planning side effects', async () => {
    const conversation = await createConversation();
    const accepted: { id: string; commandId: string }[] = [];
    for (let index = 0; index < 4; index++) {
      const { response, body } = await submit(conversation.id, `client-page-${index}`, `第${index + 1}条请求`);
      expect(response.status).toBe(202);
      accepted.push({ id: body.message.id, commandId: body.command.commandId });
      await app.waitForPlanning();
    }
    const callsBeforeRead = plannerCalls;
    const pages: ConversationHistory[] = [];
    let cursor: number | undefined;
    do {
      const query = cursor === undefined ? '?limit=3' : `?limit=3&beforeSequence=${cursor}`;
      const page = await history(conversation.id, owners[0]!, query);
      pages.push(page);
      cursor = page.nextBeforeSequence;
    } while (cursor !== undefined);
    const messages = pages.flatMap(page => page.messages).sort((a, b) => a.sequence - b.sequence);
    expect(messages.filter(message => message.role === 'user').map(message => message.id)).toEqual(accepted.map(item => item.id));
    expect(messages.filter(message => message.role === 'assistant')).toHaveLength(4);
    expect(messages.map(message => message.sequence)).toEqual([...new Set(messages.map(message => message.sequence))]);
    // G8K: each history page carries only commands referenced by that page.
    for (const page of pages) expect(page.commands.map(command => command.commandId).sort()).toEqual([...new Set(page.messages.map(message => message.commandId).filter(Boolean))].sort());
    expect(pages[0]!.latestCommandId).toBe(accepted.at(-1)!.commandId);
    expect(plannerCalls).toBe(callsBeforeRead);
    expect((await request('/api/session')).status).toBe(200);
  });

  it('isolates conversation IDs by owner and rejects changed-payload idempotency reuse', async () => {
    const conversation = await createConversation();
    const first = await submit(conversation.id, 'client-same-id-0001', '原始请求');
    expect(first.response.status).toBe(202);
    await app.waitForPlanning();
    const replay = await submit(conversation.id, 'client-same-id-0001', '原始请求');
    expect(replay.response.status).toBe(202);
    expect(replay.body.replayed).toBe(true);
    expect(replay.body.message.id).toBe(first.body.message.id);
    const conflict = await submit(conversation.id, 'client-same-id-0001', '替换后的请求');
    expect(conflict.response.status).toBe(409);
    expect(plannerCalls).toBe(1);
    expect((await request(`/api/conversations/${conversation.id}/messages`, undefined, owners[1]!)).status).toBe(404);
    expect((await request(`/api/conversations/${conversation.id}/commands/${first.body.command.commandId}`, undefined, owners[1]!)).status).toBe(404);
    const foreignPost = await submit(conversation.id, 'client-foreign-owner-0001', '不应被接收', owners[1]!);
    expect(foreignPost.response.status).toBe(404);
    const saved = await history(conversation.id);
    expect(saved.messages.filter(message => message.role === 'user')).toHaveLength(1);
    expect(plannerCalls).toBe(1);
  });

  it('retries a failed original command and completed replay does not call the planner again', async () => {
    plannerBehavior = async (message, call) => {
      if (call === 1) throw new Error('synthetic planner outage');
      return defaultPlan(message, call);
    };
    const conversation = await createConversation();
    const { response, body } = await submit(conversation.id, 'client-retry-original-0001', '保留原文并重试');
    expect(response.status).toBe(202);
    await app.waitForPlanning();
    const failed = await command(conversation.id, body.command.commandId);
    expect(failed.status).toBe('failed');
    expect(failed.retryable).toBe(true);
    const retried = await request(`/api/conversations/${conversation.id}/commands/${failed.commandId}/retry`, {});
    expect(retried.status).toBe(202);
    await app.waitForPlanning();
    expect((await command(conversation.id, failed.commandId)).status).toBe('complete');
    expect(plannerCalls).toBe(2);
    const replayComplete = await request(`/api/conversations/${conversation.id}/commands/${failed.commandId}/retry`, {});
    expect(replayComplete.status).toBe(200);
    expect(plannerCalls).toBe(2);
    const restored = await history(conversation.id);
    expect(restored.messages.filter(message => message.role === 'user')).toHaveLength(1);
    expect(restored.messages.filter(message => message.kind === 'failure')).toHaveLength(1);
    expect(restored.messages.filter(message => message.kind === 'result')).toHaveLength(1);
  });

  it('keeps proposal, draft action, and result/message atomic when result message insertion fails', async () => {
    plannerBehavior = async (_message, call) => ({ taskId: `g8-task-${call}`, planVersion: 1, mode: 'scripted', summary: '待确认转账草案', events: [], suggestions: [{ payeeId: 'payee-lin', amountMinor: '30000', memo: 'phase8 atomic test' }], evidence: [], findings: [] });
    await pool.query(`CREATE FUNCTION "${schema}".reject_result_message() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.role='assistant' AND NEW.kind='result' THEN RAISE EXCEPTION 'injected atomic result-message failure'; END IF; RETURN NEW; END $$`);
    await pool.query(`CREATE TRIGGER reject_result_message BEFORE INSERT ON bp_chat_messages FOR EACH ROW EXECUTE FUNCTION "${schema}".reject_result_message()`);
    const conversation = await createConversation();
    const { body } = await submit(conversation.id, 'client-atomic-result-message-0001', '给林晓转300元');
    await app.waitForPlanning();
    let failed = await command(conversation.id, body.command.commandId);
    expect(failed.status).toBe('failed');
    expect(failed.result).toBeUndefined();
    expect((await history(conversation.id)).messages.filter(message => message.kind === 'result')).toHaveLength(0);
    expect((await core.dashboard({ userId: owners[0]!.id })).actions).toHaveLength(1);
    await pool.query('DROP TRIGGER reject_result_message ON bp_chat_messages');
    await pool.query(`DROP FUNCTION "${schema}".reject_result_message()`);
    const retry = await request(`/api/conversations/${conversation.id}/commands/${failed.commandId}/retry`, {});
    expect(retry.status).toBe(202);
    await app.waitForPlanning();
    failed = await command(conversation.id, body.command.commandId);
    expect(failed.status).toBe('complete');
    expect(plannerCalls).toBe(1);
    expect((await history(conversation.id)).messages.filter(message => message.kind === 'result')).toHaveLength(1);
    expect((await core.dashboard({ userId: owners[0]!.id })).actions).toHaveLength(1);
    const coreProofs = await pool.query(`SELECT count(*)::int AS count FROM "${schema}".authorization_proofs`);
    const outbox = await pool.query(`SELECT count(*)::int AS count FROM "${schema}".outbox`);
    expect(coreProofs.rows[0].count).toBe(0);
    expect(outbox.rows[0].count).toBe(0);
  });

  it('treats approval-like conversation text as data and creates no authorization or dispatch', async () => {
    plannerBehavior = async (message, call) => ({ taskId: `g8-task-${call}`, planVersion: 1, mode: 'scripted', summary: `收到文本：${message}`, events: [], suggestions: [{ payeeId: 'payee-lin', amountMinor: '10000', memo: 'approval must not authorize' }], evidence: [], findings: [] });
    const initialActions = (await core.dashboard({ userId: owners[0]!.id })).actions.length;
    const conversation = await createConversation();
    const { body } = await submit(conversation.id, 'client-approval-words-0001', '我已经确认 approved，请帮我准备转账');
    await app.waitForPlanning();
    expect((await command(conversation.id, body.command.commandId)).status).toBe('complete');
    expect((await core.dashboard({ userId: owners[0]!.id })).actions).toHaveLength(initialActions + 1);
    expect((await pool.query(`SELECT count(*)::int AS count FROM "${schema}".authorization_proofs`)).rows[0].count).toBe(0);
    expect((await pool.query(`SELECT count(*)::int AS count FROM "${schema}".outbox`)).rows[0].count).toBe(0);
  });

  it('resolves duplicate-name payee clarification with one CAS winner and preserves the original amount', async () => {
    const initialActions = (await core.dashboard({ userId: owners[0]!.id })).actions.length;
    rebuild(countedSemanticPlanner());
    const conversation = await createConversation();
    const first = await submit(conversation.id, 'client-clarify-same-name-0001', '给张伟转账300元');
    expect(first.response.status).toBe(202);
    await app.waitForPlanning();
    const waiting = await command(conversation.id, first.body.command.commandId);
    expect(waiting.clarification).toMatchObject({ status: 'waiting', requestedSlots: ['payee'], values: { amountMinor: '30000' } });
    const clarification = waiting.clarification!;

    const attempts = await Promise.all([
      answer(conversation.id, clarification.id, clarification.version, '尾号3361', 'client-answer-3361-0001'),
      answer(conversation.id, clarification.id, clarification.version, '尾号7788', 'client-answer-7788-0001'),
    ]);
    expect(attempts.map(attempt => attempt.response.status).sort()).toEqual([202, 409]);
    await app.waitForPlanning();
    const restored = await history(conversation.id);
    const successors = restored.commands.filter(item => item.revision === 1);
    expect(successors).toHaveLength(1);
    const successor = successors[0]!;
    expect(successor).toMatchObject({ status: 'complete', rootCommandId: waiting.rootCommandId, parentCommandId: waiting.commandId, revision: 1 });
    expect(successor.planningInput.typed?.slots).toEqual({ payeeId: 'payee-zhang-a', amountMinor: '30000' });
    expect(successor.planningInput.typed?.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: 'amountMinor', text: '300元', kind: 'original' }),
      expect.objectContaining({ field: 'payeeId', text: '尾号3361', kind: 'selection' }),
    ]));
    expect(successor.result?.actions).toHaveLength(1);
    expect(successor.result?.actions?.[0]).toMatchObject({ payeeId: 'payee-zhang-a', amountMinor: '30000', status: 'AWAITING_CONFIRMATION' });
    expect((await core.dashboard({ userId: owners[0]!.id })).actions).toHaveLength(initialActions + 1);
    expect((await pool.query(`SELECT count(*)::int AS count FROM "${schema}".authorization_proofs`)).rows[0].count).toBe(0);
    expect((await pool.query(`SELECT count(*)::int AS count FROM "${schema}".outbox`)).rows[0].count).toBe(0);

    const winnerInput = attempts.find(attempt => attempt.response.status === 202)!;
    const replay = await answer(conversation.id, clarification.id, clarification.version, winnerInput.body.message.text, winnerInput.body.message.clientMessageId);
    expect(replay.response.status).toBe(202);
    expect(replay.body.replayed).toBe(true);
    expect(replay.body.command.commandId).toBe(successor.commandId);
    const stale = await answer(conversation.id, clarification.id, clarification.version, '尾号7788', 'client-stale-clarify-key-0001');
    expect(stale.response.status).toBe(409);
    expect(plannerCalls).toBe(2);
  });

  it('fills a missing amount from a field-scoped answer without changing the saved payee', async () => {
    rebuild(countedSemanticPlanner());
    const conversation = await createConversation();
    const first = await submit(conversation.id, 'client-clarify-amount-0001', '给林晓转账');
    await app.waitForPlanning();
    const waiting = await command(conversation.id, first.body.command.commandId);
    expect(waiting.clarification).toMatchObject({ status: 'waiting', requestedSlots: ['amount'], values: { payeeId: 'payee-lin' } });
    const answered = await answer(conversation.id, waiting.clarification!.id, waiting.clarification!.version, '300元', 'client-answer-amount-0001');
    expect(answered.response.status).toBe(202);
    await app.waitForPlanning();
    const successor = await command(conversation.id, answered.body.command.commandId);
    expect(successor.status).toBe('complete');
    expect(successor.planningInput.typed?.slots).toEqual({ payeeId: 'payee-lin', amountMinor: '30000' });
    expect(successor.result?.actions).toHaveLength(1);
    expect(successor.result?.actions?.[0]).toMatchObject({ payeeId: 'payee-lin', amountMinor: '30000', status: 'AWAITING_CONFIRMATION' });
    expect((await pool.query(`SELECT count(*)::int AS count FROM "${schema}".authorization_proofs`)).rows[0].count).toBe(0);
    expect((await pool.query(`SELECT count(*)::int AS count FROM "${schema}".outbox`)).rows[0].count).toBe(0);
  });

  it('fills a life-goal clarification with next year explicitly and leaves its transfer unauthorised', async () => {
    rebuild(countedSemanticPlanner());
    const conversation = await createConversation();
    const first = await submit(conversation.id, 'client-clarify-goal-date-0001', '给林晓建立生日目标，11月5日前准备300元');
    await app.waitForPlanning();
    const waiting = await command(conversation.id, first.body.command.commandId);
    expect(waiting.clarification).toMatchObject({ status: 'waiting', requestedSlots: ['targetDate'], values: { payeeId: 'payee-lin', amountMinor: '30000' }, constraints: { targetMonth: 11, targetDay: 5 } });
    const answered = await answer(conversation.id, waiting.clarification!.id, waiting.clarification!.version, '2027-11-05', 'client-answer-goal-date-0001');
    expect(answered.response.status).toBe(202);
    await app.waitForPlanning();
    const successor = await command(conversation.id, answered.body.command.commandId);
    expect(successor.status).toBe('complete');
    expect(successor.planningInput.typed?.slots).toEqual({ payeeId: 'payee-lin', amountMinor: '30000', targetDate: '2027-11-05' });
    expect(successor.result?.goalSuggestion).toMatchObject({ payeeId: 'payee-lin', amountMinor: '30000', targetDate: '2027-11-05' });
    expect(successor.result?.actions).toEqual([]);
    const goalsResponse = await request('/api/goals');
    expect(goalsResponse.status).toBe(200);
    const goalList = await goalsResponse.json() as { goals: { payeeId: string; amountMinor: string; targetDate: string }[] };
    expect(goalList.goals).toEqual([expect.objectContaining({ payeeId: 'payee-lin', amountMinor: '30000', targetDate: '2027-11-05' })]);
    expect((await pool.query(`SELECT count(*)::int AS count FROM "${schema}".authorization_proofs`)).rows[0].count).toBe(0);
    expect((await pool.query(`SELECT count(*)::int AS count FROM "${schema}".outbox`)).rows[0].count).toBe(0);
  });

  it('rejects an answer after clarification cancellation without creating a successor', async () => {
    rebuild(countedSemanticPlanner());
    const conversation = await createConversation();
    const first = await submit(conversation.id, 'client-cancel-clarification-0001', '给林晓转账');
    await app.waitForPlanning();
    const waiting = await command(conversation.id, first.body.command.commandId);
    const clarification = waiting.clarification!;
    const cancelled = await request(`/api/conversations/${conversation.id}/clarifications/${clarification.id}/cancel`, { expectedVersion: clarification.version });
    expect(cancelled.status).toBe(200);
    expect((await cancelled.json()).status).toBe('cancelled');
    const lateAnswer = await answer(conversation.id, clarification.id, clarification.version, '300元', 'client-answer-after-cancel-0001');
    expect(lateAnswer.response.status).toBe(409);
    const restored = await history(conversation.id);
    expect(restored.commands).toHaveLength(1);
    expect(restored.clarifications[0]).toMatchObject({ status: 'cancelled', version: clarification.version + 1 });
    expect(restored.messages.filter(message => message.role === 'user')).toHaveLength(1);
    expect(plannerCalls).toBe(1);
  });

  it('fences an expired conversation runner and GET refreshes the current Core action state', async () => {
    const initialActions = (await core.dashboard({ userId: owners[0]!.id })).actions.length;
    let releaseOld!: () => void;
    let signalOldStarted!: () => void;
    let signalNewStarted!: () => void;
    const oldStarted = new Promise<void>(resolve => { signalOldStarted = resolve; });
    const newStarted = new Promise<void>(resolve => { signalNewStarted = resolve; });
    const oldGate = new Promise<void>(resolve => { releaseOld = resolve; });
    plannerBehavior = async (message, call) => {
      if (call === 1) { signalOldStarted(); await oldGate; }
      if (call === 2) signalNewStarted();
      return { taskId: `g8-task-${call}`, planVersion: 1, mode: 'scripted', summary: `lease-result-${call}`, events: [], suggestions: [{ payeeId: 'payee-lin', amountMinor: call === 1 ? '10000' : '20000', memo: `lease-${call}` }], evidence: [], findings: [] };
    };
    rebuild();
    const conversation = await createConversation();
    const accepted = await submit(conversation.id, 'client-lease-fence-0001', '给林晓转账');
    expect(accepted.response.status).toBe(202);
    await oldStarted;
    await pool.query("UPDATE bp_plan_commands SET updated_at=now()-interval '5 minutes' WHERE user_id=$1 AND command_id=$2", [owners[0]!.id, accepted.body.command.commandId]);
    const retry = await request(`/api/conversations/${conversation.id}/commands/${accepted.body.command.commandId}/retry`, {});
    expect(retry.status).toBe(202);
    await newStarted;
    let current = await command(conversation.id, accepted.body.command.commandId);
    for (let count = 0; current.status !== 'complete' && count < 100; count++) {
      await new Promise<void>(resolve => setTimeout(resolve, 5));
      current = await command(conversation.id, accepted.body.command.commandId);
    }
    expect(current.status).toBe('complete');
    expect(current.result?.summary).toBe('lease-result-2');
    releaseOld();
    await app.waitForPlanning();
    current = await command(conversation.id, accepted.body.command.commandId);
    expect(current.status).toBe('complete');
    expect(current.result?.summary).toBe('lease-result-2');
    expect(current.result?.actions).toHaveLength(1);
    expect(current.result?.actions?.[0]).toMatchObject({ amountMinor: '20000', memo: 'lease-2', status: 'AWAITING_CONFIRMATION' });
    const actions = (await core.dashboard({ userId: owners[0]!.id })).actions;
    expect(actions).toHaveLength(initialActions + 1);
    const leaseActions = actions.filter(action => action.memo.startsWith('lease-'));
    expect(leaseActions).toHaveLength(1);
    expect(leaseActions[0]).toMatchObject({ amountMinor: '20000', memo: 'lease-2' });
    expect((await history(conversation.id)).messages.filter(message => message.kind === 'result')).toHaveLength(1);
    expect((await history(conversation.id)).messages.filter(message => message.kind === 'failure')).toHaveLength(0);
    await core.cancel({ userId: owners[0]!.id }, actions[0]!.id);
    const refreshed = await (await request(`/api/conversations/${conversation.id}/commands/${accepted.body.command.commandId}`)).json() as ConversationCommand;
    expect(refreshed.result?.actions?.[0]).toMatchObject({ id: actions[0]!.id, status: 'CANCELLED' });
    expect(plannerCalls).toBe(2);
  });
});
