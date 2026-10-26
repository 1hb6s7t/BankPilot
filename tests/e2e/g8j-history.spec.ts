import { test, expect, type Page, type Request } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { startG8hBrowserApp } from '../fixtures/g8h-browser-app.js';
import { withTransaction } from '../../packages/core/src/database.js';
import { createConversationService } from '../../apps/api/src/conversations.js';
import type { AcceptedConversationMessage, ConversationCommand } from '../../packages/contracts/src/conversations.js';

let fixture: Awaited<ReturnType<typeof startG8hBrowserApp>>;
let archive: Pool;
let attachment = 0;
const attach = (name: string, value: unknown) => test.info().attach(`${++attachment}-${name}`, { body: JSON.stringify(value, null, 2), contentType: 'application/json' });
const address = (path: string) => new URL(path, fixture.origin).href;
async function read(page: Page, path: string) { const response = await page.request.get(address(path)); expect(response.status()).toBe(200); return response.json(); }
async function login(page: Page) {
  await page.goto(fixture.origin); await page.getByLabel('邮箱地址').fill(fixture.email);
  await page.getByLabel('密码', { exact: true }).fill(fixture.password);
  await page.getByRole('button', { name: '进入安全工作台' }).click();
  await expect(page.getByRole('combobox', { name: '选择聊天' })).toBeEnabled();
}
const cid = (page: Page) => page.getByRole('combobox', { name: '选择聊天' }).inputValue();
const messageCount = (page: Page) => page.locator('.persistent-chat .chat-message');
const reload = (page: Page) => page.getByRole('button', { name: '重载聊天历史', exact: true }).click();
async function seedMessages(conversationId: string, count: number, prefix: string) {
  // Archive-size fixture only: no fabricated plan, authorization, action, or receipt.
  await withTransaction(archive, async tx => {
    const row = (await tx.query('SELECT next_sequence FROM bp_conversations WHERE user_id=$1 AND id=$2 FOR UPDATE', [fixture.userId, conversationId])).rows[0];
    const first = Number(row.next_sequence) + 1;
    for (let index = 0; index < count; index++) {
      await tx.query("INSERT INTO bp_chat_messages(id,user_id,conversation_id,sequence,role,text,kind) VALUES($1,$2,$3,$4,'assistant',$5,'result')",
        [randomUUID(), fixture.userId, conversationId, first + index, `${prefix} ${String(index + 1).padStart(3, '0')}`]);
    }
    await tx.query('UPDATE bp_conversations SET next_sequence=next_sequence+$3,version=version+$3,updated_at=now() WHERE user_id=$1 AND id=$2', [fixture.userId, conversationId, count]);
  });
}
async function loadAll(page: Page, expected: number) {
  const older = page.getByRole('button', { name: '加载更早消息', exact: true });
  for (let n = 0; n < 12 && await older.count(); n++) {
    const before = await messageCount(page).count(); await older.click();
    await expect.poll(() => messageCount(page).count()).toBeGreaterThan(before);
  }
  await expect(older).toHaveCount(0); await expect(messageCount(page)).toHaveCount(expected);
}
async function send(page: Page, amount: string) {
  const message = `给林晓转账${amount}元`;
  fixture.configureScenario({ message, semanticDraft: { tasks: [{ operation: 'transfer', disposition: 'request', scope: { source: 'whole_message' }, amount: { text: `${amount}元` }, entity: { kind: 'payee', id: 'payee-lin', mention: { text: '林晓' } } }] } });
  await page.getByRole('textbox', { name: '描述转账需求' }).fill(message);
  const response = page.waitForResponse(value => /\/api\/conversations\/[^/]+\/messages$/.test(value.url()) && value.request().method() === 'POST');
  await page.getByRole('button', { name: '发送请求' }).click();
  const acceptedResponse = await response; expect(acceptedResponse.status()).toBe(202);
  const accepted: AcceptedConversationMessage = await acceptedResponse.json();
  let command!: ConversationCommand;
  await expect.poll(async () => {
    command = await read(page, `/api/conversations/${accepted.command.conversationId}/commands/${accepted.command.commandId}`);
    return command.status;
  }, { timeout: 30_000 }).toBe('complete');
  expect(command.failure).toBeUndefined(); expect(command.result?.mode).toBe('model');
  expect(command.result?.actions).toHaveLength(1); await attach('completed-plan.json', command);
  await expect(page.getByRole('combobox', { name: '选择聊天' })).toBeEnabled();
  return command;
}

test.beforeEach(async () => {
  attachment = 0; fixture = await startG8hBrowserApp();
  archive = new Pool({ connectionString: process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? 'postgres://bankpilot:bankpilot-local@127.0.0.1:55432/bankpilot', options: `-c search_path=${fixture.schema}`, application_name: `${fixture.schema}_archive`, max: 1 });
});
test.afterEach(async () => {
  try {
    await attach('terminal-database.json', await fixture.snapshot());
    await attach('model-calls.json', fixture.calls);
    await attach('scope.json', { realLogin: true, realApiPostgresWorker: true, seededArchiveMessages: true, controlledModelHttpOnly: true, cloudCalls: 0, schema: fixture.schema });
  } finally {
    await archive.end(); const cleanup = await fixture.close(); await attach('cleanup.json', cleanup);
    expect(cleanup).toMatchObject({ success: true, clean: true, errors: [] });
  }
});

test('long history keeps the selected original plan and its executed receipt through pagination and re-login', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await login(page); const conversationId = await cid(page);
  const first = await send(page, '307.50'); const firstAction = first.result!.actions![0] as any;
  await page.getByRole('button', { name: '确认并执行', exact: true }).click();
  await expect.poll(async () => (await read(page, '/api/dashboard')).actions.find((a: any) => a.id === firstAction.id)?.status).toBe('SUCCEEDED');
  const executed = (await read(page, '/api/dashboard')).actions.find((a: any) => a.id === firstAction.id);
  await expect(page.getByRole('region', { name: '账户概览' })).toContainText('7,692.50');
  await seedMessages(conversationId, 155, '归档片段');
  const second = await send(page, '600.00');
  expect(second.requestSequence).toBeGreaterThan(first.requestSequence!);
  // Same timestamp is a real DB condition; request message sequence remains authoritative.
  await archive.query("UPDATE bp_plan_commands SET created_at='2026-10-23T00:00:00Z',updated_at='2026-10-23T00:00:00Z' WHERE user_id=$1 AND conversation_id=$2", [fixture.userId, conversationId]);
  await reload(page); await expect(page.locator('.action-review')).toContainText('600.00');
  const viewPlans = page.getByRole('button', { name: '查看计划 · 刷新动作状态', exact: true });
  // G8K only returns plans associated with loaded timeline messages. Load the
  // original request explicitly; opening history must still never plan or pay.
  await loadAll(page, 159);
  await expect(viewPlans).toHaveCount(2); await viewPlans.first().click();
  await expect(page.locator('.action-review .action-receipt')).toContainText(executed.receipt.providerTransactionId);
  await expect(page.locator('.action-review')).toContainText('307.50');
  await reload(page);
  await expect(page.locator('.action-review .action-receipt')).toContainText(executed.receipt.providerTransactionId);
  await loadAll(page, 159);
  for (const index of [1, 50, 100, 155]) await expect(page.locator('.chat-message').filter({ hasText: `归档片段 ${String(index).padStart(3, '0')}` })).toHaveCount(1);
  await expect(page.locator('.action-review .action-receipt')).toContainText(executed.receipt.providerTransactionId);
  await page.locator('.action-review').screenshot({ path: test.info().outputPath('original-receipt-after-gap-fill.png'), animations: 'disabled' });
  await page.screenshot({ path: test.info().outputPath('original-plan-after-gap-fill.png'), fullPage: false, animations: 'disabled' });
  const calls = fixture.calls.length;
  await page.reload(); await expect(page.locator('.action-review')).toContainText('600.00');
  await loadAll(page, 159);
  await viewPlans.first().click(); await expect(page.locator('.action-review .action-receipt')).toContainText(executed.receipt.providerTransactionId);
  await page.getByRole('button', { name: '退出登录', exact: true }).click(); await login(page);
  expect(await cid(page)).toBe(conversationId);
  await loadAll(page, 159);
  await viewPlans.first().click(); await expect(page.locator('.action-review .action-receipt')).toContainText(executed.receipt.providerTransactionId);
  const snapshot = await fixture.snapshot();
  expect(snapshot.providerTransfers).toHaveLength(1); expect(snapshot.ledgerEntries).toHaveLength(2);
  expect(snapshot.tables.authorizationProofs).toHaveLength(1); expect(snapshot.tables.actions).toHaveLength(2);
  expect(snapshot.dashboard.accounts[0]).toMatchObject({ balanceMinor: '769250', reservedMinor: '0' });
  expect(fixture.calls).toHaveLength(calls); expect(errors).toEqual([]);
  const saved = await fixture.saved(conversationId); expect(saved.messages).toHaveLength(159);
  expect(saved.messages.map(row => Number(row.sequence))).toEqual(Array.from({ length: 159 }, (_, i) => i + 1));
  await attach('contiguous-history.json', { conversationId, messages: saved.messages.map(row => ({ id: row.id, sequence: row.sequence })), firstCommandId: first.commandId, secondCommandId: second.commandId, originalReceipt: executed.receipt, modelCallsBeforeAndAfterReadOnlyRecovery: calls });
});

test('failed first read and failed older page remain recoverable; a later 110-message refresh leaves no permanent gap', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await login(page); const conversationId = await cid(page);
  await seedMessages(conversationId, 115, '最初历史');
  await page.getByRole('button', { name: '新建聊天', exact: true }).click();
  await expect(page.getByRole('combobox', { name: '选择聊天' })).toBeEnabled();
  const otherId = await cid(page); expect(otherId).not.toBe(conversationId);
  await page.route(url => url.pathname === `/api/conversations/${conversationId}/messages` && !url.searchParams.has('beforeSequence'), route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: '历史读取暂时中断', code: 'TEST_READ_INTERRUPTED' } }) }), { times: 1 });
  await page.getByRole('combobox', { name: '选择聊天' }).selectOption(conversationId);
  await expect(page.locator('.chat-error')).toBeVisible(); await expect(messageCount(page)).toHaveCount(0);
  await reload(page); await expect(messageCount(page)).toHaveCount(50);
  const older = page.getByRole('button', { name: '加载更早消息', exact: true }); await expect(older).toBeEnabled();
  await page.route(url => url.pathname === `/api/conversations/${conversationId}/messages` && url.searchParams.has('beforeSequence'), route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: '历史分页读取暂时中断', code: 'TEST_PAGE_INTERRUPTED' } }) }), { times: 1 });
  await older.click(); await expect(page.locator('.chat-error')).toBeVisible(); await expect(messageCount(page)).toHaveCount(50); await expect(older).toBeEnabled();
  await loadAll(page, 115);
  await seedMessages(conversationId, 110, '后来历史');
  await reload(page); await expect(messageCount(page)).toHaveCount(165); await expect(older).toBeEnabled();
  await loadAll(page, 225);
  for (const index of [1, 50, 60, 61, 110]) await expect(page.locator('.chat-message').filter({ hasText: `后来历史 ${String(index).padStart(3, '0')}` })).toHaveCount(1);
  // An old pending command remains visible even outside the newest message page.
  const pending = await createConversationService(archive).accept({ userId: fixture.userId }, conversationId, { clientMessageId: randomUUID(), text: '待恢复的原请求' });
  await seedMessages(conversationId, 55, '再追加历史');
  await page.reload(); await expect(page.getByRole('button', { name: '继续原请求', exact: true })).toBeEnabled();
  expect((await fixture.savedCommand(pending.command.commandId)).status).toBe('pending');
  await page.getByRole('combobox', { name: '选择聊天' }).selectOption(otherId);
  await expect(messageCount(page)).toHaveCount(0); await expect(page.getByRole('button', { name: '继续原请求', exact: true })).toHaveCount(0);
  await page.getByRole('combobox', { name: '选择聊天' }).selectOption(conversationId);
  await expect(page.getByRole('button', { name: '继续原请求', exact: true })).toBeEnabled();
  expect(fixture.calls).toHaveLength(0); expect(errors).toEqual([]);
  const saved = await fixture.saved(conversationId);
  expect(saved.messages).toHaveLength(281); expect(saved.commands).toHaveLength(1);
  await attach('read-only-recovery.json', { conversationId, messageCount: saved.messages.length, pendingCommandId: pending.command.commandId, pendingState: saved.commands[0].status, cloudCalls: 0, controlledModelCalls: fixture.calls.length });
});

test('a delayed old dashboard response cannot reverse the balance after a completed original receipt', async ({ page }) => {
  await login(page); const plan = await send(page, '307.50'), action = plan.result!.actions![0] as any;
  let release!: () => void, captured!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const held = new Promise<void>(resolve => { captured = resolve; });
  let oldRequest: Request | undefined;
  const firstRoute = (url: URL) => url.pathname === '/api/dashboard';
  await page.route(firstRoute, async route => {
    oldRequest = route.request(); const response = await route.fetch();
    const snapshot = await response.json(); expect(snapshot.accounts[0].balanceMinor).toBe('800000');
    captured(); await gate; await route.fulfill({ response });
  }, { times: 1 });
  try {
    await page.getByRole('button', { name: '刷新状态', exact: true }).click(); await held;
    await page.getByRole('button', { name: '确认并执行', exact: true }).click();
    await expect.poll(async () => (await read(page, '/api/dashboard')).actions.find((a: any) => a.id === action.id)?.status).toBe('SUCCEEDED');
    // Full-dashboard reads may be serialized; the authoritative transaction and
    // detail receipt must finish before releasing the genuinely older response.
    await page.getByRole('button', { name: '查看计划 · 刷新动作状态', exact: true }).click();
    await expect(page.locator('.action-review .action-receipt')).toContainText('307.50');
    const delivered = page.waitForResponse(response => response.request() === oldRequest);
    release(); await (await delivered).finished();
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(page.getByRole('region', { name: '账户概览' })).toContainText('7,692.50');
    await expect(page.locator('.action-review .action-receipt')).toContainText('307.50');
    const snapshot = await fixture.snapshot(); expect(snapshot.providerTransfers).toHaveLength(1); expect(snapshot.ledgerEntries).toHaveLength(2);
    await attach('delayed-dashboard-original-receipt.json', { delayedRealSnapshotBalance: '800000', finalBalance: snapshot.dashboard.accounts[0].balanceMinor, originalActionId: action.id, providerTransferCount: snapshot.providerTransfers.length });
    await page.screenshot({ path: test.info().outputPath('balance-and-original-receipt.png'), fullPage: true, animations: 'disabled' });
  } finally { release(); await page.unroute(firstRoute); }
});

test('lost confirmation response recovers the original balance and receipt through reads without resending authorization', async ({ page }) => {
  await login(page); const plan = await send(page, '307.50'), action = plan.result!.actions![0] as any;
  let authorizationRequests = 0;
  const path = `/api/actions/${action.id}/confirm`;
  page.on('request', request => { if (new URL(request.url()).pathname === path && request.method() === 'POST') authorizationRequests++; });
  await page.route(url => url.pathname === path, async route => {
    const committed = await route.fetch(); expect(committed.status()).toBe(200);
    expect((await committed.json()).id).toBe(action.id);
    await route.abort('failed');
  }, { times: 1 });
  await page.getByRole('button', { name: '确认并执行', exact: true }).click();
  await expect.poll(async () => (await read(page, '/api/dashboard')).actions.find((a: any) => a.id === action.id)?.status).toBe('SUCCEEDED');
  await expect(page.getByRole('region', { name: '账户概览' })).toContainText('7,692.50');
  await expect(page.locator('.action-review .action-receipt')).toContainText('307.50');
  await expect(page.getByRole('status').filter({ hasText: '无法连接本地 API' })).toBeVisible();
  const snapshot = await fixture.snapshot();
  expect(authorizationRequests).toBe(1); expect(snapshot.providerTransfers).toHaveLength(1);
  expect(snapshot.ledgerEntries).toHaveLength(2); expect(snapshot.tables.authorizationProofs).toHaveLength(1);
  await attach('unknown-confirmation-response-read-only-recovery.json', { authorizationRequests, balanceMinor: snapshot.dashboard.accounts[0].balanceMinor, receipt: snapshot.providerTransfers[0].receipt });
});
