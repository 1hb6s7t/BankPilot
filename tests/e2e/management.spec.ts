import { waitForConversationPlan } from './chat-helpers.js';
import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { createPool, createAuth } from '../../apps/api/src/config.js';
import { createCore, createFinance, createManagement } from '../../packages/core/src/index.js';

const pool = createPool();
test.use({ actionTimeout: 15_000 });
const password = 'BankPilot-management-e2e!';
let email: string;
test.beforeAll(async () => {
  email = `management-e2e-${randomUUID()}@example.test`;
  const { user } = await createAuth(pool).api.signUpEmail({ body: { email, password, name: '联系人卡片订阅验收' } });
  const actor = { userId: user.id };
  await createCore(pool).seedDemo(actor);
  await createFinance(pool).seedDemo(actor);
  await createManagement(pool).seedDemo(actor);
});
test.afterAll(async () => { await pool.end(); });
const dashboard = (page: Page) => page.evaluate(async () => (await fetch('/api/dashboard')).json());
const management = (page: Page) => page.evaluate(async () => (await fetch('/api/management')).json());

test('confirmed personal alias, signed card changes and distinct subscription cancellation/blocking', async ({ page, context }) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await page.getByLabel('邮箱地址').fill(email);
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '进入安全工作台' }).click();
  await expect(page.getByRole('textbox', { name: '描述转账需求' })).toBeVisible();

  await page.getByRole('button', { name: '联系人', exact: true }).click();
  await page.getByRole('combobox', { name: '收款人', exact: true }).selectOption('payee-lin');
  await page.getByLabel('新增称呼').fill('房东');
  await page.getByRole('button', { name: '生成别名保存候选' }).click();
  await expect(page.getByRole('button', { name: '确认此管理动作' })).toBeVisible();
  expect((await dashboard(page)).payees.find((p: any) => p.id === 'payee-lin').aliases).not.toContain('房东');
  await page.getByRole('button', { name: '确认此管理动作' }).click();
  await expect.poll(async () => (await dashboard(page)).payees.find((p: any) => p.id === 'payee-lin').aliases).toContain('房东');
  await expect(page.locator('.management-action-status')).toHaveText('已完成');
  await page.screenshot({ path: 'test-results/phase3-contacts-desktop.png', fullPage: true, animations: 'disabled' });

  await page.getByRole('button', { name: '卡片', exact: true }).click();
  const card = (await management(page)).cards[0];
  const cardPanel = page.locator('.synthetic-card').filter({ hasText: card.maskedNumber });
  await cardPanel.getByRole('button', { name: '准备挂失' }).click();
  await expect(page.getByRole('button', { name: 'Passkey 强验证', exact: true })).toBeVisible();
  expect((await management(page)).cards[0].status).toBe('ACTIVE');
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', { options: {
    protocol: 'ctap2', transport: 'internal', hasResidentKey: true,
    hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true,
  } });
  await page.getByRole('button', { name: '还没有 Passkey？先注册' }).click();
  await expect(page.locator('.management-action-card').getByRole('status')).toContainText('Passkey 已注册');
  await page.getByRole('button', { name: 'Passkey 强验证', exact: true }).click();
  await expect.poll(async () => (await management(page)).cards[0].status).toBe('LOST');
  await expect(cardPanel.getByRole('button', { name: '准备解挂' })).toBeVisible();
  await page.screenshot({ path: 'test-results/phase3-card-desktop.png', fullPage: true, animations: 'disabled' });
  await cardPanel.getByRole('button', { name: '准备解挂' }).click();
  await page.getByRole('button', { name: 'Passkey 强验证', exact: true }).click();
  await expect.poll(async () => (await management(page)).cards[0].status).toBe('ACTIVE');

  await page.getByRole('button', { name: '订阅', exact: true }).click();
  await expect(page.locator('.subscription-card')).toHaveCount(0);
  await page.getByRole('button', { name: '准备查询订阅' }).click();
  await expect(page.getByRole('button', { name: '确认此管理动作' })).toBeVisible();
  await expect(page.locator('.subscription-card')).toHaveCount(0);
  await page.getByRole('button', { name: '确认此管理动作' }).click();
  await expect(page.locator('.subscription-card')).toHaveCount(2);
  const grant = (await management(page)).subscriptionQueryActionId;
  const snapshot = await page.evaluate(async id => (await fetch(`/api/subscriptions?queryActionId=${encodeURIComponent(id)}`)).json(), grant);
  const cancellable = snapshot.items.find((item: any) => item.cancellationSupported);

  // A real cloud planner proposes a management action after the user's separately confirmed query.
  await page.getByRole('button', { name: '转账工作台', exact: true }).click();
  await page.getByRole('textbox', { name: '描述转账需求' }).fill(`取消${cancellable.merchant}订阅`);
  const returned = waitForConversationPlan(page);
  await page.getByRole('button', { name: '发送请求' }).click();
  const plan = await returned;
  expect(plan.mode).toBe(process.env.BANKPILOT_MODEL_NAME ? 'model' : 'scripted');
  expect(plan.actions).toEqual([]);
  expect(plan.managementActions).toHaveLength(1);
  expect(plan.managementActions[0]).toMatchObject({ status: 'AWAITING_CONFIRMATION', spec: { kind: 'SUBSCRIPTION_CANCEL', subscriptionId: cancellable.id } });
  if (plan.mode === 'model') expect(plan.modelRuns.every((run: any) => run.status === 'success')).toBe(true);
  await expect(page.locator('.management-plan-actions .management-action-details')).toContainText(cancellable.merchant);
  await page.locator('.management-plan-actions').getByRole('button', { name: '确认此管理动作' }).click();
  await expect.poll(async () => (await management(page)).actions.find((a: any) => a.id === plan.managementActions[0].id)?.status).toBe('SUCCEEDED');
  await page.reload();
  await expect(page.locator('.management-plan-actions .management-action-status')).toHaveText('已完成');
  expect((await dashboard(page)).latestPlan.taskId).toBe(plan.taskId);
  await page.screenshot({ path: 'test-results/phase3-plan-desktop.png', fullPage: true, animations: 'disabled' });

  await page.getByRole('button', { name: '订阅', exact: true }).click();
  await expect(page.locator('.subscription-card')).toHaveCount(0);
  await page.getByRole('button', { name: '准备查询订阅' }).click();
  await page.getByRole('button', { name: '确认此管理动作' }).click();
  await expect(page.locator('.subscription-card')).toHaveCount(2);
  const cancelled = page.locator('.subscription-card').filter({ hasText: cancellable.merchant });
  await expect(cancelled).toContainText('已取消');
  await expect(cancelled).toContainText('允许扣款');
  const other = snapshot.items.find((item: any) => !item.cancellationSupported);
  const blocked = page.locator('.subscription-card').filter({ hasText: other.merchant });
  await expect(blocked).toContainText('请联系商户办理');
  await blocked.getByRole('button', { name: '准备银行拦截扣款' }).click();
  await page.getByRole('button', { name: '确认此管理动作' }).click();
  await expect(blocked.locator('.subscription-status-grid')).toContainText('有效');
  await expect(blocked.locator('.subscription-status-grid')).toContainText('已拦截');
  expect((await dashboard(page)).accounts[0].balanceMinor).toBe('800000');
  await page.screenshot({ path: 'test-results/phase3-subscriptions-desktop.png', fullPage: true, animations: 'disabled' });
  await page.getByRole('button', { name: '重新授权查询', exact: true }).click();
  await expect(page.locator('.subscription-card')).toHaveCount(0);
  await page.getByRole('button', { name: '确认此管理动作' }).click();
  await expect(page.locator('.subscription-card')).toHaveCount(2);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(async () => page.locator('.sidebar').evaluate(el => el.getBoundingClientRect().right)).toBeLessThanOrEqual(0);
  await page.screenshot({ path: 'test-results/phase3-subscriptions-mobile.png', fullPage: true, animations: 'disabled' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});
