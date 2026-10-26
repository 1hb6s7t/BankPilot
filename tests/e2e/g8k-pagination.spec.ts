import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { startG8hBrowserApp } from '../fixtures/g8h-browser-app.js';
import { withTransaction } from '../../packages/core/src/database.js';
import { createConversationService } from '../../apps/api/src/conversations.js';
import type { AcceptedConversationMessage, ConversationCommand, ConversationEnvelope } from '../../packages/contracts/src/conversations.js';

let fixture: Awaited<ReturnType<typeof startG8hBrowserApp>>;
let archive: Pool;
let service: ReturnType<typeof createConversationService>;
let attachment = 0;
const attach = (name: string, value: unknown) => test.info().attach(`${++attachment}-${name}`, { body: JSON.stringify(value, null, 2), contentType: 'application/json' });
const cid = (page: Page) => page.getByRole('combobox', { name: '选择聊天' }).inputValue();
const recovery = (page: Page) => page.getByRole('region', { name: '待处理请求', exact: true });
const nextRecovery = (page: Page) => page.getByRole('button', { name: '下一页待处理请求', exact: true });
async function read(page: Page, path: string) {
  const response = await page.request.get(new URL(path, fixture.origin).href);
  expect(response.status()).toBe(200); return response.json();
}
async function login(page: Page) {
  await page.goto(fixture.origin); await page.getByLabel('邮箱地址').fill(fixture.email);
  await page.getByLabel('密码', { exact: true }).fill(fixture.password);
  await page.getByRole('button', { name: '进入安全工作台' }).click();
  await expect(page.getByRole('combobox', { name: '选择聊天' })).toBeEnabled();
}
async function appendArchive(conversationId: string, count: number) {
  await withTransaction(archive, async tx => {
    const row = (await tx.query('SELECT next_sequence FROM bp_conversations WHERE user_id=$1 AND id=$2 FOR UPDATE', [fixture.userId, conversationId])).rows[0];
    const start = Number(row.next_sequence);
    await tx.query(`INSERT INTO bp_chat_messages(id,user_id,conversation_id,sequence,role,text,kind)
      SELECT $1||g::text,$2,$3,$4::bigint+g,'assistant','有界归档片段 '||g::text,'result' FROM generate_series(1,$5::int) g`, [randomUUID(), fixture.userId, conversationId, start, count]);
    await tx.query('UPDATE bp_conversations SET next_sequence=next_sequence+$3,version=version+$3,updated_at=now() WHERE user_id=$1 AND id=$2', [fixture.userId, conversationId, count]);
  });
}
const accept = (conversationId: string, text: string) => service.accept({ userId: fixture.userId }, conversationId, { clientMessageId: randomUUID(), text });
async function complete(item: AcceptedConversationMessage, waiting = false) {
  const token = randomUUID();
  const envelope: ConversationEnvelope = { taskId: randomUUID(), planVersion: 1, mode: 'scripted', summary: waiting ? '请补充转账金额' : '原请求已完成', events: [], suggestions: [], actions: [], evidence: [], findings: [], ...(waiting ? { clarification: '请补充转账金额' } : {}) };
  const dashboard = (await fixture.snapshot()).dashboard;
  await withTransaction(archive, async tx => {
    await tx.query("UPDATE bp_plan_commands SET status='complete',lease_token=$3,result=$4 WHERE user_id=$1 AND command_id=$2", [fixture.userId, item.command.commandId, token, JSON.stringify(envelope)]);
    await service.onComplete(tx, { userId: fixture.userId }, item.command.commandId, token, envelope,
      waiting ? { taskId: envelope.taskId, message: item.command.originalMessage, accounts: dashboard.accounts, payees: dashboard.payees, referenceDate: '2026-10-24' } : undefined);
  });
  return service.getCommand({ userId: fixture.userId }, item.command.conversationId, item.command.commandId);
}

test.beforeEach(async () => {
  attachment = 0; fixture = await startG8hBrowserApp();
  archive = new Pool({ connectionString: process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? 'postgres://bankpilot:bankpilot-local@127.0.0.1:55432/bankpilot', options: `-c search_path=${fixture.schema}`, application_name: `${fixture.schema}_g8k_archive`, max: 2 });
  service = createConversationService(archive);
});
test.afterEach(async () => {
  try {
    await attach('terminal-database.json', await fixture.snapshot());
    await attach('model-calls.json', fixture.calls);
    await attach('scope.json', { realLogin: true, realApiPostgresWorker: true, seededArchiveAndPlanningStates: true, controlledModelHttpOnly: true, cloudCalls: 0, schema: fixture.schema });
  } finally {
    await archive.end(); const cleanup = await fixture.close(); await attach('cleanup.json', cleanup);
    expect(cleanup).toMatchObject({ success: true, clean: true, errors: [] });
  }
});

test('126 chats stay reachable with bounded initial reads, retryable pagination and direct selected-chat restoration', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await login(page); const original = await cid(page);
  await archive.query("UPDATE bp_conversations SET created_at='2026-10-20T00:00:00.123456Z',title='较早选中的聊天' WHERE id=$1", [original]);
  const ids: string[] = [original];
  for (let n = 0; n < 125; n++) ids.push((await service.create({ userId: fixture.userId }, { title: `归档聊天 ${String(n).padStart(3, '0')}` })).id);
  // Deliberately identical native microsecond timestamps exercise the ID tie-breaker.
  await archive.query("UPDATE bp_conversations SET created_at='2026-10-24T00:00:00.123456Z' WHERE user_id=$1 AND id<>$2", [fixture.userId, original]);
  const listRequests: string[] = [], listSizes: number[] = [];
  page.on('request', request => { if (new URL(request.url()).pathname === '/api/conversations' && request.method() === 'GET') listRequests.push(new URL(request.url()).search); });
  page.on('response', async response => {
    if (new URL(response.url()).pathname === '/api/conversations' && response.request().method() === 'GET' && response.ok()) listSizes.push((await response.json()).conversations.length);
  });
  await page.reload(); await expect(page.getByRole('combobox', { name: '选择聊天' })).toHaveValue(original);
  await expect(page.getByRole('combobox', { name: '选择聊天' })).toBeEnabled();
  // The real Vite fixture uses React StrictMode: its discarded first mount can
  // start an aborted duplicate GET. Neither mount may walk older list pages.
  const initialRequests = listRequests.length;
  expect(initialRequests).toBeGreaterThanOrEqual(1); expect(initialRequests).toBeLessThanOrEqual(2);
  expect(listRequests.every(query => query === '?limit=30')).toBe(true);
  const more = page.getByRole('button', { name: '加载更多聊天', exact: true }); await expect(more).toBeEnabled();
  await page.route(url => url.pathname === '/api/conversations' && url.searchParams.has('cursor'), route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'G8K_TEST_PAGE_UNAVAILABLE', message: '聊天列表暂时不可读，请重试。' } }) }), { times: 1 });
  const initialOptions = await page.locator('select[aria-label="选择聊天"] option').count();
  await more.click(); await expect(page.getByRole('alert').filter({ hasText: '聊天列表暂时不可读' })).toBeVisible();
  expect(await page.locator('select[aria-label="选择聊天"] option').count()).toBe(initialOptions);
  await expect(more).toBeEnabled(); await more.click();
  await expect.poll(() => page.locator('select[aria-label="选择聊天"] option').count()).toBeGreaterThan(initialOptions);
  expect(listRequests[initialRequests]).toBe(listRequests[initialRequests + 1]);
  for (let n = 0; n < 6 && await more.count(); n++) {
    if (!await more.isEnabled()) break;
    const count = await page.locator('select[aria-label="选择聊天"] option').count(); await more.click();
    await expect.poll(() => page.locator('select[aria-label="选择聊天"] option').count()).toBeGreaterThan(count);
  }
  const options = await page.locator('select[aria-label="选择聊天"] option').evaluateAll(nodes => nodes.map(node => (node as HTMLOptionElement).value));
  expect(new Set(options).size).toBe(126); expect(new Set(options)).toEqual(new Set(ids));
  expect(listSizes.every(count => count <= 30)).toBe(true);
  const target = ids[1]!; await page.getByRole('combobox', { name: '选择聊天' }).selectOption(target);
  await expect(page.getByRole('combobox', { name: '选择聊天' })).toBeEnabled();
  await page.getByRole('button', { name: '退出登录', exact: true }).click(); await login(page);
  await expect(page.getByRole('combobox', { name: '选择聊天' })).toHaveValue(target);
  const snapshot = await fixture.snapshot(); expect(snapshot.providerTransfers).toHaveLength(0); expect(fixture.calls).toHaveLength(0); expect(errors).toEqual([]);
  await attach('bounded-list-and-restoration.json', { count: ids.length, original, selectedAfterRelogin: target, listRequests, listSizes, cloudCalls: 0, controlledModelCalls: fixture.calls.length });
});

test('older pending, failed and waiting requests remain discoverable on bounded recovery pages without automatic planning', async ({ page }) => {
  await login(page); const conversationId = await cid(page);
  const waiting = await accept(conversationId, '给林晓转账'); const waitingCommand = await complete(waiting, true);
  expect(waitingCommand.clarification?.status).toBe('waiting');
  const failed = await accept(conversationId, '给林晓转账317元');
  await archive.query("UPDATE bp_plan_commands SET status='failed',last_error_code='MODEL_HTTP_502' WHERE user_id=$1 AND command_id=$2", [fixture.userId, failed.command.commandId]);
  for (let n = 0; n < 43; n++) await accept(conversationId, `暂未处理的原请求 ${String(n).padStart(3, '0')}`);
  await appendArchive(conversationId, 240);
  const pages: { itemCount: number; commandIds: string[]; messageCount?: number; commandCount?: number; bytes: number }[] = [];
  page.on('response', async response => {
    const url = new URL(response.url());
    if (url.pathname === `/api/conversations/${conversationId}/recovery` && response.ok()) {
      const data = await response.json(); pages.push({ itemCount: data.items.length, commandIds: data.items.map((item: any) => item.commandId), bytes: Buffer.byteLength(JSON.stringify(data)) });
      expect(data.items.every((item: any) => !('result' in item) && !('modelAttempts' in item) && !('planningInput' in item))).toBe(true);
    }
  });
  await page.reload(); await expect(recovery(page)).toBeVisible();
  const history = await read(page, `/api/conversations/${conversationId}/messages?limit=50`);
  expect(history.messages).toHaveLength(50); expect(history.commands).toHaveLength(0); expect(history.clarifications).toHaveLength(0);
  await expect(nextRecovery(page)).toBeEnabled(); await nextRecovery(page).click();
  await expect(nextRecovery(page)).toBeEnabled(); await nextRecovery(page).click();
  await expect(recovery(page)).toContainText('给林晓转账317元'); await expect(recovery(page)).toContainText(waitingCommand.clarification!.question);
  expect(fixture.calls).toHaveLength(0); expect(pages.every(value => value.itemCount <= 20)).toBe(true);
  // Explicitly open the waiting request; cancelling never starts a new model task.
  const waitingRow = recovery(page).locator(`[data-command-id="${waiting.command.commandId}"]`);
  await waitingRow.getByRole('button', { name: '查看请求状态', exact: true }).click();
  await page.getByRole('button', { name: '继续补充此请求', exact: true }).click();
  await page.getByRole('textbox', { name: '补充金额', exact: true }).fill('300元');
  await page.getByRole('button', { name: '刷新待处理请求', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '补充金额', exact: true })).toHaveValue('300元');
  await page.getByRole('button', { name: '取消这次请求', exact: true }).click();
  await expect.poll(async () => (await service.getCommand({ userId: fixture.userId }, conversationId, waiting.command.commandId)).clarification?.status).toBe('cancelled');
  expect(fixture.calls).toHaveLength(0);
  fixture.configureScenario({ message: '给林晓转账317元', semanticDraft: { tasks: [{ operation: 'transfer', disposition: 'request', scope: { source: 'whole_message' }, amount: { text: '317元' }, entity: { kind: 'payee', id: 'payee-lin', mention: { text: '林晓' } } }] } });
  const failedRow = recovery(page).locator('[data-command-id]').filter({ hasText: '给林晓转账317元' });
  await failedRow.getByRole('button', { name: '查看请求状态', exact: true }).click();
  let retryPosts = 0;
  page.on('request', request => { if (new URL(request.url()).pathname === `/api/conversations/${conversationId}/commands/${failed.command.commandId}/retry` && request.method() === 'POST') retryPosts++; });
  await page.getByRole('button', { name: '重试原请求', exact: true }).click();
  let finished!: ConversationCommand;
  await expect.poll(async () => { finished = await read(page, `/api/conversations/${conversationId}/commands/${failed.command.commandId}`); return finished.status; }, { timeout: 30_000 }).toBe('complete');
  expect(finished.result?.actions).toHaveLength(1); expect(retryPosts).toBe(1);
  await expect(page.locator('.action-review')).toContainText('317.00');
  const snapshot = await fixture.snapshot(); expect(snapshot.providerTransfers).toHaveLength(0); expect(snapshot.tables.authorizationProofs).toHaveLength(0);
  expect((await fixture.saved(conversationId)).commands).toHaveLength(45);
  await attach('bounded-recovery-discovery.json', { historyMessageCount: history.messages.length, historyCommandCount: history.commands.length, pages, waitingCommandId: waiting.command.commandId, resumedOriginalCommandId: failed.command.commandId, retryPosts, noPaymentOrAuthorization: true });
  await page.screenshot({ path: test.info().outputPath('older-original-request-recovered.png'), fullPage: false, animations: 'disabled' });
});

test('late recovery snapshots cannot revive a completed request or leak across a conversation switch', async ({ page }) => {
  await login(page); const conversationId = await cid(page);
  const pending = await accept(conversationId, '较早待处理的唯一原请求'); await appendArchive(conversationId, 60);
  const other = await service.create({ userId: fixture.userId }, { title: '隔离的另一个聊天' });
  await page.reload(); await expect(recovery(page)).toContainText('较早待处理的唯一原请求');
  let release!: () => void, captured!: () => void;
  const held = new Promise<void>(resolve => { captured = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const routePattern = (url: URL) => url.pathname === `/api/conversations/${conversationId}/recovery`;
  await page.route(routePattern, async route => {
    const response = await route.fetch(); const data = await response.json();
    expect(data.items.some((item: any) => item.commandId === pending.command.commandId)).toBe(true);
    captured(); await gate; await route.fulfill({ response });
  }, { times: 1 });
  try {
    await page.getByRole('button', { name: '刷新待处理请求', exact: true }).click(); await held;
    const done = await complete(pending);
    await recovery(page).getByRole('button', { name: '查看请求状态', exact: true }).click();
    await expect(page.locator('.chat-command')).toContainText('规划已完成');
    release();
    await expect(recovery(page).locator('[data-command-id]')).toHaveCount(0);
    expect(done.status).toBe('complete');
  } finally { release(); await page.unroute(routePattern); }
  const later = await accept(conversationId, '切换后不应出现的旧请求');
  await page.getByRole('button', { name: '刷新待处理请求', exact: true }).click();
  await expect(recovery(page)).toContainText('切换后不应出现的旧请求');
  let releaseSwitch!: () => void, capturedSwitch!: () => void;
  const heldSwitch = new Promise<void>(resolve => { capturedSwitch = resolve; });
  const switchGate = new Promise<void>(resolve => { releaseSwitch = resolve; });
  await page.route(routePattern, async route => { const response = await route.fetch(); capturedSwitch(); await switchGate; await route.fulfill({ response }); }, { times: 1 });
  try {
    await page.getByRole('button', { name: '刷新待处理请求', exact: true }).click(); await heldSwitch;
    await page.getByRole('combobox', { name: '选择聊天' }).selectOption(other.id);
    await expect(page.getByRole('combobox', { name: '选择聊天' })).toBeEnabled(); releaseSwitch();
    await expect(recovery(page)).not.toContainText('切换后不应出现的旧请求');
    await expect(page.locator('.chat-message')).toHaveCount(0);
    expect((await fixture.savedCommand(later.command.commandId)).status).toBe('pending');
  } finally { releaseSwitch(); await page.unroute(routePattern); }
  expect(fixture.calls).toHaveLength(0);
  await attach('late-recovery-and-generation.json', { completedCommandId: pending.command.commandId, oldConversationId: conversationId, newConversationId: other.id, stillPendingCommandId: later.command.commandId, controlledModelCalls: fixture.calls.length });
});

for (const failFollowupReads of [false, true]) test(`cancelling an old clarification rejects its delayed waiting index${failFollowupReads ? ' when subsequent reads fail' : ''}`, async ({ page }) => {
  await login(page); const conversationId = await cid(page);
  const accepted = await accept(conversationId, '给林晓转账');
  const waiting = await complete(accepted, true); expect(waiting.clarification?.status).toBe('waiting');
  await appendArchive(conversationId, 60);
  await page.reload(); await expect(recovery(page)).toContainText(waiting.clarification!.question);
  let release!: () => void, captured!: () => void, oldResponseSeen = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const held = new Promise<void>(resolve => { captured = resolve; });
  const pattern = (url: URL) => url.pathname === `/api/conversations/${conversationId}/recovery`;
  const followupPattern = (url: URL) => url.pathname === `/api/conversations/${conversationId}/commands/${accepted.command.commandId}` || url.pathname === `/api/conversations/${conversationId}/messages`;
  await page.route(pattern, async route => {
    const response = await route.fetch(); const body = await response.json();
    expect(body.items[0].clarification).toMatchObject({ id: waiting.clarification!.id, version: 1 });
    oldResponseSeen = true; captured(); await gate; await route.fulfill({ response });
  }, { times: 1 });
  try {
    // The normal polling loop may win this race; either path must capture the
    // actual pre-cancellation server response, not a fabricated stale object.
    const refresh = page.getByRole('button', { name: '刷新待处理请求', exact: true }).click({ timeout: 2500 }).catch(error => { if (!oldResponseSeen) throw error; });
    await held;
    if (failFollowupReads) await page.route(followupPattern, route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'TEST_READ_INTERRUPTED', message: '原请求详情暂时不可读，请稍后刷新。' } }) }));
    const cancellation = page.waitForResponse(response => new URL(response.url()).pathname.endsWith(`/clarifications/${waiting.clarification!.id}/cancel`) && response.request().method() === 'POST');
    await recovery(page).getByRole('button', { name: '取消这次请求', exact: true }).click();
    const cancellationResponse = await cancellation; expect(cancellationResponse.status()).toBe(200);
    expect(await cancellationResponse.json()).toMatchObject({ status: 'cancelled', version: 2 });
    await expect(recovery(page).locator('[data-command-id]')).toHaveCount(0);
    const cancelled = await service.getCommand({ userId: fixture.userId }, conversationId, accepted.command.commandId);
    expect(cancelled.clarification).toMatchObject({ status: 'cancelled', version: 2 });
    expect(BigInt(cancelled.stateVersion!)).toBeGreaterThan(BigInt(waiting.stateVersion!));
    const delivered = page.waitForResponse(response => new URL(response.url()).pathname === `/api/conversations/${conversationId}/recovery`);
    release(); await (await delivered).finished(); await refresh;
    await expect(recovery(page).locator('[data-command-id]')).toHaveCount(0);
    await expect(page.getByRole('button', { name: '继续补充此请求', exact: true })).toHaveCount(0);
    if (failFollowupReads) await page.unroute(followupPattern);
    await page.reload(); await expect(page.getByRole('combobox', { name: '选择聊天' })).toBeEnabled();
    await expect(recovery(page).locator('[data-command-id]')).toHaveCount(0);
    const saved = await fixture.saved(conversationId);
    expect(saved.commands).toHaveLength(1); expect(saved.messages.filter(row => row.kind === 'cancellation')).toHaveLength(1);
    expect(fixture.calls).toHaveLength(0);
    await attach('late-waiting-after-cancel.json', { originalCommandId: accepted.command.commandId, waitingStateVersion: waiting.stateVersion, cancelledStateVersion: cancelled.stateVersion, clarification: cancelled.clarification, delayedRealIndexRejected: true, failFollowupReads, controlledModelCalls: fixture.calls.length });
  } finally { release(); await page.unroute(pattern); if (failFollowupReads) await page.unroute(followupPattern); }
});

test('accepted clarification successor closes its parent even when following reads fail and an old index arrives', async ({ page }) => {
  await login(page); const conversationId = await cid(page);
  const original = await accept(conversationId, '给林晓转账'); const waiting = await complete(original, true);
  await appendArchive(conversationId, 60); await page.reload();
  await recovery(page).getByRole('button', { name: '继续补充此请求', exact: true }).click();
  await page.getByRole('textbox', { name: '补充金额', exact: true }).fill('318元');
  const payee = (await fixture.snapshot()).dashboard.payees.find(item => item.id === waiting.clarification!.values.payeeId)!;
  const typedMessage = `转给${payee.name}尾号${payee.maskedNumber.replace(/\D/g, '').slice(-4)}，金额318.00元`;
  fixture.configureScenario({ message: typedMessage, semanticDraft: { tasks: [{ operation: 'transfer', disposition: 'request', scope: { source: 'whole_message' }, amount: { text: '318.00元' }, entity: { kind: 'payee', id: payee.id, mention: { text: payee.name } } }] } });
  let release!: () => void, captured!: () => void, oldResponseSeen = false;
  const gate = new Promise<void>(resolve => { release = resolve; }), held = new Promise<void>(resolve => { captured = resolve; });
  const pattern = (url: URL) => url.pathname === `/api/conversations/${conversationId}/recovery`;
  const followupPattern = (url: URL) => url.pathname === `/api/conversations/${conversationId}/commands/${original.command.commandId}` || url.pathname === `/api/conversations/${conversationId}/messages`;
  await page.route(pattern, async route => {
    const response = await route.fetch(); const body = await response.json();
    expect(body.items[0].clarification).toMatchObject({ id: waiting.clarification!.id, version: 1 });
    oldResponseSeen = true; captured(); await gate; await route.fulfill({ response });
  }, { times: 1 });
  let messagePosts = 0;
  page.on('request', request => { if (new URL(request.url()).pathname === `/api/conversations/${conversationId}/messages` && request.method() === 'POST') messagePosts++; });
  try {
    const refresh = page.getByRole('button', { name: '刷新待处理请求', exact: true }).click({ timeout: 2500 }).catch(error => { if (!oldResponseSeen) throw error; });
    await held;
    await page.route(followupPattern, route => route.request().method() === 'GET'
      ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'TEST_READ_INTERRUPTED', message: '原请求详情暂时不可读，请稍后刷新。' } }) })
      : route.continue());
    const acceptedResponse = page.waitForResponse(response => new URL(response.url()).pathname === `/api/conversations/${conversationId}/messages` && response.request().method() === 'POST');
    await page.getByRole('button', { name: '提交补充', exact: true }).click();
    const response = await acceptedResponse; expect(response.status()).toBe(202);
    const accepted: AcceptedConversationMessage = await response.json();
    expect(accepted.command.parentCommandId).toBe(original.command.commandId);
    await expect(recovery(page).locator(`[data-command-id="${original.command.commandId}"]`)).toHaveCount(0);
    const delivered = page.waitForResponse(value => new URL(value.url()).pathname === `/api/conversations/${conversationId}/recovery`);
    release(); await (await delivered).finished(); await refresh;
    await expect(page.getByRole('button', { name: '继续补充此请求', exact: true })).toHaveCount(0);
    const parent = await service.getCommand({ userId: fixture.userId }, conversationId, original.command.commandId);
    expect(parent.clarification).toMatchObject({ status: 'resolved', version: 2, resolvedByCommandId: accepted.command.commandId });
    await page.unroute(followupPattern);
    await page.getByRole('button', { name: '重载聊天历史', exact: true }).click();
    await expect.poll(async () => (await service.getCommand({ userId: fixture.userId }, conversationId, accepted.command.commandId)).status, { timeout: 30_000 }).toBe('complete');
    await expect(page.locator('.action-review')).toContainText('318.00');
    expect(messagePosts).toBe(1); expect((await fixture.saved(conversationId)).commands).toHaveLength(2);
    const snapshot = await fixture.snapshot(); expect(snapshot.providerTransfers).toHaveLength(0); expect(snapshot.tables.authorizationProofs).toHaveLength(0);
    await attach('accepted-answer-parent-closure.json', { originalCommandId: original.command.commandId, successorCommandId: accepted.command.commandId, parentStateVersion: parent.stateVersion, resolvedClarification: parent.clarification, messagePosts, noPaymentOrAuthorization: true });
  } finally { release(); await page.unroute(pattern); await page.unroute(followupPattern); }
});
