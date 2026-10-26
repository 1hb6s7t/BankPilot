import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createConversationService } from '../apps/api/src/conversations.js';
import type { AcceptedConversationMessage, ConversationEnvelope } from '../packages/contracts/src/conversations.js';

const url = process.env.TEST_DATABASE_URL ?? 'postgres://bankpilot:bankpilot-local@127.0.0.1:55432/bankpilot';
const schema = `g9j_chat_${randomUUID().replaceAll('-', '')}`;
const admin = new Pool({ connectionString: url });
const pool = new Pool({ connectionString: url, options: `-c search_path=${schema}`, max: 4 });
const service = createConversationService(pool);
const owner = { userId: 'presentation-owner' };
const withheld = '账单结论尚未通过核对，未作为本次查询答案。';
const envelope = (): ConversationEnvelope => ({ taskId: 'presentation-task', planVersion: 1, mode: 'model',
  summary: withheld, clarification: withheld, events: [], suggestions: [], actions: [], evidence: [],
  billAnswerReview: { status: 'withheld', message: withheld },
  findings: ['BILL_DOMAIN_ASSESSMENT_REJECTED', 'BILL_DOMAIN_QUERY_SCOPE_MISMATCH', 'BILL_DOMAIN_CONCERN:evidence', 'BILL_ANSWER_REVIEW_REJECTED'],
});
async function setup(text = '查询本月账单') {
  const cid = (await service.create(owner)).id;
  return { cid, accepted: await service.accept(owner, cid, { clientMessageId: randomUUID(), text }) };
}
async function complete(accepted: AcceptedConversationMessage, value: ConversationEnvelope) {
  const token = randomUUID(), tx = await pool.connect();
  try {
    await tx.query('BEGIN');
    await tx.query("UPDATE bp_plan_commands SET status='complete',lease_token=$3,result=$4 WHERE user_id=$1 AND command_id=$2", [owner.userId, accepted.command.commandId, token, JSON.stringify(value)]);
    await service.onComplete(tx, owner, accepted.command.commandId, token, value);
    await tx.query('COMMIT');
  } catch (error) { await tx.query('ROLLBACK'); throw error; } finally { tx.release(); }
}
beforeAll(async () => { await admin.query(`CREATE SCHEMA "${schema}"`); await service.migrate(); });
beforeEach(async () => { await pool.query('TRUNCATE bp_chat_messages,bp_clarifications,bp_plan_commands,bp_conversations CASCADE'); });
afterAll(async () => { await pool.end(); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end(); });

describe('G9J persisted and recovered user-facing bill result', () => {
  it('persists readable refusal while preserving machine findings and withheld state', async () => {
    const { cid, accepted } = await setup(), value = envelope();
    const originalFindings = [...value.findings];
    await complete(accepted, value);
    const rows = (await pool.query("SELECT text FROM bp_chat_messages WHERE user_id=$1 AND conversation_id=$2 AND role='assistant'", [owner.userId, cid])).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].text).toContain(withheld);
    expect(rows[0].text).not.toMatch(/BILL_[A-Z_]+|CONCERN:/);
    const result = (await service.getCommand(owner, cid, accepted.command.commandId)).result!;
    expect(result.findings).toEqual(originalFindings);
    expect(result.billAnswerReview?.status).toBe('withheld');
    expect(result.actions).toEqual([]);
    expect(result.billAnalysis).toBeUndefined();
  });
  it('projects legacy assistant results without rewriting stored messages or command results', async () => {
    const { cid, accepted } = await setup();
    const legacyEnvelope = envelope();
    legacyEnvelope.summary += ' HIDDEN_BILL_FACT_927';
    legacyEnvelope.events = [{ role: 'card', status: 'completed', at: '2026-10-25T00:00:00Z', summary: 'HIDDEN_OTHER_DOMAIN_BILL_FACT_193' }];
    await complete(accepted, legacyEnvelope);
    const legacy = `${withheld}\n\nBILL_DOMAIN_ASSESSMENT_REJECTED\n\nBILL_DOMAIN_CONCERN:evidence`;
    await pool.query("UPDATE bp_chat_messages SET text=$3 WHERE user_id=$1 AND conversation_id=$2 AND role='assistant'", [owner.userId, cid, legacy]);
    const snapshot = async () => ({ messages: (await pool.query('SELECT * FROM bp_chat_messages ORDER BY sequence')).rows,
      commands: (await pool.query('SELECT * FROM bp_plan_commands ORDER BY command_id')).rows });
    const before = await snapshot();
    for (let i = 0; i < 2; i++) {
      const history = await service.history(owner, cid);
      const text = history.messages.find(message => message.role === 'assistant')!.text;
      expect(text).toContain(withheld);
      expect(text).not.toMatch(/BILL_[A-Z_]+|CONCERN:/);
      expect(text).not.toContain('HIDDEN_BILL_FACT_927');
      expect(text).not.toContain('HIDDEN_OTHER_DOMAIN_BILL_FACT_193');
      expect(history.commands[0]?.result?.findings).toContain('BILL_DOMAIN_ASSESSMENT_REJECTED');
      const exposed = history.commands[0]!.result!;
      expect([exposed.summary, exposed.clarification, ...exposed.events.map(event => event.summary)].join(' ')).not.toMatch(/HIDDEN_BILL_FACT_927|HIDDEN_OTHER_DOMAIN_BILL_FACT_193/);
      const direct = (await service.getCommand(owner, cid, accepted.command.commandId)).result!;
      expect([direct.summary, ...direct.events.map(event => event.summary)].join(' ')).not.toMatch(/HIDDEN_BILL_FACT_927|HIDDEN_OTHER_DOMAIN_BILL_FACT_193/);
    }
    expect(await snapshot()).toEqual(before);
  });
  it('never projects another conversation result through a mismatched command reference', async () => {
    const first = await setup(), second = await setup();
    await complete(first.accepted, envelope());
    await complete(second.accepted, { ...envelope(), summary: 'OTHER_CONVERSATION_PRIVATE_CANARY', clarification: undefined, billAnswerReview: undefined, findings: [] });
    await pool.query("UPDATE bp_chat_messages SET command_id=$3,response_key='cross-conversation-fixture' WHERE user_id=$1 AND conversation_id=$2 AND role='assistant'", [owner.userId, first.cid, second.accepted.command.commandId]);
    const history = await service.history(owner, first.cid);
    expect(JSON.stringify(history)).not.toContain('OTHER_CONVERSATION_PRIVATE_CANARY');
    expect(history.commands.every(command => command.conversationId === first.cid)).toBe(true);
    await expect(service.history({ userId: 'another-owner' }, first.cid)).rejects.toMatchObject({ statusCode: 404 });
  });
  it('preserves user-authored technical strings and independently paginated messages', async () => {
    const userText = '请解释 BILL_DOMAIN_QUERY_SCOPE_MISMATCH，不要办理任何动作。';
    const { cid, accepted } = await setup(userText);
    await complete(accepted, envelope());
    const latest = await service.history(owner, cid, { limit: 1 });
    expect(latest.messages).toHaveLength(1);
    expect(latest.messages[0]?.role).toBe('assistant');
    expect(latest.messages[0]?.text).not.toContain('BILL_DOMAIN_');
    const previous = await service.history(owner, cid, { limit: 1, beforeSequence: latest.nextBeforeSequence });
    expect(previous.messages.map(message => message.text)).toEqual([userText]);
    expect(previous.nextBeforeSequence).toBeUndefined();
  });
});
