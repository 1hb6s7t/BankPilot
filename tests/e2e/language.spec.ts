import { waitForConversationPlan } from './chat-helpers.js';
import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { createPool, createAuth } from '../../apps/api/src/config.js';
import { createCore, createFinance, createManagement, createInvestment } from '../../packages/core/src/index.js';

const pool = createPool(), password = 'BankPilot-language-e2e!';
let email: string, userId: string;
test.beforeAll(async () => {
  email = `language-e2e-${randomUUID()}@example.test`;
  const { user } = await createAuth(pool).api.signUpEmail({ body: { email, password, name: '语言入口独立验收' } });
  userId = user.id;
  const actor = { userId };
  await createCore(pool).seedDemo(actor);
  await createFinance(pool).seedDemo(actor);
  await createManagement(pool).seedDemo(actor);
  await createInvestment(pool).seedDemo(actor);
});
test.afterAll(async () => { await pool.end(); });

async function send(page: Page, message: string) {
  await page.getByRole('textbox', { name: '描述转账需求' }).fill(message);
  const pending = waitForConversationPlan(page);
  await page.getByRole('button', { name: '发送请求' }).click();
  const plan = await pending;
  expect(plan.mode).toBe(process.env.BANKPILOT_MODEL_NAME ? 'model' : 'scripted');
  if (plan.mode === 'model') expect(plan.modelRuns.every((run: { status: string }) => run.status === 'success')).toBe(true);
  return plan;
}

test('language routing reaches real API contexts and exact-money drafts without premature execution', async ({ page }) => {
  test.setTimeout(240_000);
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await page.getByLabel('邮箱地址').fill(email);
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '进入安全工作台' }).click();
  await expect(page.getByRole('textbox', { name: '描述转账需求' })).toBeVisible();
  const read = await send(page, '查询2026年9月的收入、支出和净额；查看日常借记卡状态；查一下我有哪些自动续费项目');
  expect(read.billReport.period).toBe('2026-09');
  expect(read.events.filter((e: { status: string }) => e.status === 'started').map((e: { role: string }) => e.role).sort()).toEqual(['bills', 'card', 'reviewer', 'subscription']);
  expect(read.actions).toEqual([]); expect(read.investmentActions ?? []).toEqual([]);
  expect(read.managementSuggestions).toEqual([{ kind: 'SUBSCRIPTION_QUERY' }]);
  expect(read.managementActions).toHaveLength(1);
  expect(read.managementActions[0].status).toBe('AWAITING_CONFIRMATION');
  expect(read.evidence.some((e: { source: string }) => e.source.startsWith('bill-report:'))).toBe(true);

  const history = await send(page, '看看2026年9月账单里有没有订阅扣款');
  expect(history.events.filter((e: { status: string }) => e.status === 'started').map((e: { role: string }) => e.role).sort()).toEqual(['bills', 'reviewer']);
  expect(history.actions).toEqual([]);
  expect(history.managementSuggestions ?? []).toEqual([]);
  expect(history.managementActions ?? []).toEqual([]);
  expect(history.billReport.period).toBe('2026-09');

  const positions = await send(page, '列出我当前持有的理财产品与可赎回金额');
  expect(positions.clarification).toBeUndefined();
  expect(positions.actions).toEqual([]); expect(positions.investmentActions ?? []).toEqual([]);
  expect(positions.events.filter((e: { status: string }) => e.status === 'started').map((e: { role: string }) => e.role).sort()).toEqual(['investment', 'reviewer']);

  const transfer = await send(page, '请汇给张伟，选尾号3361那张收款账户，金额人民币壹佰零陆元零捌分');
  expect(transfer.clarification).toBeUndefined(); expect(transfer.actions).toHaveLength(1);
  expect(transfer.suggestions[0].amountMinor).toBe('10608');
  expect(transfer.fundsPreview.amountMinor).toBe('10608');
  expect(transfer.actions[0].status).toBe('AWAITING_CONFIRMATION');
  expect(transfer.actions[0].tier).toBe('YELLOW');
  await expect(page.getByRole('button', { name: '确认并执行', exact: true })).toBeVisible();
  await page.reload();
  const state = await page.evaluate(async () => (await fetch('/api/dashboard')).json());
  expect(state.latestPlan.taskId).toBe(transfer.taskId);
  expect(state.accounts[0]).toMatchObject({ balanceMinor: '800000', reservedMinor: '0' });
  expect(state.actions).toHaveLength(1);
  expect(state.actions[0].status).toBe('AWAITING_CONFIRMATION');
  expect((await pool.query('SELECT count(*)::int AS n FROM bankpilot_core.provider_transfers WHERE account_id=$1', [`acc-main-${userId}`])).rows[0].n).toBe(0);
  expect((await pool.query('SELECT count(*)::int AS n FROM bankpilot_core.management_query_grants WHERE user_id=$1', [userId])).rows[0].n).toBe(0);
  await page.screenshot({ path: 'test-results/phase6-language-desktop.png', fullPage: true, animations: 'disabled' });
  expect(errors).toEqual([]);
});
