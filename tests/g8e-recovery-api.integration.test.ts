import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, migrateApi } from '../apps/api/src/app.js';
import { createCore, createFinance } from '../packages/core/src/index.js';
import { createPlanner } from '../packages/agents/src/index.js';
import type { FinanceService } from '../packages/contracts/src/index.js';
import type { ConversationCommand, ConversationHistory } from '../packages/contracts/src/conversations.js';

const connectionString = process.env.TEST_DATABASE_URL ?? 'postgres://bankpilot:bankpilot-local@127.0.0.1:55432/bankpilot';
const schema = `g8e_api_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
const admin = new Pool({ connectionString, max: 2 });
const pool = new Pool({ connectionString, options: `-c search_path=${schema}`, max: 12 });
const origin = 'http://localhost:5178';
let actor = { userId: '' };
let core: ReturnType<typeof createCore>;
let finance: FinanceService;
let app: ReturnType<typeof createApp>;
let calls: { role: string; cap: number; task: any }[];
let respond: (task: any, index: number) => Promise<Response>;
let fetchMock: ReturnType<typeof vi.spyOn> | undefined;
const text = '给林晓转账317.25元，备注恢复核对';
const jsonResponse = (value: unknown) => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value) } }] }), { status: 200 });
function successfulResponse(task: any): Response {
  if (task.role === 'semantic_intent') return jsonResponse({ tasks: [{ operation: 'transfer', disposition: 'request', scope: { source: 'whole_message' }, entity: { kind: 'payee', id: 'payee-lin', mention: { text: '林晓' } }, ...(task.message.includes('317.25') ? { amount: { text: '317.25元' }, memo: { text: '恢复核对' } } : {}) }] });
  if (task.role === 'transfer') return jsonResponse({ role: 'transfer', planVersion: 1, summary: '待本人确认', suggestion: task.data.resolved.suggestion, findings: [], evidence: [] });
  if (task.role === 'reviewer') return jsonResponse({ approved: true, findings: [], summary: '仅同意生成待确认草稿' });
  throw new Error(`Unexpected model role ${task.role}`);
}
function rebuild(customFinance = finance) {
  const auth = { api: { getSession: async ({ headers }: { headers: Headers }) => headers.get('cookie') === `g8e-owner=${actor.userId}` ? { user: { id: actor.userId, email: 'g8e@example.test' } } : null } };
  const planner = createPlanner({ provider: { baseURL: 'https://model.invalid', model: 'g8e-controlled', outputMode: 'json_object', maxAttempts: 2, retryDelayMs: 1 } });
  app = createApp({ pool, core, finance: customFinance, planner, auth: auth as never, origin, rpID: 'localhost', sandbox: false, plannerMode: 'model' });
}
async function request(path: string, body?: unknown) {
  return app.request(`${origin}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { Cookie: `g8e-owner=${actor.userId}`, Origin: origin, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function submit(message = text) {
  const conversationResponse = await request('/api/conversations', { title: '服务恢复验收' });
  expect(conversationResponse.status).toBe(201);
  const conversation = await conversationResponse.json();
  const clientMessageId = randomUUID();
  const response = await request(`/api/conversations/${conversation.id}/messages`, { text: message, clientMessageId });
  expect(response.status).toBe(202);
  const accepted = await response.json();
  return { cid: conversation.id as string, id: accepted.command.commandId as string, clientMessageId, accepted };
}
async function command(cid: string, id: string): Promise<ConversationCommand> {
  const response = await request(`/api/conversations/${cid}/commands/${id}`);
  expect(response.status).toBe(200); return response.json();
}
async function history(cid: string): Promise<ConversationHistory> {
  const response = await request(`/api/conversations/${cid}/messages`);
  expect(response.status).toBe(200); return response.json();
}
async function retry(cid: string, id: string) { return request(`/api/conversations/${cid}/commands/${id}/retry`, {}); }
async function saved(id: string) { return (await pool.query('SELECT * FROM bp_plan_commands WHERE user_id=$1 AND command_id=$2', [actor.userId, id])).rows[0]; }
async function unchangedFundsAndNoExecution() {
  const dashboard = await core.dashboard(actor);
  expect(dashboard.accounts[0]).toMatchObject({ balanceMinor: '800000', reservedMinor: '0' });
  expect((await pool.query(`SELECT count(*)::int AS n FROM "${schema}".provider_transfers WHERE account_id=$1`, [`acc-main-${actor.userId}`])).rows[0].n).toBe(0);
}

describe('G8E independent real API/PG recovery with controlled provider transport', () => {
  beforeAll(async () => {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await migrateApi(pool);
    core = createCore(pool, { schema }); await core.migrate();
    finance = createFinance(pool, { schema });
  }, 30000);
  beforeEach(async () => {
    actor = { userId: `g8e-${randomUUID()}` };
    await core.seedDemo(actor); await finance.seedDemo(actor);
    await pool.query(`UPDATE "${schema}".payees SET name='林晓' WHERE id='payee-lin'`);
    calls = []; respond = async task => successfulResponse(task);
    fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      if (!String(url).startsWith('https://model.invalid/')) throw new Error('Unexpected external endpoint');
      const body = JSON.parse(String(init?.body));
      const task = JSON.parse(body.messages.find((m: any) => m.role === 'user').content);
      const index = calls.length; calls.push({ role: task.role, cap: body.max_tokens, task });
      return respond(task, index);
    });
    rebuild();
  });
  afterEach(async () => { await app.waitForPlanning(); fetchMock?.mockRestore(); });
  afterAll(async () => { await pool.end(); await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await admin.end(); });

  it('keeps service failure recoverable, reuses the original catalog, and replays success without a second draft', async () => {
    respond = async () => new Response('controlled upstream unavailable', { status: 502 });
    const { cid, id, clientMessageId, accepted } = await submit(); await app.waitForPlanning();
    const failed = await command(cid, id);
    expect(failed).toMatchObject({ status: 'failed', retryable: true, rootCommandId: id, revision: 0, failure: { phase: 'semantic_intent', code: 'MODEL_HTTP_502', retryable: true } });
    expect(failed.result).toBeUndefined(); expect(failed.clarification).toBeUndefined();
    expect(failed.failure?.modelRuns).toHaveLength(2);
    const failedRow = await saved(id);
    expect(failedRow.proposal).toBeNull(); expect(failedRow.result).toBeNull();
    expect(failedRow.prepared_input?.semanticIntent?.status).not.toBe('failed');
    const failedHistory = await history(cid);
    expect(failedHistory.messages.filter(m => m.role === 'user')).toHaveLength(1);
    expect(failedHistory.messages.filter(m => m.kind === 'failure')).toHaveLength(1);
    expect(failedHistory.clarifications).toEqual([]);
    expect((await core.dashboard(actor)).actions).toEqual([]); await unchangedFundsAndNoExecution();
    await history(cid); await command(cid, id);
    const replay = await request(`/api/conversations/${cid}/messages`, { clientMessageId, text });
    expect((await replay.json()).replayed).toBe(true); await app.waitForPlanning(); expect(calls).toHaveLength(2);
    await pool.query(`UPDATE "${schema}".payees SET name='目录已更新' WHERE id='payee-lin'`);
    respond = async task => successfulResponse(task);
    const recovery = await retry(cid, id); expect(recovery.status).toBe(202); await app.waitForPlanning();
    const completed = await command(cid, id);
    expect(completed.status).toBe('complete'); expect(completed.commandId).toBe(id);
    expect(completed.rootCommandId).toBe(accepted.command.rootCommandId); expect(completed.revision).toBe(0);
    expect(completed.result?.actions).toHaveLength(1);
    expect(completed.result?.actions?.[0]).toMatchObject({ amountMinor: '31725', memo: '恢复核对', status: 'AWAITING_CONFIRMATION' });
    expect(calls.map(c => c.role)).toEqual(['semantic_intent', 'semantic_intent', 'semantic_intent', 'transfer', 'reviewer']);
    expect(calls[2]?.task).toEqual(calls[0]?.task);
    expect(completed.result?.modelRuns?.filter(r => r.role === 'semantic_intent').map(r => r.status)).toEqual(['failed', 'failed', 'success']);
    const restored = await history(cid);
    expect(restored.commands).toHaveLength(1);
    expect(restored.messages.filter(m => m.role === 'user')).toHaveLength(1);
    expect(restored.messages.filter(m => m.kind === 'failure')).toHaveLength(1);
    expect(restored.messages.filter(m => m.kind === 'result')).toHaveLength(1);
    const beforeReplay = calls.length;
    await retry(cid, id); await app.waitForPlanning();
    expect(calls).toHaveLength(beforeReplay); expect((await core.dashboard(actor)).actions).toHaveLength(1);
    expect(calls.reduce((sum, c) => sum + c.cap, 0)).toBeLessThanOrEqual(32768); await unchangedFundsAndNoExecution();
  }, 30000);

  it('genuine missing amount remains a completed business clarification, not a service failure', async () => {
    const { cid, id } = await submit('给林晓转账'); await app.waitForPlanning();
    const result = await command(cid, id);
    expect(result.status).toBe('complete'); expect(result.retryable).toBe(false); expect(result.failure).toBeUndefined();
    expect(result.result?.clarification).toBeTruthy(); expect(result.result?.actions).toEqual([]);
    expect((await history(cid)).messages.filter(m => m.kind === 'failure')).toEqual([]);
    expect(calls.every(c => c.role === 'semantic_intent')).toBe(true); await unchangedFundsAndNoExecution();
  }, 30000);

  it('does not offer or dispatch retry for non-transient provider authentication failure', async () => {
    respond = async () => new Response('controlled authentication failure', { status: 401 });
    const { cid, id } = await submit(); await app.waitForPlanning();
    const failed = await command(cid, id);
    expect(failed).toMatchObject({ status: 'failed', retryable: false, failure: { code: 'MODEL_HTTP_401', retryable: false } });
    expect(failed.clarification).toBeUndefined(); expect(failed.result).toBeUndefined();
    expect(calls).toHaveLength(1); await retry(cid, id); await app.waitForPlanning(); expect(calls).toHaveLength(1);
    await unchangedFundsAndNoExecution();
  }, 30000);

  it.each([
    { code: 'MODEL_SCHEMA_INVALID', content: '{}' },
    { code: 'MODEL_OUTPUT_JSON_INVALID', content: '{incomplete' },
  ])('keeps exhausted $code output failure separate from missing user information', async ({ code, content }) => {
    respond = async () => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content } }] }));
    const { cid, id } = await submit(); await app.waitForPlanning();
    const failed = await command(cid, id);
    expect(failed).toMatchObject({ status: 'failed', retryable: false, failure: { phase: 'semantic_intent', code, retryable: false } });
    expect(failed.result).toBeUndefined(); expect(failed.clarification).toBeUndefined();
    expect(calls.map(call => call.role)).toEqual(['semantic_intent', 'semantic_intent']);
    const row = await saved(id);
    expect(row.proposal).toBeNull(); expect(row.result).toBeNull(); expect(row.semantic_result).toBeNull();
    expect(row.model_attempts).toHaveLength(2);
    expect(row.model_attempts.every((attempt: any) => attempt.outcome === 'failed' && attempt.errorCode === code)).toBe(true);
    const restored = await history(cid);
    expect(restored.clarifications).toEqual([]);
    expect(restored.messages.filter(message => message.role === 'user')).toHaveLength(1);
    expect(restored.messages.filter(message => message.kind === 'failure')).toHaveLength(1);
    expect(restored.messages.some(message => message.text.includes('请明确当前要办理'))).toBe(false);
    rebuild(); await retry(cid, id); await app.waitForPlanning(); expect(calls).toHaveLength(2);
    expect((await core.dashboard(actor)).actions).toEqual([]); await unchangedFundsAndNoExecution();
  }, 30000);

  it('counts request caps across explicit retries and stops before issuing a call over the same-command budget', async () => {
    respond = async () => new Response('still unavailable', { status: 502 });
    const { cid, id } = await submit(); await app.waitForPlanning();
    let state = await command(cid, id), retries = 0;
    while (state.retryable && retries < 8) {
      await retry(cid, id); await app.waitForPlanning(); state = await command(cid, id); retries++;
      expect(calls.reduce((sum, c) => sum + c.cap, 0)).toBeLessThanOrEqual(32768);
    }
    expect(retries).toBeLessThan(8); expect(state.status).toBe('failed'); expect(state.retryable).toBe(false);
    expect(calls.length).toBeGreaterThan(2); expect(calls.length).toBeLessThanOrEqual(8);
    const before = calls.length; await retry(cid, id); await app.waitForPlanning(); expect(calls).toHaveLength(before);
    expect((await history(cid)).messages.filter(m => m.role === 'user')).toHaveLength(1);
    expect((await saved(id)).proposal).toBeNull(); await unchangedFundsAndNoExecution();
  }, 30000);

  it('reuses a successful interpretation when financial preparation fails, including after rebuilding the app', async () => {
    let fundsCalls = 0;
    rebuild({ ...finance, funds: async (...args: Parameters<FinanceService['funds']>) => {
      fundsCalls++; if (fundsCalls === 1) throw new Error('controlled financial read interruption');
      return finance.funds(...args);
    } });
    const { cid, id } = await submit(); await app.waitForPlanning();
    expect((await command(cid, id)).status).toBe('failed'); expect(calls.map(c => c.role)).toEqual(['semantic_intent']);
    expect((await saved(id)).proposal).toBeNull();
    rebuild(); await retry(cid, id); await app.waitForPlanning();
    const completed = await command(cid, id);
    expect(completed.status).toBe('complete'); expect(completed.result?.actions).toHaveLength(1);
    expect(calls.map(c => c.role)).toEqual(['semantic_intent', 'transfer', 'reviewer']); await unchangedFundsAndNoExecution();
  }, 30000);

  it('reports planning exhaustion accurately when the last permitted semantic call succeeds', async () => {
    respond = async (task, index) => index < 7 ? new Response('controlled failure', { status: 502 }) : successfulResponse(task);
    const { cid, id } = await submit(); await app.waitForPlanning();
    for (let i = 0; i < 3; i++) { expect((await command(cid, id)).retryable).toBe(true); await retry(cid, id); await app.waitForPlanning(); }
    const failed = await command(cid, id);
    expect(failed).toMatchObject({ status: 'failed', retryable: false, failure: { phase: 'planning', code: 'MODEL_OUTPUT_BUDGET_EXHAUSTED', retryable: false } });
    const row = await saved(id);
    expect(row.semantic_result.status).toBe('ready'); expect(row.proposal).toBeNull(); expect(row.result).toBeNull();
    expect(calls).toHaveLength(8); expect(calls.every(c => c.role === 'semantic_intent')).toBe(true);
    expect(calls.reduce((sum, call) => sum + call.cap, 0)).toBe(32768);
    await retry(cid, id); await app.waitForPlanning(); expect(calls).toHaveLength(8); await unchangedFundsAndNoExecution();
  }, 30000);

  it.each([
    { code: 'RECOGNITION_SNAPSHOT_INCOMPATIBLE', sql: "recognition_graph_version='incompatible-graph'" },
    { code: 'SEMANTIC_SNAPSHOT_INVALID', sql: "semantic_digest=repeat('0',64)" },
  ])('does not offer endless retries for a persisted $code snapshot', async ({ code, sql }) => {
    rebuild({ ...finance, funds: async () => { throw new Error('controlled financial read interruption'); } });
    const { cid, id } = await submit(); await app.waitForPlanning();
    expect(calls.map(c => c.role)).toEqual(['semantic_intent']);
    await pool.query(`UPDATE bp_plan_commands SET ${sql} WHERE user_id=$1 AND command_id=$2`, [actor.userId, id]);
    rebuild(); await retry(cid, id); await app.waitForPlanning();
    const failed = await command(cid, id);
    expect(failed).toMatchObject({ status: 'failed', retryable: false, failure: { code, retryable: false } });
    expect(failed.result).toBeUndefined(); expect(failed.clarification).toBeUndefined();
    await retry(cid, id); await app.waitForPlanning(); expect(calls).toHaveLength(1);
    expect((await saved(id)).semantic_result).toBeTruthy(); await unchangedFundsAndNoExecution();
  }, 30000);

  it('concurrent explicit retries create one winning plan and one draft', async () => {
    respond = async () => new Response('controlled failure', { status: 502 });
    const { cid, id } = await submit(); await app.waitForPlanning();
    respond = async task => successfulResponse(task);
    await Promise.all([retry(cid, id), retry(cid, id), retry(cid, id)]); await app.waitForPlanning();
    const completed = await command(cid, id);
    expect(completed.status).toBe('complete'); expect(completed.result?.actions).toHaveLength(1);
    expect(calls.map(c => c.role)).toEqual(['semantic_intent', 'semantic_intent', 'semantic_intent', 'transfer', 'reviewer']);
    const messages = (await history(cid)).messages;
    expect(messages.filter(m => m.kind === 'result')).toHaveLength(1);
    expect((await core.dashboard(actor)).actions).toHaveLength(1); await unchangedFundsAndNoExecution();
  }, 30000);

  it('fences an in-flight superseded response while retaining its unknown reservation and original catalog', async () => {
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const released = new Promise<void>(resolve => { release = resolve; });
    respond = async (task, index) => { if (index === 0) { enter(); await released; } return successfulResponse(task); };
    const { cid, id } = await submit();
    try {
      await entered;
      const before = await saved(id);
      expect(before.model_output_reserved).toBe(4096);
      expect(before.model_attempts).toHaveLength(1); expect(before.model_attempts[0].outcome).toBe('unknown');
      await pool.query(`UPDATE "${schema}".payees SET name='接管期间新名称' WHERE id='payee-lin'`);
      await pool.query("UPDATE bp_plan_commands SET updated_at=now()-interval '5 minutes' WHERE user_id=$1 AND command_id=$2", [actor.userId, id]);
      await retry(cid, id);
      await vi.waitFor(async () => { expect((await command(cid, id)).status).toBe('complete'); }, { timeout: 10000 });
      const winning = await saved(id);
      expect(winning.lease_token).not.toBe(before.lease_token);
      expect(winning.result.actions).toHaveLength(1);
      expect(calls.filter(c => c.role === 'semantic_intent')).toHaveLength(2);
      expect(calls[1]?.task).toEqual(calls[0]?.task);
      release(); await app.waitForPlanning();
      const after = await saved(id);
      expect(after.lease_token).toBe(winning.lease_token);
      expect(after.result).toEqual(winning.result);
      expect(after.model_attempts.filter((a: any) => a.outcome === 'unknown')).toHaveLength(1);
      expect(after.model_output_reserved).toBe(calls.reduce((sum, call) => sum + call.cap, 0));
      expect(after.model_output_reserved).toBeLessThanOrEqual(32768);
      expect((await history(cid)).messages.filter(m => m.kind === 'failure')).toEqual([]);
      expect((await core.dashboard(actor)).actions).toHaveLength(1); await unchangedFundsAndNoExecution();
    } finally { release(); }
  }, 30000);
});
