import { waitForConversationPlan } from './chat-helpers.js';
import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { createPool, createAuth } from '../../apps/api/src/config.js';
import { createCore, createFinance } from '../../packages/core/src/index.js';

const pool = createPool();
const password = 'BankPilot-finance-e2e!';
let email: string;
test.beforeAll(async () => {
  email = `finance-e2e-${randomUUID()}@example.test`;
  const { user } = await createAuth(pool).api.signUpEmail({ body: { email, password, name: '资金计划验收' } });
  await createCore(pool).seedDemo({ userId: user.id });
  await createFinance(pool).seedDemo({ userId: user.id });
});
test.afterAll(async () => { await pool.end(); });

test('bill evidence, confirmed budget editing, live multi-agent refusal and refreshed plan', async ({ page }) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await page.getByLabel('邮箱地址').fill(email);
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '进入安全工作台' }).click();
  await expect(page.getByRole('textbox', { name: '描述转账需求' })).toBeVisible();
  await page.getByRole('button', { name: '账单', exact: true }).click();
  await expect(page.getByRole('heading', { name: '账单分析', exact: true })).toBeVisible();
  await expect(page.locator('.bill-table tbody tr').first()).toBeVisible();
  const report = await page.evaluate(async () => (await fetch('/api/bills')).json());
  expect(report.incomeMinor).toBe('1200000');
  const finding = report.findings.find((f: { kind: string }) => f.kind === 'RECURRING');
  expect(finding).toBeTruthy();
  await page.getByRole('button', { name: `查看原交易 ${finding.transactionIds[1]}`, exact: false }).first().click();
  await expect(page.locator('.bill-row-focused')).toHaveCount(1);
  await page.screenshot({ path: 'test-results/phase2-bills-desktop.png', fullPage: true, animations: 'disabled' });

  await page.getByRole('button', { name: '资金计划', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '最低保留金额（元）', exact: true })).toHaveValue('2000.00');
  await page.getByRole('textbox', { name: '最低保留金额（元）', exact: true }).fill('2500');
  await page.getByRole('button', { name: '确认并保存规则' }).click();
  await expect(page.getByText('资金保护规则已保存，版本 2。')).toBeVisible();
  const funds = await page.evaluate(async () => (await fetch('/api/funds')).json());
  expect(funds.preview.protectedMinor).toBe('550000');
  expect(funds.preview.spendableMinor).toBe('250000');
  await page.screenshot({ path: 'test-results/phase2-funds-desktop.png', fullPage: true, animations: 'disabled' });

  await page.getByRole('button', { name: '返回转账工作台', exact: true }).click();
  await page.getByRole('textbox', { name: '描述转账需求' }).fill('查本月账单，给林晓转4000元，不影响房租和生活费');
  const returned = waitForConversationPlan(page);
  await page.getByRole('button', { name: '发送请求' }).click();
  const plan = await returned;
  expect(plan.mode).toBe(process.env.BANKPILOT_MODEL_NAME ? 'model' : 'scripted');
  expect(plan.actions).toEqual([]);
  expect(plan.fundsPreview).toMatchObject({ allowed: false, protectedMinor: '550000', shortfallMinor: '150000' });
  expect(plan.billReport.expenseMinor).toBe(report.expenseMinor);
  expect(plan.events.filter((e: { status: string }) => e.status === 'started').map((e: { role: string }) => e.role).sort()).toEqual(['bills', 'goal', 'reviewer', 'transfer']);
  await expect(page.getByRole('button', { name: '确认并执行', exact: true })).toHaveCount(0);
  await page.reload();
  await expect(page.locator('.plan-evidence-card').first()).toBeVisible();
  const dashboard = await page.evaluate(async () => (await fetch('/api/dashboard')).json());
  expect(dashboard.latestPlan.taskId).toBe(plan.taskId);
  expect(dashboard.accounts[0].balanceMinor).toBe('800000');
  expect(dashboard.actions).toHaveLength(0);
  await page.screenshot({ path: 'test-results/phase2-plan-desktop.png', fullPage: true, animations: 'disabled' });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(async () => page.locator('.sidebar').evaluate(el => el.getBoundingClientRect().right)).toBeLessThanOrEqual(0);
  await page.getByRole('button', { name: '打开导航菜单' }).click();
  await page.getByRole('button', { name: '资金计划', exact: true }).click();
  await expect(page.getByRole('heading', { name: '资金计划', exact: true })).toBeVisible();
  await page.screenshot({ path: 'test-results/phase2-funds-mobile.png', fullPage: true, animations: 'disabled' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(errors).toEqual([]);
  if (plan.mode === 'model') {
    expect(plan.modelRuns.filter((r: { status: string }) => r.status === 'success')).toHaveLength(4);
    expect(plan.modelRuns.every((r: { model: string }) => r.model === process.env.BANKPILOT_MODEL_NAME)).toBe(true);
  }
});
