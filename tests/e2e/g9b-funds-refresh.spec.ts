import { test, expect, type Route } from '@playwright/test';
import { startG8hBrowserApp } from '../fixtures/g8h-browser-app.js';

test('a delayed initial funds read cannot replace an edited policy before save', async ({ page }) => {
  const fixture = await startG8hBrowserApp();
  let held: Route | undefined;
  let released = false;
  let heldSave: Route | undefined;
  let saveReleased = false;
  let signalSave!: () => void;
  const saveStarted = new Promise<void>(resolve => { signalSave = resolve; });
  let fundsReads = 0;
  try {
    await page.goto(fixture.origin);
    await page.getByLabel('邮箱地址').fill(fixture.email);
    await page.getByLabel('密码', { exact: true }).fill(fixture.password);
    await page.getByRole('button', { name: '进入安全工作台' }).click();
    await expect(page.getByRole('textbox', { name: '描述转账需求' })).toBeVisible();

    await page.route('**/api/funds?**', async route => {
      if (route.request().method() !== 'GET') return route.continue();
      fundsReads += 1;
      if (fundsReads === 1) { held = route; return; }
      await route.continue();
    });
    await page.getByRole('button', { name: '资金计划', exact: true }).click();
    const minimum = page.getByRole('textbox', { name: '最低保留金额（元）', exact: true });
    await expect(minimum).toHaveValue('2000.00');
    expect(fundsReads).toBeGreaterThanOrEqual(2);
    expect(held).toBeDefined();

    await minimum.fill('2500');
    await expect(minimum).toHaveValue('2500');
    const lateResponse = page.waitForResponse(response => response.request().method() === 'GET' && response.url().includes('/api/funds?'));
    await held!.continue();
    released = true;
    await (await lateResponse).finished();
    // Wait for React to process the late response before checking the input.
    await page.waitForTimeout(100);
    await expect(minimum).toHaveValue('2500');

    await page.route('**/api/funds/policy', route => {
      if (heldSave) return route.continue();
      heldSave = route; signalSave();
    });
    const submitted = page.waitForRequest(request => request.method() === 'POST' && request.url().endsWith('/api/funds/policy'));
    await page.getByRole('button', { name: '确认并保存规则' }).click();
    await saveStarted;
    await expect(minimum).toBeDisabled();
    expect((await submitted).postDataJSON()).toMatchObject({ expectedVersion: 1, minimumBalanceMinor: '250000', confirmed: true });
    await heldSave!.continue();
    saveReleased = true;
    await expect(page.getByText('资金保护规则已保存，版本 2。')).toBeVisible();
    const response = await page.request.get(`${fixture.origin}/api/funds`);
    expect(response.ok()).toBe(true);
    const funds = await response.json();
    expect(funds.policy).toMatchObject({ version: 2, minimumBalanceMinor: '250000' });
    expect(funds.preview).toMatchObject({ protectedMinor: '550000', spendableMinor: '250000' });

    // A second editor advances the policy while this tab has a local draft.
    await minimum.fill('2600');
    const otherEditor = await page.request.post(`${fixture.origin}/api/funds/policy`, { headers: { Origin: fixture.origin }, data: {
      expectedVersion: 2, minimumBalanceMinor: '270000', obligations: funds.policy.obligations, confirmed: true,
    } });
    expect(otherEditor.ok()).toBe(true);
    expect(await otherEditor.json()).toMatchObject({ version: 3, minimumBalanceMinor: '270000' });
    const staleSubmit = page.waitForRequest(request => request.method() === 'POST' && request.url().endsWith('/api/funds/policy'));
    await page.getByRole('button', { name: '确认并保存规则' }).click();
    expect((await staleSubmit).postDataJSON()).toMatchObject({ expectedVersion: 2, minimumBalanceMinor: '260000' });
    await expect(page.getByText('资金规则版本已变化，已刷新服务端最新版本与表单；请复核后再保存。')).toBeVisible();
    await expect(minimum).toHaveValue('2700.00');
    const currentResponse = await page.request.get(`${fixture.origin}/api/funds`);
    expect(currentResponse.ok()).toBe(true);
    const current = await currentResponse.json();
    expect(current.policy).toMatchObject({ version: 3, minimumBalanceMinor: '270000' });
    expect(current.preview).toMatchObject({ protectedMinor: '570000', spendableMinor: '230000' });
  } finally {
    if (held && !released) await held.continue().catch(() => {});
    if (heldSave && !saveReleased) await heldSave.continue().catch(() => {});
    const cleanup = await fixture.close();
    expect(cleanup).toMatchObject({ success: true, clean: true, schemaDropped: true, authUserDeleted: true, portsClosed: true });
    expect(cleanup.errors).toEqual([]);
  }
});
