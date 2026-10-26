import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { createConversationService } from '../apps/api/src/conversations.js';
import { createApp } from '../apps/api/src/app.js';
import { observePoolErrors } from '../packages/core/src/database.js';

const connectionString = process.env.TEST_DATABASE_URL ?? 'postgres://bankpilot:bankpilot-local@127.0.0.1:55432/bankpilot';
const schema = `g8k_pages_${randomUUID().replaceAll('-', '')}`;
const admin = new Pool({ connectionString, max: 2 }), pool = new Pool({ connectionString, options: `-c search_path=${schema}`, max: 6 });
observePoolErrors(admin); observePoolErrors(pool);
const service = createConversationService(pool), owner = { userId: 'pages-owner' }, other = { userId: 'pages-other' };
beforeAll(async () => { await admin.query(`CREATE SCHEMA "${schema}"`); await service.migrate(); });
beforeEach(async () => { await pool.query('TRUNCATE bp_chat_messages,bp_clarifications,bp_plan_commands,bp_conversations CASCADE'); });
afterAll(async () => { await pool.end(); await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await admin.end(); });
async function seed(cid: string, count: number) {
  await pool.query(`INSERT INTO bp_chat_messages(id,user_id,conversation_id,sequence,role,text,kind,command_id,root_command_id,revision)
    SELECT 'm-'||$2||'-'||s,$1,$2,s,'user','独立请求 '||s,'request','c-'||$2||'-'||s,'c-'||$2||'-'||s,0 FROM generate_series(1,$3::int) s`, [owner.userId, cid, count]);
  await pool.query(`INSERT INTO bp_plan_commands(user_id,command_id,message_hash,status,conversation_id,user_message_id,root_command_id,original_message,planning_input)
    SELECT $1,'c-'||$2||'-'||s,'hash','pending',$2,'m-'||$2||'-'||s,'c-'||$2||'-'||s,'独立请求 '||s,'{}'::jsonb FROM generate_series(1,$3::int) s`, [owner.userId, cid, count]);
  await pool.query('UPDATE bp_conversations SET next_sequence=$2 WHERE id=$1', [cid, count]);
}
const command = (cid: string, sequence: number) => `c-${cid}-${sequence}`;

it('bounds history associations and recovery summaries independently across 163 commands', async () => {
  const cid = (await service.create(owner)).id; await seed(cid, 163);
  await pool.query("UPDATE bp_plan_commands SET result=$1,model_attempts=$2", [JSON.stringify({ large: 'result'.repeat(1000) }), JSON.stringify([{ secretToSummary: 'history'.repeat(1000) }])]);
  const messages: number[] = [], recovered: number[] = []; let beforeSequence: number | undefined, cursor: string | undefined;
  do {
    const page = await service.history(owner, cid, { limit: 17, beforeSequence });
    expect(page.commands.map(c => c.commandId)).toEqual(page.messages.map(m => m.commandId)); expect(page.commands.length).toBeLessThanOrEqual(17);
    expect(page.latestCommandId).toBe(command(cid, 163)); messages.push(...page.messages.map(m => m.sequence)); beforeSequence = page.nextBeforeSequence;
  } while (beforeSequence);
  do {
    const page = await service.recovery(owner, cid, { cursor, limit: 20 });
    expect(page.items.length).toBeLessThanOrEqual(20); expect(JSON.stringify(page)).not.toContain('secretToSummary'); expect(JSON.stringify(page)).not.toContain('planningInput'); expect(JSON.stringify(page)).not.toContain('resultresult');
    recovered.push(...page.items.map(item => item.requestSequence)); cursor = page.nextCursor;
  } while (cursor);
  expect(messages.length).toBe(163); expect(new Set(messages).size).toBe(163);
  expect(recovered).toEqual(Array.from({ length: 163 }, (_, i) => 163 - i));
  expect((await service.getCommand(owner, cid, command(cid, 1))).result).toHaveProperty('large');
});

it('history includes an assistant-page command while unrelated older clarification stays in recovery', async () => {
  const cid = (await service.create(owner)).id; await seed(cid, 4);
  const clarificationId = randomUUID();
  await pool.query("UPDATE bp_plan_commands SET status='complete'");
  await pool.query(`INSERT INTO bp_clarifications(id,user_id,conversation_id,parent_command_id,root_command_id,payload) VALUES($1,$2,$3,$4,$4,$5)`, [clarificationId, owner.userId, cid, command(cid, 1), { question: '需要补充', requestedSlots: [], sources: [] }]);
  await pool.query(`INSERT INTO bp_chat_messages(id,user_id,conversation_id,sequence,role,text,kind,command_id,root_command_id,revision) VALUES('assistant',$1,$2,5,'assistant','原请求结果','result',$3,$3,0)`, [owner.userId, cid, command(cid, 2)]);
  const page = await service.history(owner, cid, { limit: 1 });
  expect(page.commands.map(c => c.commandId)).toEqual([command(cid, 2)]); expect(page.clarifications).toEqual([]); expect(page.latestCommandId).toBe(command(cid, 4));
  expect((await service.recovery(owner, cid)).items).toMatchObject([{ commandId: command(cid, 1), clarification: { id: clarificationId } }]);
});

it('lists beyond 100 using exact microsecond timestamps and deterministic ties despite mutable updated_at', async () => {
  await pool.query(`INSERT INTO bp_conversations(id,user_id,title,created_at) SELECT 'chat-'||lpad(s::text,3,'0'),$1,'聊天'||s,
    timestamptz '2026-10-23 00:00:00+00' + (s/3)*interval '1 microsecond' FROM generate_series(1,127) s`, [owner.userId]);
  const expected = (await pool.query('SELECT id FROM bp_conversations ORDER BY created_at DESC,id DESC')).rows.map(r => r.id);
  let cursor: string | undefined; const seen: string[] = [];
  do {
    const page = await service.list(owner, { cursor, limit: 11 }); seen.push(...page.conversations.map(c => c.id)); cursor = page.nextCursor;
    await pool.query('UPDATE bp_conversations SET updated_at=now(),version=version+1 WHERE id=$1', [expected.at(-1)]);
  } while (cursor);
  expect(seen).toEqual(expected); expect(new Set(seen).size).toBe(127);
  expect((await service.get(owner, expected.at(-1)!)).id).toBe(expected.at(-1));
});

it('recovery anchor may finish or resolve without invalidating the next page or repeating commands', async () => {
  const cid = (await service.create(owner)).id; await seed(cid, 7);
  const first = await service.recovery(owner, cid, { limit: 2 }); expect(first.items.map(i => i.requestSequence)).toEqual([7, 6]);
  await pool.query("UPDATE bp_plan_commands SET status='complete' WHERE command_id=$1", [command(cid, 6)]);
  await pool.query("UPDATE bp_plan_commands SET status='failed' WHERE command_id=$1", [command(cid, 3)]);
  const next = await service.recovery(owner, cid, { limit: 10, cursor: first.nextCursor });
  expect(next.items.map(i => i.requestSequence)).toEqual([5, 4, 3, 2, 1]); expect(next.items.find(i => i.requestSequence === 3)?.status).toBe('failed');
  const accepted = await service.accept(owner, cid, { clientMessageId: randomUUID(), text: '新追加请求' });
  const refreshed = await service.recovery(owner, cid, { limit: 2 }); expect(refreshed.items[0].commandId).toBe(accepted.command.commandId);
  expect((await service.recovery(owner, cid, { limit: 10, cursor: first.nextCursor })).items.map(i => i.requestSequence)).toEqual([5, 4, 3, 2, 1]);
});

it('keeps all failure kinds discoverable, bounds preview fields, and removes resolved waiting items on refresh', async () => {
  const cid = (await service.create(owner)).id; await seed(cid, 4);
  await pool.query("UPDATE bp_plan_commands SET status='failed',planning_failure=$1,original_message=$2 WHERE command_id=$3", [{ retryable: false, modelRuns: [{ privateLarge: 'omit' }] }, '原'.repeat(2000), command(cid, 1)]);
  await pool.query("UPDATE bp_plan_commands SET status='running',updated_at=now()-interval '5 minutes' WHERE command_id=$1", [command(cid, 2)]);
  await pool.query("UPDATE bp_plan_commands SET status='complete' WHERE command_id=$1", [command(cid, 3)]);
  const id = randomUUID(); await pool.query(`INSERT INTO bp_clarifications(id,user_id,conversation_id,parent_command_id,root_command_id,payload) VALUES($1,$2,$3,$4,$4,$5)`, [id, owner.userId, cid, command(cid, 3), { question: '问'.repeat(1000) }]);
  const items = (await service.recovery(owner, cid)).items;
  expect(items).toHaveLength(4); expect(items.find(i => i.requestSequence === 1)).toMatchObject({ retryable: false, messagePreview: '原'.repeat(240) });
  expect(items.find(i => i.requestSequence === 2)).toMatchObject({ status: 'running', retryable: true }); expect(items.find(i => i.requestSequence === 3)?.clarification?.question.length).toBe(500);
  await pool.query("UPDATE bp_clarifications SET status='resolved',version=version+1 WHERE id=$1", [id]);
  expect((await service.recovery(owner, cid)).items.map(i => i.requestSequence)).toEqual([4, 2, 1]);
});

it('rejects malformed, cross-owner, cross-chat and missing-anchor cursors without borrowing authority', async () => {
  const cid = (await service.create(owner)).id, otherCid = (await service.create(owner)).id; await seed(cid, 3);
  const recovery = await service.recovery(owner, cid, { limit: 1 }), list = await service.list(owner, { limit: 1 });
  await expect(service.recovery(other, cid, { cursor: recovery.nextCursor })).rejects.toMatchObject({ statusCode: 404 });
  await expect(service.recovery(owner, otherCid, { cursor: recovery.nextCursor })).rejects.toMatchObject({ statusCode: 404 });
  await expect(service.list(other, { cursor: list.nextCursor })).rejects.toMatchObject({ statusCode: 404 });
  await expect(service.list(owner, { cursor: recovery.nextCursor })).rejects.toMatchObject({ statusCode: 404 });
  for (const cursor of ['', 'not-json', 'a='.repeat(10), Buffer.from('{}').toString('base64url')]) await expect(service.recovery(owner, cid, { cursor })).rejects.toMatchObject({ statusCode: 400 });
  const forged = JSON.parse(Buffer.from(recovery.nextCursor!, 'base64url').toString()); forged.anchorId = 'missing';
  await expect(service.recovery(owner, cid, { cursor: Buffer.from(JSON.stringify(forged)).toString('base64url') })).rejects.toMatchObject({ statusCode: 404 });
  await expect(service.get(other, cid)).rejects.toMatchObject({ statusCode: 404 });
});

it('returns honest empty pages and enforces bounds without inferring completion', async () => {
  const cid = (await service.create(owner)).id;
  expect(await service.recovery(owner, cid)).toEqual({ items: [] }); expect(await service.list(other)).toEqual({ conversations: [] });
  await seed(cid, 3); const first = await service.recovery(owner, cid, { limit: 1 });
  await pool.query("UPDATE bp_plan_commands SET status='complete'");
  expect(await service.recovery(owner, cid, { cursor: first.nextCursor })).toEqual({ items: [] });
  for (const limit of [0, -1, 101, 1.5, NaN]) {
    await expect(service.list(owner, { limit })).rejects.toMatchObject({ statusCode: 400 });
    await expect(service.recovery(owner, cid, { limit })).rejects.toMatchObject({ statusCode: 400 });
  }
});

it('GET pagination routes validate parameters and never dispatch planning or actions', async () => {
  const cid = (await service.create(owner)).id; await seed(cid, 3);
  const plan = vi.fn(), authorize = vi.fn();
  const app = createApp({ pool, core: { authorize } as never, planner: { plan } as never, auth: { api: { getSession: async () => ({ user: { id: owner.userId, email: 'pages@example.test' } }) } } as never, origin: 'http://localhost:5178', rpID: 'localhost', sandbox: false, plannerMode: 'scripted' });
  const get = (path: string) => app.request(`http://localhost:5178${path}`);
  expect((await get(`/api/conversations/${cid}`)).status).toBe(200);
  const first = await (await get(`/api/conversations/${cid}/recovery?limit=1`)).json(); expect(first.items).toHaveLength(1);
  expect((await (await get(`/api/conversations/${cid}/recovery?limit=1&cursor=${first.nextCursor}`)).json()).items[0].requestSequence).toBe(2);
  for (const path of ['/api/conversations?limit=0', '/api/conversations?limit=101', '/api/conversations?unexpected=1', `/api/conversations/${cid}/recovery?limit=1.5`, `/api/conversations/${cid}/recovery?cursor=bad`, `/api/conversations/${cid}/messages?limit=101`]) expect((await get(path)).status).toBe(400);
  expect(plan).not.toHaveBeenCalled(); expect(authorize).not.toHaveBeenCalled();
  expect((await pool.query("SELECT count(*)::int n FROM bp_plan_commands WHERE status='pending'")).rows[0].n).toBe(3);
});

it('recovery membership and metadata share one repeatable-read snapshot across concurrent completion', async () => {
  const cid = (await service.create(owner)).id; await seed(cid, 2); let changed = false;
  const hooked = { connect: async () => {
    const client = await pool.connect(), query = client.query, release = client.release;
    client.query = (async (...args: unknown[]) => {
      const result = await (query as any).apply(client, args);
      if (!changed && String(args[0]).startsWith('SELECT * FROM bp_conversations')) {
        changed = true; await pool.query("UPDATE bp_plan_commands SET status='complete'");
      }
      return result;
    }) as typeof client.query;
    client.release = error => { client.query = query; client.release = release; release.call(client, error); };
    return client;
  } } as unknown as Pool;
  const old = await createConversationService(hooked).recovery(owner, cid);
  expect(changed).toBe(true); expect(old.items).toHaveLength(2); expect(old.items.every(item => item.status === 'pending' && item.stateVersion === '1')).toBe(true);
  expect(await service.recovery(owner, cid)).toEqual({ items: [] });
  expect((await service.getCommand(owner, cid, command(cid, 1))).stateVersion).toBe('2');
});

it.each(['pending', 'waiting'] as const)('reports an eligible %s orphan instead of silently omitting its recovery item', async kind => {
  const cid = (await service.create(owner)).id; await seed(cid, 2);
  await pool.query('UPDATE bp_plan_commands SET user_message_id=NULL,status=$2 WHERE command_id=$1', [command(cid, 1), kind === 'waiting' ? 'complete' : 'pending']);
  if (kind === 'waiting') await pool.query(`INSERT INTO bp_clarifications(id,user_id,conversation_id,parent_command_id,root_command_id,payload) VALUES($1,$2,$3,$4,$4,'{}')`, [randomUUID(), owner.userId, cid, command(cid, 1)]);
  await expect(service.recovery(owner, cid)).rejects.toMatchObject({ code: 'RECOVERY_REQUEST_SEQUENCE_UNAVAILABLE', statusCode: 409 });
  expect((await service.getCommand(owner, cid, command(cid, 1))).commandId).toBe(command(cid, 1));
  await expect(service.recovery(other, cid)).rejects.toMatchObject({ statusCode: 404 });
});

const payee = { id: 'p1', name: '林晓', aliases: [], bank: '合成银行', maskedNumber: '****1234' };
async function waiting() {
  const svc = createConversationService(pool, { getPayees: async () => [payee] }), cid = (await svc.create(owner)).id;
  const accepted = await svc.accept(owner, cid, { clientMessageId: randomUUID(), text: '给林晓转账' });
  const token = randomUUID(), tx = await pool.connect();
  try {
    await tx.query('BEGIN'); await tx.query("UPDATE bp_plan_commands SET status='complete',lease_token=$2 WHERE command_id=$1", [accepted.command.commandId, token]);
    await svc.onComplete(tx, owner, accepted.command.commandId, token, { taskId: 'test', planVersion: 1, mode: 'scripted', summary: '请补金额', clarification: '请补金额', events: [], findings: [], evidence: [], suggestions: [], actions: [] }, { taskId: 'test', message: '给林晓转账', accounts: [], payees: [payee], referenceDate: '2026-10-24' });
    await tx.query('COMMIT');
  } catch (error) { await tx.query('ROLLBACK'); throw error; } finally { tx.release(); }
  const before = await svc.getCommand(owner, cid, accepted.command.commandId); expect(before.clarification?.status).toBe('waiting');
  return { svc, cid, before, token, clarification: before.clarification! };
}
it('cancellation advances parent evidence version atomically without renewing its lease or duplicating cancellation', async () => {
  const { svc, cid, before, token, clarification } = await waiting();
  const delayed = await svc.recovery(owner, cid);
  await svc.cancelClarification(owner, cid, clarification.id, clarification.version);
  const after = await svc.getCommand(owner, cid, before.commandId);
  expect(BigInt(after.stateVersion!)).toBe(BigInt(before.stateVersion!) + 1n); expect(after.updatedAt).toBe(before.updatedAt);
  expect(after.clarification).toMatchObject({ status: 'cancelled', version: clarification.version + 1 });
  expect(BigInt(delayed.items[0].stateVersion)).toBeLessThan(BigInt(after.stateVersion!)); expect((await svc.recovery(owner, cid)).items).toEqual([]);
  await svc.cancelClarification(owner, cid, clarification.id, clarification.version);
  expect((await svc.getCommand(owner, cid, before.commandId)).stateVersion).toBe(after.stateVersion);
  expect((await pool.query('SELECT lease_token FROM bp_plan_commands WHERE command_id=$1', [before.commandId])).rows[0].lease_token).toBe(token);
});
it('a clarification answer advances parent evidence while creating only one original-lineage successor', async () => {
  const { svc, cid, before, clarification } = await waiting();
  const input = { clientMessageId: randomUUID(), text: '317.25元', clarificationId: clarification.id, expectedClarificationVersion: clarification.version };
  const next = await svc.accept(owner, cid, input), after = await svc.getCommand(owner, cid, before.commandId);
  expect(BigInt(after.stateVersion!)).toBe(BigInt(before.stateVersion!) + 1n); expect(after.updatedAt).toBe(before.updatedAt);
  expect(after.clarification).toMatchObject({ status: 'resolved', version: clarification.version + 1, resolvedByCommandId: next.command.commandId });
  expect(next.command).toMatchObject({ parentCommandId: before.commandId, rootCommandId: before.rootCommandId, revision: 1, status: 'pending' });
  expect((await svc.accept(owner, cid, input)).replayed).toBe(true); expect((await svc.getCommand(owner, cid, before.commandId)).stateVersion).toBe(after.stateVersion);
  expect((await svc.recovery(owner, cid)).items.map(item => item.commandId)).toEqual([next.command.commandId]);
});
it.each(['cancel', 'answer'] as const)('%s rollback restores parent version and waiting clarification together', async operation => {
  const { cid, before, clarification } = await waiting();
  const hooked = { query: pool.query.bind(pool), connect: async () => {
    const client = await pool.connect(), query = client.query, release = client.release;
    client.query = (async (...args: unknown[]) => { if (String(args[0]).startsWith('INSERT INTO bp_chat_messages')) throw new Error('CONTROLLED_APPEND_FAILURE'); return (query as any).apply(client, args); }) as typeof client.query;
    client.release = error => { client.query = query; client.release = release; release.call(client, error); }; return client;
  } } as unknown as Pool;
  const failing = createConversationService(hooked, { getPayees: async () => [payee] });
  await expect(operation === 'cancel' ? failing.cancelClarification(owner, cid, clarification.id, clarification.version) : failing.accept(owner, cid, { clientMessageId: randomUUID(), text: '317.25元', clarificationId: clarification.id, expectedClarificationVersion: clarification.version })).rejects.toThrow('CONTROLLED_APPEND_FAILURE');
  const after = await service.getCommand(owner, cid, before.commandId); expect(after.stateVersion).toBe(before.stateVersion); expect(after.updatedAt).toBe(before.updatedAt); expect(after.clarification).toEqual(before.clarification);
  expect((await pool.query('SELECT count(*)::int n FROM bp_plan_commands')).rows[0].n).toBe(1);
});
