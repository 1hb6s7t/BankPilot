import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { createPool, createAuth } from '../../apps/api/src/config.js';
import { createCore, createFinance, createManagement, createInvestment } from '../../packages/core/src/index.js';
import type { ConversationCommand, ConversationHistory } from '../../packages/contracts/src/conversations.js';

const pool = createPool(), password = 'BankPilot-conversations-e2e!';
const users: { id: string; email: string }[] = [];
test.beforeAll(async () => {
  for (let i = 0; i < 2; i++) {
    const email = `conversation-e2e-${randomUUID()}@example.test`;
    const { user } = await createAuth(pool).api.signUpEmail({ body: { email, password, name: `会话恢复验收${i}` } });
    users.push({ id: user.id, email }); const actor = { userId: user.id };
    await createCore(pool).seedDemo(actor); await createFinance(pool).seedDemo(actor);
    await createManagement(pool).seedDemo(actor); await createInvestment(pool).seedDemo(actor);
  }
});
test.afterAll(async () => { await pool.end(); });
async function login(page: Page, index = 0) {
  await page.goto('/'); await page.getByLabel('邮箱地址').fill(users[index]!.email);
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '进入安全工作台' }).click();
  await expect(page.getByRole('combobox', { name: '选择聊天' })).toBeEnabled();
}
async function readHistory(page: Page, cid: string): Promise<ConversationHistory> {
  const response = await page.request.get(`/api/conversations/${cid}/messages`); expect(response.status()).toBe(200); return response.json();
}
async function waitComplete(page: Page, cid: string, commandId: string): Promise<ConversationCommand> {
  let command!: ConversationCommand;
  await expect.poll(async () => {
    const response = await page.request.get(`/api/conversations/${cid}/commands/${commandId}`);
    expect(response.status()).toBe(200); command = await response.json();
    return command.status === 'complete' || command.status === 'failed';
  }, { timeout: 190_000, intervals: [100, 300, 1000] }).toBe(true);
  expect(command.status, command.lastErrorCode).toBe('complete'); return command;
}
async function sendSaved(page: Page, text: string) {
  await page.getByRole('textbox', { name: '描述转账需求' }).fill(text);
  const saved = page.waitForResponse(r => /\/api\/conversations\/[^/]+\/messages$/.test(r.url()) && r.request().method() === 'POST');
  await page.getByRole('button', { name: '发送请求' }).click();
  const response = await saved; expect(response.status()).toBe(202); return response.json();
}

test('lost acceptance response, refresh during planning and sign-in restore the same saved request', async ({ page }) => {
  test.setTimeout(240_000);
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  await login(page);
  const text = '给林晓转账317.25元，备注会话恢复';
  let accepted: any;
  await page.route('**/api/conversations/*/messages', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    const response = await route.fetch(); expect(response.status()).toBe(202); accepted = await response.json();
    // The server has committed the original input; the browser loses only the response.
    await route.abort('connectionreset'); await page.unroute('**/api/conversations/*/messages');
  });
  await page.getByRole('textbox', { name: '描述转账需求' }).fill(text);
  await page.getByRole('button', { name: '发送请求' }).click();
  await expect.poll(() => Boolean(accepted), { timeout: 15000 }).toBe(true);
  const cid = accepted.command.conversationId, commandId = accepted.command.commandId;
  expect(accepted.command.status).toBe('pending');
  await page.reload();
  await expect(page.locator('.chat-message-user').filter({ hasText: text })).toHaveCount(1);
  const complete = await waitComplete(page, cid, commandId);
  await test.info().attach('g8-response-loss-command.json', { body: JSON.stringify(complete, null, 2), contentType: 'application/json' });
  expect(complete.result?.actions).toHaveLength(1);
  expect(complete.result?.actions?.[0]).toMatchObject({ amountMinor: '31725', memo: '会话恢复', status: 'AWAITING_CONFIRMATION' });
  await expect(page.getByRole('button', { name: '确认并执行', exact: true })).toBeVisible({ timeout: 15000 });
  const first = await readHistory(page, cid);
  expect(first.messages).toHaveLength(2); expect(first.commands).toHaveLength(1);
  await page.getByRole('button', { name: '退出登录', exact: true }).click();
  await login(page);
  await expect(page.locator('.chat-message-user').filter({ hasText: text })).toHaveCount(1);
  const restored = await readHistory(page, cid);
  expect(restored.messages).toEqual(first.messages);
  expect(restored.commands[0]?.result?.modelRuns).toEqual(first.commands[0]?.result?.modelRuns);
  const dashboard = await (await page.request.get('/api/dashboard')).json();
  expect(dashboard.actions).toHaveLength(1); expect(dashboard.accounts[0]).toMatchObject({ balanceMinor: '800000', reservedMinor: '0' });
  expect((await pool.query('SELECT count(*)::int AS n FROM bankpilot_core.provider_transfers WHERE account_id=$1', [`acc-main-${users[0]!.id}`])).rows[0].n).toBe(0);
  await test.info().attach('g8-response-loss-history.json', { body: JSON.stringify(restored, null, 2), contentType: 'application/json' });
  await page.screenshot({ path: 'test-results/phase8-chat-recovery-desktop.png', fullPage: true, animations: 'disabled' });
  expect(errors).toEqual([]);
});

test('explicit payee clarification survives refresh and preserves the original amount and revision', async ({ page }) => {
  test.setTimeout(390_000); await login(page);
  await page.getByRole('button', { name: '新建聊天', exact: true }).click();
  await expect(page.getByRole('combobox', { name: '选择聊天' })).toBeEnabled();
  const saved = await sendSaved(page, '给张伟转账300元');
  const cid = saved.command.conversationId;
  const parent = await waitComplete(page, cid, saved.command.commandId);
  expect(parent.result?.actions).toEqual([]); expect(parent.clarification?.requestedSlots).toEqual(['payee']);
  await page.reload(); await expect(page.getByRole('button', { name: '继续补充此请求', exact: true })).toBeVisible({ timeout: 15000 });
  await page.getByRole('button', { name: '继续补充此请求', exact: true }).click();
  const selected = parent.clarification!.candidates.find(c => c.maskedNumber.endsWith('3361'))!;
  expect(selected).toBeTruthy();
  await page.getByRole('combobox', { name: '补充收款账户' }).selectOption(selected.id);
  const accepted = page.waitForResponse(r => /\/api\/conversations\/[^/]+\/messages$/.test(r.url()) && r.request().method() === 'POST');
  await page.getByRole('button', { name: '提交补充', exact: true }).click();
  const response = await accepted; expect(response.status()).toBe(202); const next = await response.json();
  expect(next.command).toMatchObject({ rootCommandId: parent.commandId, parentCommandId: parent.commandId, revision: 1 });
  const complete = await waitComplete(page, cid, next.command.commandId);
  await test.info().attach('g8-clarification-command.json', { body: JSON.stringify(complete, null, 2), contentType: 'application/json' });
  expect(complete.result?.actions).toHaveLength(1);
  expect(complete.result?.actions?.[0]).toMatchObject({ payeeId: selected.id, amountMinor: '30000', status: 'AWAITING_CONFIRMATION' });
  expect(complete.planningInput.typed?.slots).toMatchObject({ payeeId: selected.id, amountMinor: '30000' });
  expect(complete.result?.modelRuns?.some(run => run.role === 'semantic_intent')).toBe(false);
  const history = await readHistory(page, cid); expect(history.messages).toHaveLength(4);
  expect(history.clarifications[0]).toMatchObject({ status: 'resolved', resolvedByCommandId: complete.commandId });
  await test.info().attach('g8-clarification-history.json', { body: JSON.stringify(history, null, 2), contentType: 'application/json' });
  await expect(page.getByRole('button', { name: '确认并执行', exact: true })).toBeVisible({ timeout: 15000 });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/phase8-chat-clarification-mobile.png', fullPage: true, animations: 'disabled' });
});

test('signing in as another owner clears history and rejects old conversation IDs', async ({ page }) => {
  test.setTimeout(45000); await login(page);
  const { conversations } = await (await page.request.get('/api/conversations')).json();
  expect(conversations.length).toBeGreaterThan(0);
  const oldId = conversations[0].id;
  await page.getByRole('button', { name: '退出登录', exact: true }).click(); await login(page, 1);
  await expect(page.locator('.chat-message-user')).toHaveCount(0);
  expect((await page.request.get(`/api/conversations/${oldId}/messages`)).status()).toBe(404);
  const { conversations: own } = await (await page.request.get('/api/conversations')).json();
  expect(own.some((item: { id: string }) => item.id === oldId)).toBe(false);
  const dashboard = await (await page.request.get('/api/dashboard')).json(); expect(dashboard.actions).toEqual([]);
});
