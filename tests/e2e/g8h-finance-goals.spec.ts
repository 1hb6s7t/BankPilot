import { test, expect, type Page, type BrowserContext } from '@playwright/test';
import type { AcceptedConversationMessage, ConversationCommand, ConversationHistory } from '../../packages/contracts/src/conversations.js';
import type { GoalView, InvestmentAction, BillReport } from '../../packages/contracts/src/index.js';
import { startG8hBrowserApp } from '../fixtures/g8h-browser-app.js';

let fixture: Awaited<ReturnType<typeof startG8hBrowserApp>> | undefined;
let pageErrors: string[];
const attach = (name: string, data: unknown) => test.info().attach(name, { body: JSON.stringify(data, null, 2), contentType: 'application/json' });
const shot = (page: Page, name: string) => page.screenshot({ path: test.info().outputPath(`${name}.png`), fullPage: true, animations: 'disabled' });
const read = async <T = any>(page: Page, path: string): Promise<T> => {
  const response = await page.request.get(`${fixture!.origin}${path}`);
  expect(response.status()).toBe(200);
  return response.json();
};
async function login(page: Page) {
  await page.goto(fixture!.origin);
  await page.getByLabel('邮箱地址').fill(fixture!.email);
  await page.getByLabel('密码', { exact: true }).fill(fixture!.password);
  await page.getByRole('button', { name: '进入安全工作台' }).click();
  await expect(page.getByRole('textbox', { name: '描述转账需求' })).toBeVisible();
  await expect(page.getByRole('combobox', { name: '选择聊天' })).toBeEnabled();
}
async function chat(page: Page) {
  if (!await page.getByRole('textbox', { name: '描述转账需求' }).isVisible()) {
    await page.getByRole('button', { name: '转账工作台', exact: true }).click();
  }
  await expect(page.getByRole('textbox', { name: '描述转账需求' })).toBeVisible();
}
async function terminal(page: Page, cid: string, id: string, status: 'failed' | 'complete') {
  let value!: ConversationCommand;
  await expect.poll(async () => {
    value = await read(page, `/api/conversations/${cid}/commands/${id}`);
    return value.status;
  }, { timeout: 30_000, intervals: [100, 250, 500] }).toBe(status);
  return value;
}
async function send(page: Page, message: string, status: 'failed' | 'complete' = 'complete') {
  await chat(page);
  await page.getByRole('textbox', { name: '描述转账需求' }).fill(message);
  const accepted = page.waitForResponse(response => new URL(response.url()).origin === fixture!.origin && /\/api\/conversations\/[^/]+\/messages$/.test(response.url()) && response.request().method() === 'POST');
  await page.getByRole('button', { name: '发送请求' }).click();
  const response = await accepted;
  expect(response.status()).toBe(202);
  const { command }: AcceptedConversationMessage = await response.json();
  const done = await terminal(page, command.conversationId, command.commandId, status);
  await attach(`command-${command.commandId}.json`, done);
  return done;
}
async function authenticator(context: BrowserContext, page: Page) {
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', { options: {
    protocol: 'ctap2', transport: 'internal', hasResidentKey: true,
    hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true,
  } });
}
function unchangedMoney(before: any, after: any) {
  expect(after.dashboard.accounts).toEqual(before.dashboard.accounts);
  expect(after.investment.positions).toEqual(before.investment.positions);
  expect(after.tables.providerTransfers).toEqual(before.tables.providerTransfers);
  expect(after.tables.providerRedemptions).toEqual(before.tables.providerRedemptions);
  expect(after.tables.ledgerEntries).toEqual(before.tables.ledgerEntries);
  expect(after.tables.redemptionEntries).toEqual(before.tables.redemptionEntries);
  expect(after.tables.authorizationProofs).toEqual(before.tables.authorizationProofs);
  expect(after.tables.investmentAuthorizationProofs).toEqual(before.tables.investmentAuthorizationProofs);
}
function balanced(entries: any[], key: string, amount: string) {
  const rows = entries.filter(row => row.provider_key === key);
  expect(rows).toHaveLength(2);
  expect(rows.map(row => row.side).sort()).toEqual(['CREDIT', 'DEBIT']);
  expect(rows.every(row => row.amount_minor === amount)).toBe(true);
}
function authorized(snapshot: any, table: string, action: { id: string; actionHash: string }, level: 'STRONG' | 'CONFIRMATION') {
  const proofs = snapshot.tables[table].filter((proof: any) => proof.action_id === action.id);
  expect(proofs).toHaveLength(1);
  expect(proofs[0]).toMatchObject({ user_id: fixture!.userId, action_hash: action.actionHash, level });
  expect(Number.isFinite(Date.parse(proofs[0].consumed_at))).toBe(true);
}

test.beforeEach(async ({ page }) => {
  pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  fixture = await startG8hBrowserApp({ businessTime: 'previous-business-day' });
});
test.afterEach(async () => {
  if (!fixture) return;
  const current = fixture;
  fixture = undefined;
  try {
    await attach('terminal-snapshot.json', await current.snapshot());
    await attach('model-calls.json', current.calls);
    await attach('isolation.json', { origin: current.origin, apiOrigin: current.apiOrigin, schema: current.schema, jobsSchema: current.jobsSchema, userId: current.userId,
      realLoginApiPlannerDatabaseWorker: true, controlledModelTransport: true, cloudCalls: 0, timeDomains: current.timeDomains, softwareAuthenticator: 'Chromium CTAP2; real signature verification' });
    await attach('page-errors.json', pageErrors);
    expect(pageErrors).toEqual([]);
  } finally {
    const cleanup = await current.close();
    await attach('cleanup.json', cleanup);
    expect(cleanup.errors).toEqual([]);
    expect(cleanup).toMatchObject({ success: true, clean: true, planningDrained: true, workerStopped: true,
      schemaDropped: true, jobsSchemaDropped: true, authUserDeleted: true,
      portsClosed: true, ownedConnectionsClosed: true, temporaryDirectoryRemoved: true });
  }
});

test('bills preserve source evidence and missing months, and confirmed funds protection blocks an unaffordable transfer', async ({ page }) => {
  await login(page);
  const before = await fixture!.snapshot();
  const current = await send(page, fixture!.scenarios.billsCurrent);
  expect(current.failure).toBeUndefined();
  expect(current.result?.actions).toEqual([]);
  expect(current.result?.billAnalysis?.status).toBe('partial');
  await page.getByRole('button', { name: '账单', exact: true }).click();
  await expect(page.getByText('该月数据不完整。以下汇总只覆盖已提供的流水，不代表完整月份的收支。')).toBeVisible();
  const report = await read<BillReport>(page, '/api/bills');
  expect(report.coverage?.status).toBe('partial');
  expect(report.source).toBe('SYNTHETIC');
  expect(report.period).toBe(before.investment.businessDate.slice(0, 7));
  expect(current.result?.billReport?.period).toBe(report.period);
  expect(report.incomeMinor).toBe('1200000');
  expect(current.result?.billReport?.expenseMinor).toBe(report.expenseMinor);
  const recurring = report.findings.find(finding => finding.kind === 'RECURRING')!;
  expect(recurring.transactionIds.length).toBeGreaterThan(1);
  const evidenceIds = new Set([...report.transactions, ...(report.evidenceTransactions ?? [])].map(row => row.id));
  expect(recurring.transactionIds.every(id => evidenceIds.has(id))).toBe(true);
  await page.getByRole('button', { name: `查看原交易 ${recurring.transactionIds[1]}`, exact: false }).first().click();
  await expect(page.locator('.bill-row-focused')).toHaveCount(1);
  await shot(page, 'bills-source-evidence');
  await page.getByLabel('选择账单月份').fill('2020-01');
  await expect(page.getByRole('heading', { name: '2020-01 账单尚未提供' })).toBeVisible();
  await expect(page.locator('.bill-summary-grid')).toHaveCount(0);
  await expect(page.getByText('不能将缺少数据理解为该月没有消费。请选择有账单的月份。')).toBeVisible();
  await shot(page, 'missing-month-is-not-zero');
  const missing = await send(page, fixture!.scenarios.billsMissing);
  expect(missing.failure).toBeUndefined();
  expect(missing.result?.billAnalysis?.status).toBe('missing_data');
  expect(missing.result?.billAnalysis?.missingPeriods).toContain('2020-01');
  expect(missing.result?.billAnalysis?.amountMinor).toBeUndefined();
  expect(missing.result?.actions).toEqual([]);
  unchangedMoney(before, await fixture!.snapshot());

  await page.getByRole('button', { name: '资金计划', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '最低保留金额（元）', exact: true })).toHaveValue('2000.00');
  await page.getByRole('textbox', { name: '最低保留金额（元）', exact: true }).fill('2500');
  await page.getByRole('button', { name: '确认并保存规则' }).click();
  await expect(page.getByText('资金保护规则已保存，版本 2。')).toBeVisible();
  const funds = await read(page, '/api/funds');
  expect(funds.policy.version).toBe(2);
  expect(funds.preview).toMatchObject({ protectedMinor: '550000', spendableMinor: '250000' });
  const blocked = await send(page, fixture!.scenarios.billsProtectedTransfer);
  expect(blocked.failure).toBeUndefined();
  expect(blocked.result?.actions).toEqual([]);
  expect(blocked.result?.fundsPreview).toMatchObject({ allowed: false, policyVersion: 2, protectedMinor: '550000', shortfallMinor: '150000' });
  await expect(page.locator('.actions-panel').getByRole('button', { name: '确认并执行', exact: true })).toHaveCount(0);
  const after = await fixture!.snapshot();
  unchangedMoney(before, after);
  expect(after.dashboard.actions).toEqual([]);
  await page.reload();
  expect((await read(page, '/api/dashboard')).latestPlan.taskId).toBe(blocked.result!.taskId);
  await shot(page, 'funds-protection-refusal');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(async () => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await shot(page, 'funds-refusal-mobile');
  await attach('reports-and-funds.json', { report, funds, before, after });
});

test('chat redemptions require real Passkey: T+0 posts one receipt while T+2 remains reserved and unavailable as cash', async ({ page, context }) => {
  await login(page);
  await authenticator(context, page);
  const before = await fixture!.snapshot();
  const unknown = await send(page, fixture!.scenarios.redeemUnknown);
  expect(unknown.failure).toBeUndefined();
  expect(unknown.result?.investmentActions ?? []).toEqual([]);
  unchangedMoney(before, await fixture!.snapshot());
  const proposed = await send(page, fixture!.scenarios.redeemT0);
  const immediate = proposed.result?.investmentActions?.[0] as InvestmentAction;
  expect(immediate).toMatchObject({ productId: 'synthetic-t0', amountMinor: '42735', status: 'AWAITING_VERIFICATION', tier: 'RED' });
  unchangedMoney(before, await fixture!.snapshot());
  await page.getByRole('button', { name: '查看赎回确认卡', exact: true }).click();
  const t0 = page.locator('.investment-action-card').filter({ hasText: 'T+0' });
  await t0.getByRole('button', { name: '还没有 Passkey？先注册' }).click();
  await expect(t0.getByRole('status')).toContainText('Passkey 已登记');
  unchangedMoney(before, await fixture!.snapshot());
  await shot(page, 'redemption-before-authorization');
  await t0.getByRole('button', { name: 'Passkey 强验证并确认赎回' }).click();
  await expect.poll(async () => (await read(page, '/api/investments')).actions.find((action: InvestmentAction) => action.id === immediate.id)?.status, { timeout: 25_000 }).toBe('SUCCEEDED');
  await expect(t0.locator('.management-receipt')).toContainText('模拟结算已完成');
  const settled = await fixture!.snapshot();
  expect(settled.dashboard.accounts[0]).toMatchObject({ balanceMinor: '842735', reservedMinor: '0' });
  expect(settled.investment.positions.find((position: any) => position.productId === 'synthetic-t0')).toMatchObject({ principalMinor: '457265', reservedMinor: '0' });
  expect(settled.tables.providerRedemptions).toHaveLength(1);
  authorized(settled, 'investmentAuthorizationProofs', immediate, 'STRONG');
  const provider = settled.tables.providerRedemptions[0];
  expect(provider.status).toBe('SETTLED');
  expect(provider.receipt.providerTransactionId).toBe(settled.investment.actions.find((action: any) => action.id === immediate.id)!.receipt!.providerTransactionId);
  balanced(settled.tables.redemptionEntries, provider.provider_key, '42735');
  await shot(page, 't0-real-worker-receipt');

  const deferred = await send(page, fixture!.scenarios.redeemT2);
  const delayed = deferred.result?.investmentActions?.[0] as InvestmentAction;
  expect(delayed).toMatchObject({ productId: 'synthetic-t2', amountMinor: '10050', status: 'AWAITING_VERIFICATION' });
  unchangedMoney(settled, await fixture!.snapshot());
  await page.getByRole('button', { name: '查看赎回确认卡', exact: true }).click();
  const t2 = page.locator('.investment-action-card').filter({ hasText: 'T+2' });
  await t2.getByRole('button', { name: 'Passkey 强验证并确认赎回' }).click();
  await expect(t2.locator('.management-action-status')).toHaveText('模拟结算中 · 未到账', { timeout: 25_000 });
  await expect(t2.locator('.investment-settling-note')).toContainText('不计入可用现金');
  const waiting = await fixture!.snapshot();
  expect(waiting.dashboard.accounts).toEqual(settled.dashboard.accounts);
  expect(waiting.investment.actions.find((action: any) => action.id === delayed.id)).toMatchObject({ status: 'SETTLING' });
  expect(waiting.tables.investmentActions.find((action: any) => action.id === delayed.id)).toMatchObject({ status: 'SETTLING', reserved: true });
  expect(waiting.investment.actions.find((action: any) => action.id === delayed.id)!.receipt).toBeUndefined();
  expect(waiting.investment.positions.find((position: any) => position.productId === 'synthetic-t2')).toMatchObject({ principalMinor: '1000000', reservedMinor: '10050' });
  expect(waiting.tables.providerRedemptions).toHaveLength(2);
  authorized(waiting, 'investmentAuthorizationProofs', delayed, 'STRONG');
  expect(waiting.tables.providerRedemptions.filter((row: any) => row.status === 'ACCEPTED')).toHaveLength(1);
  expect(waiting.tables.redemptionEntries).toHaveLength(2);
  const timeline = await read(page, '/api/investments/timeline');
  expect(timeline.days.some((day: any) => day.expectedInMinor === '10050')).toBe(true);
  await page.reload();
  await page.getByRole('button', { name: '理财', exact: true }).click();
  await expect(page.locator('.investment-action-card').filter({ hasText: 'T+2' }).locator('.management-action-status')).toHaveText('模拟结算中 · 未到账');
  await shot(page, 't2-awaiting-settlement');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(async () => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await shot(page, 'investment-mobile');
  await attach('redemption-boundaries.json', { before, settled, waiting, timeline });
});

test('tuition goal resumes the same review, redeems first, then separately authorizes one payment and survives re-login', async ({ page, context }) => {
  test.setTimeout(150_000);
  await login(page);
  await authenticator(context, page);
  const before = await fixture!.snapshot();
  const bills = await send(page, fixture!.scenarios.billsCurrent);
  expect(bills.result?.billAnalysis?.status).toBe('partial');
  expect((await read(page, '/api/funds')).preview.protectedMinor).toBe('500000');
  const callStart = fixture!.calls.length;
  fixture!.failNextRolePair('reviewer');
  const failed = await send(page, fixture!.scenarios.tuitionGoal, 'failed');
  expect(failed).toMatchObject({ retryable: true, failure: { phase: 'planning', code: 'MODEL_HTTP_502' } });
  expect(failed.result).toBeUndefined();
  const failedState = await fixture!.snapshot();
  unchangedMoney(before, failedState);
  expect(failedState.goals).toEqual([]);
  const failedRow = await fixture!.savedCommand(failed.commandId);
  expect(Object.keys(failedRow.stage_results).sort()).toEqual(['domain:goal', 'domain:investment']);
  await page.reload();
  await expect(page.getByRole('button', { name: '重试原请求', exact: true })).toBeVisible();
  await shot(page, 'goal-review-failed-restored');
  const callsBeforeRetry = fixture!.calls.length;
  const retry = page.waitForResponse(response => response.url().endsWith(`/commands/${failed.commandId}/retry`) && response.request().method() === 'POST');
  await page.getByRole('button', { name: '重试原请求', exact: true }).click();
  expect((await retry).status()).toBe(202);
  const complete = await terminal(page, failed.conversationId, failed.commandId, 'complete');
  expect(complete).toMatchObject({ commandId: failed.commandId, rootCommandId: failed.commandId, revision: 0 });
  expect(fixture!.calls.slice(callsBeforeRetry).map(call => call.role)).toEqual(['reviewer']);
  expect(fixture!.calls.slice(callStart).filter(call => call.role === 'semantic_intent')).toHaveLength(1);
  expect(fixture!.calls.slice(callStart).filter(call => call.role === 'goal')).toHaveLength(1);
  expect(fixture!.calls.slice(callStart).filter(call => call.role === 'investment')).toHaveLength(1);
  expect(fixture!.calls.slice(callStart).filter(call => call.role === 'reviewer')).toHaveLength(3);
  expect(complete.modelAttempts).toHaveLength(6);
  expect(complete.modelAttempts!.reduce((sum, attempt) => sum + attempt.requestMaxOutputTokens, 0)).toBeLessThanOrEqual(32768);
  expect(complete.result?.actions).toEqual([]);
  expect(complete.result?.investmentActions ?? []).toEqual([]);
  let goal = complete.result?.goal as GoalView;
  expect(goal).toMatchObject({ amountMinor: '60075', payeeId: 'payee-lin', targetDate: fixture!.scenarios.targetDate, funding: { redemptionAmountMinor: '100000' } });
  expect(goal.title).toBe('林晓生活目标');
  expect(complete.originalMessage).toBe(fixture!.scenarios.tuitionGoal);
  expect(goal.nodes.map(node => node.kind)).toEqual(['REDEEM', 'WAIT_SETTLEMENT', 'TRANSFER']);
  expect(goal.nodes[0].investmentAction?.status).toBe('AWAITING_VERIFICATION');
  expect(goal.nodes.slice(1).every(node => !node.actionRef)).toBe(true);
  unchangedMoney(before, await fixture!.snapshot());
  await page.getByRole('button', { name: '查看生活目标计划', exact: true }).click();
  await expect(page.getByRole('heading', { name: '生活目标计划', exact: true })).toBeVisible();
  const detail = page.locator('.goal-detail-panel');
  await expect(detail.locator('.goal-metrics')).toContainText('600.75');
  await shot(page, 'tuition-goal-before-authorization');
  await detail.getByRole('button', { name: '检查进度并准备下一步' }).click();
  await expect(detail.getByRole('button', { name: 'Passkey 强验证并确认赎回' })).toBeVisible();
  goal = await read<GoalView>(page, `/api/goals/${goal.id}`);
  const redemptionId = goal.nodes[0].actionRef!.actionId;
  expect(goal.nodes[2].actionRef).toBeUndefined();
  await detail.getByRole('button', { name: '检查进度并准备下一步' }).click();
  expect((await read<GoalView>(page, `/api/goals/${goal.id}`)).nodes[0].actionRef!.actionId).toBe(redemptionId);
  unchangedMoney(before, await fixture!.snapshot());
  await detail.getByRole('button', { name: '还没有 Passkey？先注册' }).click();
  await expect(detail.getByRole('status')).toContainText('Passkey 已登记');
  await detail.getByRole('button', { name: 'Passkey 强验证并确认赎回' }).click();
  await expect.poll(async () => (await read<GoalView>(page, `/api/goals/${goal.id}`)).nodes[0].investmentAction?.status, { timeout: 25_000 }).toBe('SUCCEEDED');
  goal = await read<GoalView>(page, `/api/goals/${goal.id}`);
  expect(goal.nodes[1].status).toBe('SUCCEEDED');
  expect(goal.nodes[2].actionRef).toBeUndefined();
  const redemptionReceipt = goal.nodes[0].investmentAction!.receipt!;
  const funded = await fixture!.snapshot();
  expect(funded.dashboard.accounts[0]).toMatchObject({ balanceMinor: '900000', reservedMinor: '0' });
  expect(funded.tables.providerTransfers).toHaveLength(0);
  expect(funded.tables.providerRedemptions).toHaveLength(1);
  authorized(funded, 'investmentAuthorizationProofs', goal.nodes[0].investmentAction!, 'STRONG');
  balanced(funded.tables.redemptionEntries, funded.tables.providerRedemptions[0].provider_key, '100000');
  await page.getByRole('button', { name: '刷新目标', exact: true }).click();
  await shot(page, 'funded-without-payment-permission');
  await detail.getByRole('button', { name: '检查进度并准备下一步' }).click();
  await expect(detail.getByRole('button', { name: '确认此转账', exact: true })).toBeVisible();
  await expect(detail.locator('.goal-transfer-action')).toContainText('待本人确认');
  goal = await read<GoalView>(page, `/api/goals/${goal.id}`);
  const transferId = goal.nodes[2].actionRef!.actionId;
  unchangedMoney(funded, await fixture!.snapshot());
  await shot(page, 'goal-separate-transfer-confirmation');
  await detail.getByRole('button', { name: '确认此转账', exact: true }).click();
  await expect.poll(async () => (await read<GoalView>(page, `/api/goals/${goal.id}`)).status, { timeout: 25_000 }).toBe('SUCCEEDED');
  await page.getByRole('button', { name: '刷新目标', exact: true }).click();
  await expect(detail.locator('.goal-status')).toHaveText('目标已完成');
  await expect(detail.locator('.goal-transfer-action')).toContainText('已完成');
  const final = await fixture!.snapshot();
  expect(final.dashboard.accounts[0]).toMatchObject({ balanceMinor: '839925', reservedMinor: '0' });
  expect(final.tables.providerTransfers).toHaveLength(1);
  expect(final.tables.providerRedemptions).toHaveLength(1);
  balanced(final.tables.ledgerEntries, final.tables.providerTransfers[0].provider_key, '60075');
  balanced(final.tables.redemptionEntries, final.tables.providerRedemptions[0].provider_key, '100000');
  goal = await read<GoalView>(page, `/api/goals/${goal.id}`);
  expect(goal.nodes.every(node => node.status === 'SUCCEEDED')).toBe(true);
  expect(goal.nodes[0].actionRef?.actionId).toBe(redemptionId);
  expect(goal.nodes[0].investmentAction?.receipt).toEqual(redemptionReceipt);
  expect(goal.nodes[2].actionRef?.actionId).toBe(transferId);
  authorized(final, 'authorizationProofs', goal.nodes[2].transferAction!, 'CONFIRMATION');
  expect(goal.nodes[2].transferAction?.receipt?.providerTransactionId).toBe(final.tables.providerTransfers[0].receipt.providerTransactionId);
  const advanceReplay = await page.request.post(`${fixture!.origin}/api/goals/${goal.id}/advance`, { headers: { Origin: fixture!.origin } });
  expect(advanceReplay.status()).toBe(200);
  const afterReplay = await fixture!.snapshot();
  expect(afterReplay.tables.providerTransfers).toEqual(final.tables.providerTransfers);
  expect(afterReplay.tables.providerRedemptions).toEqual(final.tables.providerRedemptions);
  const history = await read<ConversationHistory>(page, `/api/conversations/${failed.conversationId}/messages`);
  expect(history.commands.filter(command => command.commandId === failed.commandId)).toHaveLength(1);
  expect(history.messages.filter(message => message.commandId === failed.commandId && message.kind === 'failure')).toHaveLength(1);
  expect(history.messages.filter(message => message.commandId === failed.commandId && message.kind === 'result')).toHaveLength(1);
  await shot(page, 'tuition-goal-final-receipts');
  await page.getByRole('button', { name: '退出登录', exact: true }).click();
  await expect(page.getByRole('button', { name: '进入安全工作台' })).toBeVisible();
  await login(page);
  await page.getByRole('button', { name: '生活目标', exact: true }).click();
  await expect(page.locator('.goal-detail-panel .goal-status')).toHaveText('目标已完成');
  expect((await read<GoalView>(page, `/api/goals/${goal.id}`)).nodes[2].actionRef?.actionId).toBe(transferId);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(async () => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await shot(page, 'completed-tuition-mobile');
  await attach('goal-lifecycle.json', { before, failed, failedRow, complete, completedRow: await fixture!.savedCommand(failed.commandId), funded, final, goal, history });
});
