import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, migrateApi } from '../apps/api/src/app';
import { createCore, createManagement } from '../packages/core/src/index';
import { createPlanner } from '../packages/agents/src/index';
import type { ManagementAction, Planner, SubscriptionSnapshot } from '../packages/contracts/src/index';

type SemanticCatalog = { kind: string; id: string; names: string[] }[];
const connectionString = process.env.TEST_DATABASE_URL ?? 'postgres://bankpilot:bankpilot-local@127.0.0.1:55432/bankpilot';
const schema = `g9c_mbatch_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
const admin = new Pool({ connectionString, max: 2 });
const pool = new Pool({ connectionString, options: `-c search_path=${schema}`, max: 8 });
const origin = 'http://localhost:5178';
const cancelClause = '取消蒲溪听书的商户订阅';
const blockClause = '对晴川健身只做银行扣款拦截，合约我自己处理';
const message = `${cancelClause}；${blockClause}`;
let actor = { userId: '' };
let core: ReturnType<typeof createCore>;
let management: ReturnType<typeof createManagement>;
let app: ReturnType<typeof createApp>;
let intent: ReturnType<typeof vi.fn<(input: unknown) => Promise<unknown>>>;

function build(planner: Planner) {
  // Same local authenticated-session seam as G8E API integration tests. All
  // subscription grants, preparation, authorization and state writes are real.
  const auth = { api: { getSession: async ({ headers }: { headers: Headers }) => headers.get('cookie') === `g9c-batch=${actor.userId}` ? { user: { id: actor.userId, email: 'g9c-batch@example.test' } } : null } };
  app = createApp({ pool, core, management, planner, auth: auth as never, origin, rpID: 'localhost', sandbox: false, plannerMode: 'scripted' });
}
function semanticPlanner() {
  intent = vi.fn(async (input: unknown) => {
    const catalog = (input as { catalog: SemanticCatalog }).catalog;
    const target = (name: string) => {
      const rows = catalog.filter(item => item.kind === 'subscription' && item.names.includes(name));
      expect(rows).toHaveLength(1);
      return { kind: 'subscription', id: rows[0]!.id, mention: { text: name } };
    };
    return { tasks: [
      { operation: 'subscription_cancel', disposition: 'request', scope: { text: cancelClause }, entity: target('蒲溪听书') },
      { operation: 'subscription_block', disposition: 'request', scope: { text: blockClause }, entity: target('晴川健身') },
    ] };
  });
  return createPlanner({ provider: false, semantic: true, intentAdapter: intent });
}
async function request(path: string, body?: unknown) {
  return app.request(`${origin}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { Cookie: `g9c-batch=${actor.userId}`, Origin: origin, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function json<T>(path: string, body?: unknown): Promise<T> {
  const response = await request(path, body);
  expect(response.status).toBe(200);
  return response.json();
}
async function actualGrant(): Promise<SubscriptionSnapshot> {
  const action = await json<ManagementAction>('/api/management/actions', { commandId: randomUUID(), spec: { kind: 'SUBSCRIPTION_QUERY' } });
  expect(action).toMatchObject({ tier: 'YELLOW', status: 'AWAITING_CONFIRMATION' });
  const completed = await json<ManagementAction>(`/api/management/actions/${action.id}/confirm`, { actionHash: action.actionHash });
  expect(completed.status).toBe('SUCCEEDED');
  const snapshot = await json<SubscriptionSnapshot>(`/api/subscriptions?queryActionId=${action.id}`);
  expect(snapshot.queryActionId).toBe(action.id);
  expect(snapshot).toEqual(completed.receipt?.subscriptions);
  return snapshot;
}
async function subscriptionRows() {
  return (await pool.query('SELECT id,merchant,merchant_status,bank_status,version FROM management_subscriptions WHERE user_id=$1 ORDER BY id', [actor.userId])).rows;
}
async function counts() {
  return (await pool.query(`SELECT (SELECT count(*)::int FROM management_actions WHERE user_id=$1) AS actions,
    (SELECT count(*)::int FROM management_authorization_proofs WHERE user_id=$1) AS proofs,
    (SELECT count(*)::int FROM management_query_grants WHERE user_id=$1) AS grants,
    (SELECT count(*)::int FROM audit_events WHERE user_id=$1) AS audit`, [actor.userId])).rows[0];
}
async function saved(commandId: string) {
  return (await pool.query('SELECT status,prepared_input,proposal,result FROM bp_plan_commands WHERE user_id=$1 AND command_id=$2', [actor.userId, commandId])).rows[0];
}

describe('G9C real API/PG subscription batch preparation with independent confirmation', () => {
  beforeAll(async () => {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await migrateApi(pool);
    core = createCore(pool, { schema }); await core.migrate();
    management = createManagement(pool, { schema }); await management.migrate();
  }, 30000);
  beforeEach(async () => {
    actor = { userId: `g9c-batch-${randomUUID()}` };
    await core.seedDemo(actor); await management.seedDemo(actor);
    await pool.query(`UPDATE management_subscriptions SET merchant=CASE WHEN cancellation_supported THEN '蒲溪听书' ELSE '晴川健身' END WHERE user_id=$1`, [actor.userId]);
    vi.stubGlobal('fetch', vi.fn(() => { throw new Error('G9C_BATCH_CLOUD_FORBIDDEN'); }));
    build(semanticPlanner());
  });
  afterEach(async () => { await app?.waitForPlanning(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  afterAll(async () => { await pool.end(); await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await admin.end(); });

  it('persists both actual planner proposals, confirms their different scopes separately and replays the original command without duplication', async () => {
    const originalRows = await subscriptionRows();
    const snapshot = await actualGrant();
    const music = snapshot.items.find(item => item.merchant === '蒲溪听书')!;
    const club = snapshot.items.find(item => item.merchant === '晴川健身')!;
    expect(music.cancellationSupported).toBe(true); expect(club.cancellationSupported).toBe(false);
    const body = { commandId: randomUUID(), message };
    const plan = await json<any>('/api/plan', body);
    const specs = [
      { kind: 'SUBSCRIPTION_CANCEL', subscriptionId: music.id, expectedVersion: music.version, queryActionId: snapshot.queryActionId },
      { kind: 'SUBSCRIPTION_BLOCK', subscriptionId: club.id, expectedVersion: club.version, queryActionId: snapshot.queryActionId },
    ];
    expect(plan.managementSuggestions).toEqual(specs);
    expect(plan.managementActions).toHaveLength(2);
    expect(plan.managementActions.map((action: ManagementAction) => action.spec)).toEqual(specs);
    const [cancel, block] = plan.managementActions as ManagementAction[];
    expect(cancel!.id).not.toBe(block!.id); expect(cancel!.actionHash).not.toBe(block!.actionHash);
    expect(plan.actions).toEqual([]); expect(plan.investmentSuggestions).toEqual([]);
    for (const action of [cancel!, block!]) expect(action).toMatchObject({ status: 'AWAITING_CONFIRMATION', tier: 'YELLOW', actionVersion: 1 });
    expect(await subscriptionRows()).toEqual(originalRows);
    expect(await counts()).toMatchObject({ actions: 3, proofs: 1, grants: 1 });
    const frozen = await saved(body.commandId);
    expect(frozen.status).toBe('complete');
    expect(frozen.prepared_input.managementContext.subscriptions.queryActionId).toBe(snapshot.queryActionId);
    expect(frozen.prepared_input.semanticIntent.tasks.map((task: any) => ({ operation: task.operation, source: task.source.text, entityId: task.slots.entityId }))).toEqual([
      { operation: 'subscription_cancel', source: cancelClause, entityId: music.id },
      { operation: 'subscription_block', source: blockClause, entityId: club.id },
    ]);
    expect(frozen.proposal.managementSuggestions).toEqual(specs);
    const persisted = (await pool.query('SELECT id,command_id,spec,status FROM management_actions WHERE user_id=$1 AND id=ANY($2) ORDER BY created_at,id', [actor.userId, [cancel!.id, block!.id]])).rows;
    expect(persisted).toHaveLength(2);
    expect(new Set(persisted.map(row => row.command_id)).size).toBe(2);
    expect(persisted.every(row => row.status === 'AWAITING_CONFIRMATION')).toBe(true);
    expect(persisted.map(row => row.spec)).toEqual(expect.arrayContaining(specs));
    const beforeReplay = await counts();
    const firstReplay = await json<any>('/api/plan', body);
    expect(firstReplay.managementActions.map((action: ManagementAction) => action.id)).toEqual([cancel!.id, block!.id]);
    expect(await counts()).toEqual(beforeReplay); expect(intent).toHaveBeenCalledTimes(1);

    const cancelled = await json<ManagementAction>(`/api/management/actions/${cancel!.id}/confirm`, { actionHash: cancel!.actionHash });
    expect(cancelled).toMatchObject({ status: 'SUCCEEDED', receipt: { balanceDeltaMinor: '0', subscription: { id: music.id, merchantStatus: 'CANCELLED', bankStatus: 'ALLOWED', collectionStatus: 'MERCHANT_CANCELLED', version: music.version + 1 } } });
    const afterCancel = await subscriptionRows();
    expect(afterCancel.find(row => row.id === club.id)).toEqual(originalRows.find(row => row.id === club.id));
    expect(afterCancel.find(row => row.id === music.id)).toEqual({ ...originalRows.find(row => row.id === music.id), merchant_status: 'CANCELLED', version: music.version + 1 });
    expect(await management.getAction(actor, block!.id)).toMatchObject({ status: 'AWAITING_CONFIRMATION' });
    const beforeConfirmReplay = await counts();
    const cancelledReplay = await json<ManagementAction>(`/api/management/actions/${cancel!.id}/confirm`, { actionHash: cancel!.actionHash });
    expect(cancelledReplay.receipt).toEqual(cancelled.receipt);
    expect(await counts()).toEqual(beforeConfirmReplay); expect(await subscriptionRows()).toEqual(afterCancel);

    const blocked = await json<ManagementAction>(`/api/management/actions/${block!.id}/confirm`, { actionHash: block!.actionHash });
    expect(blocked).toMatchObject({ status: 'SUCCEEDED', receipt: { balanceDeltaMinor: '0', subscription: { id: club.id, merchantStatus: 'ACTIVE', bankStatus: 'BLOCKED', collectionStatus: 'BLOCKED_BY_BANK', version: club.version + 1 } } });
    const afterBlock = await subscriptionRows();
    expect(afterBlock.find(row => row.id === music.id)).toEqual(afterCancel.find(row => row.id === music.id));
    expect(afterBlock.find(row => row.id === club.id)).toEqual({ ...originalRows.find(row => row.id === club.id), bank_status: 'BLOCKED', version: club.version + 1 });
    const finishedCounts = await counts();
    expect(finishedCounts).toMatchObject({ actions: 3, proofs: 3, grants: 1 });
    const finalReplay = await json<any>('/api/plan', body);
    expect(finalReplay.managementActions.map((action: ManagementAction) => ({ id: action.id, status: action.status, spec: action.spec }))).toEqual([
      { id: cancel!.id, status: 'SUCCEEDED', spec: specs[0] }, { id: block!.id, status: 'SUCCEEDED', spec: specs[1] },
    ]);
    expect(await counts()).toEqual(finishedCounts); expect(await subscriptionRows()).toEqual(afterBlock);
    expect(intent).toHaveBeenCalledTimes(1); expect(fetch).not.toHaveBeenCalled();
    expect((await core.dashboard(actor)).accounts[0]).toMatchObject({ balanceMinor: '800000', reservedMinor: '0' });
  });

  it('without a query grant a semantic adapter cannot invent private catalog entities to prepare the two writes', async () => {
    const before = await subscriptionRows();
    const raw = { tasks: [
      { operation: 'subscription_cancel', disposition: 'request', scope: { text: cancelClause }, entity: { kind: 'subscription', id: before.find(row => row.merchant === '蒲溪听书')!.id, mention: { text: '蒲溪听书' } } },
      { operation: 'subscription_block', disposition: 'request', scope: { text: blockClause }, entity: { kind: 'subscription', id: before.find(row => row.merchant === '晴川健身')!.id, mention: { text: '晴川健身' } } },
    ] };
    const adapter = vi.fn(async (input: unknown) => {
      expect((input as { catalog: SemanticCatalog }).catalog.filter(item => item.kind === 'subscription')).toEqual([]);
      return raw;
    });
    build(createPlanner({ provider: false, semantic: true, intentAdapter: adapter }));
    const plan = await json<any>('/api/plan', { commandId: randomUUID(), message });
    expect(plan.clarification).toBeTruthy();
    expect(plan.managementSuggestions).toEqual([]); expect(plan.managementActions ?? []).toEqual([]);
    expect(await counts()).toMatchObject({ actions: 0, proofs: 0, grants: 0 });
    expect(await subscriptionRows()).toEqual(before); expect(fetch).not.toHaveBeenCalled();
  });
});
