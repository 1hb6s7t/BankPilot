import { waitForConversationPlan } from './chat-helpers.js';
import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { createPool, createAuth } from '../../apps/api/src/config.js';
import { createCore } from '../../packages/core/src/index.js';

const password = 'BankPilot-e2e-2026!';
let email: string;
let userId: string;
const pool = createPool();

test.beforeAll(async () => {
  email = `e2e-${randomUUID()}@example.test`;
  const result = await createAuth(pool).api.signUpEmail({ body: { email, password, name: '独立验收用户' } });
  userId = result.user.id;
  await createCore(pool).seedDemo({ userId });
});
test.afterAll(async () => { await pool.end(); });

async function dashboard(page: Page) { return page.evaluate(async () => (await fetch('/api/dashboard')).json()); }
async function send(page: Page, message: string) {
  await page.getByRole('textbox', { name: '描述转账需求' }).fill(message);
  const response = waitForConversationPlan(page);
  await page.getByRole('button', { name: '发送请求' }).click();
  const result = await response;
  expect(result.mode).toBe(process.env.BANKPILOT_MODEL_NAME ? 'model' : 'scripted');
  if (result.mode === 'model') expect(result.modelRuns.every((run: { status: string }) => run.status === 'success')).toBe(true);
  expect(result.actions).toHaveLength(1);
  return result.actions[0];
}
test('real UI, worker, database and signed WebAuthn: yellow → red → unknown → reconcile', async ({ page, context }) => {
  test.setTimeout(process.env.BANKPILOT_MODEL_NAME ? 180_000 : 60_000);
  const pageErrors: string[] = [];
  page.on('pageerror', e => pageErrors.push(e.message));
  await page.goto('/');
  await page.getByLabel('邮箱地址').fill(email);
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '进入安全工作台' }).click();
  await expect(page.getByRole('textbox', { name: '描述转账需求' })).toBeVisible();
  expect((await dashboard(page)).accounts[0].balanceMinor).toBe('800000');

  const first = await send(page, '帮我查账单，并给林晓转600元');
  expect(first.tier).toBe('YELLOW');
  await page.getByRole('button', { name: '确认并执行' }).click();
  await expect.poll(async () => (await dashboard(page)).actions.find((a: any) => a.id === first.id)?.status).toBe('SUCCEEDED');
  await expect(page.locator('.action-review .final-state')).toContainText('已完成');
  expect((await dashboard(page)).accounts[0].balanceMinor).toBe('740000');

  const second = await send(page, '给林晓转600元');
  expect(second.tier).toBe('RED');
  const forbidden = await page.evaluate(async a => {
    const response = await fetch(`/api/actions/${a.id}/confirm`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ actionHash: a.actionHash }) });
    return { status: response.status, body: await response.json() };
  }, second);
  expect(forbidden.status).toBe(200);
  expect(forbidden.body.status).toBe('AWAITING_VERIFICATION');
  expect((await dashboard(page)).accounts[0].balanceMinor).toBe('740000');

  // Chromium authenticator generates real key material and signed responses; no server auth result is mocked.
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', { options: {
    protocol: 'ctap2', transport: 'internal', hasResidentKey: true,
    hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true,
  } });
  await page.getByRole('button', { name: '还没有 Passkey？先注册' }).click();
  await expect(page.getByRole('status')).toContainText('Passkey 已注册');
  await page.locator('#fault-mode').selectOption('TIMEOUT_AFTER_COMMIT');
  await page.getByRole('button', { name: '应用', exact: true }).click();
  await page.getByRole('button', { name: 'Passkey 授权', exact: true }).click();
  await expect.poll(async () => (await dashboard(page)).actions.find((a: any) => a.id === second.id)?.status).toBe('UNKNOWN');
  const unknown = await dashboard(page);
  expect(unknown.accounts[0].reservedMinor).toBe('60000');
  const provider = await pool.query('SELECT count(*)::int AS n FROM bankpilot_core.provider_transfers WHERE account_id=$1', [`acc-main-${userId}`]);
  expect(provider.rows[0].n).toBe(2);
  await page.reload();
  await expect(page.getByRole('button', { name: '手动查单' })).toBeVisible();
  await page.getByRole('button', { name: '手动查单' }).click();
  await expect.poll(async () => (await dashboard(page)).actions.find((a: any) => a.id === second.id)?.status).toBe('SUCCEEDED');
  expect((await dashboard(page)).accounts[0].balanceMinor).toBe('680000');
  expect((await dashboard(page)).accounts[0].reservedMinor).toBe('0');
  const settled = await pool.query('SELECT count(*)::int AS n FROM bankpilot_core.provider_transfers WHERE account_id=$1', [`acc-main-${userId}`]);
  expect(settled.rows[0].n).toBe(2);
  await page.screenshot({ path: 'test-results/transfer-desktop.png', fullPage: true, animations: 'disabled' });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(async () => page.locator('.sidebar').evaluate(e => e.getBoundingClientRect().right)).toBeLessThanOrEqual(0);
  await page.getByRole('button', { name: '打开导航菜单' }).click();
  await expect(page.locator('.sidebar')).toHaveClass(/sidebar-open/);
  await page.getByRole('button', { name: '关闭菜单', exact: true }).click();
  await expect.poll(async () => page.locator('.sidebar').evaluate(e => e.getBoundingClientRect().right)).toBeLessThanOrEqual(0);
  await page.screenshot({ path: 'test-results/transfer-mobile.png', fullPage: true, animations: 'disabled' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(pageErrors).toEqual([]);
});
