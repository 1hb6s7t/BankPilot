import { test, expect, type Page } from '@playwright/test';
import type { AcceptedConversationMessage, ConversationCommand, ConversationHistory } from '../../packages/contracts/src/conversations.js';
import { startG8eBrowserApp } from '../fixtures/g8e-browser-app.js';

let fixture: Awaited<ReturnType<typeof startG8eBrowserApp>>;
test.use({ trace: 'on' });
test.beforeAll(async () => { fixture = await startG8eBrowserApp(); });
test.afterAll(async () => { await fixture?.close(); });

async function login(page: Page) {
  await page.goto(fixture.origin);
  await page.getByLabel('邮箱地址').fill(fixture.email);
  await page.getByLabel('密码', { exact: true }).fill(fixture.password);
  await page.getByRole('button', { name: '进入安全工作台' }).click();
  await expect(page.getByRole('combobox', { name: '选择聊天' })).toBeEnabled();
}
async function send(page: Page, text: string): Promise<AcceptedConversationMessage> {
  await page.getByRole('textbox', { name: '描述转账需求' }).fill(text);
  const accepted = page.waitForResponse(response => new URL(response.url()).origin === fixture.origin
    && /\/api\/conversations\/[^/]+\/messages$/.test(response.url()) && response.request().method() === 'POST');
  await page.getByRole('button', { name: '发送请求' }).click();
  const response = await accepted; expect(response.status()).toBe(202); return response.json();
}
async function getCommand(page: Page, cid: string, commandId: string): Promise<ConversationCommand> {
  const response = await page.request.get(`${fixture.origin}/api/conversations/${cid}/commands/${commandId}`);
  expect(response.status()).toBe(200); return response.json();
}
async function history(page: Page, cid: string): Promise<ConversationHistory> {
  const response = await page.request.get(`${fixture.origin}/api/conversations/${cid}/messages`);
  expect(response.status()).toBe(200); return response.json();
}
async function terminal(page: Page, cid: string, commandId: string, status: 'failed' | 'complete') {
  let command!: ConversationCommand;
  await expect.poll(async () => { command = await getCommand(page, cid, commandId); return command.status; }, { timeout: 25_000, intervals: [100, 250, 500] }).toBe(status);
  return command;
}

test('controlled provider outage preserves the original request through refresh, chat switch, login and one idempotent retry', async ({ page }) => {
  test.setTimeout(120_000);
  const pageErrors: string[] = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  const responses: unknown[] = [], responseTasks: Promise<unknown>[] = [];
  page.on('response', response => {
    const url = new URL(response.url());
    if (url.origin !== fixture.origin || !/^\/api\/(?:conversations|dashboard)(?:\/|$)/.test(url.pathname)) return;
    responseTasks.push(response.json().then(body => { responses.push({ path: `${url.pathname}${url.search}`, method: response.request().method(), status: response.status(), body }); }).catch(() => {}));
  });
  const attach = async (name: string, value: unknown) => test.info().attach(name, { body: JSON.stringify(value, null, 2), contentType: 'application/json' });
  try {
    await login(page);
    const old = await send(page, '给林晓转账111.25元');
    const cid = old.command.conversationId;
    const previous = await terminal(page, cid, old.command.commandId, 'complete');
    expect(previous.result?.actions).toHaveLength(1);
    await expect(page.locator('.actions-panel .transfer-amount')).toContainText('111.25');
    await expect(page.locator('.actions-panel').getByRole('button', { name: '确认并执行', exact: true })).toBeVisible();

    fixture.failNextSemanticPair();
    const accepted = await send(page, '给林晓转账317.25元');
    const id = accepted.command.commandId;
    expect(accepted.command.conversationId).toBe(cid);
    const failed = await terminal(page, cid, id, 'failed');
    expect(failed).toMatchObject({ commandId: id, rootCommandId: id, revision: 0, retryable: true,
      failure: { phase: 'semantic_intent', code: 'MODEL_HTTP_502', retryable: true } });
    expect(failed.failure?.modelRuns).toHaveLength(2); expect(failed.result).toBeUndefined(); expect(failed.clarification).toBeUndefined();
    const failedHistory = await history(page, cid);
    expect(failedHistory.commands).toHaveLength(2);
    expect(failedHistory.messages.filter(message => message.role === 'user')).toHaveLength(2);
    expect(failedHistory.messages.filter(message => message.commandId === id && message.kind === 'failure')).toHaveLength(1);
    expect(failedHistory.clarifications).toEqual([]);
    const before = await fixture.saved(id);
    await attach('g8e-failed-command.json', failed); await attach('g8e-failed-history.json', failedHistory); await attach('g8e-failed-database.json', before);

    const assertFailedView = async () => {
      await expect(page.getByRole('button', { name: '重试原请求', exact: true })).toBeVisible();
      await expect(page.locator('.agent-progress')).toContainText('识别尚未完成');
      await expect(page.locator('.agent-progress')).not.toContainText('规划已完成');
      await expect(page.locator('.actions-panel').getByRole('button', { name: '确认并执行', exact: true })).toHaveCount(0);
      await expect(page.locator('.actions-panel .transfer-amount')).toHaveCount(0);
      await expect(page.getByRole('button', { name: '继续补充此请求', exact: true })).toHaveCount(0);
      await expect(page.locator('body')).not.toContainText('MODEL_HTTP_502');
      await expect(page.locator('body')).not.toContainText('请以新请求完整重述');
      await expect(page.locator('body')).not.toContainText('请明确当前要办理的操作');
      const funds = await fixture.funds();
      expect(funds.actions).toHaveLength(1); expect(funds.actions.map(action => action.amountMinor)).toEqual(['11125']);
      expect(funds.accounts[0]).toMatchObject({ balanceMinor: '800000', reservedMinor: '0' }); expect(funds.providerTransfers).toBe(0);
    };
    await assertFailedView();
    await page.screenshot({ path: test.info().outputPath('g8e-failed-before-refresh.png'), fullPage: true, animations: 'disabled' });
    const callsBeforeRefresh = fixture.calls.length;
    await page.reload(); await assertFailedView();
    await page.getByRole('button', { name: '新建聊天', exact: true }).click();
    await expect(page.getByRole('combobox', { name: '选择聊天' })).toBeEnabled();
    await expect(page.locator('.chat-message-user')).toHaveCount(0);
    await page.getByRole('combobox', { name: '选择聊天' }).selectOption(cid); await assertFailedView();
    await page.getByRole('button', { name: '退出登录', exact: true }).click();
    await login(page); await page.getByRole('combobox', { name: '选择聊天' }).selectOption(cid); await assertFailedView();
    expect(fixture.calls).toHaveLength(callsBeforeRefresh);
    await page.screenshot({ path: test.info().outputPath('g8e-failed-restored.png'), fullPage: true, animations: 'disabled' });

    const retryResponse = page.waitForResponse(response => response.url() === `${fixture.origin}/api/conversations/${cid}/commands/${id}/retry` && response.request().method() === 'POST');
    await page.getByRole('button', { name: '重试原请求', exact: true }).click();
    const retry = await retryResponse; expect(retry.status()).toBe(202); await attach('g8e-retry-accepted.json', await retry.json());
    const complete = await terminal(page, cid, id, 'complete');
    expect(complete).toMatchObject({ commandId: id, rootCommandId: id, revision: 0, retryable: false });
    expect(complete.failure).toBeUndefined(); expect(complete.result?.actions).toHaveLength(1);
    expect(complete.result?.actions?.[0]).toMatchObject({ amountMinor: '31725', status: 'AWAITING_CONFIRMATION' });
    expect(complete.result?.modelRuns?.filter(run => run.role === 'semantic_intent').map(run => run.status)).toEqual(['failed', 'failed', 'success']);
    await expect(page.locator('.actions-panel .transfer-amount')).toContainText('317.25');
    await expect(page.locator('.actions-panel').getByRole('button', { name: '确认并执行', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '重试原请求', exact: true })).toHaveCount(0);
    const restored = await history(page, cid);
    expect(restored.commands).toHaveLength(2); expect(restored.messages.filter(message => message.role === 'user')).toHaveLength(2);
    expect(restored.messages.filter(message => message.commandId === id && message.kind === 'failure')).toHaveLength(1);
    expect(restored.messages.filter(message => message.commandId === id && message.kind === 'result')).toHaveLength(1);
    expect((await fixture.saved(id)).recognition_digest).toBe(before.recognition_digest);
    const callsAfterRecovery = fixture.calls.length;
    await page.reload(); await expect(page.locator('.actions-panel .transfer-amount')).toContainText('317.25');
    const replay = await page.request.post(`${fixture.origin}/api/conversations/${cid}/commands/${id}/retry`, { headers: { Origin: fixture.origin }, data: {} });
    expect(replay.status()).toBe(200); await attach('g8e-complete-replay.json', await replay.json());
    expect(fixture.calls).toHaveLength(callsAfterRecovery);
    const final = await fixture.funds();
    expect(final.actions).toHaveLength(2); expect(final.actions.filter(action => action.amountMinor === '31725')).toHaveLength(1);
    expect(final.accounts[0]).toMatchObject({ balanceMinor: '800000', reservedMinor: '0' }); expect(final.providerTransfers).toBe(0);
    expect(fixture.calls.map(call => call.status)).toEqual([200, 200, 200, 502, 502, 200, 200, 200]);
    await page.screenshot({ path: test.info().outputPath('g8e-recovered-pending-draft.png'), fullPage: true, animations: 'disabled' });
    await attach('g8e-complete-command.json', complete); await attach('g8e-complete-history.json', restored);
    await attach('g8e-final-database.json', await fixture.saved(id)); await attach('g8e-final-funds.json', final);
    expect(pageErrors).toEqual([]);
  } finally {
    await Promise.allSettled(responseTasks);
    await attach('g8e-responses.json', responses); await attach('g8e-controlled-model-calls.json', fixture.calls);
    await attach('g8e-isolation.json', { origin: fixture.origin, apiOrigin: fixture.apiOrigin, schema: fixture.schema, userId: fixture.userId,
      realLogin: true, realLocalApiAndDatabase: true, controlledModelTransport: true, cloudCalls: false, authorizedExecution: false,
      boundary: 'Controlled model.invalid responses with real local UI/API/PG and Better Auth; not a cloud-model quality or financial execution acceptance.' });
  }
});

test('controlled malformed model output is a persistent nonretryable system failure, never a user clarification', async ({ page }) => {
  test.setTimeout(120_000);
  const pageErrors: string[] = []; page.on('pageerror', error => pageErrors.push(error.message));
  const attach = async (name: string, value: unknown) => test.info().attach(name, { body: JSON.stringify(value, null, 2), contentType: 'application/json' });
  await login(page);
  try {
    for (const [mode, code] of [['schema', 'MODEL_SCHEMA_INVALID'], ['malformed_json', 'MODEL_OUTPUT_JSON_INVALID']] as const) {
      const before = await fixture.funds();
      const existing = await (await page.request.get(`${fixture.origin}/api/conversations`)).json();
      await page.getByRole('button', { name: '新建聊天', exact: true }).click();
      await expect(page.getByRole('combobox', { name: '选择聊天' })).toBeEnabled();
      const cid = await page.getByRole('combobox', { name: '选择聊天' }).inputValue();
      expect(existing.conversations.some((item: { id: string }) => item.id === cid)).toBe(false);
      expect((await history(page, cid)).messages).toEqual([]);
      fixture.invalidSemanticOutput(mode);
      const callsBefore = fixture.calls.length;
      const accepted = await send(page, '给林晓转账219.40元');
      expect(accepted.command.conversationId).toBe(cid);
      await attach(`g8e-${mode}-accepted.json`, accepted);
      const id = accepted.command.commandId;
      const failed = await terminal(page, cid, id, 'failed');
      expect(failed).toMatchObject({ commandId: id, rootCommandId: id, revision: 0, retryable: false,
        failure: { phase: 'semantic_intent', code, retryable: false } });
      expect(failed.result).toBeUndefined(); expect(failed.clarification).toBeUndefined();
      expect(failed.failure?.modelRuns.map(run => ({ status: run.status, errorCode: run.errorCode })))
        .toEqual([{ status: 'failed', errorCode: code }, { status: 'failed', errorCode: code }]);
      const callsAfter = fixture.calls.length;
      expect(callsAfter - callsBefore).toBe(2);
      expect(fixture.calls.slice(callsBefore).map(call => ({ role: call.role, status: call.status, responseKind: call.responseKind })))
        .toEqual([{ role: 'semantic_intent', status: 200, responseKind: mode }, { role: 'semantic_intent', status: 200, responseKind: mode }]);
      const assertSystemFailure = async () => {
        await expect(page.locator('.agent-progress')).toContainText('识别尚未完成');
        await expect(page.locator('.agent-progress')).not.toContainText('规划已完成');
        await expect(page.getByRole('button', { name: '重试原请求', exact: true })).toHaveCount(0);
        await expect(page.getByRole('button', { name: '继续原请求', exact: true })).toHaveCount(0);
        await expect(page.getByRole('button', { name: '继续补充此请求', exact: true })).toHaveCount(0);
        await expect(page.locator('.clarification-form')).toHaveCount(0);
        await expect(page.locator('.actions-panel').getByRole('button', { name: '确认并执行', exact: true })).toHaveCount(0);
        await expect(page.locator('body')).not.toContainText('请以新请求完整重述');
        await expect(page.locator('body')).not.toContainText('请明确当前要办理的操作');
        await expect(page.locator('body')).not.toContainText(code);
      };
      await assertSystemFailure();
      const failedHistory = await history(page, cid);
      expect(failedHistory.commands).toHaveLength(1);
      expect(failedHistory.messages.filter(message => message.role === 'user')).toHaveLength(1);
      expect(failedHistory.messages.filter(message => message.kind === 'failure')).toHaveLength(1);
      expect(failedHistory.messages.filter(message => message.kind === 'result')).toEqual([]);
      expect(failedHistory.clarifications).toEqual([]);
      expect(await fixture.funds()).toEqual(before);
      await attach(`g8e-${mode}-failed-command.json`, failed); await attach(`g8e-${mode}-failed-history.json`, failedHistory);
      await attach(`g8e-${mode}-database.json`, await fixture.saved(id)); await attach(`g8e-${mode}-funds-before.json`, before);
      await page.screenshot({ path: test.info().outputPath(`g8e-${mode}-failed.png`), fullPage: true, animations: 'disabled' });
      await page.reload(); await assertSystemFailure();
      expect((await getCommand(page, cid, id)).failure).toEqual(failed.failure);
      expect(fixture.calls).toHaveLength(callsAfter);
      expect(await fixture.funds()).toEqual(before);
      await attach(`g8e-${mode}-history-after-refresh.json`, await history(page, cid));
      await attach(`g8e-${mode}-funds-after-refresh.json`, await fixture.funds());
      await page.screenshot({ path: test.info().outputPath(`g8e-${mode}-restored.png`), fullPage: true, animations: 'disabled' });
    }
    expect(pageErrors).toEqual([]);
  } finally {
    fixture.invalidSemanticOutput(undefined);
    await attach('g8e-protocol-controlled-model-calls.json', fixture.calls);
    await attach('g8e-protocol-isolation.json', { origin: fixture.origin, apiOrigin: fixture.apiOrigin, schema: fixture.schema, userId: fixture.userId,
      realLogin: true, controlledModelTransport: true, cloudCalls: false, authorizedExecution: false,
      boundary: 'Two invalid output protocols in separate new conversations; real local UI/API/PG, no user clarification, no retry and no new draft.' });
  }
});
