import { waitForConversationPlan } from './chat-helpers.js';
import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { createPool, createAuth } from '../../apps/api/src/config.js';
import { createCore } from '../../packages/core/src/index.js';

const pool = createPool();
const password = 'BankPilot-negation-e2e!';
let email: string, userId: string;
test.beforeAll(async () => {
  email = `negation-e2e-${randomUUID()}@example.test`;
  const { user } = await createAuth(pool).api.signUpEmail({ body: { email, password, name: '否定意图独立验收' } });
  userId = user.id;
  await createCore(pool).seedDemo({ userId });
});
test.afterAll(async () => { await pool.end(); });

test('explicit negation returns no draft, authorization, reservation or debit through live UI/API', async ({ page }) => {
  test.setTimeout(150_000);
  await page.goto('/');
  await page.getByLabel('邮箱地址').fill(email);
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '进入安全工作台' }).click();
  const box = page.getByRole('textbox', { name: '描述转账需求' });
  await expect(box).toBeVisible();
  const before = await page.evaluate(async () => (await fetch('/api/dashboard')).json());
  await box.fill('先不要给林晓转账286.45元，我只是在核对金额');
  const response = waitForConversationPlan(page);
  await page.getByRole('button', { name: '发送请求' }).click();
  const plan = await response;
  expect(plan.mode).toBe(process.env.BANKPILOT_MODEL_NAME ? 'model' : 'scripted');
  expect(plan.suggestions).toEqual([]); expect(plan.actions).toEqual([]); expect(plan.clarification).toBeUndefined();
  if (plan.mode === 'model') {
    expect(plan.modelRuns.map((run: { role: string }) => run.role).sort()).toEqual(['reviewer', 'transfer']);
    expect(plan.modelRuns.every((run: { status: string }) => run.status === 'success')).toBe(true);
  }
  await expect(page.getByRole('button', { name: '确认并执行', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Passkey 授权', exact: true })).toHaveCount(0);
  await page.reload();
  const after = await page.evaluate(async () => (await fetch('/api/dashboard')).json());
  expect(after.accounts).toEqual(before.accounts); expect(after.actions).toEqual([]);
  expect(after.latestPlan.taskId).toBe(plan.taskId);
  const provider = await pool.query('SELECT count(*)::int AS n FROM bankpilot_core.provider_transfers WHERE account_id=$1', [`acc-main-${userId}`]);
  expect(provider.rows[0].n).toBe(0);
  await page.screenshot({ path: 'test-results/phase5-negation-desktop.png', fullPage: true, animations: 'disabled' });
});
