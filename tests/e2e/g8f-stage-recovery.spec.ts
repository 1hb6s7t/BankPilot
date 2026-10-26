import { test, expect, type Page } from '@playwright/test';
import type { AcceptedConversationMessage, ConversationCommand, ConversationHistory } from '../../packages/contracts/src/conversations.js';
import { startG8eBrowserApp } from '../fixtures/g8e-browser-app.js';

let fixture: Awaited<ReturnType<typeof startG8eBrowserApp>>;
test.use({ trace: 'on' });
test.beforeAll(async () => { fixture = await startG8eBrowserApp(); });
test.afterAll(async () => { await fixture?.close(); });
async function command(page: Page, cid: string, id: string): Promise<ConversationCommand> {
  const response = await page.request.get(`${fixture.origin}/api/conversations/${cid}/commands/${id}`);
  expect(response.status()).toBe(200); return response.json();
}
async function terminal(page: Page, cid: string, id: string, status: 'failed' | 'complete') {
  let value!: ConversationCommand;
  await expect.poll(async () => { value = await command(page, cid, id); return value.status; }, { timeout: 25_000, intervals: [100, 250] }).toBe(status);
  return value;
}
const attach = (name: string, value: unknown) => test.info().attach(name, { body: JSON.stringify(value, null, 2), contentType: 'application/json' });

for (const role of ['transfer', 'reviewer'] as const) {
  test(`controlled ${role} outage resumes only unfinished planning work after refresh`, async ({ page }) => {
    test.setTimeout(90_000);
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(fixture.origin);
    await page.getByLabel('邮箱地址').fill(fixture.email); await page.getByLabel('密码', { exact: true }).fill(fixture.password);
    await page.getByRole('button', { name: '进入安全工作台' }).click();
    await expect(page.getByRole('combobox', { name: '选择聊天' })).toBeEnabled();
    await page.getByRole('button', { name: '新建聊天', exact: true }).click();
    await expect(page.getByRole('combobox', { name: '选择聊天' })).toBeEnabled();
    const before = await fixture.funds(), callStart = fixture.calls.length;
    const amount = role === 'transfer' ? '317.25' : '428.15';
    fixture.failNextRolePair(role);
    await page.getByRole('textbox', { name: '描述转账需求' }).fill(`给林晓转账${amount}元`);
    const acceptedResponse = page.waitForResponse(response => new URL(response.url()).origin === fixture.origin && /\/api\/conversations\/[^/]+\/messages$/.test(response.url()) && response.request().method() === 'POST');
    await page.getByRole('button', { name: '发送请求' }).click();
    const response = await acceptedResponse; expect(response.status()).toBe(202);
    const accepted: AcceptedConversationMessage = await response.json();
    const { commandId: id, conversationId: cid } = accepted.command;
    try {
      const failed = await terminal(page, cid, id, 'failed');
      expect(failed).toMatchObject({ status: 'failed', retryable: true, failure: { phase: 'planning', code: 'MODEL_HTTP_502', retryable: true } });
      expect(failed.result).toBeUndefined(); expect(failed.clarification).toBeUndefined();
      expect(await fixture.funds()).toEqual(before);
      await expect(page.locator('.agent-progress')).toContainText('规划尚未完成');
      await expect(page.locator('.actions-panel').getByRole('button', { name: '确认并执行', exact: true })).toHaveCount(0);
      await expect(page.getByRole('button', { name: '重试原请求', exact: true })).toBeVisible();
      const callsBeforeRefresh = fixture.calls.length;
      const failedRow = await fixture.saved(id);
      expect(Object.keys(failedRow.stage_results)).toEqual(role === 'reviewer' ? ['domain:transfer'] : []);
      expect(failedRow.stage_history.some((event: any) => event.key === (role === 'reviewer' ? 'reviewer' : 'domain:transfer') && event.failure)).toBe(true);
      await attach('failed-command.json', failed); await attach('failed-database.json', failedRow);
      await page.reload();
      await expect(page.locator('.agent-progress')).toContainText('规划尚未完成');
      await expect(page.getByRole('button', { name: '重试原请求', exact: true })).toBeVisible();
      expect(fixture.calls).toHaveLength(callsBeforeRefresh);
      await page.screenshot({ path: test.info().outputPath(`${role}-failed-restored.png`), fullPage: true, animations: 'disabled' });
      const retryResponse = page.waitForResponse(response => response.url().endsWith(`/commands/${id}/retry`) && response.request().method() === 'POST');
      await page.getByRole('button', { name: '重试原请求', exact: true }).click();
      expect((await retryResponse).status()).toBe(202);
      const complete = await terminal(page, cid, id, 'complete');
      expect(complete).toMatchObject({ commandId: id, rootCommandId: id, revision: 0, status: 'complete' });
      expect(complete.failure).toBeUndefined(); expect(complete.result?.actions).toHaveLength(1);
      expect(complete.result?.actions?.[0]).toMatchObject({ amountMinor: amount.replace('.', ''), status: 'AWAITING_CONFIRMATION' });
      const roles = fixture.calls.slice(callStart).map(call => call.role);
      expect(roles).toEqual(role === 'transfer' ? ['semantic_intent', 'transfer', 'transfer', 'transfer', 'reviewer'] : ['semantic_intent', 'transfer', 'reviewer', 'reviewer', 'reviewer']);
      expect(complete.modelAttempts).toHaveLength(5);
      expect(complete.result?.modelRuns).toHaveLength(5);
      const completedRow = await fixture.saved(id);
      expect(Object.keys(completedRow.stage_results).sort()).toEqual(['domain:transfer', 'reviewer']);
      expect(completedRow.stage_history.filter((event: any) => event.resultDigest)).toHaveLength(2);
      expect(completedRow.stage_history.filter((event: any) => event.failure)).toHaveLength(1);
      expect(complete.modelAttempts!.reduce((sum, attempt) => sum + attempt.requestMaxOutputTokens, 0)).toBeLessThanOrEqual(32768);
      await expect(page.locator('.actions-panel .transfer-amount')).toContainText(amount);
      await expect(page.locator('.actions-panel').getByRole('button', { name: '确认并执行', exact: true })).toBeVisible();
      const history: ConversationHistory = await (await page.request.get(`${fixture.origin}/api/conversations/${cid}/messages`)).json();
      expect(history.commands).toHaveLength(1); expect(history.clarifications).toEqual([]);
      expect(history.messages.filter(message => message.role === 'user')).toHaveLength(1);
      expect(history.messages.filter(message => message.kind === 'failure')).toHaveLength(1);
      expect(history.messages.filter(message => message.kind === 'result')).toHaveLength(1);
      const after = await fixture.funds();
      expect(after.accounts).toEqual(before.accounts); expect(after.providerTransfers).toBe(0);
      expect(after.actions).toHaveLength(before.actions.length + 1);
      await page.reload(); await expect(page.locator('.actions-panel .transfer-amount')).toContainText(amount);
      const replay = await page.request.post(`${fixture.origin}/api/conversations/${cid}/commands/${id}/retry`, { data: {}, headers: { Origin: fixture.origin } });
      expect(replay.status()).toBe(200); expect((await replay.json()).modelAttempts).toEqual(complete.modelAttempts);
      expect(fixture.calls.slice(callStart)).toHaveLength(5); expect(errors).toEqual([]);
      await page.screenshot({ path: test.info().outputPath(`${role}-recovered-draft.png`), fullPage: true, animations: 'disabled' });
      await attach('completed-command.json', complete); await attach('history.json', history);
      await attach('funds-before-after.json', { before, after });
    } finally {
      await attach('controlled-calls.json', fixture.calls.slice(callStart)); await attach('terminal-database.json', await fixture.saved(id));
      await attach('isolation.json', { origin: fixture.origin, apiOrigin: fixture.apiOrigin, schema: fixture.schema, userId: fixture.userId, realLogin: true, realApiAndDatabase: true, controlledModelTransport: true, cloudCalls: false, authorizationOrExecution: false });
    }
  });
}
