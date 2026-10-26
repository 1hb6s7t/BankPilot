import { randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { createAuth, createPool } from '../../apps/api/src/config.js';
import { createCore, createFinance, createInvestment, createManagement } from '../../packages/core/src/index.js';
import type { ConversationCommand } from '../../packages/contracts/src/conversations.js';
import type { PlanEnvelope } from '../../apps/api/src/plan-runner.js';

// One integration sample against the configured cloud service. It is not an
// unseen quality benchmark or a controlled outage/retry acceptance test.
const pool = createPool();
const password = `BankPilot-${randomUUID()}!`;
let email: string;
let userId: string;
test.use({ trace: 'on' });
test.beforeAll(async () => {
  if (!process.env.BANKPILOT_MODEL_NAME) return;
  email = `g8e-live-${randomUUID()}@example.test`;
  const { user } = await createAuth(pool).api.signUpEmail({ body: { email, password, name: 'G8E 云服务接入验收' } });
  userId = user.id;
  const actor = { userId };
  await createCore(pool).seedDemo(actor);
  await createFinance(pool).seedDemo(actor);
  await createManagement(pool).seedDemo(actor);
  await createInvestment(pool).seedDemo(actor);
});
test.afterAll(async () => { await pool.end(); });

test('configured cloud planning saves bounded attempt records and restores one unexecuted draft', async ({ page }) => {
  test.setTimeout(210_000);
  test.skip(!process.env.BANKPILOT_MODEL_NAME, 'Requires the explicitly configured cloud model.');
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await page.getByLabel('邮箱地址').fill(email);
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '进入安全工作台' }).click();
  await expect(page.getByRole('textbox', { name: '描述转账需求' })).toBeVisible();
  await page.getByRole('textbox', { name: '描述转账需求' }).fill('给林晓转账317.25元，备注恢复核对');
  const acceptance = page.waitForResponse(response => /\/api\/conversations\/[^/]+\/messages$/.test(response.url()) && response.request().method() === 'POST');
  await page.getByRole('button', { name: '发送请求' }).click();
  const accepted = await (await acceptance).json();
  const { conversationId, commandId } = accepted.command as ConversationCommand;
  let latest!: ConversationCommand;
  try {
    await expect.poll(async () => {
      latest = await page.evaluate(async ({ cid, id }) => (await fetch(`/api/conversations/${cid}/commands/${id}`)).json(), { cid: conversationId, id: commandId });
      return latest.status;
    }, { timeout: 185_000, intervals: [750, 1500] }).toMatch(/^(complete|failed)$/);
    await test.info().attach('terminal-command.json', { body: JSON.stringify(latest, null, 2), contentType: 'application/json' });
    expect(latest.status).toBe('complete');
    expect(latest.failure).toBeUndefined();
    const plan = latest.result! as PlanEnvelope;
    const runs = plan.modelRuns ?? [];
    expect(plan.mode).toBe('model');
    expect(runs.filter(run => run.status === 'success').map(run => run.role)).toEqual(['semantic_intent', 'transfer', 'reviewer']);
    expect(plan.actions).toHaveLength(1);
    expect(plan.actions[0]).toMatchObject({ amountMinor: '31725', memo: '恢复核对', status: 'AWAITING_CONFIRMATION' });
    expect(latest.modelAttempts?.length).toBe(runs.length);
    expect(latest.modelAttempts?.every(attempt => attempt.outcome !== 'unknown')).toBe(true);
    const reserved = latest.modelAttempts!.reduce((sum, attempt) => sum + attempt.requestMaxOutputTokens, 0);
    expect(reserved).toBeGreaterThan(0); expect(reserved).toBeLessThanOrEqual(32768);
    await page.reload();
    await expect(page.getByRole('button', { name: '确认并执行', exact: true })).toBeVisible();
    const after = await page.evaluate(async () => (await fetch('/api/dashboard')).json());
    expect(after.accounts[0]).toMatchObject({ balanceMinor: '800000', reservedMinor: '0' });
    expect(after.actions).toHaveLength(1); expect(after.actions[0].id).toBe(plan.actions[0]!.id);
    const replay = await page.evaluate(async ({ cid, id }) => {
      const response = await fetch(`/api/conversations/${cid}/commands/${id}/retry`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      return { status: response.status, body: await response.json() };
    }, { cid: conversationId, id: commandId });
    expect(replay.status).toBe(200);
    expect(replay.body.modelAttempts).toEqual(latest.modelAttempts);
    expect(replay.body.result.actions[0].id).toBe(plan.actions[0]!.id);
    const transfers = (await pool.query('SELECT count(*)::int AS n FROM bankpilot_core.provider_transfers WHERE account_id=$1', [`acc-main-${userId}`])).rows[0].n;
    expect(transfers).toBe(0);
    expect(errors).toEqual([]);
    await test.info().attach('restored-state-and-replay.json', { body: JSON.stringify({ after, replay, providerTransfers: transfers, pageErrors: errors }, null, 2), contentType: 'application/json' });
  } finally {
    const history = await page.evaluate(async cid => (await fetch(`/api/conversations/${cid}/messages`)).json(), conversationId);
    await test.info().attach('history.json', { body: JSON.stringify(history, null, 2), contentType: 'application/json' });
    await page.screenshot({ path: test.info().outputPath('cloud-terminal-state.png'), fullPage: true, animations: 'disabled' });
  }
});
