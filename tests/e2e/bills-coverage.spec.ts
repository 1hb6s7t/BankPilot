import { randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { createPool, createAuth } from '../../apps/api/src/config.js';
import { createCore, createFinance } from '../../packages/core/src/index.js';

const pool = createPool(), password = 'BankPilot-bill-coverage-e2e!';
let email: string;
test.beforeAll(async () => {
  email = `bill-coverage-${randomUUID()}@example.test`;
  const { user } = await createAuth(pool).api.signUpEmail({ body: { email, password, name: '账单完整性验收' } });
  await createCore(pool).seedDemo({ userId: user.id });
  await createFinance(pool).seedDemo({ userId: user.id });
});
test.afterAll(async () => { await pool.end(); });

test('current partial statement and unprovided month stay distinct on desktop and mobile', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('/'); await page.getByLabel('邮箱地址').fill(email); await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '进入安全工作台' }).click();
  await expect(page.getByRole('textbox', { name: '描述转账需求' })).toBeVisible();
  await page.getByRole('button', { name: '账单', exact: true }).click();
  await expect(page.getByText('该月数据不完整。以下汇总只覆盖已提供的流水，不代表完整月份的收支。')).toBeVisible();
  const result = await page.evaluate(async () => (await fetch('/api/bills')).json());
  expect(result.coverage.status).toBe('partial');
  await page.screenshot({ path: 'docs/evidence/g8c-bills-partial-desktop.png', fullPage: true, animations: 'disabled' });
  await page.getByLabel('选择账单月份').fill('2020-01');
  await expect(page.getByRole('heading', { name: '2020-01 账单尚未提供' })).toBeVisible();
  await expect(page.locator('.bill-summary-grid')).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByText('不能将缺少数据理解为该月没有消费。请选择有账单的月份。')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'docs/evidence/g8c-bills-missing-mobile.png', fullPage: true, animations: 'disabled' });
  const dashboard = await page.evaluate(async () => (await fetch('/api/dashboard')).json());
  expect(dashboard.actions).toEqual([]); expect(dashboard.accounts[0].balanceMinor).toBe('800000');
  expect(errors).toEqual([]);
});
