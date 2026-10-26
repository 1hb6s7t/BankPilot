import { test, expect, type Page, type BrowserContext, type Route } from '@playwright/test';
import { startG8hBrowserApp } from '../fixtures/g8h-browser-app.js';
import { Pool } from 'pg';

let fixture: Awaited<ReturnType<typeof startG8hBrowserApp>>;
let pageErrors: string[];
let committedResponseLosses = 0;
const attach = (name: string, data: unknown) => test.info().attach(name, { body: JSON.stringify(data, null, 2), contentType: 'application/json' });
async function login(page: Page) {
  await page.goto(fixture.origin); await page.getByLabel('邮箱地址').fill(fixture.email);
  await page.getByLabel('密码', { exact: true }).fill(fixture.password);
  await page.getByRole('button', { name: '进入安全工作台' }).click();
  await expect(page.getByRole('combobox', { name: '选择聊天' })).toBeEnabled();
}
const nav = (page: Page, name: string) => page.getByRole('button', { name, exact: true }).click();
const recovery = (page: Page) => page.getByRole('region', { name: '原请求恢复', exact: true });
const unavailable = (route: Route) => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'G8L_READ_UNAVAILABLE', message: '故障注入：原请求暂时无法读取。' } }) });
async function read(page: Page, path: string) { const response = await page.request.get(`${fixture.origin}${path}`); expect(response.status()).toBe(200); return response.json(); }
async function lostResponse(page: Page, path: (url: URL) => boolean, bodies: unknown[]) {
  await page.route(path, async route => {
    if (route.request().method() !== 'POST') return route.continue();
    bodies.push(route.request().postDataJSON());
    const committed = await route.fetch(); expect(committed.ok(), `Expected committed mutation, received ${committed.status()}: ${await committed.text()}`).toBe(true);
    committedResponseLosses += 1;
    await attach(`committed-but-response-lost-${bodies.length}.json`, await committed.json());
    await route.abort('failed');
  }, { times: 1 });
}
async function softwarePasskey(context: BrowserContext, page: Page) {
  const cdp = await context.newCDPSession(page); await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
}
test.beforeEach(async ({ page }) => { committedResponseLosses = 0; pageErrors = []; page.on('pageerror', error => pageErrors.push(error.message)); fixture = await startG8hBrowserApp(); });
test.afterEach(async () => {
  try {
    await attach('terminal-database.json', await fixture.snapshot());
    await attach('scope.json', { realLoginApiPostgresWorker: true, responseLossAfterRealCommit: committedResponseLosses > 0, committedResponseLosses, cloudCalls: 0, controlledModelCalls: fixture.calls.length, schema: fixture.schema });
    await attach('page-errors.json', pageErrors); expect(pageErrors).toEqual([]); expect(fixture.calls).toHaveLength(0);
  } finally { const cleanup = await fixture.close(); await attach('cleanup.json', cleanup); expect(cleanup).toMatchObject({ success: true, clean: true, errors: [] }); }
});

test('contact preparation survives lost response, unavailable lookup and reload; original confirmation recovers once', async ({ page }) => {
  await login(page); await nav(page, '联系人');
  const posts: unknown[] = [], commandPath = (url: URL) => url.pathname.startsWith('/api/management/commands/');
  await page.route(commandPath, unavailable);
  await lostResponse(page, url => url.pathname === '/api/management/actions', posts);
  await page.getByLabel('新增称呼').fill('恢复联系称呼');
  await page.getByRole('button', { name: '生成别名保存候选' }).click();
  await expect(recovery(page)).toContainText('已保留原编号和内容');
  await page.getByLabel('新增称呼').fill('不能替换未核实请求');
  await expect(page.getByRole('button', { name: '生成别名保存候选' })).toBeDisabled();
  await page.reload(); await nav(page, '联系人');
  await expect(recovery(page)).toContainText('已保留原编号和内容');
  await recovery(page).getByText('核对原请求内容').click();
  await expect(recovery(page)).toContainText('恢复联系称呼');
  expect(posts).toHaveLength(1);
  await page.unroute(commandPath, unavailable);
  await recovery(page).getByRole('button', { name: '查询原请求', exact: true }).click();
  await expect(recovery(page)).toContainText('已找到原请求');
  const card = page.locator('.management-action-card').filter({ hasText: '恢复联系称呼' });
  await expect(card).toHaveCount(1);
  await lostResponse(page, url => /\/api\/management\/actions\/[^/]+\/confirm$/.test(url.pathname), posts);
  await card.getByRole('button', { name: '确认此管理动作' }).click();
  await expect(card.locator('.management-action-status')).toHaveText('已完成', { timeout: 20_000 });
  await expect(card.getByRole('alert')).toBeVisible();
  const snapshot = await fixture.snapshot();
  expect(snapshot.management.actions.filter((action: any) => action.spec.kind === 'CONTACT_ALIAS_SAVE')).toHaveLength(1);
  expect(snapshot.tables.managementAuthorizationProofs).toHaveLength(1);
  expect(snapshot.tables.providerTransfers).toHaveLength(0);
  await page.screenshot({ path: test.info().outputPath('contact-original-result.png'), fullPage: true });
});

test('card cancellation blocks stale authorization across navigation until readonly original lookup succeeds', async ({ page }) => {
  await login(page); await nav(page, '卡片');
  await page.getByRole('button', { name: '准备挂失', exact: true }).first().click();
  const card = page.locator('.management-action-card').first();
  await expect(card.getByRole('button', { name: '取消候选动作' })).toBeEnabled();
  const reads = (url: URL) => /^\/api\/management\/actions\/[^/]+$/.test(url.pathname);
  await page.route(reads, unavailable);
  const posts: unknown[] = []; await lostResponse(page, url => /\/api\/management\/actions\/[^/]+\/cancel$/.test(url.pathname), posts);
  await card.getByRole('button', { name: '取消候选动作' }).click();
  await expect(card.getByRole('button', { name: '只读查询原动作状态' })).toBeEnabled();
  await expect(card.getByRole('button', { name: 'Passkey 强验证', exact: true })).toBeDisabled();
  await nav(page, '联系人'); await nav(page, '卡片');
  await expect(card.getByRole('button', { name: '只读查询原动作状态' })).toBeEnabled();
  await expect(card.getByRole('button', { name: 'Passkey 强验证', exact: true })).toBeDisabled();
  await page.unroute(reads, unavailable);
  await card.getByRole('button', { name: '只读查询原动作状态' }).click();
  await expect(card.locator('.management-action-status')).toHaveText('已取消');
  expect(posts).toHaveLength(1);
  const snapshot = await fixture.snapshot(); expect(snapshot.tables.managementAuthorizationProofs).toHaveLength(0);
  expect(snapshot.management.cards.every((value: any) => value.status === 'ACTIVE')).toBe(true);
});

test('subscription query confirmation recovers its original grant without exposing a query receipt or reauthorizing', async ({ page }) => {
  await login(page); await nav(page, '订阅');
  await page.getByRole('button', { name: '准备查询订阅', exact: true }).click();
  const card = page.locator('.management-action-card').first(), posts: unknown[] = [];
  await lostResponse(page, url => /\/api\/management\/actions\/[^/]+\/confirm$/.test(url.pathname), posts);
  await card.getByRole('button', { name: '确认此管理动作' }).click();
  await expect(card.locator('.management-action-status')).toHaveText('已完成', { timeout: 20_000 });
  await expect(page.locator('.subscription-card').first()).toBeVisible();
  const snapshot = await fixture.snapshot();
  const query = snapshot.management.actions.find((action: any) => action.spec.kind === 'SUBSCRIPTION_QUERY')!;
  const detail = await read(page, `/api/management/actions/${query.id}`); expect(detail.receipt?.subscriptions).toBeUndefined();
  expect(JSON.stringify(detail)).not.toContain('nextChargeDate');
  expect(snapshot.tables.managementAuthorizationProofs).toHaveLength(1); expect(posts).toHaveLength(1);
  await page.reload(); await nav(page, '订阅');
  await expect(page.locator('.subscription-card')).toHaveCount(0);
  await page.getByRole('button', { name: '查看已授权订阅' }).click();
  await expect(page.locator('.subscription-card').first()).toBeVisible();
  expect((await fixture.snapshot()).tables.managementAuthorizationProofs).toHaveLength(1);
});

test('redemption explicit retry uses the same durable command and original payload, then lost cancellation releases no funds', async ({ page }) => {
  await login(page); await nav(page, '理财');
  const position = page.locator('.investment-position-card').filter({ hasText: 'T+0' });
  await position.getByLabel('赎回金额（元）').fill('100');
  const commands = (url: URL) => url.pathname.startsWith('/api/investments/commands/');
  await page.route(commands, unavailable);
  const writes: unknown[] = [];
  page.on('request', request => { if (new URL(request.url()).pathname === '/api/investments/redemptions' && request.method() === 'POST') writes.push(request.postDataJSON()); });
  await lostResponse(page, url => url.pathname === '/api/investments/redemptions', []);
  await position.getByRole('button', { name: '预览并准备赎回' }).click();
  await expect(recovery(page)).toContainText('已保留原编号和内容');
  await page.reload(); await nav(page, '理财');
  await expect(recovery(page)).toContainText('已保留原编号和内容');
  await recovery(page).getByRole('button', { name: '按原内容重试' }).click();
  await expect(recovery(page).getByRole('button', { name: '按原内容重试' })).toHaveCount(0);
  expect(writes).toHaveLength(2); expect(writes[1]).toEqual(writes[0]);
  const card = page.locator('.investment-action-card').filter({ hasText: 'T+0' }); await expect(card).toHaveCount(1);
  await lostResponse(page, url => /\/api\/investments\/actions\/[^/]+\/cancel$/.test(url.pathname), []);
  await card.getByRole('button', { name: '取消赎回候选' }).click();
  await expect(card.locator('.management-action-status')).toHaveText('已取消');
  const snapshot = await fixture.snapshot(); expect(snapshot.investment.actions).toHaveLength(1);
  expect(snapshot.tables.investmentAuthorizationProofs).toHaveLength(0); expect(snapshot.tables.providerRedemptions).toHaveLength(0);
  expect(snapshot.investment.positions.every((value: any) => value.reservedMinor === '0')).toBe(true);
  await attach('identical-preparation-retries.json', writes);
});

test('goal create, replan, advance and transfer confirmation recover original records with one plan increment and debit', async ({ page }) => {
  await login(page); await nav(page, '生活目标');
  const form = page.locator('.goal-create-panel');
  await form.getByLabel('目标名称').fill('响应恢复生活目标'); await form.getByLabel('目标金额（元）').fill('100');
  await form.getByLabel('目标完成日期').fill('2026-10-30');
  const creates: unknown[] = []; await lostResponse(page, url => url.pathname === '/api/goals', creates);
  await form.getByRole('button', { name: '保存并查看计划' }).click();
  await expect(page.locator('.goal-detail-panel')).toContainText('响应恢复生活目标');
  let goals = (await read(page, '/api/goals')).goals; expect(goals).toHaveLength(1); const id = goals[0].id;
  // Critical field changes require explicitly cancelling the existing, unapproved candidate first.
  await page.locator('.goal-transfer-action').getByRole('button', { name: '取消候选', exact: true }).click();
  await expect(page.locator('.goal-transfer-action')).toContainText('已取消');
  await page.getByRole('button', { name: '修改目标并重新规划' }).click();
  const edit = page.locator('.goal-replan-form'); await edit.getByLabel('目标金额（元）').fill('110');
  const replans: unknown[] = []; await lostResponse(page, url => url.pathname === `/api/goals/${id}/replan`, replans);
  await edit.getByRole('button', { name: '确认修改并重规划' }).click();
  await expect.poll(async () => (await read(page, `/api/goals/${id}`)).planVersion).toBe(2);
  await expect(edit).toHaveCount(0);
  const advances: unknown[] = []; await lostResponse(page, url => url.pathname === `/api/goals/${id}/advance`, advances);
  await page.getByRole('button', { name: '检查进度并准备下一步' }).click();
  const transfer = page.locator('.goal-transfer-action');
  await expect(transfer.getByRole('button', { name: '确认此转账' })).toBeEnabled();
  const confirms: unknown[] = []; await lostResponse(page, url => /\/api\/actions\/[^/]+\/confirm$/.test(url.pathname), confirms);
  await transfer.getByRole('button', { name: '确认此转账' }).click();
  await expect.poll(async () => (await fixture.snapshot()).tables.providerTransfers.length, { timeout: 20_000 }).toBe(1);
  await page.getByRole('button', { name: '刷新目标', exact: true }).click();
  await expect(page.locator('.goal-detail-panel')).toContainText('目标已完成');
  await page.reload(); await nav(page, '生活目标');
  goals = (await read(page, '/api/goals')).goals; expect(goals).toHaveLength(1); expect(goals[0]).toMatchObject({ id, planVersion: 2, amountMinor: '11000', status: 'SUCCEEDED' });
  const snapshot = await fixture.snapshot(); expect(snapshot.tables.authorizationProofs).toHaveLength(1); expect(snapshot.tables.ledgerEntries).toHaveLength(2);
  expect(snapshot.dashboard.accounts[0].balanceMinor).toBe('789000');
  expect([creates.length, replans.length, advances.length, confirms.length]).toEqual([1, 1, 1, 1]);
  await page.screenshot({ path: test.info().outputPath('goal-original-completion.png'), fullPage: true });
});

test('lost signed redemption authorization queries the original action once and preserves unsettled funds', async ({ page, context }) => {
  await login(page); await softwarePasskey(context, page); await nav(page, '理财');
  const position = page.locator('.investment-position-card').filter({ hasText: 'T+2' });
  await position.getByLabel('赎回金额（元）').fill('100'); await position.getByRole('button', { name: '预览并准备赎回' }).click();
  const card = page.locator('.investment-action-card');
  await card.getByRole('button', { name: '还没有 Passkey？先注册' }).click();
  await expect(card.getByRole('status')).toContainText('Passkey 已登记');
  const proofs: unknown[] = []; await lostResponse(page, url => /\/api\/investments\/actions\/[^/]+\/authentication\/verify$/.test(url.pathname), proofs);
  await card.getByRole('button', { name: 'Passkey 强验证并确认赎回' }).click();
  await expect(card.locator('.management-action-status')).toHaveText('模拟结算中 · 未到账', { timeout: 25_000 });
  const snapshot = await fixture.snapshot(); expect(snapshot.tables.investmentAuthorizationProofs).toHaveLength(1);
  expect(snapshot.tables.providerRedemptions).toHaveLength(1); expect(snapshot.tables.redemptionEntries).toHaveLength(0);
  expect(snapshot.dashboard.accounts[0].balanceMinor).toBe('800000'); expect(proofs).toHaveLength(1);
  expect(snapshot.investment.positions.find((position: any) => position.productId === 'synthetic-t2')?.reservedMinor).toBe('10000');
  await attach('software-passkey-scope.json', { softwareAuthenticator: true, realCryptographicVerification: true, signedRequests: proofs.length, cloudCalls: 0 });
});

test('goal committed before a later conflict retains its command while receipt lookup is unavailable', async ({ page }) => {
  await login(page); await nav(page, '生活目标');
  const form = page.locator('.goal-create-panel');
  await form.getByLabel('目标名称').fill('提交后冲突恢复'); await form.getByLabel('目标金额（元）').fill('100');
  await form.getByLabel('目标完成日期').fill('2026-10-30');
  const commands = (url: URL) => url.pathname.startsWith('/api/goal-commands/'); await page.route(commands, unavailable);
  let commandId = '', posts = 0;
  await page.route(url => url.pathname === '/api/goals', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    posts += 1; commandId = route.request().postDataJSON().commandId;
    const committed = await route.fetch(); expect(committed.ok()).toBe(true);
    await route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: { code: 'G8L_POST_COMMIT_CHILD_CONFLICT', message: '故障注入：目标已保存，后续准备遇到版本冲突。' } }) });
  });
  await form.getByRole('button', { name: '保存并查看计划' }).click();
  await expect(recovery(page)).toContainText('已保留原编号和内容');
  await expect(recovery(page)).toContainText(commandId);
  await page.reload(); await nav(page, '生活目标');
  await expect(recovery(page)).toContainText(commandId); expect(posts).toBe(1);
  await page.unroute(commands, unavailable);
  await recovery(page).getByRole('button', { name: '查询原请求', exact: true }).click();
  await expect(recovery(page)).toContainText('已找到原请求');
  expect((await read(page, '/api/goals')).goals).toHaveLength(1);
  expect((await fixture.snapshot()).tables.authorizationProofs).toHaveLength(0);
});

test('not-found after a pre-commit transport loss retains original identity until explicit retry', async ({ page }) => {
  await login(page); await nav(page, '联系人');
  const writes: unknown[] = [];
  page.on('request', request => { if (new URL(request.url()).pathname === '/api/management/actions' && request.method() === 'POST') writes.push(request.postDataJSON()); });
  await page.route(url => url.pathname === '/api/management/actions', route => route.abort('failed'), { times: 1 });
  await page.getByLabel('新增称呼').fill('提交前断线恢复'); await page.getByRole('button', { name: '生成别名保存候选' }).click();
  await expect(recovery(page)).toContainText('暂未找到原请求记录');
  expect((await fixture.snapshot()).management.actions).toHaveLength(0);
  await recovery(page).getByRole('button', { name: '按原内容重试' }).click();
  await expect(page.locator('.management-action-card')).toHaveCount(1);
  expect(writes).toHaveLength(2); expect(writes[0]).toEqual(writes[1]);
  expect((await fixture.snapshot()).tables.managementAuthorizationProofs).toHaveLength(0);
});

test('a definite rejection stays recoverable until the server explicitly stops its durable request', async ({ page }) => {
  await login(page); await nav(page, '联系人');
  const commands = (url: URL) => url.pathname.startsWith('/api/management/commands/'); await page.route(commands, unavailable);
  // Existing legal names are rejected by the real alias conflict rule before preparation commits.
  const name = (await read(page, '/api/dashboard')).payees[0].name;
  await page.getByLabel('新增称呼').fill(name); await page.getByRole('button', { name: '生成别名保存候选' }).click();
  await expect(recovery(page)).toContainText('已保留原编号和内容');
  expect((await fixture.snapshot()).management.actions).toHaveLength(0);
  await page.reload(); await nav(page, '联系人');
  await expect(recovery(page)).toContainText('已保留原编号和内容');
  await page.unroute(commands, unavailable); await recovery(page).getByRole('button', { name: '查询原请求', exact: true }).click();
  await expect(recovery(page)).toContainText('服务端已记录原请求');
  await expect(page.getByRole('button', { name: '生成别名保存候选' })).toBeDisabled();
  await recovery(page).getByRole('button', { name: '停止准备原请求' }).click();
  await expect(recovery(page)).toContainText('服务端已停止准备原请求');
  await page.getByLabel('新增称呼').fill('纠正拒绝后称呼'); await page.getByRole('button', { name: '生成别名保存候选' }).click();
  await expect(page.locator('.management-action-card')).toHaveCount(1);
  expect((await fixture.snapshot()).tables.managementAuthorizationProofs).toHaveLength(0);
});

test('a newly ambiguous retry cannot reuse the rejection evidence from an earlier attempt', async ({ page }) => {
  await login(page); await nav(page, '联系人');
  const commands = (url: URL) => url.pathname.startsWith('/api/management/commands/'); await page.route(commands, unavailable);
  const name = (await read(page, '/api/dashboard')).payees[0].name;
  await page.getByLabel('新增称呼').fill(name); await page.getByRole('button', { name: '生成别名保存候选' }).click();
  await expect(recovery(page)).toContainText('已保留原编号和内容');
  const commandId = await recovery(page).locator('code').innerText();
  await page.unroute(commands, unavailable);
  await page.route(url => url.pathname === '/api/management/actions', route => route.abort('failed'), { times: 1 });
  await recovery(page).getByRole('button', { name: '按原内容重试' }).click();
  await expect(recovery(page)).toContainText('服务端已记录原请求');
  await expect(recovery(page).locator('code')).toHaveText(commandId);
  await page.reload(); await nav(page, '联系人');
  await expect(recovery(page).locator('code')).toHaveText(commandId);
  await expect(recovery(page)).toContainText('服务端已记录原请求');
  expect((await fixture.snapshot()).management.actions).toHaveLength(0);
});

test('a held older goal list cannot remove the goal selected by a newer creation result', async ({ page }) => {
  await login(page); await nav(page, '生活目标'); await expect(page.getByRole('button', { name: '刷新目标', exact: true })).toBeEnabled();
  let release!: () => void, captured!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const ready = new Promise<void>(resolve => { captured = resolve; });
  await page.route(url => url.pathname === '/api/goals', async route => {
    expect(route.request().method()).toBe('GET'); const old = await route.fetch(); expect((await old.json()).goals).toEqual([]);
    captured(); await held; await route.fulfill({ response: old });
  }, { times: 1 });
  await page.getByRole('button', { name: '刷新目标', exact: true }).click(); await ready;
  try {
    const form = page.locator('.goal-create-panel'); await form.getByLabel('目标名称').fill('迟到列表不能切走');
    await form.getByLabel('目标金额（元）').fill('100'); await form.getByLabel('目标完成日期').fill('2026-10-30');
    await form.getByRole('button', { name: '保存并查看计划' }).click();
    await expect(page.locator('.goal-detail-panel')).toContainText('迟到列表不能切走');
  } finally { release(); }
  await expect(page.getByRole('button', { name: '刷新目标', exact: true })).toBeEnabled();
  await expect(page.locator('.goal-detail-panel')).toContainText('迟到列表不能切走');
  expect((await fixture.snapshot()).goals).toHaveLength(1);
});

test('subscription action details expire in place and remain redacted after a fresh same-version observation', async ({ page }) => {
  await login(page); await nav(page, '订阅'); await page.getByRole('button', { name: '准备查询订阅', exact: true }).click();
  await page.locator('.management-action-card').getByRole('button', { name: '确认此管理动作' }).click();
  const subscription = page.locator('.subscription-card').first(); await expect(subscription).toBeVisible();
  const merchant = await subscription.locator('.subscription-card-main strong').innerText();
  const db = new Pool({ connectionString: process.env.TEST_DATABASE_URL ?? 'postgres://bankpilot:bankpilot-local@127.0.0.1:55432/bankpilot', max: 1 });
  try {
    await db.query(`UPDATE "${fixture.schema}".management_query_grants SET expires_at=now()+interval '5 seconds' WHERE user_id=$1`, [fixture.userId]);
  } finally { await db.end(); }
  const prepared = page.waitForResponse(response => new URL(response.url()).pathname === '/api/management/actions'
    && response.request().method() === 'POST' && response.request().postDataJSON()?.spec?.kind === 'SUBSCRIPTION_BLOCK');
  await subscription.getByRole('button', { name: '准备银行拦截扣款' }).click();
  const committed = await prepared; expect(committed.ok(), await committed.text()).toBe(true);
  const before = await fixture.snapshot(), action = before.management.actions.find((item: any) => item.spec.kind === 'SUBSCRIPTION_BLOCK')!;
  const card = page.locator(`[data-action-id="${action.id}"]`);
  await expect(card).toContainText(merchant); expect(action.detailsRedacted).toBe(false); expect(action.detailsAccessExpiresAt).toBeTruthy();
  await expect(card).not.toContainText(merchant, { timeout: 12_000 });
  await expect(card.getByRole('button', { name: '确认此管理动作' })).toBeDisabled();
  const fresh = await read(page, `/api/management/actions/${action.id}`);
  expect(fresh).toMatchObject({ id: action.id, updatedAt: action.updatedAt, detailsRedacted: true }); expect(fresh.detailsAccessExpiresAt).toBeUndefined();
  // Preparing a new query refreshes parent management props without remounting this old card.
  await page.getByRole('button', { name: '重新授权查询', exact: true }).click();
  await expect(page.locator('.management-action-card')).toHaveCount(3);
  await expect(card).not.toContainText(merchant);
  expect((await fixture.snapshot()).tables.managementAuthorizationProofs).toHaveLength(1);
  await attach('same-business-time-different-disclosure.json', { original: action, expired: fresh });
  await page.screenshot({ path: test.info().outputPath('expired-subscription-details.png'), fullPage: true });
});
