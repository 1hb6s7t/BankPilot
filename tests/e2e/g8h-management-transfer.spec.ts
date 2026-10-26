import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import type { ActionView, Dashboard, ManagementAction, ManagementDashboard, SubscriptionSnapshot } from '../../packages/contracts/src/index.js';
import type { AcceptedConversationMessage, ConversationCommand } from '../../packages/contracts/src/conversations.js';
import type { SemanticIntentDraft } from '../../packages/agents/src/semantic-intent.js';
import { startG8hBrowserApp } from '../fixtures/g8h-browser-app.js';

test.describe.configure({ retries: 0 });
test.use({ trace: 'on', actionTimeout: 15_000 });
let fixture: Awaited<ReturnType<typeof startG8hBrowserApp>> | undefined;
let attachment = 0;
const attach = (name: string, value: unknown) => test.info().attach(`${++attachment}-${name}`, { body: JSON.stringify(value, null, 2), contentType: 'application/json' });
function app() { if (!fixture) throw new Error('Isolated G8H fixture has not started'); return fixture; }
const address = (path: string) => new URL(path, app().origin).href;
async function read<T = any>(page: Page, path: string): Promise<T> {
  const response = await page.request.get(address(path)); expect(response.status()).toBe(200); return response.json();
}
async function post(page: Page, path: string, body: unknown = {}) {
  const response = await page.request.post(address(path), { headers: { Origin: app().origin }, data: body });
  return { status: response.status(), body: await response.json() };
}
const dashboard = (page: Page) => read<Dashboard>(page, '/api/dashboard');
const management = (page: Page) => read<ManagementDashboard>(page, '/api/management');
async function shot(page: Page, name: string) { await page.screenshot({ path: test.info().outputPath(`${name}.png`), fullPage: true, animations: 'disabled' }); }

test.beforeEach(async () => { attachment = 0; fixture = await startG8hBrowserApp(); });
test.afterEach(async () => {
  const current = fixture; fixture = undefined;
  if (!current) return;
  try {
    await attach('terminal-database.json', await current.snapshot());
    await attach('controlled-model-calls.json', current.calls);
    await attach('isolation.json', { origin: current.origin, apiOrigin: current.apiOrigin, schema: current.schema, jobsSchema: current.jobsSchema,
      userId: current.userId, realLogin: true, realApiAndPostgres: true, realWorker: true, controlledModelHttpOnly: true, cloudCalls: false, timeDomains: current.timeDomains, softwareAuthenticator: true });
  } finally {
    const cleanup = await current.close(); await attach('cleanup.json', cleanup);
    expect(cleanup).toMatchObject({ clean: true, success: true, workerStopped: true, planningDrained: true,
      schemaDropped: true, jobsSchemaDropped: true, authUserDeleted: true, portsClosed: true, temporaryDirectoryRemoved: true, errors: [] });
  }
});

async function login(page: Page) {
  await page.goto(app().origin); await page.getByLabel('邮箱地址').fill(app().email);
  await page.getByLabel('密码', { exact: true }).fill(app().password);
  await page.getByRole('button', { name: '进入安全工作台' }).click();
  await expect(page.getByRole('combobox', { name: '选择聊天' })).toBeEnabled();
}
async function authenticator(page: Page, context: BrowserContext) {
  const cdp = await context.newCDPSession(page); await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true,
    hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
}
async function terminal(page: Page, accepted: AcceptedConversationMessage): Promise<ConversationCommand> {
  const { conversationId, commandId } = accepted.command;
  let command!: ConversationCommand;
  await expect.poll(async () => {
    command = await read(page, `/api/conversations/${conversationId}/commands/${commandId}`);
    return ['complete', 'failed'].includes(command.status);
  }, { timeout: 30_000, intervals: [100, 250, 500] }).toBe(true);
  await attach('command.json', command); await attach('history.json', await app().saved(conversationId));
  expect(command.status, command.lastErrorCode).toBe('complete');
  expect(command.failure).toBeUndefined();
  expect(command.result?.mode).toBe('model');
  expect(command.result?.modelRuns?.every(run => run.status === 'success')).toBe(true);
  return command;
}
async function acceptedBy(page: Page, click: () => Promise<unknown>) {
  const response = page.waitForResponse(value => new URL(value.url()).origin === app().origin
    && /\/api\/conversations\/[^/]+\/messages$/.test(value.url()) && value.request().method() === 'POST');
  await click(); const saved = await response; expect(saved.status()).toBe(202);
  return terminal(page, await saved.json());
}
async function send(page: Page, message: string, semanticDraft: SemanticIntentDraft) {
  app().configureScenario({ message, semanticDraft });
  await page.getByRole('button', { name: '转账工作台', exact: true }).click();
  await page.getByRole('button', { name: '新建聊天', exact: true }).click();
  await expect(page.getByRole('combobox', { name: '选择聊天' })).toBeEnabled();
  await page.getByRole('textbox', { name: '描述转账需求' }).fill(message);
  return acceptedBy(page, () => page.getByRole('button', { name: '发送请求' }).click());
}
const transferDraft = (amount: string, options: { ambiguous?: boolean; negated?: boolean } = {}): SemanticIntentDraft => ({ tasks: [{
  operation: 'transfer', disposition: options.negated ? 'negated' : 'request', scope: { source: 'whole_message' }, amount: { text: amount },
  ...(!options.ambiguous ? { entity: { kind: 'payee' as const, id: 'payee-lin', mention: { text: '林晓' } } } : {}),
}] });
const taskDraft = (operation: SemanticIntentDraft['tasks'][number]['operation'], disposition: 'request' | 'query', entity?: SemanticIntentDraft['tasks'][number]['entity']): SemanticIntentDraft => ({
  tasks: [{ operation, disposition, scope: { source: 'whole_message' }, ...(entity ? { entity } : {}) }],
});
function onlyTransfer(command: ConversationCommand): ActionView { expect(command.result?.actions).toHaveLength(1); return command.result!.actions![0] as ActionView; }
function onlyManagement(command: ConversationCommand): ManagementAction { expect(command.result?.managementActions).toHaveLength(1); return command.result!.managementActions![0] as ManagementAction; }
async function waitTransfer(page: Page, id: string, status: ActionView['status']) {
  let action!: ActionView;
  await expect.poll(async () => { action = (await dashboard(page)).actions.find(value => value.id === id)!; return action?.status; }, { timeout: 25_000, intervals: [100, 250, 500] }).toBe(status);
  return action;
}
async function waitManagement(page: Page, id: string) {
  let action!: ManagementAction;
  await expect.poll(async () => { action = (await management(page)).actions.find(value => value.id === id)!; return action?.status; }, { timeout: 20_000, intervals: [100, 250] }).toBe('SUCCEEDED');
  expect(action.receipt?.operationId).toBe(`local:${id}`); expect(action.receipt?.balanceDeltaMinor).toBe('0'); return action;
}
function assertLedger(snapshot: any, count: number) {
  expect(snapshot.providerTransfers).toHaveLength(count); expect(snapshot.ledgerEntries).toHaveLength(count * 2);
  const dispatched = snapshot.tables.outbox.filter((row: any) => row.kind === 'execute');
  expect(dispatched).toHaveLength(count); expect(dispatched.every((row: any) => row.sent_at !== null)).toBe(true);
  expect(new Set(snapshot.providerTransfers.map((row: any) => row.provider_key)).size).toBe(count);
  for (const row of snapshot.providerTransfers) {
    const entries = snapshot.ledgerEntries.filter((entry: any) => entry.provider_key === row.provider_key);
    expect(entries.map((entry: any) => entry.side).sort()).toEqual(['CREDIT', 'DEBIT']);
    expect(entries.map((entry: any) => String(entry.amount_minor))).toEqual([String(row.amount_minor), String(row.amount_minor)]);
    expect(row.receipt.providerRequestId).toBe(row.provider_key);
  }
}
function assertProofs(snapshot: any, actions: { id: string; actionHash: string; level: 'CONFIRMATION' | 'STRONG' }[], isManagement = false) {
  const proofs = isManagement ? snapshot.tables.managementAuthorizationProofs : snapshot.tables.authorizationProofs;
  expect(proofs).toHaveLength(actions.length);
  for (const action of actions) {
    const rows = proofs.filter((row: any) => row.action_id === action.id); expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ user_id: app().userId, action_hash: action.actionHash, level: action.level });
    expect(Number.isFinite(Date.parse(rows[0].consumed_at))).toBe(true);
    const eventType = isManagement ? 'MANAGEMENT_SUCCEEDED' : 'ACTION_AUTHORIZED';
    const event = snapshot.audit.find((row: any) => row.action_id === action.id && row.type === eventType);
    expect(event?.detail).toMatchObject({ proofId: rows[0].proof_id, actionHash: action.actionHash, level: action.level });
  }
}

test('controlled transfer: clarification and cancellation, yellow execution, signed red UNKNOWN and original receipt', async ({ page, context }) => {
  test.setTimeout(150_000); const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await login(page); const initial = await dashboard(page); expect(initial.accounts[0]).toMatchObject({ balanceMinor: '800000', reservedMinor: '0' });
  const negated = await send(page, '不要给林晓转账50.00元', transferDraft('50.00元', { negated: true }));
  expect(negated.result?.diagnostics?.intent?.status).toBe('no_action'); expect(negated.result?.actions).toEqual([]);
  expect((await dashboard(page)).accounts).toEqual(initial.accounts);
  const refused = await send(page, '给林晓转账9000.00元', transferDraft('9000.00元'));
  expect(refused.result?.fundsPreview?.allowed).toBe(false); expect(refused.result?.actions).toEqual([]);
  expect((await dashboard(page)).accounts).toEqual(initial.accounts); assertLedger(await app().snapshot(), 0);
  await shot(page, 'transfer-funds-refused');

  const ambiguous = await send(page, '给张伟转账300.00元', transferDraft('300.00元', { ambiguous: true }));
  expect(ambiguous.result?.actions).toEqual([]); expect(ambiguous.clarification?.requestedSlots).toEqual(['payee']);
  await page.reload(); await page.getByRole('button', { name: '继续补充此请求', exact: true }).click();
  const selected = ambiguous.clarification!.candidates.find(value => value.maskedNumber.endsWith('3361'))!; expect(selected).toBeTruthy();
  await page.getByRole('combobox', { name: '补充收款账户' }).selectOption(selected.id);
  const clarified = await acceptedBy(page, () => page.getByRole('button', { name: '提交补充', exact: true }).click());
  expect(clarified).toMatchObject({ rootCommandId: ambiguous.commandId, parentCommandId: ambiguous.commandId, revision: 1 });
  const cancelled = onlyTransfer(clarified); expect(cancelled).toMatchObject({ payeeId: selected.id, amountMinor: '30000', status: 'AWAITING_CONFIRMATION' });
  expect(clarified.result?.modelRuns?.some(run => run.role === 'semantic_intent')).toBe(false);
  expect((await dashboard(page)).accounts).toEqual(initial.accounts);
  await page.getByRole('button', { name: '取消这笔转账', exact: true }).click(); await waitTransfer(page, cancelled.id, 'CANCELLED');
  expect((await dashboard(page)).accounts).toEqual(initial.accounts); assertLedger(await app().snapshot(), 0);

  const first = onlyTransfer(await send(page, '给林晓转账600.00元', transferDraft('600.00元')));
  expect(first).toMatchObject({ tier: 'YELLOW', status: 'AWAITING_CONFIRMATION', amountMinor: '60000' });
  expect((await dashboard(page)).accounts).toEqual(initial.accounts); assertLedger(await app().snapshot(), 0);
  await shot(page, 'transfer-yellow-awaiting-confirmation');
  await page.getByRole('button', { name: '确认并执行', exact: true }).click(); const firstDone = await waitTransfer(page, first.id, 'SUCCEEDED');
  expect(firstDone.receipt).toMatchObject({ amountMinor: '60000', payeeId: 'payee-lin', currency: 'CNY' });
  expect((await dashboard(page)).accounts[0]).toMatchObject({ balanceMinor: '740000', reservedMinor: '0' }); assertLedger(await app().snapshot(), 1);
  const repeated = await post(page, `/api/actions/${first.id}/confirm`, { actionHash: first.actionHash });
  expect(repeated.status).toBe(409); assertLedger(await app().snapshot(), 1);

  const second = onlyTransfer(await send(page, '给林晓转账600.00元', transferDraft('600.00元')));
  expect(second).toMatchObject({ tier: 'RED', status: 'AWAITING_VERIFICATION' });
  const weak = await post(page, `/api/actions/${second.id}/confirm`, { actionHash: second.actionHash });
  expect(weak.status).toBe(200); expect(weak.body.status).toBe('AWAITING_VERIFICATION');
  expect((await dashboard(page)).accounts[0]).toMatchObject({ balanceMinor: '740000', reservedMinor: '0' }); assertLedger(await app().snapshot(), 1);
  await authenticator(page, context); await page.getByRole('button', { name: '还没有 Passkey？先注册', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Passkey 已注册');
  await app().timeoutNextTransfer();
  await page.getByRole('button', { name: 'Passkey 授权', exact: true }).click(); await waitTransfer(page, second.id, 'UNKNOWN');
  expect((await dashboard(page)).accounts[0]).toMatchObject({ balanceMinor: '740000', reservedMinor: '60000' });
  const unknown = await app().snapshot(); assertLedger(unknown, 2); await attach('unknown-original-provider-rows.json', unknown);
  await shot(page, 'transfer-unknown-before-reconciliation');
  await page.reload(); await page.getByRole('button', { name: '手动查单', exact: true }).click();
  const secondDone = await waitTransfer(page, second.id, 'SUCCEEDED');
  const original = unknown.providerTransfers.find((row: any) => row.provider_key === secondDone.receipt?.providerRequestId);
  expect(secondDone.receipt).toEqual(original?.receipt);
  expect((await dashboard(page)).accounts[0]).toMatchObject({ balanceMinor: '680000', reservedMinor: '0' });
  const recheck = await post(page, `/api/actions/${second.id}/reconcile`); expect(recheck.status).toBe(200); expect(recheck.body.receipt).toEqual(secondDone.receipt);
  assertLedger(await app().snapshot(), 2);
  const final = await dashboard(page); expect(final.audit.some(event => event.actionId === second.id && event.type === 'TRANSFER_UNKNOWN')).toBe(true);
  expect(final.audit.some(event => event.actionId === second.id && event.type === 'TRANSFER_SUCCEEDED')).toBe(true);
  expect(final.actions).toHaveLength(3);
  expect(final.audit.find(event => event.actionId === first.id && event.type === 'ACTION_AUTHORIZED')?.detail.level).toBe('CONFIRMATION');
  expect(final.audit.find(event => event.actionId === second.id && event.type === 'ACTION_AUTHORIZED')?.detail.level).toBe('STRONG');
  assertProofs(await app().snapshot(), [{ ...first, level: 'CONFIRMATION' }, { ...second, level: 'STRONG' }]);
  await expect(page.locator('.action-review .action-receipt')).toContainText(secondDone.receipt!.providerTransactionId);
  await shot(page, 'transfer-original-receipt-complete'); expect(errors).toEqual([]);
});

test('controlled card: read-only query, clarification and typed-tail signed loss and restoration', async ({ page, context }) => {
  test.setTimeout(120_000); const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await login(page); const initial = await dashboard(page), before = await management(page), card = before.cards[0]!;
  const query = await send(page, '查询我的银行卡状态', taskDraft('card_query', 'query'));
  expect(query.result?.managementActions ?? []).toEqual([]); expect(query.result?.summary).toContain(card.name);
  const ambiguous = await send(page, '挂失银行卡', taskDraft('card_report_lost', 'request'));
  expect(ambiguous.result?.clarification).toBeTruthy(); expect(ambiguous.result?.managementActions ?? []).toEqual([]);
  expect((await management(page)).cards).toEqual(before.cards); expect((await dashboard(page)).accounts).toEqual(initial.accounts);
  const suffix = card.maskedNumber.replace(/\D/g, '').slice(-4), mention = `银行卡尾号${suffix}`;
  const entity = { kind: 'card' as const, id: card.id, mention: { text: mention } };
  const lost = onlyManagement(await send(page, `挂失${mention}`, taskDraft('card_report_lost', 'request', entity)));
  expect(lost).toMatchObject({ tier: 'RED', status: 'AWAITING_VERIFICATION', spec: { kind: 'CARD_REPORT_LOST', cardId: card.id, expectedVersion: card.version } });
  expect((await management(page)).cards).toEqual(before.cards);
  const weak = await post(page, `/api/management/actions/${lost.id}/confirm`, { actionHash: lost.actionHash });
  expect(weak.status).toBe(200); expect(weak.body.status).toBe('AWAITING_VERIFICATION');
  expect((await management(page)).cards).toEqual(before.cards); await shot(page, 'card-loss-awaiting-signed-authority');
  await authenticator(page, context);
  const actionCard = page.locator('.management-plan-actions .management-action-card');
  await actionCard.getByRole('button', { name: '还没有 Passkey？先注册', exact: true }).click();
  await expect(actionCard.getByRole('status')).toContainText('Passkey 已注册');
  await actionCard.getByRole('button', { name: 'Passkey 强验证', exact: true }).click(); const lostDone = await waitManagement(page, lost.id);
  expect(lostDone.receipt?.card).toMatchObject({ id: card.id, status: 'LOST', version: card.version + 1 });
  const repeat = await post(page, `/api/management/actions/${lost.id}/confirm`, { actionHash: lost.actionHash });
  expect(repeat.status).toBe(200); expect(repeat.body.receipt).toEqual(lostDone.receipt);
  expect((await management(page)).cards[0]).toMatchObject({ status: 'LOST', version: card.version + 1 });
  await page.reload(); await expect(page.locator('.management-plan-actions .management-action-status')).toHaveText('已完成');
  await shot(page, 'card-lost-receipt-restored');
  const restored = onlyManagement(await send(page, `解挂${mention}`, taskDraft('card_restore', 'request', entity)));
  expect(restored.spec).toMatchObject({ kind: 'CARD_UNREPORT_LOST', expectedVersion: card.version + 1 });
  await page.locator('.management-plan-actions').getByRole('button', { name: 'Passkey 强验证', exact: true }).click();
  const restoredDone = await waitManagement(page, restored.id); expect(restoredDone.receipt?.card).toMatchObject({ id: card.id, status: 'ACTIVE', version: card.version + 2 });
  expect((await dashboard(page)).accounts).toEqual(initial.accounts); assertLedger(await app().snapshot(), 0);
  const final = await dashboard(page);
  for (const id of [lost.id, restored.id]) {
    const audited = final.audit.filter(event => event.actionId === id && event.type === 'MANAGEMENT_SUCCEEDED');
    expect(audited).toHaveLength(1); expect(audited[0]?.detail.level).toBe('STRONG');
  }
  assertProofs(await app().snapshot(), [{ ...lost, level: 'STRONG' }, { ...restored, level: 'STRONG' }], true);
  await page.getByRole('button', { name: '卡片', exact: true }).click(); await expect(page.locator('.synthetic-card')).toContainText('正常');
  await shot(page, 'card-restored-and-versioned'); expect(errors).toEqual([]);
});

test('controlled subscription: separate query grant, merchant cancellation and bank blocking without refunds', async ({ page }) => {
  test.setTimeout(120_000); const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const subscriptionReads: string[] = [], testOrigin = app().origin;
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.origin === testOrigin && url.pathname === '/api/subscriptions' && request.method() === 'GET') subscriptionReads.push(url.href);
  });
  await login(page); const initial = await dashboard(page);
  const denied = await page.request.get(address('/api/subscriptions?queryActionId=not-issued'));
  expect(denied.status()).toBe(403); expect(JSON.stringify(await denied.json())).not.toMatch(/云音乐|城市健身合约/);
  expect((await management(page)).subscriptionQueryActionId).toBeUndefined();
  await page.getByRole('button', { name: '订阅', exact: true }).click(); await expect(page.locator('.subscription-card')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '查看已授权订阅', exact: true })).toHaveCount(0);
  const query = onlyManagement(await send(page, '查询订阅', taskDraft('subscription_query', 'query')));
  expect(query.spec).toEqual({ kind: 'SUBSCRIPTION_QUERY' }); expect(query.status).toBe('AWAITING_CONFIRMATION');
  const beforeGrant = await page.request.get(address(`/api/subscriptions?queryActionId=${query.id}`)); expect(beforeGrant.status()).toBe(403);
  expect((await management(page)).subscriptionQueryActionId).toBeUndefined();
  await shot(page, 'subscription-query-before-grant');
  await page.locator('.management-plan-actions').getByRole('button', { name: '确认此管理动作', exact: true }).click();
  const queried = await waitManagement(page, query.id);
  // Ordinary management reads intentionally redact the query receipt's data;
  // the separately authorized subscriptions endpoint is the read boundary.
  expect(queried.receipt?.subscriptions).toBeUndefined();
  const snapshot = await read<SubscriptionSnapshot>(page, `/api/subscriptions?queryActionId=${query.id}`);
  expect(snapshot.queryActionId).toBe(query.id);
  const authorized = await app().snapshot(), grants = authorized.tables.managementQueryGrants!;
  expect(grants).toHaveLength(1); expect(grants[0]).toMatchObject({ action_id: query.id, user_id: app().userId });
  // The persisted grant is the snapshot's timestamp source; receipt completion
  // is a separate clock read and need not occur in the identical millisecond.
  expect(new Date(grants[0]!.queried_at).toISOString()).toBe(snapshot.queriedAt);
  expect(new Date(grants[0]!.expires_at).toISOString()).toBe(snapshot.accessExpiresAt);
  const storedQuery = authorized.tables.managementActions!.find(row => row.id === query.id)!;
  expect(storedQuery).toMatchObject({ id: query.id, user_id: app().userId, status: 'SUCCEEDED', spec: { kind: 'SUBSCRIPTION_QUERY' } });
  // The grant uses a second clock read for its five-minute expiry. Its base
  // must fall within this persisted transaction, without an arbitrary tolerance.
  const grantExpiryBase = Date.parse(snapshot.accessExpiresAt) - 5 * 60_000;
  expect(grantExpiryBase).toBeGreaterThanOrEqual(Date.parse(snapshot.queriedAt));
  expect(grantExpiryBase).toBeLessThanOrEqual(new Date(storedQuery.updated_at).getTime());
  expect(storedQuery.receipt.operationId).toBe(queried.receipt?.operationId);
  expect(storedQuery.receipt.subscriptions.queryActionId).toBe(query.id);
  assertProofs(authorized, [{ ...query, level: 'CONFIRMATION' }], true);
  await attach('subscription-authorized-grant-and-receipt.json', { snapshot, grants, receipt: queried.receipt, storedReceipt: storedQuery.receipt });
  expect(snapshot.items).toHaveLength(2); const cancellable = snapshot.items.find(item => item.cancellationSupported)!, unsupported = snapshot.items.find(item => !item.cancellationSupported)!;
  const merchant = (item: typeof cancellable) => ({ kind: 'subscription' as const, id: item.id, mention: { text: item.merchant } });
  const cancelled = onlyManagement(await send(page, `取消${cancellable.merchant}订阅`, taskDraft('subscription_cancel', 'request', merchant(cancellable))));
  expect(cancelled.spec).toMatchObject({ kind: 'SUBSCRIPTION_CANCEL', subscriptionId: cancellable.id, queryActionId: query.id, expectedVersion: cancellable.version });
  expect((await read<SubscriptionSnapshot>(page, `/api/subscriptions?queryActionId=${query.id}`)).items.find(item => item.id === cancellable.id)).toMatchObject({ merchantStatus: 'ACTIVE', bankStatus: 'ALLOWED' });
  await page.locator('.management-plan-actions').getByRole('button', { name: '确认此管理动作', exact: true }).click();
  const cancelledDone = await waitManagement(page, cancelled.id);
  expect(cancelledDone.receipt?.subscription).toMatchObject({ id: cancellable.id, merchantStatus: 'CANCELLED', bankStatus: 'ALLOWED', version: cancellable.version + 1 });
  expect(cancelledDone.receipt?.summary).toContain('未退款');
  const refusal = await send(page, `取消${unsupported.merchant}订阅`, taskDraft('subscription_cancel', 'request', merchant(unsupported)));
  expect(refusal.result?.managementActions ?? []).toEqual([]); expect(refusal.result?.summary).toContain('不能自动改为银行扣款限制');
  const current = await read<SubscriptionSnapshot>(page, `/api/subscriptions?queryActionId=${query.id}`);
  expect(current.items.find(item => item.id === unsupported.id)).toMatchObject({ merchantStatus: 'ACTIVE', bankStatus: 'ALLOWED', version: unsupported.version });
  expect(app().scenarios.subscriptionBlock).toBe(`阻止${unsupported.merchant}的银行扣款`);
  const blocked = onlyManagement(await send(page, app().scenarios.subscriptionBlock, taskDraft('subscription_block', 'request', merchant(unsupported))));
  expect(blocked.spec).toMatchObject({ kind: 'SUBSCRIPTION_BLOCK', subscriptionId: unsupported.id, queryActionId: query.id });
  await page.locator('.management-plan-actions').getByRole('button', { name: '确认此管理动作', exact: true }).click(); const blockedDone = await waitManagement(page, blocked.id);
  expect(blockedDone.receipt?.subscription).toMatchObject({ id: unsupported.id, merchantStatus: 'ACTIVE', bankStatus: 'BLOCKED', collectionStatus: 'BLOCKED_BY_BANK', version: unsupported.version + 1 });
  expect(blockedDone.receipt?.summary).toContain('未退款');
  const repeat = await post(page, `/api/management/actions/${blocked.id}/confirm`, { actionHash: blocked.actionHash });
  expect(repeat.status).toBe(200); expect(repeat.body.receipt).toEqual(blockedDone.receipt);
  expect((await dashboard(page)).accounts).toEqual(initial.accounts); assertLedger(await app().snapshot(), 0);
  const final = await dashboard(page);
  for (const id of [query.id, cancelled.id, blocked.id]) expect(final.audit.filter(event => event.actionId === id && event.type === 'MANAGEMENT_SUCCEEDED')).toHaveLength(1);
  assertProofs(await app().snapshot(), [query, cancelled, blocked].map(action => ({ ...action, level: 'CONFIRMATION' })), true);
  const readOffset = subscriptionReads.length;
  await page.reload(); await page.getByRole('button', { name: '订阅', exact: true }).click();
  await expect(page.locator('.subscription-card')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '查看已授权订阅', exact: true })).toBeVisible();
  await page.waitForLoadState('networkidle');
  expect(subscriptionReads.slice(readOffset)).toEqual([]);
  const beforeView = await app().snapshot(), callsBeforeView = app().calls.length;
  await shot(page, 'subscription-refresh-hidden-until-explicit-view');
  const viewed = page.waitForResponse(response => {
    const url = new URL(response.url());
    return url.origin === app().origin && url.pathname === '/api/subscriptions' && response.request().method() === 'GET' && url.searchParams.get('queryActionId') === query.id;
  });
  await page.getByRole('button', { name: '查看已授权订阅', exact: true }).click();
  const viewedResponse = await viewed; expect(viewedResponse.status()).toBe(200);
  const viewedSnapshot: SubscriptionSnapshot = await viewedResponse.json(); expect(viewedSnapshot.queryActionId).toBe(query.id);
  expect(subscriptionReads.slice(readOffset)).toHaveLength(1);
  const afterView = await app().snapshot();
  expect(afterView.tables.managementActions).toEqual(beforeView.tables.managementActions);
  expect(afterView.tables.managementQueryGrants).toEqual(beforeView.tables.managementQueryGrants);
  expect(afterView.tables.managementAuthorizationProofs).toEqual(beforeView.tables.managementAuthorizationProofs);
  expect(app().calls).toHaveLength(callsBeforeView);
  await attach('subscription-explicit-existing-grant-read.json', { requestsAfterRefresh: subscriptionReads.slice(readOffset), viewedSnapshot,
    managementActionsBefore: beforeView.tables.managementActions, managementActionsAfter: afterView.tables.managementActions,
    proofsBefore: beforeView.tables.managementAuthorizationProofs, proofsAfter: afterView.tables.managementAuthorizationProofs });
  const cancelledCard = page.locator('.subscription-card').filter({ hasText: cancellable.merchant });
  await expect(cancelledCard).toContainText('已取消'); await expect(cancelledCard).toContainText('允许扣款');
  const blockedCard = page.locator('.subscription-card').filter({ hasText: unsupported.merchant });
  await expect(blockedCard).toContainText('有效'); await expect(blockedCard).toContainText('已拦截'); await expect(blockedCard).toContainText('请联系商户办理');
  await shot(page, 'subscription-distinct-merchant-and-bank-terminal');
  await page.setViewportSize({ width: 390, height: 844 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await shot(page, 'subscription-terminal-mobile'); expect(errors).toEqual([]);
});
