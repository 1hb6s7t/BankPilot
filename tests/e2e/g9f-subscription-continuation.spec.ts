import { test, expect, type Page } from '@playwright/test';
import type { AcceptedConversationMessage, ConversationCommand } from '../../packages/contracts/src/conversations.js';
import type { ManagementAction, SubscriptionSnapshot } from '../../packages/contracts/src/index.js';
import type { G8hSemanticRequest } from '../fixtures/g8h-controlled-model.js';
import { recognizeSubscriptionPrerequisite } from '../../packages/agents/src/subscription-prerequisite.js';
import { providerFromEnv } from '../../packages/agents/src/provider.js';
import { PLANNING_OUTPUT_TOKEN_LIMIT } from '../../packages/agents/src/budget.js';
import { startG8hBrowserApp } from '../fixtures/g8h-browser-app.js';

test.describe.configure({ retries: 0 });
test.use({ trace: 'on', actionTimeout: 15_000 });
let fixture: Awaited<ReturnType<typeof startG8hBrowserApp>> | undefined;
let attachment = 0;
let evidenceConversationId: string | undefined;
const live = process.env.BANKPILOT_G9F_LIVE === '1';
const attach = (name: string, value: unknown) => test.info().attach(`${++attachment}-${name}`, { body: JSON.stringify(value, null, 2), contentType: 'application/json' });
function app() { if (!fixture) throw new Error('G9F isolated browser fixture is not active'); return fixture; }
const address = (path: string) => new URL(path, app().origin).href;
async function read<T>(page: Page, path: string): Promise<T> {
  const response = await page.request.get(address(path)); expect(response.status()).toBe(200); return response.json();
}
async function shot(page: Page, name: string) { await page.screenshot({ path: test.info().outputPath(`${name}.png`), fullPage: true, animations: 'disabled' }); }
async function login(page: Page) {
  await page.goto(app().origin);
  await page.getByLabel('邮箱地址').fill(app().email);
  await page.getByLabel('密码', { exact: true }).fill(app().password);
  await page.getByRole('button', { name: '进入安全工作台' }).click();
  await expect(page.getByRole('combobox', { name: '选择聊天' })).toBeEnabled();
}
async function command(page: Page, conversationId: string, commandId: string): Promise<ConversationCommand> {
  return read(page, `/api/conversations/${conversationId}/commands/${commandId}`);
}
async function terminal(page: Page, conversationId: string, commandId: string): Promise<ConversationCommand> {
  let current!: ConversationCommand;
  await expect.poll(async () => {
    current = await command(page, conversationId, commandId);
    return current.status;
  }, { timeout: live ? 210_000 : 45_000, intervals: live ? [500, 1000, 2000] : [100, 250, 500] }).toBe('complete');
  expect(current.failure).toBeUndefined();
  return current;
}
async function action(page: Page, id: string): Promise<ManagementAction> {
  return read(page, `/api/management/actions/${id}`);
}
async function actionStatus(page: Page, id: string, status: ManagementAction['status']) {
  let current!: ManagementAction;
  await expect.poll(async () => { current = await action(page, id); return current.status; }, { timeout: 30_000, intervals: [100, 250, 500] }).toBe(status);
  return current;
}
async function actionUi(page: Page, current: ManagementAction, status: '待本人确认' | '已完成') {
  const card = page.locator(`.management-plan-actions .management-action-card[data-action-id="${current.id}"]`);
  await expect(card).toHaveCount(1);
  await expect(card.locator('.management-action-status')).toHaveText(status);
  if (status === '待本人确认') await expect(card.getByRole('button', { name: '确认此管理动作', exact: true })).toBeEnabled();
  else {
    expect(current.receipt).toBeDefined();
    await expect(card.locator('.management-receipt')).toBeVisible();
    await expect(card.locator('.management-receipt strong')).toHaveText(current.receipt!.summary);
  }
  return card;
}

test.beforeEach(async () => {
  attachment = 0; evidenceConversationId = undefined;
  if (live) {
    const provider = providerFromEnv();
    if (!provider) throw new Error('G9F_EXPLICIT_CLOUD_PROVIDER_REQUIRED');
    fixture = await startG8hBrowserApp({ cloudProvider: { ...provider, maxAttempts: 1, maxStructureRepairs: 0, timeoutMs: 60_000 } });
  } else fixture = await startG8hBrowserApp();
});
test.afterEach(async () => {
  const current = fixture; fixture = undefined;
  if (!current) return;
  try {
    if (evidenceConversationId) {
      const saved = await current.saved(evidenceConversationId);
      const safeCode = (value:unknown) => typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(value) ? value : undefined;
      const safeRuns = (value:unknown) => (Array.isArray(value) ? value : []).map((run:Record<string,unknown>) => ({
        role: run.role, model: run.model, status: run.status, attempt: run.attempt,
        inputTokens: run.inputTokens, outputTokens: run.outputTokens, reasoningTokens: run.reasoningTokens,
        requestMaxOutputTokens: run.requestMaxOutputTokens, errorCode: safeCode(run.errorCode),
      }));
      await attach('owned-command-attempts.json', { conversationId: evidenceConversationId, commands: saved.commands.map(row => ({
        commandId: row.command_id, parentCommandId: row.parent_command_id ?? null, status: row.status,
        lastErrorCode: safeCode(row.last_error_code),
        failure: row.planning_failure ? { phase: row.planning_failure.phase, retryable: row.planning_failure.retryable, code: safeCode(row.planning_failure.code) } : undefined,
        modelRunsFromResult: safeRuns(row.result?.modelRuns), modelRunsFromFailure: safeRuns(row.planning_failure?.modelRuns),
        modelRunsFromSemantic: safeRuns(row.semantic_result?.modelRuns),
        modelAttempts: (Array.isArray(row.model_attempts) ? row.model_attempts : []).map((attempt:Record<string,unknown>) => ({
          attemptId: attempt.attemptId, invocationId: attempt.invocationId, role: attempt.role, attempt: attempt.attempt,
          requestMaxOutputTokens: attempt.requestMaxOutputTokens, startedAtUtc: attempt.startedAtUtc,
          outcome: attempt.outcome, endedAtUtc: attempt.endedAtUtc, errorCode: safeCode(attempt.errorCode),
          inputTokens: attempt.inputTokens, outputTokens: attempt.outputTokens,
        })),
      })) });
    }
    await attach('terminal-database.json', await current.snapshot());
    await attach('controlled-model-calls.json', current.calls);
    await attach('isolation.json', { origin: current.origin, apiOrigin: current.apiOrigin, schema: current.schema, jobsSchema: current.jobsSchema,
      userId: current.userId, realLogin: true, realApiAndPostgres: true, realWorker: true, modelMode: current.modelMode,
      controlledModelHttpOnly: !live, cloudCalls: current.cloudCalls, controlledCalls: current.calls.length, timeDomains: current.timeDomains });
  } finally {
    const cleanup = await current.close(); await attach('cleanup.json', cleanup);
    expect(cleanup).toMatchObject({ clean: true, success: true, workerStopped: true, planningDrained: true,
      schemaDropped: true, jobsSchemaDropped: true, authUserDeleted: true, portsClosed: true,
      temporaryDirectoryRemoved: true, errors: [] });
  }
});

test('two subscription writes resume from one confirmed query and remain independently authorized through refresh and login', async ({ page }) => {
  test.setTimeout(live ? 360_000 : 150_000);
  const pageErrors: string[] = []; page.on('pageerror', error => pageErrors.push(error.message));
  await login(page);
  const initial = await app().snapshot();
  expect(initial.tables.managementQueryGrants).toHaveLength(0);
  expect(initial.tables.managementAuthorizationProofs).toHaveLength(0);
  expect(initial.tables.managementActions).toHaveLength(0);
  const message = '取消云音乐订阅，阻止城市健身合约的银行扣款';
  const prerequisite = recognizeSubscriptionPrerequisite(message);
  expect(prerequisite?.tasks.map(task => task.operation)).toEqual(['subscription_cancel', 'subscription_block']);
  if (!live) app().configureScenario({ message, semanticDraft: (request: G8hSemanticRequest) => {
    const names = ['云音乐', '城市健身合约'];
    return { tasks: prerequisite!.tasks.map((task, index) => {
      const entry = request.catalog.find(item => item.kind === 'subscription' && item.names.includes(names[index]!));
      if (!entry) throw new Error('G9F_SEMANTIC_CALLED_WITHOUT_AUTHORIZED_SUBSCRIPTION_CATALOG');
      return { operation: task.operation, disposition: 'request' as const, scope: task.source,
        entity: { kind: 'subscription' as const, id: entry.id, mention: { text: names[index]! } } };
    }) };
  } });
  await page.getByRole('button', { name: '转账工作台', exact: true }).click();
  const createdResponse = page.waitForResponse(response => new URL(response.url()).origin === app().origin
    && new URL(response.url()).pathname === '/api/conversations' && response.request().method() === 'POST');
  await page.getByRole('button', { name: '新建聊天', exact: true }).click();
  const created = await (await createdResponse).json() as { id: string };
  await expect(page.getByRole('combobox', { name: '选择聊天' })).toHaveValue(created.id);
  await expect(page.getByRole('combobox', { name: '选择聊天' })).toBeEnabled();
  const acceptedResponse = page.waitForResponse(response => new URL(response.url()).origin === app().origin
    && /\/api\/conversations\/[^/]+\/messages$/.test(response.url()) && response.request().method() === 'POST');
  await page.getByRole('textbox', { name: '描述转账需求' }).fill(message);
  await page.getByRole('button', { name: '发送请求' }).click();
  const acceptedHttp = await acceptedResponse; expect(acceptedHttp.status()).toBe(202);
  const accepted = await acceptedHttp.json() as AcceptedConversationMessage;
  const conversationId = accepted.command.conversationId, sourceId = accepted.command.commandId;
  evidenceConversationId = conversationId;
  const source = await terminal(page, conversationId, sourceId);
  expect(source.originalMessage).toBe(message);
  expect(source.result?.mode).toBe('scripted');
  expect(source.result?.subscriptionContinuation).toMatchObject({ sourceCommandId: sourceId, taskCount: 2, state: 'WAITING_QUERY' });
  expect(source.result?.managementActions).toHaveLength(1);
  const query = source.result!.managementActions![0] as ManagementAction;
  expect(query).toMatchObject({ status: 'AWAITING_CONFIRMATION', spec: { kind: 'SUBSCRIPTION_QUERY' } });
  expect(source.result?.summary).not.toMatch(/云音乐|城市健身合约|1800|19900/);
  expect(source.result?.events).toEqual([]);
  expect(source.result?.evidence).toEqual([]);
  expect(app().calls).toHaveLength(0);
  expect(app().cloudCalls).toHaveLength(0);
  const beforeQuery = await app().snapshot();
  expect(beforeQuery.tables.managementActions).toHaveLength(1);
  expect(beforeQuery.tables.managementAuthorizationProofs).toHaveLength(0);
  expect(beforeQuery.tables.managementQueryGrants).toHaveLength(0);
  await expect(page.locator('[aria-label="订阅原请求续办"]')).toContainText('等待查询确认');
  const queryCard = page.locator('.management-plan-actions .management-action-card');
  await expect(queryCard).toHaveCount(1);
  await actionUi(page, query, '待本人确认');
  await shot(page, 'waiting-for-query-confirmation');

  await queryCard.getByRole('button', { name: '确认此管理动作', exact: true }).click();
  const queried = await actionStatus(page, query.id, 'SUCCEEDED');
  const snapshot: SubscriptionSnapshot = (await read<SubscriptionSnapshot>(page, `/api/subscriptions?queryActionId=${query.id}`));
  expect(snapshot.queryActionId).toBe(query.id);
  const music = snapshot.items.find(item => item.merchant === '云音乐')!;
  const club = snapshot.items.find(item => item.merchant === '城市健身合约')!;
  expect(music).toMatchObject({ merchantStatus: 'ACTIVE', bankStatus: 'ALLOWED' });
  expect(club).toMatchObject({ merchantStatus: 'ACTIVE', bankStatus: 'ALLOWED' });
  expect(queried.receipt?.subscriptions).toBeUndefined(); // ordinary action reads do not disclose the snapshot
  let resumedSource!: ConversationCommand;
  await expect.poll(async () => {
    resumedSource = await command(page, conversationId, sourceId);
    return resumedSource.result?.subscriptionContinuation?.successorCommandId;
  }, { timeout: live ? 210_000 : 45_000, intervals: live ? [500, 1000, 2000] : [100, 250, 500] }).toBeTruthy();
  const childId = resumedSource.result!.subscriptionContinuation!.successorCommandId!;
  const child = await terminal(page, conversationId, childId);
  expect(child).toMatchObject({ parentCommandId: sourceId, rootCommandId: source.rootCommandId, originalMessage: message,
    revision: source.revision + 1, planningInput: { message, originalMessage: message } });
  expect(source.rootCommandId).toBe(sourceId);
  expect(child.result?.mode).toBe('model');
  expect(child.result?.managementActions).toHaveLength(2);
  const [cancel, block] = child.result!.managementActions as ManagementAction[];
  const originalActionIds = [query.id, cancel.id, block.id].sort();
  expect(new Set(originalActionIds).size).toBe(3);
  expect(cancel).toMatchObject({ status: 'AWAITING_CONFIRMATION', spec: { kind: 'SUBSCRIPTION_CANCEL', subscriptionId: music.id, expectedVersion: music.version, queryActionId: query.id } });
  expect(block).toMatchObject({ status: 'AWAITING_CONFIRMATION', spec: { kind: 'SUBSCRIPTION_BLOCK', subscriptionId: club.id, expectedVersion: club.version, queryActionId: query.id } });
  expect(child.result?.summary).not.toMatch(/云音乐|城市健身合约|1800|19900/);
  const savedChild = await app().savedCommand(childId);
  expect(savedChild.original_message).toBe(message);
  expect(savedChild.planning_input.message).toBe(message);
  expect(savedChild.result.managementActions).toHaveLength(2);
  for (const stored of savedChild.result.managementActions) {
    expect(stored.title).toBe('订阅事务'); expect(stored.details).toEqual([]);
    expect(stored.receipt).toBeUndefined(); expect(stored.failureReason).toBeUndefined();
  }
  if (live) {
    const runs = child.result!.modelRuns!;
    expect([...new Set(runs.map(run => run.role))].sort()).toEqual(['semantic_intent', 'subscription', 'reviewer'].sort());
    expect(runs.every(run => run.status === 'success')).toBe(true);
    const attempts = savedChild.model_attempts as { attemptId: string; role: string; outcome: string; requestMaxOutputTokens: number; startedAtUtc: string; endedAtUtc?: string }[];
    expect(attempts).toHaveLength(runs.length);
    expect(new Set(attempts.map(attempt => attempt.attemptId)).size).toBe(attempts.length);
    expect(attempts.map(attempt => attempt.role).sort()).toEqual(runs.map(run => run.role).sort());
    for (const attempt of attempts) {
      expect(attempt.outcome).toBe('success');
      expect(Number.isSafeInteger(attempt.requestMaxOutputTokens) && attempt.requestMaxOutputTokens > 0).toBe(true);
      expect(Number.isFinite(Date.parse(attempt.endedAtUtc ?? ''))).toBe(true);
      expect(Date.parse(attempt.endedAtUtc!)).toBeGreaterThanOrEqual(Date.parse(attempt.startedAtUtc));
    }
    const reserved = attempts.reduce((total, attempt) => total + attempt.requestMaxOutputTokens, 0);
    expect(reserved).toBe(Number(savedChild.model_output_reserved));
    expect(reserved).toBeLessThanOrEqual(PLANNING_OUTPUT_TOKEN_LIMIT);
    expect(app().cloudCalls).toHaveLength(attempts.length);
  }
  let saved = await app().saved(conversationId);
  expect(saved.messages.filter(row => row.role === 'user')).toHaveLength(1);
  expect(saved.messages.find(row => row.role === 'user')?.text).toBe(message);
  expect(saved.commands).toHaveLength(2);
  const sourceRow = saved.commands.find(row => row.command_id === sourceId), childRow = saved.commands.find(row => row.command_id === childId);
  const userMessage = saved.messages.find(row => row.role === 'user')!;
  expect(sourceRow).toBeDefined(); expect(childRow).toBeDefined(); expect(userMessage.id).toBeTruthy();
  expect(userMessage.command_id).toBe(sourceId);
  expect(sourceRow!.user_message_id).toBe(userMessage.id);
  expect(childRow!.user_message_id).toBe(userMessage.id);
  expect(childRow).toMatchObject({ parent_command_id: sourceId, root_command_id: source.rootCommandId, revision: source.revision + 1,
    conversation_id: conversationId, user_id: app().userId });
  expect(saved.messages.some(row => row.command_id === childId && row.role === 'assistant')).toBe(true);
  const prepared = await app().snapshot();
  expect(prepared.tables.managementActions).toHaveLength(3);
  expect(prepared.tables.managementActions.map(row => row.id).sort()).toEqual(originalActionIds);
  expect(prepared.tables.managementAuthorizationProofs).toHaveLength(1);
  expect(prepared.tables.managementQueryGrants).toHaveLength(1);
  expect(prepared.tables.managementSubscriptions).toEqual(initial.tables.managementSubscriptions);
  expect(prepared.providerTransfers).toHaveLength(0); expect(prepared.ledgerEntries).toHaveLength(0);
  await attach('prepared-continuation.json', { source, resumedSource, child, savedChild, prepared });

  await expect(page.getByRole('button', { name: '查看续办计划' })).toBeVisible();
  await page.getByRole('button', { name: '查看续办计划' }).click();
  await expect(page.locator('.management-plan-actions .management-action-card')).toHaveCount(2);
  await actionUi(page, cancel, '待本人确认'); await actionUi(page, block, '待本人确认');
  await shot(page, 'two-write-cards-awaiting-independent-confirmation');
  await page.reload();
  await expect(page.getByRole('combobox', { name: '选择聊天' })).toBeEnabled();
  await page.getByRole('combobox', { name: '选择聊天' }).selectOption(conversationId);
  await expect(page.getByRole('button', { name: '查看续办计划' })).toBeVisible();
  await page.getByRole('button', { name: '查看续办计划' }).click();
  await expect(page.locator('.management-plan-actions .management-action-card')).toHaveCount(2);
  await actionUi(page, cancel, '待本人确认'); await actionUi(page, block, '待本人确认');
  await page.getByRole('button', { name: '退出登录', exact: true }).click();
  await expect(page.getByRole('button', { name: '进入安全工作台' })).toBeVisible();
  await login(page);
  await page.getByRole('combobox', { name: '选择聊天' }).selectOption(conversationId);
  await expect(page.getByRole('button', { name: '查看续办计划' })).toBeVisible();
  await page.getByRole('button', { name: '查看续办计划' }).click();
  const writeCards = page.locator('.management-plan-actions .management-action-card');
  await expect(writeCards).toHaveCount(2);
  await actionUi(page, cancel, '待本人确认'); await actionUi(page, block, '待本人确认');
  await expect(page.locator('.chat-message-user')).toHaveCount(1);
  saved = await app().saved(conversationId);
  expect(saved.messages.filter(row => row.role === 'user')).toHaveLength(1);
  const beforeWrites = await app().snapshot();
  expect(beforeWrites.tables.managementAuthorizationProofs).toHaveLength(1);
  expect(beforeWrites.tables.managementActions.map(row => row.id).sort()).toEqual(originalActionIds);
  expect(beforeWrites.tables.managementSubscriptions).toEqual(initial.tables.managementSubscriptions);
  await shot(page, 'relogin-restores-original-request-and-two-pending-cards');

  await writeCards.filter({ has: page.getByRole('heading', { name: '取消商户订阅', exact: true }) }).getByRole('button', { name: '确认此管理动作', exact: true }).click();
  const cancelled = await actionStatus(page, cancel.id, 'SUCCEEDED');
  expect((await action(page, block.id)).status).toBe('AWAITING_CONFIRMATION');
  const afterFirst = await app().snapshot();
  expect(afterFirst.tables.managementAuthorizationProofs).toHaveLength(2);
  expect(afterFirst.tables.managementSubscriptions.find(row => row.id === music.id)).toMatchObject({ merchant_status: 'CANCELLED', bank_status: 'ALLOWED', version: music.version + 1 });
  expect(afterFirst.tables.managementSubscriptions.find(row => row.id === club.id)).toMatchObject({ merchant_status: 'ACTIVE', bank_status: 'ALLOWED', version: club.version });
  await actionUi(page, cancelled, '已完成'); await actionUi(page, block, '待本人确认');
  await shot(page, 'first-write-only-second-still-pending');
  await writeCards.filter({ has: page.getByRole('heading', { name: '限制银行扣款', exact: true }) }).getByRole('button', { name: '确认此管理动作', exact: true }).click();
  const blocked = await actionStatus(page, block.id, 'SUCCEEDED');
  const final = await app().snapshot();
  expect(final.tables.managementAuthorizationProofs).toHaveLength(3);
  expect(final.tables.managementActions.map(row => row.id).sort()).toEqual(originalActionIds);
  expect(final.tables.managementAuthorizationProofs.map(row => row.action_id).sort()).toEqual(originalActionIds);
  expect(new Set(final.tables.managementAuthorizationProofs.map(row => row.proof_id)).size).toBe(3);
  for (const original of [query, cancel, block]) {
    expect(final.tables.managementAuthorizationProofs.find(row => row.action_id === original.id)).toMatchObject({
      action_hash: original.actionHash, level: original.tier === 'RED' ? 'STRONG' : 'CONFIRMATION',
    });
  }
  expect(final.tables.managementQueryGrants).toHaveLength(1);
  expect(final.tables.managementSubscriptions.find(row => row.id === music.id)).toMatchObject({ merchant_status: 'CANCELLED', bank_status: 'ALLOWED', version: music.version + 1 });
  expect(final.tables.managementSubscriptions.find(row => row.id === club.id)).toMatchObject({ merchant_status: 'ACTIVE', bank_status: 'BLOCKED', version: club.version + 1 });
  expect(final.dashboard.accounts).toEqual(initial.dashboard.accounts);
  expect(final.providerTransfers).toHaveLength(0); expect(final.ledgerEntries).toHaveLength(0);
  expect(final.audit.filter(row => row.type === 'MANAGEMENT_SUCCEEDED' && [query.id,cancel.id,block.id].includes(row.action_id))).toHaveLength(3);
  if (live) {
    expect(app().calls).toHaveLength(0);
    expect(app().cloudCalls.length).toBeGreaterThan(0);
    expect(app().cloudCalls.every(call => call.outcome === 'response' && call.httpStatus === 200)).toBe(true);
  } else {
    expect(app().cloudCalls).toHaveLength(0);
    expect(app().calls.map(call => call.role)).toEqual(['semantic_intent','subscription','reviewer']);
    expect(app().calls.every(call => call.status === 200)).toBe(true);
  }
  expect(pageErrors).toEqual([]);
  await actionUi(page, cancelled, '已完成'); await actionUi(page, blocked, '已完成');
  await shot(page, 'two-independent-writes-complete');
});
