import { test, expect, type Page, type BrowserContext, type Route } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { startG8hBrowserApp } from '../fixtures/g8h-browser-app.js';

let fixture: Awaited<ReturnType<typeof startG8hBrowserApp>>;
let contexts: BrowserContext[], faults: string[], errors: string[];
const attach = (name: string, value: unknown) => test.info().attach(name, { body: JSON.stringify(value, null, 2), contentType: 'application/json' });
async function login(page: Page) {
  page.on('pageerror', error => errors.push(error.message)); await page.goto(fixture.origin);
  await page.getByLabel('邮箱地址').fill(fixture.email); await page.getByLabel('密码', { exact: true }).fill(fixture.password);
  await page.getByRole('button', { name: '进入安全工作台' }).click(); await expect(page.getByRole('combobox', { name: '选择聊天' })).toBeEnabled();
}
const nav = (page: Page, name: string) => page.getByRole('button', { name, exact: true }).click();
const localRecovery = (page: Page) => page.getByRole('region', { name: '原请求恢复', exact: true });
const row = (page: Page, id: string) => page.getByRole('article', { name: new RegExp(`请求 ${id}$`) });
const unreadable = (route: Route) => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'G8M_READ_FAULT', message: '故障注入：原请求读取暂不可用。' } }) });
async function read(page: Page, path: string) { const response = await page.request.get(`${fixture.origin}${path}`); expect(response.status()).toBe(200); return response.json(); }
const post = (page: Page, path: string, data: unknown) => page.request.post(`${fixture.origin}${path}`, { data, headers: { origin: fixture.origin } });
async function rejectAlias(page: Page, id = randomUUID()) {
  const dashboard = await read(page, '/api/dashboard');
  const input = { commandId: id, spec: { kind: 'CONTACT_ALIAS_SAVE', payeeId: dashboard.payees[0].id, alias: dashboard.payees[0].name } };
  const response = await post(page, '/api/management/actions', input); expect(response.status(), await response.text()).toBe(409);
  return input;
}
test.beforeEach(async () => { contexts = []; faults = []; errors = []; fixture = await startG8hBrowserApp(); });
test.afterEach(async () => {
  for (const context of contexts) await context.close();
  try {
    await attach('terminal-database.json', await fixture.snapshot());
    await attach('scope.json', { realLoginApiPostgresWorker: true, faultModes: faults, cloudCalls: 0, controlledModelCalls: fixture.calls.length, independentBrowserContexts: contexts.length, schema: fixture.schema });
    expect(errors).toEqual([]); expect(fixture.calls).toHaveLength(0);
  } finally { const cleanup = await fixture.close(); await attach('cleanup.json', cleanup); expect(cleanup).toMatchObject({ success: true, clean: true, errors: [] }); }
});

test('a fresh browser session finds the same prepared request after its original response was lost', async ({ page, browser }) => {
  await login(page); await nav(page, '联系人');
  await page.route(url => url.pathname.startsWith('/api/management/commands/'), unreadable);
  let input: any;
  await page.route(url => url.pathname === '/api/management/actions', async route => {
    input = route.request().postDataJSON(); const result = await route.fetch(); expect(result.ok()).toBe(true);
    faults.push('management_prepare_response_aborted_after_commit'); await route.abort('failed');
  }, { times: 1 });
  await page.getByLabel('新增称呼').fill('换浏览器找回原单'); await page.getByRole('button', { name: '生成别名保存候选' }).click();
  await expect(localRecovery(page)).toContainText('已保留原编号和内容');
  const context = await browser.newContext(); contexts.push(context); const other = await context.newPage(); await login(other);
  expect(await other.evaluate(() => Object.keys(sessionStorage).filter(key => key.startsWith('bankpilot:command-recovery:')))).toEqual([]);
  await nav(other, '请求恢复'); const item = row(other, input.commandId);
  await expect(item).toContainText('已生成原结果'); await item.getByText('核对原请求内容').click(); await expect(item).toContainText('换浏览器找回原单');
  await item.getByRole('button', { name: '查询原请求', exact: true }).click(); await expect(item.locator('.management-action-card')).toHaveCount(1);
  await other.screenshot({ path: test.info().outputPath('server-request-inbox.png'), fullPage: true });
  await other.route(url => url.pathname === '/api/management', unreadable);
  await item.getByRole('button', { name: '查看对应管理页面' }).click();
  await expect(other.locator('.management-action-card')).toContainText('换浏览器找回原单');
  const snapshot = await fixture.snapshot(); expect(snapshot.management.actions).toHaveLength(1); expect(snapshot.tables.preparationRequests).toHaveLength(1);
  expect(snapshot.tables.managementAuthorizationProofs).toHaveLength(0);
  await other.screenshot({ path: test.info().outputPath('fresh-browser-original-action.png'), fullPage: true });
});

test('stopping a request that has not reached the server fences its delayed original POST', async ({ page }) => {
  await login(page); await nav(page, '联系人'); let input: any;
  await page.route(url => url.pathname === '/api/management/actions', async route => { input = route.request().postDataJSON(); faults.push('pre_commit_transport_abort'); await route.abort('failed'); }, { times: 1 });
  await page.getByLabel('新增称呼').fill('迟到请求不得再创建'); await page.getByRole('button', { name: '生成别名保存候选' }).click();
  await expect(localRecovery(page)).toContainText('暂未找到原请求记录');
  await localRecovery(page).getByRole('button', { name: '停止准备原请求' }).click(); await expect(localRecovery(page)).toContainText('服务端已停止准备原请求');
  const late = await post(page, '/api/management/actions', input); expect(late.status(), await late.text()).toBe(409); expect((await late.json()).error.code).toBe('PREPARATION_ABANDONED');
  await nav(page, '请求恢复'); await expect(row(page, input.commandId)).toContainText('已停止准备');
  const snapshot = await fixture.snapshot(); expect(snapshot.management.actions).toHaveLength(0); expect(snapshot.tables.preparationRequests).toHaveLength(1);
  expect(snapshot.tables.preparationRequests[0].state).toBe('ABANDONED'); expect(snapshot.tables.managementAuthorizationProofs).toHaveLength(0);
});

test('a rejected durable request can be stopped from another browser and the original tab observes that tombstone', async ({ page, browser }) => {
  await login(page); await nav(page, '联系人'); const dashboard = await read(page, '/api/dashboard');
  await page.getByLabel('新增称呼').fill(dashboard.payees[0].name); await page.getByRole('button', { name: '生成别名保存候选' }).click();
  await expect(localRecovery(page)).toContainText('服务端已记录原请求'); const id = await localRecovery(page).locator('code').innerText();
  const context = await browser.newContext(); contexts.push(context); const other = await context.newPage(); await login(other); await nav(other, '请求恢复');
  const item = row(other, id); await expect(item).toContainText('待核实或继续准备'); await item.getByRole('button', { name: '停止准备', exact: true }).click();
  await expect(item.locator('.preparation-state')).toHaveText('已停止准备');
  await localRecovery(page).getByRole('button', { name: '查询原请求', exact: true }).click(); await expect(localRecovery(page)).toContainText('服务端已停止准备原请求');
  await expect(page.getByRole('button', { name: '生成别名保存候选' })).toBeEnabled();
  expect((await fixture.snapshot()).management.actions).toHaveLength(0);
});

test('a lost stop reply plus unavailable reads remains unresolved until a later server read after reload', async ({ page }) => {
  await login(page); const input = await rejectAlias(page); await nav(page, '请求恢复'); const item = row(page, input.commandId);
  const requestPath = (url: URL) => url.pathname === `/api/preparation-requests/management/${input.commandId}`;
  await page.route(requestPath, unreadable);
  await page.route(url => url.pathname === `/api/preparation-requests/management/${input.commandId}/abandon`, async route => {
    const stopped = await route.fetch(); expect((await stopped.json()).state).toBe('ABANDONED'); faults.push('stop_response_aborted_after_commit_then_read_503'); await route.abort('failed');
  }, { times: 1 });
  await item.getByRole('button', { name: '停止准备', exact: true }).click(); await expect(item).toContainText('处理结果仍未核实');
  await expect(item.getByRole('button', { name: '按原内容重试' })).toBeDisabled(); await expect(item.getByRole('button', { name: '停止准备', exact: true })).toBeDisabled();
  await page.reload(); await nav(page, '请求恢复'); await expect(row(page, input.commandId).locator('.preparation-state')).toHaveText('已停止准备');
  const late = await post(page, '/api/management/actions', input); expect((await late.json()).error.code).toBe('PREPARATION_ABANDONED');
  expect((await fixture.snapshot()).management.actions).toHaveLength(0);
});

test('a delayed older inbox page cannot reopen a request already stopped on its row', async ({ page }) => {
  await login(page); const input = await rejectAlias(page); await nav(page, '请求恢复'); const item = row(page, input.commandId); await expect(item).toBeVisible();
  let release!: () => void, captured!: () => void; const hold = new Promise<void>(resolve => { release = resolve; }); const ready = new Promise<void>(resolve => { captured = resolve; });
  await page.route(url => url.pathname === '/api/preparation-requests', async route => { const old = await route.fetch(); faults.push('held_pre_stop_inbox_read'); captured(); await hold; await route.fulfill({ response: old }); }, { times: 1 });
  await page.getByRole('button', { name: '查看最新一页' }).click(); await ready;
  try { await item.getByRole('button', { name: '停止准备', exact: true }).click(); await expect(item.locator('.preparation-state')).toHaveText('已停止准备'); } finally { release(); }
  await expect(page.getByRole('button', { name: '查看最新一页' })).toBeEnabled(); await expect(item.locator('.preparation-state')).toHaveText('已停止准备');
  await expect(item.getByRole('button', { name: '按原内容重试' })).toHaveCount(0);
});

test('bounded inbox pagination retries the same failed page without preparing or authorizing anything', async ({ page }) => {
  await login(page); const ids: string[] = [];
  for (let i = 0; i < 25; i++) ids.push((await rejectAlias(page)).commandId);
  const reads: string[] = []; let writes = 0;
  page.on('request', request => { const url = new URL(request.url()); if (url.pathname === '/api/preparation-requests' && request.method() === 'GET') reads.push(url.search); if (request.method() === 'POST' && url.pathname.startsWith('/api/preparation-requests')) writes += 1; });
  await nav(page, '请求恢复'); await expect(page.locator('.preparation-request')).toHaveCount(20);
  const first = await page.locator('.preparation-request-id code').allTextContents();
  await page.route(url => url.pathname === '/api/preparation-requests' && url.searchParams.has('cursor'), unreadable, { times: 1 }); faults.push('next_page_503');
  await page.getByRole('button', { name: '查看下一页' }).click(); await expect(page.getByRole('alert')).toContainText('本页读取失败');
  await expect(page.locator('.preparation-request')).toHaveCount(20); await page.getByRole('button', { name: '重试读取此页' }).click();
  await expect(page.locator('.preparation-request')).toHaveCount(5); const second = await page.locator('.preparation-request-id code').allTextContents();
  expect(new Set([...first, ...second])).toEqual(new Set(ids)); expect(reads.at(-1)).toBe(reads.at(-2)); expect(writes).toBe(0);
  expect((await fixture.snapshot()).management.actions).toHaveLength(0);
});

test('opening an older recovered goal selects that exact original goal and prepared retry creates no extra nodes', async ({ page, browser }) => {
  await login(page); const dashboard = await read(page, '/api/dashboard'); const created: any[] = [];
  for (const title of ['较早的原生活目标', '后来创建的其他目标']) {
    const input = { commandId: randomUUID(), title, accountId: dashboard.accounts[0].id, payeeId: dashboard.payees[0].id, amountMinor: '10000', targetDate: '2026-10-30' };
    const response = await post(page, '/api/goals', input); expect(response.ok(), await response.text()).toBe(true); created.push({ input, goal: await response.json() });
  }
  const before = await fixture.snapshot();
  const context = await browser.newContext(); contexts.push(context); const other = await context.newPage(); await login(other); await nav(other, '请求恢复');
  const item = row(other, created[0].input.commandId); await item.getByRole('button', { name: '查询原请求', exact: true }).click();
  await item.getByRole('button', { name: '查看生活目标' }).click(); await expect(other.locator('.goal-detail-panel')).toContainText('较早的原生活目标');
  await expect(other.locator('.goal-detail-panel')).not.toContainText('后来创建的其他目标');
  const replay = await post(other, `/api/preparation-requests/goal/${created[0].input.commandId}/retry`, {}); expect(replay.ok(), await replay.text()).toBe(true);
  const after = await fixture.snapshot(); expect(after.tables.goalNodeIntents).toEqual(before.tables.goalNodeIntents); expect(after.tables.actions).toEqual(before.tables.actions);
  expect(after.tables.authorizationProofs).toHaveLength(0);
  await other.screenshot({ path: test.info().outputPath('older-goal-selected.png'), fullPage: true });
});

test('a fresh browser can read the original redemption candidate without replaying preparation or strong authorization', async ({ page, browser }) => {
  await login(page); const investments = await read(page, '/api/investments'), position = investments.positions.find((value: any) => value.productId === 'synthetic-t2');
  const input = { commandId: randomUUID(), positionId: position.id, amountMinor: '12550', expectedVersion: position.version };
  const response = await post(page, '/api/investments/redemptions', input); expect(response.ok(), await response.text()).toBe(true); const action = await response.json();
  const context = await browser.newContext(); contexts.push(context); const other = await context.newPage(); await login(other); await nav(other, '请求恢复');
  const item = row(other, input.commandId); await item.getByRole('button', { name: '查询原请求', exact: true }).click();
  await expect(item.locator('.investment-action-card')).toContainText('125.50');
  const snapshot = await fixture.snapshot(); expect(snapshot.investment.actions.map((value: any) => value.id)).toEqual([action.id]);
  expect(snapshot.tables.investmentAuthorizationProofs).toHaveLength(0); expect(snapshot.tables.providerRedemptions).toHaveLength(0);
});
