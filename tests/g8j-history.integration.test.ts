import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { createConversationService } from '../apps/api/src/conversations.js';

const connectionString = process.env.TEST_DATABASE_URL ?? 'postgres://bankpilot:bankpilot-local@127.0.0.1:55432/bankpilot';
const schema = `g8j_history_${randomUUID().replaceAll('-', '')}`;
const admin = new Pool({ connectionString });
const pool = new Pool({ connectionString, options: `-c search_path=${schema}`, max: 4 });
const service = createConversationService(pool);
const owner = { userId: 'g8j-history-owner' }, other = { userId: 'g8j-history-other' };
const accept = (cid: string, text: string) => service.accept(owner, cid, { clientMessageId: randomUUID(), text });

beforeAll(async () => { await admin.query(`CREATE SCHEMA "${schema}"`); await service.migrate(); });
beforeEach(async () => { await pool.query('TRUNCATE bp_chat_messages,bp_clarifications,bp_plan_commands,bp_conversations CASCADE'); });
afterAll(async () => { await pool.end(); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end(); });

it('orders requests by their durable user-message sequence when timestamps tie', async () => {
  const cid = (await service.create(owner)).id;
  const first = await accept(cid, '第一条请求'), second = await accept(cid, '第二条请求');
  await pool.query("UPDATE bp_plan_commands SET created_at='2026-10-23T00:00:00Z',updated_at='2026-10-23T00:00:00Z'");
  const history = await service.history(owner, cid);
  expect(history.commands.map(c => [c.commandId, c.requestSequence])).toEqual([[first.command.commandId, 1], [second.command.commandId, 2]]);
  expect((await service.getCommand(owner, cid, first.command.commandId)).requestSequence).toBe(1);
  const replay = await service.accept(owner, cid, { clientMessageId: first.message.clientMessageId!, text: '第一条请求' });
  expect(replay.replayed).toBe(true); expect(replay.command.requestSequence).toBe(1);
  expect((await service.history(owner, cid)).messages).toHaveLength(2);
});

it('advances an exact state version even when failed and retried updates share a timestamp', async () => {
  const cid = (await service.create(owner)).id, accepted = await accept(cid, '保留原请求');
  expect(accepted.command.stateVersion).toBe('1');
  await pool.query("UPDATE bp_plan_commands SET status='failed',updated_at='2026-10-23T00:00:00Z',state_version=0 WHERE command_id=$1", [accepted.command.commandId]);
  const failed = await service.getCommand(owner, cid, accepted.command.commandId);
  await pool.query("UPDATE bp_plan_commands SET status='running',updated_at='2026-10-23T00:00:00Z',state_version=0 WHERE command_id=$1", [accepted.command.commandId]);
  const retried = await service.getCommand(owner, cid, accepted.command.commandId);
  expect(failed.updatedAt).toBe(retried.updatedAt); expect(failed.stateVersion).toBe('2'); expect(retried.stateVersion).toBe('3');
  expect(retried.status).toBe('running');
  const tx = await pool.connect();
  try { await tx.query('BEGIN'); await tx.query("UPDATE bp_plan_commands SET status='complete' WHERE command_id=$1", [accepted.command.commandId]); await tx.query('ROLLBACK'); }
  finally { tx.release(); }
  expect((await service.getCommand(owner, cid, accepted.command.commandId)).stateVersion).toBe('3');
  await service.migrate();
  expect((await service.getCommand(owner, cid, accepted.command.commandId)).stateVersion).toBe('3');
});

it('keeps bigint state versions exact above JavaScript safe integers', async () => {
  const cid = (await service.create(owner)).id;
  await pool.query(`INSERT INTO bp_plan_commands(user_id,command_id,message_hash,status,conversation_id,root_command_id,state_version,original_message,planning_input)
    VALUES($1,'old-bigint-command','hash','pending',$2,'old-bigint-command',9007199254740992,'旧请求','{}')`, [owner.userId, cid]);
  await pool.query("UPDATE bp_plan_commands SET status='failed' WHERE command_id='old-bigint-command'");
  expect((await service.getCommand(owner, cid, 'old-bigint-command')).stateVersion).toBe('9007199254740993');
});

it('uses a constant number of history queries and retains every pending request across 160 messages', async () => {
  const cid = (await service.create(owner)).id;
  for (let i = 1; i <= 160; i++) await accept(cid, `独立历史请求 ${i}`);
  const queryCounts: number[] = [];
  const hooked = { query: pool.query.bind(pool), connect: async () => {
    const client = await pool.connect(), originalQuery = client.query, originalRelease = client.release; let count = 0;
    client.query = (async (...args: unknown[]) => { count++; return (originalQuery as any).apply(client, args); }) as typeof client.query;
    client.release = error => { queryCounts.push(count); client.query = originalQuery; client.release = originalRelease; originalRelease.call(client, error); };
    return client;
  } } as unknown as Pool;
  const measured = createConversationService(hooked);
  const all = new Set<number>(); let beforeSequence: number | undefined;
  do {
    const page = await measured.history(owner, cid, { beforeSequence, limit: 50 });
    expect(page.commands).toHaveLength(page.messages.length);
    expect(page.commands.every(c => c.status === 'pending' && c.retryable)).toBe(true);
    expect(page.commands.map(c => c.requestSequence)).toEqual(page.messages.map(message => message.sequence));
    expect(page.latestCommandId).toBeDefined();
    for (const message of page.messages) { expect(all.has(message.sequence)).toBe(false); all.add(message.sequence); }
    beforeSequence = page.nextBeforeSequence;
  } while (beforeSequence !== undefined);
  expect([...all].sort((a, b) => a - b)).toEqual(Array.from({ length: 160 }, (_, i) => i + 1));
  // G8K: bounded page associations plus a lightweight latest-command pointer.
  expect(queryCounts).toEqual([7, 7, 7, 7]);
  const recovered = new Set<string>(); let cursor: string | undefined;
  do { const page = await service.recovery(owner, cid, { cursor, limit: 50 }); for (const item of page.items) { expect(recovered.has(item.commandId)).toBe(false); recovered.add(item.commandId); } cursor = page.nextCursor; } while (cursor);
  expect(recovered.size).toBe(160);
  await expect(measured.history(other, cid)).rejects.toMatchObject({ statusCode: 404 });
});

it('does not lose old failed or waiting-clarification commands when only the newest messages are visible', async () => {
  const cid = (await service.create(owner)).id, oldest = await accept(cid, '最早待补充请求');
  const clarificationId = randomUUID();
  await pool.query("UPDATE bp_plan_commands SET status='complete' WHERE command_id=$1", [oldest.command.commandId]);
  const payload = { question: '请补充金额', requestedSlots: ['amount'], operation: 'transfer', values: { payeeId: 'payee-lin' }, sources: [], candidates: [] };
  await pool.query(`INSERT INTO bp_clarifications(id,user_id,conversation_id,parent_command_id,root_command_id,payload) VALUES($1,$2,$3,$4,$4,$5)`, [clarificationId, owner.userId, cid, oldest.command.commandId, JSON.stringify(payload)]);
  const failed = await accept(cid, '旧失败请求');
  await pool.query("UPDATE bp_plan_commands SET status='failed' WHERE command_id=$1", [failed.command.commandId]);
  for (let i = 0; i < 55; i++) await accept(cid, `新请求${i}`);
  const page = await service.history(owner, cid);
  expect(page.messages.some(m => m.id === oldest.message.id)).toBe(false);
  expect(page.commands.some(c => c.commandId === oldest.command.commandId || c.commandId === failed.command.commandId)).toBe(false);
  expect(page.clarifications).toEqual([]);
  const recovery = await service.recovery(owner, cid, { limit: 100 });
  expect(recovery.items.find(c => c.commandId === oldest.command.commandId)?.clarification).toMatchObject({ id: clarificationId, version: 1 });
  expect(recovery.items.find(c => c.commandId === failed.command.commandId)).toMatchObject({ status: 'failed', retryable: true });
  expect((await service.getCommand(owner, cid, oldest.command.commandId)).clarification?.status).toBe('waiting');
  await service.cancelClarification(owner, cid, clarificationId, 1);
  expect((await service.getCommand(owner, cid, oldest.command.commandId)).clarification?.status).toBe('cancelled');
  expect((await service.recovery(owner, cid, { limit: 100 })).items.some(item => item.commandId === oldest.command.commandId)).toBe(false);
});

it('rejects unsafe message sequence conversion and rolls back an unrepresentable append', async () => {
  const cid = (await service.create(owner)).id;
  await pool.query('UPDATE bp_conversations SET next_sequence=9007199254740991 WHERE id=$1', [cid]);
  await expect(accept(cid, '不能被舍入的序号')).rejects.toMatchObject({ code: 'HISTORY_SEQUENCE_UNSUPPORTED' });
  expect((await pool.query('SELECT count(*)::int count FROM bp_chat_messages')).rows[0].count).toBe(0);
  expect((await pool.query('SELECT count(*)::int count FROM bp_plan_commands')).rows[0].count).toBe(0);
  expect((await pool.query('SELECT next_sequence FROM bp_conversations WHERE id=$1', [cid])).rows[0].next_sequence).toBe('9007199254740991');
});
