import { billDomainResponse } from './fixtures/bill-domain-response.js';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, migrateApi } from '../apps/api/src/app.js';
import { createCore, createFinance } from '../packages/core/src/index.js';
import { createPlanner } from '../packages/agents/src/index.js';
import { reviewResponse } from './fixtures/review-response.js';
import type { FinanceService } from '../packages/contracts/src/index.js';
import type { ConversationCommand, ConversationHistory } from '../packages/contracts/src/conversations.js';

const connectionString = process.env.TEST_DATABASE_URL ?? 'postgres://bankpilot:bankpilot-local@127.0.0.1:55432/bankpilot';
const schema = `g8f_api_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
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
const billClause = '查询2026年10月账单';
const combined = `${billClause}；${text}`;
const jsonResponse = (value: unknown) => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value) } }] }), { status: 200 });
function successfulResponse(task: any): Response {
  if (task.role === 'semantic_intent') return jsonResponse({ tasks: [
    ...(task.message === combined ? [{ operation: 'bills_query', disposition: 'query', scope: { text: billClause }, period: { text: '2026年10月' } }] : []),
    { operation: 'transfer', disposition: 'request', scope: task.message === combined ? { text } : { source: 'whole_message' }, entity: { kind: 'payee', id: 'payee-lin', mention: { text: '林晓' } }, amount: { text: '317.25元' }, memo: { text: '恢复核对' } },
  ] });
  if (task.role === 'bills') return jsonResponse(billDomainResponse(task));
  if (task.role === 'transfer') return jsonResponse({ role: 'transfer', planVersion: 1, summary: '待本人确认', suggestion: task.data.resolved.suggestion, findings: [], evidence: [] });
  if (task.role === 'reviewer') return jsonResponse(reviewResponse(task, { summary: '仅同意生成待确认草稿' }));
  throw new Error(`Unexpected model role ${task.role}`);
}
function rebuild(customFinance = finance, customCore = core) {
  const auth = { api: { getSession: async ({ headers }: { headers: Headers }) => headers.get('cookie') === `g8f-owner=${actor.userId}` ? { user: { id: actor.userId, email: 'g8f@example.test' } } : null } };
  const planner = createPlanner({ provider: { baseURL: 'https://model.invalid', model: 'g8f-controlled', outputMode: 'json_object', maxAttempts: 2, retryDelayMs: 1 } });
  app = createApp({ pool, core: customCore, finance: customFinance, planner, auth: auth as never, origin, rpID: 'localhost', sandbox: false, plannerMode: 'model' });
}
async function request(path: string, body?: unknown) {
  return app.request(`${origin}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { Cookie: `g8f-owner=${actor.userId}`, Origin: origin, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
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

describe('G8F independent API/PG recovery across domain and review failures', () => {
  beforeAll(async () => {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await migrateApi(pool);
    core = createCore(pool, { schema }); await core.migrate();
    finance = createFinance(pool, { schema });
  }, 30000);
  beforeEach(async () => {
    actor = { userId: `g8f-${randomUUID()}` };
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

  it('recovers transfer service failure under the same command without rerunning interpretation', async () => {
    let broken = true;
    respond = async task => broken && task.role === 'transfer' ? new Response('', { status: 502 }) : successfulResponse(task);
    const { cid, id, accepted } = await submit(); await app.waitForPlanning();
    const failed = await command(cid, id);
    expect(failed).toMatchObject({ status: 'failed', retryable: true, failure: { phase: 'planning', code: 'MODEL_HTTP_502', retryable: true } });
    expect(failed.result).toBeUndefined(); expect(failed.clarification).toBeUndefined();
    expect(calls.map(call => call.role)).toEqual(['semantic_intent', 'transfer', 'transfer']);
    expect((await saved(id)).proposal).toBeNull(); expect((await core.dashboard(actor)).actions).toEqual([]);
    broken = false; rebuild();
    expect((await retry(cid, id)).status).toBe(202); await app.waitForPlanning();
    const completed = await command(cid, id);
    expect(completed).toMatchObject({ commandId: id, rootCommandId: accepted.command.rootCommandId, revision: 0, status: 'complete' });
    expect(calls.map(call => call.role)).toEqual(['semantic_intent', 'transfer', 'transfer', 'transfer', 'reviewer']);
    expect(completed.result?.actions).toHaveLength(1);
    expect(completed.result?.actions?.[0]).toMatchObject({ amountMinor: '31725', memo: '恢复核对', status: 'AWAITING_CONFIRMATION' });
    expect(completed.modelAttempts).toHaveLength(5);
    expect(completed.result?.modelRuns?.filter(run => run.role === 'transfer').map(run => run.status)).toEqual(['failed', 'failed', 'success']);
    const restored = await history(cid);
    expect(restored.messages.filter(message => message.role === 'user')).toHaveLength(1);
    expect(restored.messages.filter(message => message.kind === 'failure')).toHaveLength(1);
    expect(restored.messages.filter(message => message.kind === 'result')).toHaveLength(1);
    await retry(cid, id); await app.waitForPlanning(); expect(calls).toHaveLength(5);
    expect(calls.reduce((sum, call) => sum + call.cap, 0)).toBeLessThanOrEqual(32768);
    expect((await core.dashboard(actor)).actions).toHaveLength(1); await unchangedFundsAndNoExecution();
  });

  it('retries only the reviewer after its outage, including after rebuilding the application', async () => {
    let broken = true;
    respond = async task => broken && task.role === 'reviewer' ? new Response('', { status: 502 }) : successfulResponse(task);
    const { cid, id } = await submit(); await app.waitForPlanning();
    const failed = await command(cid, id);
    expect(failed).toMatchObject({ status: 'failed', retryable: true, failure: { phase: 'planning', code: 'MODEL_HTTP_502' } });
    expect(calls.map(call => call.role)).toEqual(['semantic_intent', 'transfer', 'reviewer', 'reviewer']);
    expect((await saved(id)).proposal).toBeNull(); expect((await core.dashboard(actor)).actions).toEqual([]);
    broken = false; rebuild(); await retry(cid, id); await app.waitForPlanning();
    const completed = await command(cid, id);
    expect(completed.status).toBe('complete'); expect(completed.result?.actions).toHaveLength(1);
    expect(calls.map(call => call.role)).toEqual(['semantic_intent', 'transfer', 'reviewer', 'reviewer', 'reviewer']);
    expect(completed.modelAttempts).toHaveLength(5);
    expect(completed.result?.modelRuns?.filter(run => run.role === 'reviewer').map(run => run.status)).toEqual(['failed', 'failed', 'success']);
    expect(calls.reduce((sum, call) => sum + call.cap, 0)).toBeLessThanOrEqual(32768); await unchangedFundsAndNoExecution();
  });

  it('retains a slower successful sibling when another parallel domain has already failed', async () => {
    let release!: () => void, entered!: () => void, broken = true;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    respond = async task => {
      if (task.role === 'transfer' && broken) { entered(); await pending; }
      return task.role === 'bills' && broken ? new Response('', { status: 502 }) : successfulResponse(task);
    };
    const { cid, id } = await submit(combined);
    try {
      await started;
      await vi.waitFor(() => { expect(calls.filter(call => call.role === 'bills')).toHaveLength(2); });
      await vi.waitFor(async () => { expect((await saved(id)).stage_history.some((event: any) => event.key === 'domain:bills' && event.failure)).toBe(true); });
      expect((await command(cid, id)).status).toBe('running');
      expect(calls.some(call => call.role === 'reviewer')).toBe(false);
      release(); await app.waitForPlanning();
      const failed = await command(cid, id);
      expect(failed.status).toBe('failed');
      expect(failed.failure?.modelRuns?.map(run => run.role).sort()).toEqual(['bills', 'bills', 'semantic_intent', 'transfer']);
      expect((await core.dashboard(actor)).actions).toEqual([]);
      broken = false; rebuild(); await retry(cid, id); await app.waitForPlanning();
      const completed = await command(cid, id);
      expect(completed.status).toBe('complete'); expect(completed.result?.actions).toHaveLength(1);
      expect(calls.filter(call => call.role === 'semantic_intent')).toHaveLength(1);
      expect(calls.filter(call => call.role === 'transfer')).toHaveLength(1);
      expect(calls.filter(call => call.role === 'bills')).toHaveLength(3);
      expect(calls.filter(call => call.role === 'reviewer')).toHaveLength(1);
      expect(completed.result?.billReport).toBeTruthy();
      expect(calls.reduce((sum, call) => sum + call.cap, 0)).toBeLessThanOrEqual(32768); await unchangedFundsAndNoExecution();
    } finally { release(); }
  });

  it.each(['transfer', 'reviewer'])('does not turn %s malformed output into missing user information or an endlessly retryable request', async role => {
    respond = async task => task.role === role ? jsonResponse({}) : successfulResponse(task);
    const { cid, id } = await submit(); await app.waitForPlanning();
    const failed = await command(cid, id);
    expect(failed).toMatchObject({ status: 'failed', retryable: false, failure: { phase: 'planning', code: 'MODEL_SCHEMA_INVALID', retryable: false } });
    expect(failed.result).toBeUndefined(); expect(failed.clarification).toBeUndefined();
    expect((await saved(id)).proposal).toBeNull(); expect((await saved(id)).result).toBeNull();
    expect((await history(cid)).clarifications).toEqual([]);
    const before = calls.length; rebuild(); await retry(cid, id); await app.waitForPlanning(); expect(calls).toHaveLength(before);
    expect((await core.dashboard(actor)).actions).toEqual([]); await unchangedFundsAndNoExecution();
  });

  it('preserves a legitimate reviewer rejection as a completed business result with no action', async () => {
    respond = async task => task.role === 'reviewer' ? jsonResponse({ approved: false, findings: ['需要人工核对的业务依据'], summary: '业务复核未通过' }) : successfulResponse(task);
    const { cid, id } = await submit(); await app.waitForPlanning();
    const completed = await command(cid, id);
    expect(completed).toMatchObject({ status: 'complete', retryable: false }); expect(completed.failure).toBeUndefined();
    expect(completed.result?.actions).toEqual([]); expect(completed.result?.findings).toContain('需要人工核对的业务依据');
    expect(completed.result?.diagnostics?.review?.effectiveApproved).toBe(false);
    const before = calls.length; await retry(cid, id); await app.waitForPlanning(); expect(calls).toHaveLength(before);
    expect((await history(cid)).messages.filter(message => message.kind === 'failure')).toEqual([]);
    await unchangedFundsAndNoExecution();
  });

  it('serializes concurrent review retries into one recovery and one draft', async () => {
    let broken = true;
    respond = async task => task.role === 'reviewer' && broken ? new Response('', { status: 502 }) : successfulResponse(task);
    const { cid, id } = await submit(); await app.waitForPlanning();
    expect((await command(cid, id)).retryable).toBe(true);
    broken = false;
    await Promise.all([retry(cid, id), retry(cid, id), retry(cid, id)]); await app.waitForPlanning();
    expect((await command(cid, id)).status).toBe('complete');
    expect(calls.filter(call => call.role === 'reviewer')).toHaveLength(3);
    expect(calls.filter(call => call.role === 'transfer')).toHaveLength(1);
    expect((await core.dashboard(actor)).actions).toHaveLength(1);
    expect((await history(cid)).messages.filter(message => message.kind === 'result')).toHaveLength(1);
    await unchangedFundsAndNoExecution();
  });

  it('does not hide a permanent domain error behind a concurrent temporary failure', async () => {
    respond = async task => task.role === 'transfer' ? jsonResponse({}) : task.role === 'bills' ? new Response('', { status: 502 }) : successfulResponse(task);
    const { cid, id } = await submit(combined); await app.waitForPlanning();
    const failed = await command(cid, id);
    expect(failed).toMatchObject({ status: 'failed', retryable: false, failure: { phase: 'planning', code: 'MODEL_SCHEMA_INVALID', stage: 'domain:transfer', retryable: false } });
    expect(failed.result).toBeUndefined(); expect(failed.clarification).toBeUndefined();
    expect(calls.filter(call => call.role === 'transfer')).toHaveLength(2);
    expect(calls.filter(call => call.role === 'bills')).toHaveLength(2);
    expect(calls.some(call => call.role === 'reviewer')).toBe(false);
    const recorded = await saved(id);
    expect(recorded.stage_results).toEqual({});
    expect(recorded.stage_history).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'domain:transfer', failure: expect.objectContaining({ code: 'MODEL_SCHEMA_INVALID', retryable: false }) }),
      expect.objectContaining({ key: 'domain:bills', failure: expect.objectContaining({ code: 'MODEL_HTTP_502', retryable: true }) }),
    ]));
    expect(failed.failure?.modelRuns?.map(run => run.role).sort()).toEqual(['bills', 'bills', 'semantic_intent', 'transfer', 'transfer']);
    const before = calls.length; await retry(cid, id); await app.waitForPlanning(); expect(calls).toHaveLength(before);
    expect((await core.dashboard(actor)).actions).toEqual([]); await unchangedFundsAndNoExecution();
  });

  it('keeps completed domains during reviewer lease takeover and rejects the old reviewer response', async () => {
    let release!: () => void, enter!: () => void, reviewerCalls = 0;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { enter = resolve; });
    respond = async task => {
      if (task.role === 'reviewer' && reviewerCalls++ === 0) {
        enter(); await pending;
        return jsonResponse({ approved: false, findings: ['过期运行结果不能覆盖新结果'], summary: '旧运行的否决' });
      }
      return successfulResponse(task);
    };
    const { cid, id } = await submit();
    try {
      await started;
      const before = await saved(id);
      expect(before.model_attempts.filter((attempt: any) => attempt.role === 'reviewer')).toMatchObject([{ outcome: 'unknown' }]);
      await pool.query("UPDATE bp_plan_commands SET updated_at=now()-interval '5 minutes' WHERE user_id=$1 AND command_id=$2", [actor.userId, id]);
      await retry(cid, id);
      await vi.waitFor(async () => { expect((await command(cid, id)).status).toBe('complete'); }, { timeout: 10000 });
      const winner = await saved(id);
      expect(winner.lease_token).not.toBe(before.lease_token); expect(winner.result.actions).toHaveLength(1);
      expect(calls.map(call => call.role)).toEqual(['semantic_intent', 'transfer', 'reviewer', 'reviewer']);
      release(); await app.waitForPlanning();
      const after = await saved(id);
      expect(after.result).toEqual(winner.result); expect(after.lease_token).toBe(winner.lease_token);
      expect(after.model_attempts.filter((attempt: any) => attempt.outcome === 'unknown')).toHaveLength(1);
      expect(after.model_output_reserved).toBe(calls.reduce((sum, call) => sum + call.cap, 0));
      expect(after.model_output_reserved).toBeLessThanOrEqual(32768);
      expect((await history(cid)).messages.filter(message => message.kind === 'failure')).toEqual([]);
      expect((await core.dashboard(actor)).actions).toHaveLength(1); await unchangedFundsAndNoExecution();
    } finally { release(); }
  });

  it('replays a saved proposal after interruption before the first action is created', async () => {
    let createCalls = 0;
    rebuild(finance, { ...core, createTransfer: async () => { createCalls++; throw new Error('controlled interruption before Core draft creation'); } });
    const { cid, id } = await submit(); await app.waitForPlanning();
    expect(createCalls).toBe(1);
    const before = await saved(id);
    expect(before.status).toBe('failed'); expect(before.proposal).toBeTruthy(); expect(before.result).toBeNull();
    expect((await core.dashboard(actor)).actions).toEqual([]);
    expect(calls.map(call => call.role)).toEqual(['semantic_intent', 'transfer', 'reviewer']);
    rebuild(); await retry(cid, id); await app.waitForPlanning();
    const completed = await command(cid, id);
    expect(completed.status).toBe('complete'); expect(completed.result?.actions).toHaveLength(1);
    expect((await saved(id)).proposal).toEqual(before.proposal);
    expect(calls).toHaveLength(3);
    await retry(cid, id); await app.waitForPlanning(); expect(calls).toHaveLength(3);
    expect((await core.dashboard(actor)).actions).toHaveLength(1); await unchangedFundsAndNoExecution();
  });

  it('does not reinterpret a legacy completed clarification containing provider failures', async () => {
    respond = async task => task.role === 'semantic_intent' ? jsonResponse({ tasks: [{ operation: 'transfer', disposition: 'ambiguous', scope: { source: 'whole_message' } }] }) : successfulResponse(task);
    const { cid, id, clientMessageId } = await submit(); await app.waitForPlanning();
    const before = await saved(id);
    expect(before.status).toBe('complete'); expect(before.result.clarification).toBeTruthy(); expect(before.result.actions).toEqual([]);
    const legacyResult = { ...before.result, modelRuns: [{ role: 'semantic_intent', model: 'legacy', status: 'failed', durationMs: 1, attempt: 1, errorCode: 'MODEL_HTTP_502', requestMaxOutputTokens: 4096 }] };
    await pool.query('UPDATE bp_plan_commands SET result=$3,proposal=$3,graph_version=$4 WHERE user_id=$1 AND command_id=$2', [actor.userId, id, JSON.stringify(legacyResult), 'bankpilot-planner-g8d-v1-lg1.5.2-cp1.2.1-pg1.1.2']);
    const historical = await saved(id), originalHistory = await history(cid), callCount = calls.length;
    respond = async task => successfulResponse(task); rebuild();
    await command(cid, id); await history(cid);
    const duplicate = await request(`/api/conversations/${cid}/messages`, { clientMessageId, text });
    expect((await duplicate.json()).replayed).toBe(true);
    const replay = await retry(cid, id); expect(replay.status).toBe(200); await app.waitForPlanning();
    const after = await saved(id), current = await command(cid, id);
    expect(current).toMatchObject({ status: 'complete', retryable: false }); expect(current.failure).toBeUndefined();
    expect(after.result).toEqual(legacyResult); expect(after.proposal).toEqual(legacyResult);
    expect(after.lease_token).toBe(historical.lease_token); expect(after.updated_at).toEqual(historical.updated_at);
    expect((await history(cid)).messages).toEqual(originalHistory.messages);
    expect(calls).toHaveLength(callCount); expect((await core.dashboard(actor)).actions).toEqual([]); await unchangedFundsAndNoExecution();
  });

  it.each(['amount', 'payee', 'memo', 'missing_suggestion'])('rejects a general-schema-valid candidate against the request-bound transfer schema: %s', async fault => {
    respond = async task => {
      if (task.role !== 'transfer') return successfulResponse(task);
      const suggestion = { ...task.data.resolved.suggestion };
      if (fault === 'amount') suggestion.amountMinor = '31726';
      if (fault === 'payee') suggestion.payeeId = 'payee-other';
      if (fault === 'memo') suggestion.memo = 'model changed the original memo';
      return jsonResponse({ role: 'transfer', planVersion: 1, summary: '结构有效但候选违背原请求', findings: [], evidence: [], ...(fault === 'missing_suggestion' ? {} : { suggestion }) });
    };
    const { cid, id } = await submit(); await app.waitForPlanning();
    // The real provider validates the narrower request-bound schema before the
    // domain adapter guard, so these contradictions consume bounded repair and
    // end as MODEL_SCHEMA_INVALID, not a completed business rejection.
    expect(await command(cid, id)).toMatchObject({ status: 'failed', retryable: false, failure: { phase: 'planning', stage: 'domain:transfer', code: 'MODEL_SCHEMA_INVALID', retryable: false } });
    const row = await saved(id);
    expect(row.proposal).toBeNull(); expect(row.result).toBeNull(); expect(row.stage_results).toEqual({});
    expect(row.stage_history).toMatchObject([{ key: 'domain:transfer', failure: { code: 'MODEL_SCHEMA_INVALID' }, modelRuns: [{ status: 'failed' }, { status: 'failed' }] }]);
    expect(calls.map(call => call.role)).toEqual(['semantic_intent', 'transfer', 'transfer']);
    const count = calls.length; await retry(cid, id); await app.waitForPlanning(); expect(calls).toHaveLength(count);
    expect((await history(cid)).clarifications).toEqual([]);
    expect((await core.dashboard(actor)).actions).toEqual([]); await unchangedFundsAndNoExecution();
  });

  it.each(['payload', 'version', 'removed_result', 'removed_history', 'removed_entire_state', 'cross_command'])('stops before HTTP when saved stage integrity fails: %s', async fault => {
    let broken = true;
    respond = async task => task.role === 'reviewer' && broken ? new Response('', { status: 502 }) : successfulResponse(task);
    const { cid, id } = await submit(); await app.waitForPlanning();
    const row = await saved(id);
    expect(row.status).toBe('failed'); expect(Object.keys(row.stage_results)).toEqual(['domain:transfer']);
    const results = structuredClone(row.stage_results), events = structuredClone(row.stage_history);
    if (fault === 'payload') results['domain:transfer'].value.proposals[0].suggestion.amountMinor = '1';
    if (fault === 'version') results['domain:transfer'].version = 999;
    if (fault === 'removed_result') delete results['domain:transfer'];
    if (fault === 'removed_history') events.splice(0, events.length);
    if (fault === 'removed_entire_state') { for (const key of Object.keys(results)) delete results[key]; events.splice(0, events.length); }
    if (fault === 'cross_command') {
      const other = await submit(); await app.waitForPlanning();
      const otherRow = await saved(other.id);
      expect(otherRow.graph_input_digest).not.toBe(row.graph_input_digest);
      results['domain:transfer'] = otherRow.stage_results['domain:transfer'];
    }
    await pool.query('UPDATE bp_plan_commands SET stage_results=$3,stage_history=$4 WHERE user_id=$1 AND command_id=$2', [actor.userId, id, JSON.stringify(results), JSON.stringify(events)]);
    const before = calls.length; broken = false; rebuild(); await retry(cid, id); await app.waitForPlanning();
    const failed = await command(cid, id);
    expect(failed).toMatchObject({ status: 'failed', retryable: false, failure: { phase: 'planning', retryable: false } });
    expect(failed.failure?.code).toMatch(/^STAGE_/); expect(calls).toHaveLength(before);
    expect((await saved(id)).proposal).toBeNull(); expect((await saved(id)).result).toBeNull();
    expect((await core.dashboard(actor)).actions).toEqual([]); await unchangedFundsAndNoExecution();
  });

  it('keeps genuine semantic clarification complete with no cached domains or infrastructure retry', async () => {
    respond = async task => task.role === 'semantic_intent' ? jsonResponse({ tasks: [{ operation: 'transfer', disposition: 'request', scope: { source: 'whole_message' }, entity: { kind: 'payee', id: 'payee-lin', mention: { text: '林晓' } } }] }) : successfulResponse(task);
    const { cid, id } = await submit('给林晓转账'); await app.waitForPlanning();
    const completed = await command(cid, id), row = await saved(id);
    expect(completed).toMatchObject({ status: 'complete', retryable: false }); expect(completed.failure).toBeUndefined();
    expect(completed.result?.clarification).toBeTruthy(); expect(completed.result?.actions).toEqual([]);
    expect(row.stage_results).toEqual({}); expect(row.stage_history).toEqual([]);
    expect(calls.map(call => call.role)).toEqual(['semantic_intent']);
    await retry(cid, id); await app.waitForPlanning(); expect(calls).toHaveLength(1);
    expect((await history(cid)).messages.some(message => message.kind === 'failure')).toBe(false);
    await unchangedFundsAndNoExecution();
  });

  it('persists an insufficient-funds business outcome and replays it without model recovery', async () => {
    await pool.query(`UPDATE "${schema}".accounts SET balance_minor=10000 WHERE id=$1`, [`acc-main-${actor.userId}`]);
    const { cid, id } = await submit(); await app.waitForPlanning();
    const completed = await command(cid, id), row = await saved(id);
    expect(completed).toMatchObject({ status: 'complete', retryable: false }); expect(completed.failure).toBeUndefined();
    expect(completed.result?.fundsPreview).toMatchObject({ allowed: false });
    expect(BigInt(completed.result!.fundsPreview!.shortfallMinor)).toBeGreaterThan(0n);
    expect(completed.result?.actions).toEqual([]); expect(completed.result?.findings?.join(' ')).toContain('FUNDS_NOT_ALLOWED');
    expect(Object.keys(row.stage_results).sort()).toEqual(['domain:transfer', 'reviewer']);
    expect(row.stage_history.every((event: any) => event.resultDigest && !event.failure)).toBe(true);
    const before = calls.length; await retry(cid, id); await app.waitForPlanning(); expect(calls).toHaveLength(before);
    expect((await history(cid)).messages.some(message => message.kind === 'failure')).toBe(false);
    expect((await core.dashboard(actor)).accounts[0]).toMatchObject({ balanceMinor: '10000', reservedMinor: '0' });
    expect((await core.dashboard(actor)).actions).toEqual([]);
    expect((await pool.query(`SELECT count(*)::int AS n FROM "${schema}".provider_transfers WHERE account_id=$1`, [`acc-main-${actor.userId}`])).rows[0].n).toBe(0);
  });
});

