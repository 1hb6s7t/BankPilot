import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../apps/api/src/app.js';
import { createPlanner } from '../packages/agents/src/index.js';
import { createCore, createFinance, createManagement } from '../packages/core/src/index.js';
import { createGoals } from '../packages/core/src/goals.js';
import { createInvestment } from '../packages/core/src/investment.js';
import type { CreateGoalInput, ManagementAction } from '../packages/contracts/src/index.js';

const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL ?? 'postgres://bankpilot:bankpilot-local@127.0.0.1:55432/bankpilot', max: 12 });
const actor = { userId: 'receipt-owner' }, other = { userId: 'receipt-other' };
const origin = 'http://localhost:5178';
let schema: string, now: Date;
let core: ReturnType<typeof createCore>, management: ReturnType<typeof createManagement>, investment: ReturnType<typeof createInvestment>, goals: ReturnType<typeof createGoals>;
let app: ReturnType<typeof createApp>;
const goalInput = (extra: Partial<CreateGoalInput> = {}): CreateGoalInput => ({ commandId: randomUUID(), title: '恢复目标原单', accountId: `acc-main-${actor.userId}`, payeeId: 'payee-lin', amountMinor: '600000', targetDate: '2026-10-30', funding: { positionId: `position:${actor.userId}:synthetic-t0`, redemptionAmountMinor: '300000' }, ...extra });
const request = (path: string, userId: string | undefined = actor.userId) => app.request(`${origin}${path}`, { headers: userId ? { Cookie: `owner=${userId}` } : {} });
const approve = (action: ManagementAction) => management.authorize(actor, action.id, { level: 'CONFIRMATION', proofId: randomUUID(), actionHash: action.actionHash });

// Snapshot full table contents, including reservations, proofs, journals, intent
// rows and audits. A count-only assertion would miss an expiry/release UPDATE.
async function snapshot() {
  const tables = (await pool.query('SELECT table_name FROM information_schema.tables WHERE table_schema=$1 ORDER BY table_name', [schema])).rows;
  const contents: Record<string, unknown> = {};
  for (const { table_name: table } of tables) {
    contents[table] = (await pool.query(`SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text),'[]'::jsonb) AS rows FROM "${schema}"."${table}" r`)).rows[0].rows;
  }
  return contents;
}

beforeEach(async () => {
  schema = `g8lreceipt_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  now = new Date('2026-10-22T08:00:00Z');
  core = createCore(pool, { schema, clock: () => now });
  management = createManagement(pool, { schema, clock: () => now });
  investment = createInvestment(pool, { schema, clock: () => now });
  const finance = createFinance(pool, { schema, clock: () => now });
  goals = createGoals(pool, core, investment, finance, { schema, clock: () => now });
  await core.migrate(); await management.migrate(); await investment.migrate(); await goals.migrate();
  for (const owner of [actor, other]) {
    await core.seedDemo(owner); await management.seedDemo(owner); await investment.seedDemo(owner); await finance.seedDemo(owner);
  }
  const auth = { api: { getSession: async ({ headers }: { headers: Headers }) => {
    const userId = headers.get('cookie')?.match(/^owner=(receipt-owner|receipt-other)$/)?.[1];
    return userId ? { user: { id: userId, email: `${userId}@example.test` } } : null;
  } } };
  app = createApp({ pool, auth: auth as never, core, management, investment, goals, finance, planner: createPlanner({ provider: false }), origin, rpID: 'localhost', sandbox: false, plannerMode: 'scripted' });
});
afterEach(async () => { await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); });
afterAll(async () => { await pool.end(); });

describe('G8L owner-scoped command receipts and read-only recovery GETs', () => {
  it('uses each owner command namespace and returns indistinguishable 404s for absent and foreign results', async () => {
    const commandId = randomUUID();
    const first = await management.prepare(actor, { commandId, spec: { kind: 'SUBSCRIPTION_QUERY' } });
    const foreignPaths = [`/api/management/commands/${commandId}`, `/api/management/actions/${first.id}`];
    const redemption = await investment.prepare(actor, { commandId, positionId: `position:${actor.userId}:synthetic-t0`, amountMinor: '10000', expectedVersion: 1 });
    foreignPaths.push(`/api/investments/commands/${commandId}`, `/api/investments/actions/${redemption.id}`);
    const input = goalInput(); const goal = await goals.create(actor, input);
    foreignPaths.push(`/api/goal-commands/${input.commandId}`, `/api/goals/${goal.id}`);
    const transfer = await core.createTransfer(actor, { commandId: randomUUID(), accountId: `acc-main-${actor.userId}`, payeeId: 'payee-lin', amountMinor: '10000', memo: '读原单' });
    foreignPaths.push(`/api/actions/${transfer.id}`);
    const before = await snapshot();
    for (const path of foreignPaths) {
      const denied = await request(path, other.userId), missing = await request(path.replace(/[^/]+$/, 'missing-command'));
      expect(denied.status).toBe(404); expect(missing.status).toBe(404);
      const missingCode = path.includes('/commands/') || path.startsWith('/api/goal-commands/') ? 'COMMAND_NOT_FOUND' : 'NOT_FOUND';
      expect((await denied.json()).error.code).toBe(missingCode);
      expect((await missing.json()).error.code).toBe(missingCode);
      expect((await request(path, '')).status).toBe(401);
    }
    expect(await snapshot()).toEqual(before);
    const second = await management.prepare(other, { commandId, spec: { kind: 'SUBSCRIPTION_QUERY' } });
    expect((await management.getByCommand(actor, commandId)).id).toBe(first.id);
    expect((await management.getByCommand(other, commandId)).id).toBe(second.id);
  });

  it('applies ordinary management read redaction without renewing query grants or exposing expired mutation details', async () => {
    const queryCommand = randomUUID();
    const query = await management.prepare(actor, { commandId: queryCommand, spec: { kind: 'SUBSCRIPTION_QUERY' } });
    const completed = await approve(query), subscriptions = completed.receipt!.subscriptions!;
    const subscription = subscriptions.items.find(item => item.cancellationSupported)!;
    const mutationCommand = randomUUID();
    const mutationInput = { commandId: mutationCommand, spec: { kind: 'SUBSCRIPTION_CANCEL' as const, subscriptionId: subscription.id, expectedVersion: subscription.version, queryActionId: query.id } };
    const mutation = await management.prepare(actor, mutationInput);
    const succeeded = await approve(mutation);
    const club = subscriptions.items.find(item => !item.cancellationSupported)!;
    const block = await management.prepare(actor, { commandId: randomUUID(), spec: { kind: 'SUBSCRIPTION_BLOCK', subscriptionId: club.id, expectedVersion: club.version, queryActionId: query.id } });
    const cancelled = await management.cancel(actor, block.id);
    for (const view of [mutation, succeeded, block, cancelled, await management.prepare(actor, mutationInput), ...(await management.dashboard(actor)).actions.filter(action => [mutation.id, block.id].includes(action.id))]) {
      expect(view.detailsRedacted).toBe(false);
      expect(view.detailsAccessExpiresAt).toBe(subscriptions.accessExpiresAt);
    }
    const before = await snapshot();
    for (const path of [`/api/management/commands/${queryCommand}`, `/api/management/actions/${query.id}`]) {
      const response = await request(path); expect(response.status).toBe(200);
      const value = await response.json();
      expect(value.receipt.subscriptions).toBeUndefined(); expect(JSON.stringify(value)).not.toContain(subscription.merchant);
    }
    expect(await management.getByCommand(actor, mutationCommand)).toEqual(await management.getAction(actor, mutation.id));
    const accessible = await management.getByCommand(actor, mutationCommand);
    expect(accessible.receipt?.subscription?.merchant).toBe(subscription.merchant);
    expect(accessible).toMatchObject({ detailsRedacted: false, detailsAccessExpiresAt: subscriptions.accessExpiresAt });
    expect(await snapshot()).toEqual(before);
    now = new Date(subscriptions.accessExpiresAt);
    const expiredBefore = await snapshot();
    const lookup = await management.getByCommand(actor, mutationCommand);
    expect(lookup).toEqual(await management.getAction(actor, mutation.id));
    expect(lookup.updatedAt).toBe(accessible.updatedAt);
    expect(lookup.detailsRedacted).toBe(true); expect(lookup.detailsAccessExpiresAt).toBeUndefined();
    expect(lookup.receipt?.subscription).toBeUndefined(); expect(lookup.details.join()).not.toContain(subscription.merchant);
    for (const view of [await management.prepare(actor, mutationInput), await approve(mutation), ...(await management.dashboard(actor)).actions.filter(action => [mutation.id, block.id].includes(action.id))]) {
      expect(view.detailsRedacted).toBe(true); expect(view.detailsAccessExpiresAt).toBeUndefined();
      expect(view.receipt?.subscription).toBeUndefined();
    }
    await expect(management.subscriptions(actor, query.id)).rejects.toMatchObject({ code: 'QUERY_ACCESS_EXPIRED' });
    expect(await snapshot()).toEqual(expiredBefore);
  });

  it('reads expired authorized actions without releasing reservations, expiring rows, or queuing execution', async () => {
    const commandId = randomUUID();
    const redemption = await investment.prepare(actor, { commandId, positionId: `position:${actor.userId}:synthetic-t0`, amountMinor: '10000', expectedVersion: 1 });
    await investment.authorize(actor, redemption.id, { level: 'STRONG', proofId: randomUUID(), actionHash: redemption.actionHash });
    const transfer = await core.createTransfer(actor, { commandId: randomUUID(), accountId: `acc-main-${actor.userId}`, payeeId: 'payee-lin', amountMinor: '10000', memo: '过期恢复' });
    await core.authorize(actor, transfer.id, { level: 'CONFIRMATION', proofId: randomUUID(), actionHash: transfer.actionHash });
    // The separately authorized transfer above reserves 10,000. Fund that gap
    // explicitly so this fixture exercises an authorized child, not NEEDS_REPLAN.
    const input = goalInput({ funding: { positionId: `position:${actor.userId}:synthetic-t0`, redemptionAmountMinor: '310000' } });
    const goal = await goals.create(actor, input);
    expect(goal.status).toBe('ACTIVE');
    const child = goal.nodes.find(node => node.kind === 'REDEEM')!.investmentAction;
    expect(child).toMatchObject({ status: 'AWAITING_VERIFICATION', amountMinor: '310000' });
    await investment.authorize(actor, child!.id, { level: 'STRONG', proofId: randomUUID(), actionHash: child!.actionHash });
    now = new Date(now.getTime() + 60 * 60_000);
    const before = await snapshot();
    for (const path of [`/api/investments/commands/${commandId}`, `/api/investments/actions/${redemption.id}`, `/api/actions/${transfer.id}`, `/api/goal-commands/${input.commandId}`, `/api/goals/${goal.id}`]) {
      const response = await request(path); expect(response.status).toBe(200);
    }
    expect(await snapshot()).toEqual(before);
    expect((await investment.getByCommand(actor, commandId)).id).toBe(redemption.id);
  });

  it('hydrates original goal results and replan command mappings without advancing a newly ready node', async () => {
    const input = goalInput(); const original = await goals.create(actor, input), redemption = original.nodes.find(node => node.investmentAction)!.investmentAction!;
    await investment.authorize(actor, redemption.id, { level: 'STRONG', proofId: randomUUID(), actionHash: redemption.actionHash });
    await investment.execute(redemption.id);
    const before = await snapshot();
    const recovered = await (await request(`/api/goal-commands/${input.commandId}`)).json();
    expect(recovered.id).toBe(original.id);
    expect(recovered.nodes.find((node: { kind: string }) => node.kind === 'WAIT_SETTLEMENT').status).toBe('SUCCEEDED');
    expect(recovered.nodes.find((node: { kind: string }) => node.kind === 'TRANSFER')).toMatchObject({ status: 'READY' });
    expect(recovered.nodes.find((node: { kind: string }) => node.kind === 'TRANSFER').actionRef).toBeUndefined();
    expect(await snapshot()).toEqual(before);
    const revisedInput = { ...input, commandId: randomUUID(), expectedPlanVersion: original.planVersion, amountMinor: '500000' };
    const revised = await goals.replan(actor, original.id, revisedInput);
    const revisedBefore = await snapshot();
    for (const commandId of [input.commandId, revisedInput.commandId]) {
      expect(await goals.getByCommand(actor, commandId)).toMatchObject({ id: original.id, planVersion: revised.planVersion, amountMinor: '500000' });
    }
    expect(await snapshot()).toEqual(revisedBefore);
  });
});
