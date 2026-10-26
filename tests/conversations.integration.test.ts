import { randomUUID, createHash } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createConversationService } from '../apps/api/src/conversations.js';
import type { AcceptedConversationMessage, ConversationEnvelope } from '../packages/contracts/src/conversations.js';
import type { PayeeView, PlannerInput } from '../packages/contracts/src/index.js';

const url = process.env.TEST_DATABASE_URL ?? 'postgres://bankpilot:bankpilot-local@127.0.0.1:55432/bankpilot';
const schema = `chat_test_${randomUUID().replaceAll('-', '')}`;
const admin = new Pool({ connectionString: url });
const pool = new Pool({ connectionString: url, options: `-c search_path=${schema}`, max: 8 });
const owner = { userId: 'owner' }, other = { userId: 'other' };
let fresh: PayeeView[];
let unavailable = false;
const service = createConversationService(pool, { getPayees: async () => { if (unavailable) throw new Error('offline'); return fresh; } });
const basePayees: PayeeView[] = [
  { id: 'p1', name: '林晓', aliases: ['小林'], bank: '合成银行', maskedNumber: '****1234' },
  { id: 'p2', name: '张伟', aliases: [], bank: '甲银行', maskedNumber: '****3361' },
  { id: 'p3', name: '张伟', aliases: [], bank: '乙银行', maskedNumber: '****7788' },
];
const result = (clarification?: string): ConversationEnvelope => ({ taskId: 'test', planVersion: 1, mode: 'scripted', summary: '已分析原请求', events: [], suggestions: [], actions: [], evidence: [], findings: [], ...(clarification ? { clarification } : {}) });
const prepared = (message: string): PlannerInput => ({ taskId: 'test', message, accounts: [], payees: fresh, referenceDate: '2026-10-23' });
async function accept(text: string) { const cid = (await service.create(owner)).id; return { cid, accepted: await service.accept(owner, cid, { clientMessageId: randomUUID(), text }) }; }
async function finish(accepted: AcceptedConversationMessage, envelope = result('请补充字段'), rollback = false) {
  const token = randomUUID(), tx = await pool.connect();
  await pool.query("UPDATE bp_plan_commands SET status='running',lease_token=$3 WHERE user_id=$1 AND command_id=$2", [owner.userId, accepted.command.commandId, token]);
  try {
    await tx.query('BEGIN');
    await tx.query("UPDATE bp_plan_commands SET status='complete',result=$3 WHERE user_id=$1 AND command_id=$2 AND lease_token=$4", [owner.userId, accepted.command.commandId, JSON.stringify(envelope), token]);
    await service.onComplete(tx, owner, accepted.command.commandId, token, envelope, prepared(accepted.command.planningInput.message));
    await tx.query(rollback ? 'ROLLBACK' : 'COMMIT');
  } finally { tx.release(); }
  return token;
}
async function waiting(text: string) {
  const setup = await accept(text); await finish(setup.accepted);
  const command = await service.getCommand(owner, setup.cid, setup.accepted.command.commandId);
  expect(command.clarification?.status).toBe('waiting');
  return { ...setup, clarification: command.clarification! };
}
beforeAll(async () => { await admin.query(`CREATE SCHEMA "${schema}"`); await service.migrate(); });
beforeEach(async () => { await pool.query('TRUNCATE bp_chat_messages,bp_clarifications,bp_plan_commands,bp_conversations CASCADE'); fresh = structuredClone(basePayees); unavailable = false; });
afterAll(async () => { await pool.end(); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end(); });

describe('durable conversations and typed clarification', () => {
  it('accepts immutable original text and replays the same client key without a new command', async () => {
    const cid = (await service.create(owner)).id, input = { clientMessageId: randomUUID(), text: '  给林晓100元  ' };
    const [one, two] = await Promise.all([service.accept(owner, cid, input), service.accept(owner, cid, input)]);
    expect(one.command.commandId).toBe(two.command.commandId);
    expect((await service.history(owner, cid)).messages).toHaveLength(1);
    const row = (await pool.query('SELECT * FROM bp_plan_commands')).rows[0];
    expect(row.original_message).toBe(input.text); expect(row.message_hash).toBe(createHash('sha256').update(input.text).digest('hex'));
    await expect(service.accept(owner, cid, { ...input, text: '给林晓200元' })).rejects.toMatchObject({ code: 'COMMAND_CONFLICT' });
  });
  it('isolates owner, conversation and commands on every lookup', async () => {
    const { cid, accepted } = await accept('查询余额');
    expect(await service.list(other)).toEqual({ conversations: [] });
    await expect(service.history(other, cid)).rejects.toMatchObject({ statusCode: 404 });
    await expect(service.accept(other, cid, { clientMessageId: randomUUID(), text: '查询余额' })).rejects.toMatchObject({ statusCode: 404 });
    const second = await service.create(owner);
    await expect(service.getCommand(owner, second.id, accepted.command.commandId)).rejects.toMatchObject({ statusCode: 404 });
  });
  it('serializes concurrent message sequences and pages without dropping history', async () => {
    const cid = (await service.create(owner)).id;
    await Promise.all(Array.from({ length: 8 }, (_, i) => service.accept(owner, cid, { clientMessageId: randomUUID(), text: `合成请求${i}` })));
    const first = await service.history(owner, cid, { limit: 3 });
    expect(first.messages.map(m => m.sequence)).toEqual([6, 7, 8]);
    const second = await service.history(owner, cid, { limit: 3, beforeSequence: first.nextBeforeSequence });
    expect(second.messages.map(m => m.sequence)).toEqual([3, 4, 5]);
    const last = await service.history(owner, cid, { limit: 3, beforeSequence: second.nextBeforeSequence });
    expect(last.messages.map(m => m.sequence)).toEqual([1, 2]); expect(last.nextBeforeSequence).toBeUndefined();
  });
  it('rolls result and assistant projection back together and rejects stale lease completion', async () => {
    const { cid, accepted } = await accept('查询余额');
    const old = await finish(accepted, result(), true);
    expect((await service.history(owner, cid)).messages).toHaveLength(1);
    expect((await service.getCommand(owner, cid, accepted.command.commandId)).result).toBeUndefined();
    await finish(accepted, result());
    const tx = await pool.connect();
    try { await expect(service.onComplete(tx, owner, accepted.command.commandId, old, result())).rejects.toMatchObject({ code: 'PLAN_SUPERSEDED' }); } finally { tx.release(); }
    const history = await service.history(owner, cid); expect(history.messages).toHaveLength(2); expect(history.commands[0]?.status).toBe('complete');
  });
  it('reads command status and final messages from one repeatable read snapshot', async () => {
    const { cid, accepted } = await accept('查询余额');
    let inject = true;
    const hookedPool = { query: pool.query.bind(pool), connect: async () => {
      const client = await pool.connect(), originalQuery = client.query, originalRelease = client.release;
      client.query = (async (...args: unknown[]) => {
        const response = await (originalQuery as any).apply(client, args);
        if (inject && typeof args[0] === 'string' && args[0].includes('ORDER BY sequence DESC')) {
          inject = false; await finish(accepted, result());
        }
        return response;
      }) as typeof client.query;
      client.release = (error?: Error | boolean) => { client.query = originalQuery; client.release = originalRelease; originalRelease.call(client, error); };
      return client;
    } } as unknown as Pool;
    const snapshot = await createConversationService(hookedPool).history(owner, cid);
    expect(snapshot.messages).toHaveLength(1); expect(snapshot.commands[0]?.status).toBe('pending');
    const current = await service.history(owner, cid);
    expect(current.messages).toHaveLength(2); expect(current.commands[0]?.status).toBe('complete');
  });
  it('deduplicates failure messages by lease attempt and preserves failed command input', async () => {
    const { cid, accepted } = await accept('给林晓100元');
    const token = randomUUID();
    await pool.query("UPDATE bp_plan_commands SET status='failed',lease_token=$1 WHERE command_id=$2", [token, accepted.command.commandId]);
    for (let i = 0; i < 2; i++) { const tx = await pool.connect(); try { await tx.query('BEGIN'); await service.onFailure(tx, owner, accepted.command.commandId, token, 'MODEL_TIMEOUT'); await tx.query('COMMIT'); } finally { tx.release(); } }
    const history = await service.history(owner, cid); expect(history.messages).toHaveLength(2); expect(history.commands[0]).toMatchObject({ retryable: true, lastErrorCode: 'MODEL_TIMEOUT', planningInput: { message: '给林晓100元' } });
    await pool.query("UPDATE bp_plan_commands SET status='running',updated_at=now()-interval '5 minutes' WHERE command_id=$1", [accepted.command.commandId]);
    expect((await service.getCommand(owner, cid, accepted.command.commandId)).retryable).toBe(true);
  });
  it('resolves a duplicate-name recipient by suffix with immutable original amount and provenance', async () => {
    const { cid, accepted, clarification } = await waiting('给张伟转账300元');
    expect(clarification.requestedSlots).toEqual(['payee']);
    const input = { clientMessageId: randomUUID(), text: '尾号3361', clarificationId: clarification.id, expectedClarificationVersion: clarification.version };
    const next = await service.accept(owner, cid, input);
    expect(next.command).toMatchObject({ rootCommandId: accepted.command.commandId, parentCommandId: accepted.command.commandId, revision: 1, originalMessage: '给张伟转账300元' });
    expect(next.command.planningInput.typed?.slots).toEqual({ payeeId: 'p2', amountMinor: '30000' });
    expect(next.command.planningInput.typed?.sources.map(s => s.kind)).toEqual(['original', 'selection']);
    unavailable = true;
    expect((await service.accept(owner, cid, input)).command.commandId).toBe(next.command.commandId);
  });
  it('allows only one successor under competing clarification responses', async () => {
    const { cid, clarification } = await waiting('给张伟转账300元');
    const results = await Promise.allSettled(['尾号3361', '尾号7788'].map(text => service.accept(owner, cid, { clientMessageId: randomUUID(), text, clarificationId: clarification.id, expectedClarificationVersion: clarification.version })));
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1); expect(results.filter(r => r.status === 'rejected')).toHaveLength(1);
    expect((await pool.query('SELECT count(*) FROM bp_plan_commands WHERE revision=1')).rows[0].count).toBe('1');
  });
  it('fills a missing amount without modifying the saved recipient', async () => {
    const { cid, clarification } = await waiting('给林晓转账');
    expect(clarification.requestedSlots).toEqual(['amount']);
    await expect(service.accept(owner, cid, { clientMessageId: randomUUID(), text: '200元，改给张伟', clarificationId: clarification.id, expectedClarificationVersion: 1 })).rejects.toMatchObject({ code: 'CLARIFICATION_INVALID' });
    const next = await service.accept(owner, cid, { clientMessageId: randomUUID(), text: '200.05元', clarificationId: clarification.id, expectedClarificationVersion: 1 });
    expect(next.command.planningInput.typed?.slots).toEqual({ payeeId: 'p1', amountMinor: '20005' });
  });
  it('fills the goal year while preserving the originally specified month and day', async () => {
    const { cid, clarification } = await waiting('给林晓建立生日目标，11月5日前准备300元');
    expect(clarification.requestedSlots).toEqual(['targetDate']);
    await expect(service.accept(owner, cid, { clientMessageId: randomUUID(), text: '2027-12-05', clarificationId: clarification.id, expectedClarificationVersion: 1 })).rejects.toMatchObject({ code: 'CLARIFICATION_INVALID' });
    const next = await service.accept(owner, cid, { clientMessageId: randomUUID(), text: '2027-11-05', clarificationId: clarification.id, expectedClarificationVersion: 1 });
    expect(next.command.planningInput.typed?.slots).toEqual({ payeeId: 'p1', amountMinor: '30000', targetDate: '2027-11-05' });
    expect(next.command.planningInput.typed?.sources.filter(s => s.field === 'targetDate').map(s => s.text)).toEqual(['11月5日', '2027-11-05']);
  });
  it.each(['给张伟转300元并查账单', '给张伟转300元，帮我预约挂号', '给林晓建立生日目标，11月5日前准备300元，从理财赎回300元', '给林晓转账300元只是个示例'])('does not discard unsupported intent while offering typed continuation: %s', async text => {
    const { cid, accepted } = await accept(text); await finish(accepted);
    const command = await service.getCommand(owner, cid, accepted.command.commandId);
    expect(command.clarification).toBeUndefined(); expect(command.result?.clarification).toContain('完整重述');
  });
  it.each(['给林晓转账，给小林转账', '给林晓准备生日目标，给小林准备生日目标', '给林晓建立目标，给小林创建目标'])('does not collapse repeated same-domain requests into one typed revision: %s', async text => {
    const { cid, accepted } = await accept(text); await finish(accepted);
    const command = await service.getCommand(owner, cid, accepted.command.commandId);
    expect(command.clarification).toBeUndefined(); expect(command.result?.clarification).toContain('完整重述');
    expect((await pool.query('SELECT count(*) FROM bp_plan_commands WHERE revision>0')).rows[0].count).toBe('0');
  });
  it('keeps one goal and its eventual transfer as a single goal through clarification', async () => {
    const { cid, clarification } = await waiting('给林晓建立生日目标，11月5日前准备300元转账');
    expect(clarification.operation).toBe('goal_create'); expect(clarification.requestedSlots).toEqual(['targetDate']);
    const next = await service.accept(owner, cid, { clientMessageId: randomUUID(), text: '2027-11-05', clarificationId: clarification.id, expectedClarificationVersion: 1 });
    expect(next.command.planningInput.typed).toMatchObject({ operation: 'goal_create', slots: { payeeId: 'p1', amountMinor: '30000', targetDate: '2027-11-05' } });
    expect(next.command.planningInput.message).toBe('建立林晓生日目标，2027-11-05前准备300.00元');
    expect(next.command.result).toBeUndefined(); expect(next.command.status).toBe('pending');
  });
  it('rejects stale candidate details even when the payee ID remains unchanged', async () => {
    const { cid, clarification } = await waiting('给张伟转账300元');
    fresh = fresh.map(p => p.id === 'p2' ? { ...p, bank: '新银行' } : p);
    await expect(service.accept(owner, cid, { clientMessageId: randomUUID(), text: '尾号3361', clarificationId: clarification.id, expectedClarificationVersion: 1 })).rejects.toMatchObject({ code: 'CLARIFICATION_INVALID' });
    expect((await service.history(owner, cid)).clarifications[0]?.status).toBe('waiting');
  });
  it('blocks new revisions once any proposal or result contains an action', async () => {
    const { cid, accepted, clarification } = await waiting('给张伟转账300元');
    await pool.query('UPDATE bp_plan_commands SET proposal=$2 WHERE command_id=$1', [accepted.command.commandId, JSON.stringify({ ...result(), actions: [{ id: 'already-created' }] })]);
    await expect(service.accept(owner, cid, { clientMessageId: randomUUID(), text: '尾号3361', clarificationId: clarification.id, expectedClarificationVersion: 1 })).rejects.toMatchObject({ code: 'COMMAND_CONFLICT' });
  });
  it('cancels only clarification and rejects later answers, with idempotent cancellation', async () => {
    const { cid, clarification } = await waiting('给林晓转账');
    await expect(service.cancelClarification(other, cid, clarification.id, 1)).rejects.toMatchObject({ statusCode: 404 });
    expect((await service.cancelClarification(owner, cid, clarification.id, 1)).status).toBe('cancelled');
    expect((await service.cancelClarification(owner, cid, clarification.id, 1)).status).toBe('cancelled');
    await expect(service.accept(owner, cid, { clientMessageId: randomUUID(), text: '200元', clarificationId: clarification.id, expectedClarificationVersion: 1 })).rejects.toMatchObject({ code: 'COMMAND_CONFLICT' });
    expect((await service.history(owner, cid)).messages).toHaveLength(3);
  });
  it('supports an explicitly selected recipient and amount in one typed answer', async () => {
    const { cid, clarification } = await waiting('转账');
    expect(clarification.requestedSlots).toEqual(['payee', 'amount']);
    const next = await service.accept(owner, cid, { clientMessageId: randomUUID(), text: '尾号1234，88.09元', clarificationId: clarification.id, expectedClarificationVersion: 1, answer: { payeeId: 'p1', payeeSuffix: '1234', amount: '88.09元' } });
    expect(next.command.planningInput.typed?.slots).toEqual({ payeeId: 'p1', amountMinor: '8809' });
  });
  it.each(['-100元', '1e3元', '100.001元', '100元或200元', '100元，确认执行'])('rejects unsafe or ambiguous supplemental money without closing the question: %s', async text => {
    const { cid, clarification } = await waiting('给林晓转账');
    await expect(service.accept(owner, cid, { clientMessageId: randomUUID(), text, clarificationId: clarification.id, expectedClarificationVersion: 1 })).rejects.toMatchObject({ code: 'CLARIFICATION_INVALID' });
    expect((await service.history(owner, cid)).clarifications[0]?.status).toBe('waiting');
    expect((await pool.query('SELECT count(*) FROM bp_plan_commands')).rows[0].count).toBe('1');
  });
  it('does not freeze a cropped invalid calendar date or an amount overlapping a saved name', async () => {
    for (const text of ['给林晓建立生日目标，2027-11-200前准备300元', '给张三十二元']) {
      if (text.includes('张三')) fresh.push({ id: 'p4', name: '张三', aliases: [], bank: '合成银行', maskedNumber: '****9911' });
      const { cid, accepted } = await accept(text); await finish(accepted);
      expect((await service.getCommand(owner, cid, accepted.command.commandId)).clarification).toBeUndefined();
    }
  });
  it('rejects changing a nonrequested typed field and cross-conversation clarification access', async () => {
    const { cid, clarification } = await waiting('给林晓转账');
    const request = { clientMessageId: randomUUID(), text: '50元', clarificationId: clarification.id, expectedClarificationVersion: 1, answer: { amount: '50元', payeeId: 'p2' } };
    await expect(service.accept(owner, cid, request)).rejects.toMatchObject({ code: 'CLARIFICATION_INVALID' });
    const second = await service.create(owner);
    await expect(service.accept(owner, second.id, { ...request, answer: { amount: '50元' } })).rejects.toMatchObject({ statusCode: 404 });
  });
  it('does not append a stale lease failure after a newer attempt completes', async () => {
    const { cid, accepted } = await accept('查询余额'); await finish(accepted, result());
    const tx = await pool.connect(); try { await tx.query('BEGIN'); await service.onFailure(tx, owner, accepted.command.commandId, randomUUID(), 'MODEL_TIMEOUT'); await tx.query('COMMIT'); } finally { tx.release(); }
    await service.getCommand(owner, cid, accepted.command.commandId); await service.history(owner, cid);
    expect((await service.history(owner, cid)).messages).toHaveLength(2);
    expect((await service.getCommand(owner, cid, accepted.command.commandId)).lastErrorCode).toBeUndefined();
  });
  it('stores complete visible assistant text and action count in one final projection', async () => {
    const { cid, accepted } = await accept('给林晓100元');
    const envelope = { ...result(), findings: ['服务端检查完成'], actions: [{ id: 'draft' }] };
    const token = await finish(accepted, envelope);
    const tx = await pool.connect(); try { await tx.query('BEGIN'); await service.onComplete(tx, owner, accepted.command.commandId, token, envelope); await tx.query('COMMIT'); } finally { tx.release(); }
    const history = await service.history(owner, cid); expect(history.messages).toHaveLength(2);
    expect(history.messages[1]?.text).toContain('已分析原请求'); expect(history.messages[1]?.text).toContain('服务端检查完成'); expect(history.messages[1]?.text).toContain('1 个待审阅动作');
  });
});
