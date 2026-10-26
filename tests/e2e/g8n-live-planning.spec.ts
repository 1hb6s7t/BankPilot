import { test, expect, type Page, type BrowserContext } from '@playwright/test';
import { startG8hBrowserApp } from '../fixtures/g8h-browser-app.js';
import { providerFromEnv } from '../../packages/agents/src/provider.js';

let fixture: Awaited<ReturnType<typeof startG8hBrowserApp>> | undefined;
let contexts: BrowserContext[], pageErrors: string[];
const attach = (name: string, data: unknown) => test.info().attach(name, { body: JSON.stringify(data, null, 2), contentType: 'application/json' });
const nav = (page: Page, name: string) => page.getByRole('button', { name, exact: true }).click();
async function login(page: Page) {
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto(fixture!.origin); await page.getByLabel('邮箱地址').fill(fixture!.email);
  await page.getByLabel('密码', { exact: true }).fill(fixture!.password);
  await page.getByRole('button', { name: '进入安全工作台' }).click();
  await expect(page.getByRole('combobox', { name: '选择聊天' })).toBeEnabled();
}
async function get(page: Page, path: string) {
  const response = await page.request.get(`${fixture!.origin}${path}`); expect(response.status()).toBe(200); return response.json();
}
async function plan(page: Page, message: string) {
  await nav(page, '转账工作台');
  const response = page.waitForResponse(value => /\/api\/conversations\/[^/]+\/messages$/.test(new URL(value.url()).pathname) && value.request().method() === 'POST');
  await page.getByRole('textbox', { name: '描述转账需求' }).fill(message);
  await page.getByRole('button', { name: '发送请求', exact: true }).click();
  const accepted = await (await response).json(), identity = accepted.command;
  let command: any;
  await expect.poll(async () => {
    command = await get(page, `/api/conversations/${identity.conversationId}/commands/${identity.commandId}`);
    return command.status;
  }, { timeout: 185_000, intervals: [500, 1000, 2000] }).toMatch(/^(complete|failed)$/);
  await attach('original-input-and-command.json', { message, command });
  expect(command.status).not.toBe('failed'); expect(command.failure).toBeUndefined();
  const attempts = command.modelAttempts ?? [];
  expect(attempts.length).toBeGreaterThan(0);
  expect(attempts.every((attempt: any) => attempt.outcome !== 'unknown')).toBe(true);
  const reserved = attempts.reduce((sum: number, attempt: any) => sum + attempt.requestMaxOutputTokens, 0);
  expect(reserved).toBeGreaterThan(0); expect(reserved).toBeLessThanOrEqual(32768);
  expect(command.result?.mode).toBe('model');
  return command;
}
test.beforeEach(async () => {
  fixture = undefined; contexts = []; pageErrors = [];
  const provider = providerFromEnv(); if (!provider) throw new Error('G8N_EXPLICIT_CLOUD_PROVIDER_REQUIRED');
  fixture = await startG8hBrowserApp({ cloudProvider: { ...provider, maxAttempts: 2, maxStructureRepairs: 1, timeoutMs: 60_000 } });
});
test.afterEach(async () => {
  for (const context of contexts) await context.close();
  if (!fixture) return;
  try {
    await attach('terminal-database.json', await fixture.snapshot());
    await attach('scope.json', { realLoginApiPostgresWorker: true, modelMode: fixture.modelMode, cloudCalls: fixture.cloudCalls,
      controlledModelCalls: fixture.calls.length, timeDomains: fixture.timeDomains, bankingData: 'synthetic', newUnseenBenchmark: false, schema: fixture.schema });
    expect(pageErrors).toEqual([]); expect(fixture.calls).toHaveLength(0);
    expect(fixture.cloudCalls.every(call => call.outcome !== 'pending')).toBe(true);
  } finally { const cleanup = await fixture.close(); await attach('cleanup.json', cleanup); expect(cleanup).toMatchObject({ success: true, clean: true, errors: [] }); }
});

test('real cloud creates a funded tuition goal, preserves separate amounts and restores its sole unapproved redemption', async ({ page, browser }) => {
  await login(page);
  const investment = await get(page, '/api/investments');
  const source = investment.positions.find((position: any) => position.productId === 'synthetic-t0'); expect(source).toBeTruthy();
  const message = `给林晓准备480元学费，2026-12-09前到账；先从${source.productName}赎回600元`;
  const command = await plan(page, message), result = command.result;
  expect(command.status).toBe('complete'); expect(result.clarification).toBeUndefined();
  expect(result.goal).toMatchObject({ amountMinor: '48000', targetDate: '2026-12-09', funding: { positionId: source.id, redemptionAmountMinor: '60000' } });
  expect(result.goal.title).toContain('学费'); expect(result.actions ?? []).toHaveLength(0);
  const before = await fixture!.snapshot(); expect(before.goals).toHaveLength(1); expect(before.investment.actions).toHaveLength(1);
  expect(before.investment.actions[0]).toMatchObject({ amountMinor: '60000', status: 'AWAITING_VERIFICATION' });
  expect(before.tables.investmentAuthorizationProofs).toHaveLength(0); expect(before.tables.providerRedemptions).toHaveLength(0); expect(before.tables.providerTransfers).toHaveLength(0);
  const context = await browser.newContext(); contexts.push(context); const other = await context.newPage(); await login(other); await nav(other, '生活目标');
  await expect(other.locator('.goal-detail-panel')).toContainText('学费');
  const recovered = await get(other, `/api/goals/${result.goal.id}`); expect(recovered.id).toBe(result.goal.id);
  const after = await fixture!.snapshot(); expect(after.investment.actions.map((action: any) => action.id)).toEqual(before.investment.actions.map((action: any) => action.id));
  expect(after.tables.providerTransfers).toHaveLength(0); expect(after.tables.providerRedemptions).toHaveLength(0);
  await other.screenshot({ path: test.info().outputPath('real-cloud-funded-goal.png'), fullPage: true });
});

test('real cloud asks for the missing deadline year and keeps all banking actions absent', async ({ page }) => {
  await login(page); const command = await plan(page, '给林晓准备360元培训报名费，1月18日前攒好');
  expect(command.result.clarification).toContain('年份'); expect(command.result.clarification).not.toContain('账单');
  expect(command.result.findings).toContain('SEMANTIC_TARGET_DATE_YEAR_REQUIRED'); expect(command.result.goal).toBeUndefined();
  expect(command.result.actions ?? []).toHaveLength(0);
  const snapshot = await fixture!.snapshot(); expect(snapshot.goals).toHaveLength(0);
  expect(snapshot.tables.actions).toHaveLength(0); expect(snapshot.management.actions).toHaveLength(0); expect(snapshot.investment.actions).toHaveLength(0);
  await page.reload(); await expect(page.getByText(/年份/).first()).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('real-cloud-missing-year.png'), fullPage: true });
});

test('real cloud preserves the merchant contract while preparing only a bank-side subscription block', async ({ page }) => {
  await login(page); await nav(page, '订阅'); await page.getByRole('button', { name: '准备查询订阅', exact: true }).click();
  await page.locator('.management-action-card').getByRole('button', { name: '确认此管理动作', exact: true }).click();
  await expect(page.locator('.subscription-card').first()).toBeVisible();
  const before = await fixture!.snapshot();
  const command = await plan(page, '保留云音乐会员，但请从银行侧阻止下一次扣款');
  expect(command.status).toBe('complete'); const result = command.result;
  expect(result.managementActions).toHaveLength(1); expect(result.managementActions[0].spec.kind).toBe('SUBSCRIPTION_BLOCK');
  // This checks the proposition expressed by both natural variants; the frozen G7 scorer remains unchanged.
  expect(result.summary).toMatch(/不(?:会)?取消商户合同/);
  expect(result.summary).toContain('未执行');
  const after = await fixture!.snapshot(); expect(after.tables.managementSubscriptions).toEqual(before.tables.managementSubscriptions);
  expect(after.tables.managementAuthorizationProofs).toHaveLength(1); // Only the separate query grant was confirmed.
  expect(after.tables.providerTransfers).toHaveLength(0); expect(after.tables.providerRedemptions).toHaveLength(0);
  await page.reload(); await nav(page, '订阅');
  await expect(page.locator(`[data-action-id="${result.managementActions[0].id}"]`)).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('real-cloud-bank-block.png'), fullPage: true });
});
