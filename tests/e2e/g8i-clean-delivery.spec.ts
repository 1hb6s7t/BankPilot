import { test, expect, type Page } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { Pool } from 'pg';

// These cases deliberately run in two CLI invocations around a real service stop/start.
// They drive the exported application and never import application services or mock requests.
const stateDir = process.env.BANKPILOT_G8I_STATE_DIR;
if (!stateDir) throw new Error('BANKPILOT_G8I_STATE_DIR_REQUIRED');
const sourceDir = process.env.BANKPILOT_G8I_SOURCE_DIR;
if (!sourceDir) throw new Error('BANKPILOT_G8I_SOURCE_DIR_REQUIRED');
const sourceManifest = await readFile(resolve(sourceDir, 'delivery-manifest.json'));
const sourceManifestSha256 = createHash('sha256').update(sourceManifest).digest('hex');
const config = JSON.parse(await readFile(resolve(stateDir, 'private.json'), 'utf8'));
const origin: string = config.webUrl;
const database = new URL(config.connectionString);
if (config.mode !== 'scripted' || new URL(origin).hostname !== 'localhost' || new URL(origin).port === '5178'
  || !['localhost', '127.0.0.1', '[::1]'].includes(database.hostname) || database.port === '55432'
  || !config.cookiePrefix || config.cookiePrefix === 'bankpilot') throw new Error('ISOLATED_SCRIPTED_DELIVERY_REQUIRED');
const pool = new Pool({ connectionString: config.connectionString, max: 2, application_name: 'g8i_clean_browser_verification' });
const markerPath = resolve(stateDir, 'browser-verification.json');
const attach = (name: string, value: unknown) => test.info().attach(name, { body: JSON.stringify(value, null, 2), contentType: 'application/json' });
const read = async (page: Page, path: string) => {
  const response = await page.request.get(`${origin}${path}`); expect(response.status()).toBe(200); return response.json();
};
const shot = (page: Page, name: string) => page.screenshot({ path: test.info().outputPath(`${name}.png`), fullPage: true, animations: 'disabled' });
async function login(page: Page) {
  await page.goto(origin);
  await page.getByLabel('邮箱地址').fill('bankpilot@example.test');
  await page.getByLabel('密码', { exact: true }).fill('BankPilot-demo-2026!');
  await page.getByRole('button', { name: '进入安全工作台' }).click();
  await expect(page.getByRole('textbox', { name: '描述转账需求' })).toBeVisible();
}
async function facts() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const result: Record<string, any> = {};
    for (const table of ['accounts', 'actions', 'investment_actions', 'investment_positions', 'provider_transfers', 'provider_redemptions', 'provider_entries', 'redemption_entries', 'authorization_proofs', 'investment_proofs', 'management_actions', 'management_authorization_proofs', 'goals']) {
      const sql = table === 'accounts'
        ? 'SELECT a.*, COALESCE((SELECT sum(x.amount_minor) FROM bankpilot_core.actions x WHERE x.account_id=a.id AND x.reserved),0)::text reserved_minor FROM bankpilot_core.accounts a ORDER BY a.id'
        : `SELECT * FROM bankpilot_core.${table} ORDER BY 1`;
      result[table] = (await client.query(sql)).rows;
    }
    result.authUserCount = (await client.query('SELECT count(*)::int n FROM public."user"')).rows[0].n;
    result.postmasterStartedAt = (await client.query('SELECT pg_postmaster_start_time() started')).rows[0].started;
    await client.query('COMMIT'); return result;
  } finally { client.release(); }
}
function finalMoney(f: Record<string, any>) {
  expect(f.accounts.filter((a: any) => a.user_id)).toHaveLength(1);
  expect(f.accounts.find((a: any) => a.user_id)).toMatchObject({ balance_minor: '839925', reserved_minor: '0' });
  expect(f.provider_transfers).toHaveLength(1); expect(f.provider_redemptions).toHaveLength(1);
  expect(f.provider_entries).toHaveLength(2); expect(f.redemption_entries).toHaveLength(2);
  for (const [entries, amount] of [[f.provider_entries, '60075'], [f.redemption_entries, '100000']] as const) {
    expect(entries.map((e: any) => e.side).sort()).toEqual(['CREDIT', 'DEBIT']);
    expect(entries.every((e: any) => e.amount_minor === amount)).toBe(true);
  }
  expect(f.authorization_proofs).toHaveLength(1); expect(f.authorization_proofs[0].level).toBe('CONFIRMATION');
  expect(f.investment_proofs).toHaveLength(1); expect(f.investment_proofs[0].level).toBe('STRONG');
  expect(f.authUserCount).toBe(1);
}
test.afterAll(async () => { await pool.end(); });
test.beforeEach(async () => {
  const runtime = JSON.parse(await readFile(resolve(stateDir, 'state.json'), 'utf8'));
  expect(runtime).toMatchObject({ instanceId: config.instanceId, ready: true, mode: 'scripted', webUrl: origin,
    source: { sourceVerified: true, pristineExport: false, manifestSha256: sourceManifestSha256, fileCount: JSON.parse(sourceManifest.toString()).files.length } });
});

test('INITIAL clean exported application supports login, six-domain navigation and an independently authorized goal', async ({ page, context }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await login(page);
  expect(await read(page, '/api/health')).toMatchObject({ status: 'ok', mode: 'scripted', sandbox: true });
  const before = await facts(); expect(before.authUserCount).toBe(1); expect(before.actions).toHaveLength(0);
  expect(before.provider_transfers).toHaveLength(0); expect(before.provider_redemptions).toHaveLength(0);
  expect((await read(page, '/api/dashboard')).accounts[0].balanceMinor).toBe('800000');
  await shot(page, 'clean-scripted-workbench');
  await page.getByRole('button', { name: '账单', exact: true }).click();
  await expect(page.getByText('该月数据不完整。以下汇总只覆盖已提供的流水，不代表完整月份的收支。')).toBeVisible();
  const bills = await read(page, '/api/bills'); expect(bills.source).toBe('SYNTHETIC'); expect(bills.coverage.status).toBe('partial');
  await page.getByLabel('选择账单月份').fill('2020-01');
  await expect(page.getByRole('heading', { name: '2020-01 账单尚未提供' })).toBeVisible();
  await page.getByRole('button', { name: '资金计划', exact: true }).click();
  await expect(page.locator('.business-page')).toBeVisible();
  await page.getByRole('button', { name: '理财', exact: true }).click();
  await expect(page.locator('.investment-position-card')).toHaveCount(2);
  const portfolio = await read(page, '/api/investments');
  const position = portfolio.positions.find((p: any) => p.redemptionBusinessDays === 0);
  const cdp = await context.newCDPSession(page); await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
  await page.getByRole('button', { name: '生活目标', exact: true }).click();
  const form = page.locator('.goal-create-panel');
  await form.getByLabel('目标名称').fill('新副本学费目标');
  await form.getByLabel('目标金额（元）').fill('600.75');
  await form.getByLabel('目标完成日期').fill(new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10));
  await form.getByLabel('收款人', { exact: true }).selectOption('payee-lin');
  await form.getByLabel('计划资金来源（可选）').selectOption(position.id);
  await form.getByLabel('预计赎回金额（元）').fill('1000');
  await form.getByRole('button', { name: '保存并查看计划' }).click();
  const detail = page.locator('.goal-detail-panel');
  await expect(detail.getByRole('heading', { name: '新副本学费目标', exact: true })).toBeVisible();
  let goal = (await read(page, '/api/goals')).goals[0];
  expect(goal.amountMinor).toBe('60075'); expect(goal.funding.redemptionAmountMinor).toBe('100000');
  const prepared = await facts(); expect(prepared.provider_redemptions).toHaveLength(0); expect(prepared.investment_proofs).toHaveLength(0);
  expect(prepared.investment_positions.every((p: any) => p.reserved_minor === '0')).toBe(true);
  await detail.getByRole('button', { name: '还没有 Passkey？先注册' }).click();
  await expect(detail.getByRole('status')).toContainText('Passkey 已登记');
  await detail.getByRole('button', { name: 'Passkey 强验证并确认赎回' }).click();
  await expect.poll(async () => (await read(page, `/api/goals/${goal.id}`)).nodes[0].investmentAction?.status, { timeout: 25_000 }).toBe('SUCCEEDED');
  goal = await read(page, `/api/goals/${goal.id}`); expect(goal.nodes[2].actionRef).toBeUndefined();
  expect((await read(page, '/api/dashboard')).accounts[0].balanceMinor).toBe('900000');
  await page.getByRole('button', { name: '刷新目标', exact: true }).click();
  await detail.getByRole('button', { name: '检查进度并准备下一步' }).click();
  await expect(detail.getByRole('button', { name: '确认此转账', exact: true })).toBeVisible();
  expect((await facts()).provider_transfers).toHaveLength(0);
  await detail.getByRole('button', { name: '确认此转账', exact: true }).click();
  await expect.poll(async () => (await read(page, `/api/goals/${goal.id}`)).status, { timeout: 25_000 }).toBe('SUCCEEDED');
  await page.getByRole('button', { name: '刷新目标', exact: true }).click();
  await expect(detail.locator('.goal-status')).toHaveText('目标已完成');
  await shot(page, 'clean-copy-goal-completed');

  await page.getByRole('button', { name: '卡片', exact: true }).click();
  const management = await read(page, '/api/management'); const card = management.cards.find((c: any) => c.maskedNumber.endsWith('2026'));
  const cardPanel = page.locator('.synthetic-card').filter({ hasText: card.maskedNumber });
  await cardPanel.getByRole('button', { name: '准备挂失' }).click();
  expect((await read(page, '/api/management')).cards.find((c: any) => c.id === card.id).status).toBe('ACTIVE');
  await page.getByRole('button', { name: 'Passkey 强验证', exact: true }).click();
  await expect.poll(async () => (await read(page, '/api/management')).cards.find((c: any) => c.id === card.id).status).toBe('LOST');
  await cardPanel.getByRole('button', { name: '准备解挂' }).click();
  await page.getByRole('button', { name: 'Passkey 强验证', exact: true }).click();
  await expect.poll(async () => (await read(page, '/api/management')).cards.find((c: any) => c.id === card.id).status).toBe('ACTIVE');
  await page.getByRole('button', { name: '订阅', exact: true }).click();
  await expect(page.locator('.subscription-card')).toHaveCount(0);
  await page.getByRole('button', { name: '准备查询订阅' }).click();
  await page.getByRole('button', { name: '确认此管理动作' }).click();
  await expect(page.locator('.subscription-card')).toHaveCount(2);
  const music = page.locator('.subscription-card').filter({ hasText: '云音乐' });
  await music.getByRole('button', { name: '准备商户取消' }).click();
  await page.getByRole('button', { name: '确认此管理动作' }).click();
  await expect(music).toContainText('商户已取消');
  const fitness = page.locator('.subscription-card').filter({ hasText: '城市健身合约' });
  await fitness.getByRole('button', { name: '准备银行拦截扣款' }).click();
  await page.getByRole('button', { name: '确认此管理动作' }).click();
  await expect(fitness).toContainText('银行已拦截'); await expect(fitness).toContainText('有效');
  await page.reload(); await page.getByRole('button', { name: '订阅', exact: true }).click();
  await expect(page.locator('.subscription-card')).toHaveCount(0);
  await page.getByRole('button', { name: '查看已授权订阅' }).click();
  await expect(page.locator('.subscription-card')).toHaveCount(2);
  const final = await facts(); finalMoney(final);
  expect(final.management_authorization_proofs).toHaveLength(5);
  await page.getByRole('button', { name: '退出登录', exact: true }).click();
  await expect(page.getByRole('button', { name: '进入安全工作台' })).toBeVisible(); await login(page);
  await page.getByRole('button', { name: '生活目标', exact: true }).click();
  await expect(detail.locator('.goal-status')).toHaveText('目标已完成');
  const runtime = JSON.parse(await readFile(resolve(stateDir!, 'state.json'), 'utf8'));
  const marker = { instanceId: config.instanceId, goalId: goal.id, runtimePid: runtime.pid, postmasterStartedAt: final.postmasterStartedAt, providerTransfers: final.provider_transfers, providerRedemptions: final.provider_redemptions, finalBalanceMinor: '839925' };
  await writeFile(markerPath, JSON.stringify(marker, null, 2) + '\n');
  await attach('terminal-database.json', final); await attach('persistence-marker.json', marker);
  await attach('scope.json', { actualExportedApplication: true, verifiedManifestSha256: sourceManifestSha256, sourceDir, actualAuthenticationDatabaseAndWorker: true, mode: 'scripted', modelTransportMocked: false, cloudCompletionCalls: 0, softwareAuthenticator: 'Chromium CTAP2', origin, instanceId: config.instanceId });
  expect(errors).toEqual([]);
});

test('RESTORED clean exported application retains the original receipts after its API Worker and PostgreSQL restart', async ({ page }) => {
  const marker = JSON.parse(await readFile(markerPath, 'utf8'));
  const runtime = JSON.parse(await readFile(resolve(stateDir!, 'state.json'), 'utf8'));
  expect(runtime.ready).toBe(true); expect(runtime.pid).not.toBe(marker.runtimePid);
  await login(page); await page.getByRole('button', { name: '生活目标', exact: true }).click();
  await expect(page.locator('.goal-detail-panel .goal-status')).toHaveText('目标已完成');
  const goal = await read(page, `/api/goals/${marker.goalId}`); expect(goal.status).toBe('SUCCEEDED');
  const final = await facts(); finalMoney(final);
  expect(new Date(final.postmasterStartedAt).getTime()).toBeGreaterThan(new Date(marker.postmasterStartedAt).getTime());
  expect(JSON.parse(JSON.stringify(final.provider_transfers))).toEqual(marker.providerTransfers);
  expect(JSON.parse(JSON.stringify(final.provider_redemptions))).toEqual(marker.providerRedemptions);
  const replay = await page.request.post(`${origin}/api/goals/${goal.id}/advance`, { headers: { Origin: origin } }); expect(replay.status()).toBe(200);
  finalMoney(await facts());
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await shot(page, 'clean-copy-after-all-services-restart');
  await attach('restored-terminal-database.json', final);
  await attach('restart-proof.json', { beforeRuntimePid: marker.runtimePid, afterRuntimePid: runtime.pid, beforePostmasterStartedAt: marker.postmasterStartedAt, afterPostmasterStartedAt: final.postmasterStartedAt, goalId: goal.id, mode: 'scripted', cloudCompletionCalls: 0 });
});
