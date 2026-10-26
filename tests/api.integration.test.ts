import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign, type KeyObject } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { isoCBOR } from '@simplewebauthn/server/helpers';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import { createAuth } from '../apps/api/src/config.js';
import { createApp, migrateApi } from '../apps/api/src/app.js';
import { createCore, createFinance } from '../packages/core/src/index.js';
import { createManagement } from '../packages/core/src/management.js';
import { createInvestment } from '../packages/core/src/investment.js';
import { createGoals } from '../packages/core/src/goals.js';
import { createPlanner } from '../packages/agents/src/index.js';
import type { ActionView, CoreService, Planner, ManagementService, ManagementSpec } from '../packages/contracts/src/index.js';

const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL ?? 'postgres://bankpilot:bankpilot-local@127.0.0.1:55432/bankpilot', max: 12 });
const origin = 'http://localhost:5178';
const testPassword = `Only-tests-${randomUUID()}!`;
let auth: ReturnType<typeof createAuth>;
let app: ReturnType<typeof createApp>;
let core: CoreService;
let schema: string;
const users: { id: string; email: string; cookie: string }[] = [];
const createdEmails: string[] = [];

const b64 = (bytes: Uint8Array | string) => Buffer.from(bytes).toString('base64url');
const sha = (value: Uint8Array | string) => createHash('sha256').update(value).digest();
function authenticator() {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = pair.publicKey.export({ format: 'jwk' });
  const credentialId = randomBytes(32);
  const cose = isoCBOR.encode(new Map<number, number | Uint8Array>([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x!, 'base64url')], [-3, Buffer.from(jwk.y!, 'base64url')]]));
  return { privateKey: pair.privateKey, credentialId, cose };
}
type FixtureAuthenticator = ReturnType<typeof authenticator>;
function registration(device: FixtureAuthenticator, challenge: string, responseOrigin = origin, uv = true): RegistrationResponseJSON {
  const clientDataJSON = b64(JSON.stringify({ type: 'webauthn.create', challenge, origin: responseOrigin, crossOrigin: false }));
  const length = Buffer.alloc(2); length.writeUInt16BE(device.credentialId.length);
  const authData = Buffer.concat([sha('localhost'), Buffer.from([0x41 | (uv ? 0x04 : 0)]), Buffer.alloc(4), Buffer.alloc(16), length, Buffer.from(device.credentialId), Buffer.from(device.cose)]);
  const attestationObject = b64(isoCBOR.encode(new Map<string, string | Uint8Array | Map<string, string>>([['fmt', 'none'], ['authData', authData], ['attStmt', new Map()]])));
  return { id: b64(device.credentialId), rawId: b64(device.credentialId), type: 'public-key', clientExtensionResults: {}, response: { clientDataJSON, attestationObject, transports: ['internal'] } };
}
function assertion(device: FixtureAuthenticator, challenge: string, options: { responseOrigin?: string; uv?: boolean; counter?: number; key?: KeyObject } = {}): AuthenticationResponseJSON {
  const clientDataJSON = b64(JSON.stringify({ type: 'webauthn.get', challenge, origin: options.responseOrigin ?? origin, crossOrigin: false }));
  const count = Buffer.alloc(4); count.writeUInt32BE(options.counter ?? 1);
  const authData = Buffer.concat([sha('localhost'), Buffer.from([0x01 | ((options.uv ?? true) ? 0x04 : 0)]), count]);
  const signature = sign('sha256', Buffer.concat([authData, sha(Buffer.from(clientDataJSON, 'base64url'))]), options.key ?? device.privateKey);
  return { id: b64(device.credentialId), rawId: b64(device.credentialId), type: 'public-key', clientExtensionResults: {}, response: { clientDataJSON, authenticatorData: b64(authData), signature: b64(signature) } };
}

async function request(path: string, body?: unknown, user = users[0], overrideOrigin: string | null = origin) {
  return app.request(`${origin}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { ...(user ? { Cookie: user.cookie } : {}), ...(overrideOrigin ? { Origin: overrideOrigin } : {}), 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function transfer(amountMinor = '200000') {
  const response = await request('/api/transfers', { commandId: randomUUID(), accountId: `acc-main-${users[0]!.id}`, payeeId: 'payee-lin', amountMinor, memo: 'API isolated fixture' });
  expect(response.status).toBe(200); return response.json() as Promise<ActionView>;
}
async function registerDevice() {
  const device = authenticator();
  const opts = await (await request('/api/webauthn/register/options', {})).json();
  const verify = await request('/api/webauthn/register/verify', { response: registration(device, opts.challenge) });
  expect(verify.status).toBe(200); return device;
}
function rebuild(planner: Planner = createPlanner({ provider: false }), overrideCore = core, withFinance = false, management?: ManagementService) {
  app = createApp({ pool, auth, core: overrideCore, planner, ...(withFinance ? { finance: createFinance(pool, { schema }) } : {}), ...(management ? { management } : {}), origin, rpID: 'localhost', sandbox: false, plannerMode: 'scripted' });
}
async function enableManagement() {
  const service = createManagement(pool, { schema }); await service.migrate();
  for (const user of users) await service.seedDemo({ userId: user.id });
  rebuild(undefined, core, true, service); return service;
}
async function prepareManagement(spec: ManagementSpec) {
  const response = await request('/api/management/actions', { commandId: randomUUID(), spec });
  expect(response.status).toBe(200); return response.json();
}

beforeAll(async () => {
  const previous = process.env.BETTER_AUTH_SECRET;
  process.env.BETTER_AUTH_SECRET = 'isolated-api-integration-fixture-secret-over-32-characters';
  try { auth = createAuth(pool); } finally { if (previous === undefined) delete process.env.BETTER_AUTH_SECRET; else process.env.BETTER_AUTH_SECRET = previous; }
  await migrateApi(pool);
  for (let index = 0; index < 2; index++) {
    const email = `api-review-${randomUUID()}@example.test`; createdEmails.push(email);
    const result = await auth.api.signUpEmail({ body: { email, password: testPassword, name: `isolated-fixture-${index}` } });
    const response = await auth.handler(new Request(`${origin}/api/auth/sign-in/email`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: testPassword }) }));
    expect(response.status).toBe(200);
    const cookie = response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
    expect(cookie).toContain('bankpilot.session_token');
    users.push({ id: result.user.id, email, cookie });
  }
}, 30000);
beforeEach(async () => {
  schema = `apitest_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  core = createCore(pool, { schema }); await core.migrate();
  for (const user of users) await core.seedDemo({ userId: user.id });
  rebuild();
});
afterEach(async () => {
  await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  const ids = users.map(user => user.id);
  await pool.query('DELETE FROM bp_plan_commands WHERE user_id=ANY($1)', [ids]);
  await pool.query('DELETE FROM bp_challenges WHERE user_id=ANY($1)', [ids]);
  await pool.query('DELETE FROM bp_credentials WHERE user_id=ANY($1)', [ids]);
});
afterAll(async () => {
  for (const email of createdEmails) {
    const result = await pool.query('SELECT id FROM "user" WHERE email=$1', [email]);
    for (const row of result.rows) {
      await pool.query('DELETE FROM "session" WHERE "userId"=$1', [row.id]);
      await pool.query('DELETE FROM "account" WHERE "userId"=$1', [row.id]);
      await pool.query('DELETE FROM "user" WHERE id=$1', [row.id]);
    }
  }
  await pool.end();
});

describe('isolated real DB/API identity and recovery integration review', () => {
  it('rejects unauthenticated calls, cross-origin mutations, owner spoofing and client STRONG assertions', async () => {
    expect((await app.request(`${origin}/api/dashboard`)).status).toBe(401);
    const draft = await transfer();
    expect((await request(`/api/actions/${draft.id}/confirm`, { actionHash: draft.actionHash }, users[0], 'https://attacker.invalid')).status).toBe(403);
    expect((await request(`/api/actions/${draft.id}/confirm`, { actionHash: draft.actionHash }, users[0], null)).status).toBe(403);
    expect((await request(`/api/actions/${draft.id}/confirm`, { actionHash: draft.actionHash, level: 'STRONG', userId: users[1]!.id })).status).toBe(400);
    const confirmation = await request(`/api/actions/${draft.id}/confirm`, { actionHash: draft.actionHash });
    expect((await confirmation.json()).status).toBe('AWAITING_VERIFICATION');
    for (const path of ['confirm', 'cancel', 'reconcile', 'authentication/options']) {
      const result = await request(`/api/actions/${draft.id}/${path}`, path === 'confirm' ? { actionHash: draft.actionHash } : {}, users[1]);
      expect(result.status).toBe(404);
    }
    const counts = await pool.query(`SELECT count(*)::int AS n FROM "${schema}".authorization_proofs`); expect(counts.rows[0].n).toBe(0);
  });

  it('replays completed plan commands using current action states and rejects changed messages', async () => {
    const body = { commandId: randomUUID(), message: '给林晓转账三百元' };
    const initial = await (await request('/api/plan', body)).json(); expect(initial.actions).toHaveLength(1);
    const action = initial.actions[0];
    expect((await request(`/api/actions/${action.id}/confirm`, { actionHash: action.actionHash })).status).toBe(200);
    const replay = await (await request('/api/plan', body)).json();
    expect(replay.actions).toHaveLength(1); expect(replay.actions[0].id).toBe(action.id); expect(replay.actions[0].status).toBe('AUTHORIZED');
    expect((await request('/api/plan', { ...body, message: '给林晓转账四百元' })).status).toBe(409);
    expect((await core.dashboard({ userId: users[0]!.id })).actions).toHaveLength(1);
  });

  it('recovers a command after an action was committed but the planner envelope was not saved, without replanning action content', async () => {
    let attempt = 0;
    const planner: Planner = { async plan(input) {
      attempt++;
      return { taskId: input.taskId, planVersion: 1, mode: 'scripted', summary: 'recovery-fixture', events: [], suggestions: [{ payeeId: 'payee-lin', amountMinor: '10000', memo: `nondeterministic-memo-${attempt}` }], evidence: [], findings: [] };
    } };
    let fail = true;
    const failureCore: CoreService = { ...core, async createTransfer(actor, input) {
      const created = await core.createTransfer(actor, input);
      if (fail) { fail = false; throw new Error('simulated loss after core commit'); }
      return created;
    } };
    rebuild(planner, failureCore);
    const body = { commandId: randomUUID(), message: '给林晓转账一百元' };
    expect((await request('/api/plan', body)).status).toBe(500);
    const recovered = await request('/api/plan', body);
    expect(recovered.status).toBe(200);
    const result = await recovered.json(); expect(result.actions).toHaveLength(1);
    expect(result.actions[0].memo).toBe('nondeterministic-memo-1');
    expect(attempt).toBe(1);
    expect((await core.dashboard({ userId: users[0]!.id })).actions).toHaveLength(1);
  });

  it('fences an expired lease so a late old planner cannot overwrite or fail the recovered command', async () => {
    let attempt = 0;
    let releaseOld!: () => void;
    let oldStarted!: () => void;
    const waiting = new Promise<void>(resolve => { oldStarted = resolve; });
    const gate = new Promise<void>(resolve => { releaseOld = resolve; });
    const planner: Planner = { async plan(input) {
      const current = ++attempt;
      if (current === 1) { oldStarted(); await gate; }
      return { taskId: input.taskId, planVersion: 1, mode: 'scripted', summary: `lease-owner-${current}`, events: [], suggestions: [{ payeeId: 'payee-lin', amountMinor: '10000', memo: `lease-owner-${current}` }], evidence: [], findings: [] };
    } };
    rebuild(planner);
    const body = { commandId: randomUUID(), message: '给林晓转账一百元' };
    const original = request('/api/plan', body);
    await waiting;
    const concurrent = await request('/api/plan', body); expect(concurrent.status).toBe(409);
    expect((await concurrent.json()).error.code).toBe('PLAN_RUNNING');
    await pool.query("UPDATE bp_plan_commands SET updated_at=now()-interval '5 minutes' WHERE user_id=$1 AND command_id=$2", [users[0]!.id, body.commandId]);
    try {
      const recovered = await request('/api/plan', body); expect(recovered.status).toBe(200);
      expect((await recovered.json()).actions[0].memo).toBe('lease-owner-2');
    } finally { releaseOld(); }
    const late = await original; expect(late.status).toBe(409); expect((await late.json()).error.code).toBe('PLAN_SUPERSEDED');
    const row = (await pool.query('SELECT status,result FROM bp_plan_commands WHERE user_id=$1 AND command_id=$2', [users[0]!.id, body.commandId])).rows[0];
    expect(row.status).toBe('complete'); expect(row.result.actions[0].memo).toBe('lease-owner-2');
    expect((await core.dashboard({ userId: users[0]!.id })).actions).toHaveLength(1);
  });

  it('public signup remains disabled for a trailing-slash path as well as the canonical path', async () => {
    for (const path of ['/api/auth/sign-up/email', '/api/auth/sign-up/email/']) {
      const email = `api-review-bypass-${randomUUID()}@example.test`; createdEmails.push(email);
      const response = await app.request(`${origin}${path}`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: testPassword, name: 'must-not-register' }) });
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect((await pool.query('SELECT id FROM "user" WHERE email=$1', [email])).rowCount).toBe(0);
    }
  });

  it('requires a real valid signature and UV for RED authorization; replay cannot produce another proof', async () => {
    const device = await registerDevice(); const draft = await transfer();
    const options = await (await request(`/api/actions/${draft.id}/authentication/options`, {})).json();
    const response = assertion(device, options.challenge);
    const verified = await request(`/api/actions/${draft.id}/authentication/verify`, { response });
    expect(verified.status).toBe(200); expect((await verified.json()).status).toBe('AUTHORIZED');
    expect((await request(`/api/actions/${draft.id}/authentication/verify`, { response })).status).toBe(409);
    const proofs = await pool.query(`SELECT level FROM "${schema}".authorization_proofs WHERE action_id=$1`, [draft.id]); expect(proofs.rows).toEqual([{ level: 'STRONG' }]);
  });

  it.each(['missing-uv', 'wrong-origin', 'wrong-signature', 'expired', 'wrong-owner'] as const)('rejects WebAuthn %s without creating authorization', async mode => {
    const device = await registerDevice(); const draft = await transfer();
    const options = await (await request(`/api/actions/${draft.id}/authentication/options`, {})).json();
    if (mode === 'expired') await pool.query('UPDATE bp_challenges SET expires_at=now()-interval \'1 second\' WHERE user_id=$1 AND challenge=$2', [users[0]!.id, options.challenge]);
    const response = assertion(device, options.challenge, { uv: mode !== 'missing-uv', responseOrigin: mode === 'wrong-origin' ? 'https://attacker.invalid' : origin, ...(mode === 'wrong-signature' ? { key: authenticator().privateKey } : {}) });
    const result = await request(`/api/actions/${draft.id}/authentication/verify`, { response }, mode === 'wrong-owner' ? users[1] : users[0]);
    expect(result.status).toBeGreaterThanOrEqual(400);
    expect((await core.getAction({ userId: users[0]!.id }, draft.id)).status).toBe('AWAITING_VERIFICATION');
    expect((await pool.query(`SELECT count(*)::int AS n FROM "${schema}".authorization_proofs`)).rows[0].n).toBe(0);
  });

  it('returns source-backed bills and isolated funds without treating historical income as current balance', async () => {
    await createFinance(pool, { schema }).seedDemo({ userId: users[0]!.id });
    rebuild(undefined, core, true);
    const bills = await (await request('/api/bills')).json();
    expect(bills.source).toBe('SYNTHETIC');
    expect(bills.categories.reduce((sum: bigint, c: { amountMinor: string }) => sum + BigInt(c.amountMinor), 0n).toString()).toBe(bills.expenseMinor);
    const ids = new Set([...bills.transactions, ...(bills.evidenceTransactions ?? [])].map((t: { id: string }) => t.id));
    for (const finding of bills.findings) for (const id of finding.transactionIds) expect(ids.has(id)).toBe(true);
    const funds = await (await request('/api/funds?amountMinor=60000')).json();
    expect(funds.preview).toMatchObject({ balanceMinor: '800000', protectedMinor: '500000', availableAfterMinor: '740000', allowed: true });
    expect((await request(`/api/funds?accountId=acc-main-${users[0]!.id}`, undefined, users[1])).status).toBe(404);
    const other = await (await request('/api/bills', undefined, users[1])).json();
    expect(other.transactions).toEqual([]);
    expect((await request('/api/bills?period=2026-13')).status).toBe(400);
  });

  it('requires explicit policy confirmation, validates real dates and rejects stale versions', async () => {
    rebuild(undefined, core, true);
    const policy = { expectedVersion: 0, minimumBalanceMinor: '200000', obligations: [] };
    expect((await request('/api/funds/policy', policy)).status).toBe(400);
    expect((await request('/api/funds/policy', { ...policy, confirmed: true, obligations: [{ id: 'rent', title: '房租', amountMinor: '300000', dueDate: '2026-02-30' }] })).status).toBe(400);
    const saved = await request('/api/funds/policy', { ...policy, confirmed: true });
    expect(saved.status).toBe(200); expect((await saved.json()).version).toBe(1);
    expect((await request('/api/funds/policy', { ...policy, confirmed: true })).status).toBe(409);
    expect((await (await request('/api/funds')).json()).policy.minimumBalanceMinor).toBe('200000');
    expect((await (await request('/api/funds', undefined, users[1])).json()).policy.version).toBe(0);
  });

  it('persists combined bill/funds evidence and refreshes latest plan from the database', async () => {
    await createFinance(pool, { schema }).seedDemo({ userId: users[0]!.id });
    rebuild(undefined, core, true);
    const response = await request('/api/plan', { commandId: randomUUID(), message: '查本月账单，给林晓转600元，不影响房租和生活费' });
    expect(response.status).toBe(200);
    const plan = await response.json();
    expect(plan.actions).toHaveLength(1); expect(plan.billReport.source).toBe('SYNTHETIC'); expect(plan.fundsPreview.allowed).toBe(true);
    expect(plan.events.filter((e: { status: string }) => e.status === 'started').map((e: { role: string }) => e.role).sort()).toEqual(['bills', 'goal', 'reviewer', 'transfer']);
    const restored = await (await request('/api/dashboard')).json();
    expect(restored.latestPlan.taskId).toBe(plan.taskId);
    expect(restored.latestPlan.fundsPreview).toEqual(plan.fundsPreview);
    expect((await (await request('/api/dashboard', undefined, users[1])).json()).latestPlan).toBeUndefined();
    const previous = new Date(); previous.setDate(1); previous.setMonth(previous.getMonth() - 1);
    const period = `${previous.getFullYear()}-${String(previous.getMonth() + 1).padStart(2, '0')}`;
    const dated = await (await request('/api/plan', { commandId: randomUUID(), message: `查询${period}账单` })).json();
    expect(dated.billReport.period).toBe(period);
  });

  it('suppresses a budget-breaking plan and independently blocks direct API authorization', async () => {
    await createFinance(pool, { schema }).seedDemo({ userId: users[0]!.id });
    rebuild(undefined, core, true);
    const result = await (await request('/api/plan', { commandId: randomUUID(), message: '给林晓转4000元，不影响房租和生活费' })).json();
    expect(result.fundsPreview).toMatchObject({ allowed: false, shortfallMinor: '100000' });
    expect(result.actions).toEqual([]); expect(result.suggestions).toEqual([]);
    expect((await core.dashboard({ userId: users[0]!.id })).actions).toEqual([]);
    const draft = await transfer('50000');
    await request('/api/funds/policy', { expectedVersion: 1, minimumBalanceMinor: '780000', obligations: [], confirmed: true });
    const rejected = await request(`/api/actions/${draft.id}/confirm`, { actionHash: draft.actionHash });
    expect(rejected.status).toBe(409); expect((await rejected.json()).error.code).toBe('FUNDS_PROTECTED');
    const after = await core.dashboard({ userId: users[0]!.id });
    expect(after.accounts[0]!.reservedMinor).toBe('0'); expect(after.accounts[0]!.balanceMinor).toBe('800000');
  });

  it('requires explicit yellow subscription query before exposing merchant data and isolates grants', async () => {
    await enableManagement();
    expect((await request('/api/subscriptions')).status).toBe(400);
    expect((await request('/api/subscriptions?queryActionId=not-authorized')).status).not.toBe(200);
    const plan = await (await request('/api/plan', { commandId: randomUUID(), message: '帮我查询订阅' })).json();
    expect(plan.actions).toEqual([]); expect(plan.managementActions).toHaveLength(1);
    const query = plan.managementActions[0];
    expect(query).toMatchObject({ tier: 'YELLOW', status: 'AWAITING_CONFIRMATION', spec: { kind: 'SUBSCRIPTION_QUERY' } });
    expect(JSON.stringify(await (await request('/api/management')).json())).not.toContain('云音乐');
    expect((await request(`/api/subscriptions?queryActionId=${query.id}`)).status).not.toBe(200);
    const result = await (await request(`/api/management/actions/${query.id}/confirm`, { actionHash: query.actionHash })).json();
    expect(result.status).toBe('SUCCEEDED'); expect(result.receipt.subscriptions.items.length).toBeGreaterThan(0);
    const snapshot = await (await request(`/api/subscriptions?queryActionId=${query.id}`)).json();
    expect(snapshot.items.some((item: any) => item.merchant === '云音乐')).toBe(true);
    expect((await request(`/api/subscriptions?queryActionId=${query.id}`, undefined, users[1])).status).not.toBe(200);
    expect((await (await request('/api/dashboard')).json()).latestPlan.managementActions[0].status).toBe('SUCCEEDED');
    expect((await core.dashboard({ userId: users[0]!.id })).accounts[0].balanceMinor).toBe('800000');
  });

  it('saves aliases only after confirmation and makes them visible only to their user and planner', async () => {
    await enableManagement();
    const body = { commandId: randomUUID(), spec: { kind: 'CONTACT_ALIAS_SAVE', payeeId: 'payee-lin', alias: '房东' } };
    const draft = await (await request('/api/management/actions', body)).json();
    expect((await (await request('/api/dashboard')).json()).payees.find((p: any) => p.id === 'payee-lin').aliases).not.toContain('房东');
    expect((await request(`/api/management/actions/${draft.id}/confirm`, { actionHash: draft.actionHash, level: 'STRONG' })).status).toBe(400);
    expect((await request(`/api/management/actions/${draft.id}/confirm`, { actionHash: draft.actionHash }, users[1])).status).not.toBe(200);
    expect((await request(`/api/management/actions/${draft.id}/confirm`, { actionHash: draft.actionHash }, users[0], 'https://attacker.invalid')).status).toBe(403);
    const confirmed = await (await request(`/api/management/actions/${draft.id}/confirm`, { actionHash: draft.actionHash })).json();
    expect(confirmed.status).toBe('SUCCEEDED');
    expect((await (await request('/api/management/actions', body)).json()).id).toBe(draft.id);
    expect((await (await request('/api/dashboard')).json()).payees.find((p: any) => p.id === 'payee-lin').aliases).toContain('房东');
    expect((await (await request('/api/dashboard', undefined, users[1])).json()).payees.find((p: any) => p.id === 'payee-lin').aliases).not.toContain('房东');
    const plan = await (await request('/api/plan', { commandId: randomUUID(), message: '给房东转300元' })).json();
    expect(plan.actions).toHaveLength(1); expect(plan.actions[0]).toMatchObject({ payeeId: 'payee-lin', amountMinor: '30000', status: 'AWAITING_CONFIRMATION' });
    expect((await core.dashboard({ userId: users[0]!.id })).accounts[0].balanceMinor).toBe('800000');
  });

  it('reuses real signed Passkeys for card actions with separate challenge scope and no weak-auth write', async () => {
    const management = await enableManagement();
    const card = (await management.dashboard({ userId: users[0]!.id })).cards.find(card => card.status === 'ACTIVE')!;
    const draft = await prepareManagement({ kind: 'CARD_REPORT_LOST', cardId: card.id, expectedVersion: card.version });
    expect(draft.tier).toBe('RED');
    const weak = await request(`/api/management/actions/${draft.id}/confirm`, { actionHash: draft.actionHash });
    expect((await weak.json()).status).not.toBe('SUCCEEDED');
    expect((await management.dashboard({ userId: users[0]!.id })).cards.find(c => c.id === card.id)!.status).toBe('ACTIVE');
    expect((await request(`/api/management/actions/${draft.id}/authentication/options`, {}, users[1])).status).not.toBe(200);
    const device = await registerDevice();
    const opts = await (await request(`/api/management/actions/${draft.id}/authentication/options`, {})).json();
    const signed = assertion(device, opts.challenge);
    expect((await request(`/api/actions/${draft.id}/authentication/verify`, { response: signed })).status).not.toBe(200);
    const verified = await request(`/api/management/actions/${draft.id}/authentication/verify`, { response: signed });
    expect(verified.status).toBe(200); expect((await verified.json()).receipt.card.status).toBe('LOST');
    expect((await request(`/api/management/actions/${draft.id}/authentication/verify`, { response: signed })).status).toBe(409);
    const lost = (await management.dashboard({ userId: users[0]!.id })).cards.find(c => c.id === card.id)!;
    const restore = await prepareManagement({ kind: 'CARD_UNREPORT_LOST', cardId: lost.id, expectedVersion: lost.version });
    const restoreOpts = await (await request(`/api/management/actions/${restore.id}/authentication/options`, {})).json();
    const restored = await request(`/api/management/actions/${restore.id}/authentication/verify`, { response: assertion(device, restoreOpts.challenge, { counter: 2 }) });
    expect(restored.status).toBe(200); expect((await restored.json()).receipt.card.status).toBe('ACTIVE');
    expect((await core.dashboard({ userId: users[0]!.id })).accounts[0].balanceMinor).toBe('800000');
  });

  it('keeps merchant cancellation and bank debit blocking distinct across planning, confirm and replay', async () => {
    await enableManagement();
    const query = await prepareManagement({ kind: 'SUBSCRIPTION_QUERY' });
    await request(`/api/management/actions/${query.id}/confirm`, { actionHash: query.actionHash });
    const snapshot = await (await request(`/api/subscriptions?queryActionId=${query.id}`)).json();
    const target = snapshot.items.find((s: any) => s.cancellationSupported);
    const body = { commandId: randomUUID(), message: `取消${target.merchant}订阅` };
    const plan = await (await request('/api/plan', body)).json();
    expect(plan.managementActions).toHaveLength(1);
    const cancel = plan.managementActions[0];
    expect(cancel.spec).toMatchObject({ kind: 'SUBSCRIPTION_CANCEL', subscriptionId: target.id, queryActionId: query.id });
    const result = await (await request(`/api/management/actions/${cancel.id}/confirm`, { actionHash: cancel.actionHash })).json();
    expect(result).toMatchObject({ status: 'SUCCEEDED', receipt: { balanceDeltaMinor: '0', subscription: { merchantStatus: 'CANCELLED', bankStatus: 'ALLOWED' } } });
    expect((await (await request('/api/plan', body)).json()).managementActions[0].status).toBe('SUCCEEDED');
    const other = snapshot.items.find((s: any) => s.id !== target.id);
    const block = await prepareManagement({ kind: 'SUBSCRIPTION_BLOCK', subscriptionId: other.id, expectedVersion: other.version, queryActionId: query.id });
    const blocked = await (await request(`/api/management/actions/${block.id}/confirm`, { actionHash: block.actionHash })).json();
    expect(blocked.receipt.subscription).toMatchObject({ merchantStatus: 'ACTIVE', bankStatus: 'BLOCKED', collectionStatus: 'BLOCKED_BY_BANK' });
    expect((await core.dashboard({ userId: users[0]!.id })).accounts[0].balanceMinor).toBe('800000');
  });
});


async function enablePhase4(planner: Planner = createPlanner({ provider: false })) {
  const finance = createFinance(pool, { schema });
  const investment = createInvestment(pool, { schema });
  await investment.migrate();
  const goals = createGoals(pool, core, investment, finance, { schema });
  await goals.migrate();
  for (const user of users) {
    await finance.seedDemo({ userId: user.id });
    await investment.seedDemo({ userId: user.id });
  }
  app = createApp({ pool, auth, core, planner, finance, investment, goals, origin, rpID: 'localhost', sandbox: false, plannerMode: 'scripted' });
  return { finance, investment, goals };
}

describe('phase4 API investment and goal boundaries', () => {
  it('requires a real scoped Passkey for redemption, isolates owners and refuses client strong flags', async () => {
    const { investment } = await enablePhase4();
    const state = await (await request('/api/investments')).json();
    const position = state.positions.find((p: any) => p.redemptionBusinessDays === 0);
    const draft = await (await request('/api/investments/redemptions', { commandId: randomUUID(), positionId: position.id, expectedVersion: position.version, amountMinor: '10000' })).json();
    expect(draft.tier).toBe('RED');
    expect((await request(`/api/investments/actions/${draft.id}/confirm`, { actionHash: draft.actionHash, level: 'STRONG' })).status).toBe(400);
    await request(`/api/investments/actions/${draft.id}/confirm`, { actionHash: draft.actionHash });
    expect((await investment.getAction({ userId: users[0]!.id }, draft.id)).status).not.toBe('AUTHORIZED');
    for (const operation of ['cancel', 'reconcile', 'authentication/options']) {
      expect((await request(`/api/investments/actions/${draft.id}/${operation}`, {}, users[1])).status).toBe(404);
    }
    const device = await registerDevice();
    const opts = await (await request(`/api/investments/actions/${draft.id}/authentication/options`, {})).json();
    const signed = assertion(device, opts.challenge);
    expect((await request(`/api/actions/${draft.id}/authentication/verify`, { response: signed })).status).toBe(409);
    const verified = await request(`/api/investments/actions/${draft.id}/authentication/verify`, { response: signed });
    expect(verified.status).toBe(200); expect((await verified.json()).status).toBe('AUTHORIZED');
    expect((await request(`/api/investments/actions/${draft.id}/authentication/verify`, { response: signed })).status).toBe(409);
    expect((await request('/api/sandbox/investment-fault', { mode: 'REJECT' })).status).toBe(404);
    expect((await core.dashboard({ userId: users[0]!.id })).accounts[0].balanceMinor).toBe('800000');
  });

  it('validates timeline inputs and rejects access to another account', async () => {
    await enablePhase4();
    expect((await app.request(`${origin}/api/investments`)).status).toBe(401);
    expect((await request('/api/investments/timeline?days=100')).status).toBe(400);
    expect((await request('/api/investments/timeline?days=1.5')).status).toBe(400);
    expect((await request(`/api/investments/timeline?accountId=acc-main-${users[1]!.id}`)).status).toBe(404);
    const result = await (await request('/api/investments/timeline?days=30')).json();
    expect(result.balanceMinor).toBe('800000'); expect(result.spendableNowMinor).toBe('300000');
    expect(result.calendar).toBe('DEMO_WEEKDAYS_V1');
  });

  it('creates an idempotent owned DAG and never grants overall goal authorization', async () => {
    const { goals } = await enablePhase4();
    const state = await (await request('/api/investments')).json();
    const position = state.positions.find((p: any) => p.redemptionBusinessDays === 0);
    const body = { commandId: randomUUID(), title: '生日礼金', accountId: position.accountId, payeeId: 'payee-lin', amountMinor: '50000', targetDate: '2099-12-30', funding: { positionId: position.id, redemptionAmountMinor: '10000' } };
    const response = await request('/api/goals', body);
    expect(response.status).toBe(200);
    const goal = await response.json();
    expect(goal.nodes.map((n: any) => n.kind)).toEqual(['REDEEM', 'WAIT_SETTLEMENT', 'TRANSFER']);
    expect((await (await request('/api/goals', body)).json()).id).toBe(goal.id);
    expect((await request(`/api/goals/${goal.id}`, undefined, users[1])).status).toBe(404);
    expect((await request(`/api/goals/${goal.id}/advance`, {}, users[1])).status).toBe(404);
    expect((await request('/api/goals', { ...body, commandId: randomUUID(), authorized: true })).status).toBe(400);
    const advanced = await (await request(`/api/goals/${goal.id}/advance`, {})).json();
    expect(advanced.nodes[0].investmentAction.tier).toBe('RED');
    expect(advanced.nodes[2].actionRef).toBeUndefined();
    expect((await core.dashboard({ userId: users[0]!.id })).actions).toHaveLength(0);
    expect((await goals.list({ userId: users[0]!.id }))).toHaveLength(1);
    expect((await request(`/api/goals/${goal.id}/replan`, { ...body, commandId: randomUUID(), expectedPlanVersion: 0 })).status).toBe(400);
  });

  it('rejects mixed goal and standalone money proposals before creating any drafts', async () => {
    const planner: Planner = { async plan(input) {
      return { taskId: input.taskId, planVersion: 1, mode: 'scripted', summary: 'invalid mixed proposal', events: [], evidence: [], findings: [],
        suggestions: [{ payeeId: 'payee-lin', amountMinor: '10000', memo: 'unsafe parallel draft' }],
        goalSuggestion: { title: '生日', accountId: input.accounts[0]!.id, payeeId: 'payee-lin', amountMinor: '10000', targetDate: '2099-12-30' } };
    } };
    const { goals } = await enablePhase4(planner);
    const response = await request('/api/plan', { commandId: randomUUID(), message: '安排生日目标' });
    expect(response.status).toBe(400); expect((await response.json()).error.code).toBe('INVALID_PROPOSAL');
    expect((await core.dashboard({ userId: users[0]!.id })).actions).toEqual([]);
    expect(await goals.list({ userId: users[0]!.id })).toEqual([]);
  });

  it('replays a frozen investment proposal and refreshes its action status', async () => {
    let calls = 0;
    const planner: Planner = { async plan(input) {
      calls++;
      const position = input.investmentContext!.positions[0]!;
      return { taskId: input.taskId, planVersion: 1, mode: 'scripted', summary: '赎回候选', events: [], evidence: [], findings: [], suggestions: [],
        investmentSuggestions: [{ positionId: position.id, expectedVersion: position.version, amountMinor: '10000' }] };
    } };
    await enablePhase4(planner);
    const body = { commandId: randomUUID(), message: '赎回理财100元' };
    const response = await request('/api/plan', body); expect(response.status).toBe(200);
    const result = await response.json(); expect(result.investmentActions).toHaveLength(1); expect(result.actions).toEqual([]);
    await request(`/api/investments/actions/${result.investmentActions[0].id}/cancel`, {});
    const replay = await (await request('/api/plan', body)).json();
    expect(replay.investmentActions[0].status).toBe('CANCELLED'); expect(calls).toBe(1);
    expect((await (await request('/api/dashboard')).json()).latestPlan.investmentActions[0].status).toBe('CANCELLED');
  });
});
