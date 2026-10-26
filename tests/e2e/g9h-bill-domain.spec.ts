import { billDomainResponse } from '../fixtures/bill-domain-response.js';
import { test, expect, type Page } from '@playwright/test';
import type { AcceptedConversationMessage, ConversationCommand } from '../../packages/contracts/src/conversations.js';
import type { BillReport } from '../../packages/contracts/src/index.js';
import { startG8hBrowserApp } from '../fixtures/g8h-browser-app.js';
import { reviewResponse } from '../fixtures/review-response.js';

type Fixture = Awaited<ReturnType<typeof startG8hBrowserApp>>;
let fixture: Fixture | undefined;
let reviewerCalls = 0;
const withheld = '账单结论尚未通过核对，未作为本次查询答案。';
const attach = (name: string, value: unknown) => test.info().attach(name, { body: JSON.stringify(value, null, 2), contentType: 'application/json' });
const capture = (page: Page, name: string) => page.screenshot({ path: test.info().outputPath(`${name}.png`), fullPage: true, animations: 'disabled' });
async function expectReadableBillRefusal(page: Page, reason: string) {
  const codes = /BILL_(?:DOMAIN|ANSWER|QUERY|REVIEW|DATA|SCOPE)_/;
  await expect(page.locator('.chat-message-assistant').filter({ hasText: reason })).toBeVisible();
  await expect.poll(async () => (await page.locator('.chat-message-assistant').allTextContents()).join('\n')).not.toMatch(codes);
  await expect(page.locator('.plan-panel')).not.toContainText(codes);
}


async function login(page: Page) {
  await page.goto(fixture!.origin);
  await page.getByLabel('邮箱地址').fill(fixture!.email);
  await page.getByLabel('密码', { exact: true }).fill(fixture!.password);
  await page.getByRole('button', { name: '进入安全工作台' }).click();
  await expect(page.getByRole('combobox', { name: '选择聊天' })).toBeEnabled();
}
async function readCommand(page: Page, conversationId: string, commandId: string) {
  const response = await page.request.get(`${fixture!.origin}/api/conversations/${conversationId}/commands/${commandId}`);
  expect(response.status()).toBe(200);
  return response.json() as Promise<ConversationCommand>;
}
async function sendBillQuestion(page: Page, message: string = fixture!.scenarios.billsCurrent) {
  await page.getByRole('textbox', { name: '描述转账需求' }).fill(message);
  const accepted = page.waitForResponse(response => response.request().method() === 'POST' &&
    new URL(response.url()).origin === fixture!.origin && /\/api\/conversations\/[^/]+\/messages$/.test(response.url()));
  await page.getByRole('button', { name: '发送请求' }).click();
  const response = await accepted;
  expect(response.status()).toBe(202);
  const { command } = await response.json() as AcceptedConversationMessage;
  let terminal!: ConversationCommand;
  await expect.poll(async () => {
    terminal = await readCommand(page, command.conversationId, command.commandId);
    return terminal.status;
  }, { timeout: 45_000, intervals: [100, 250, 500] }).toBe('complete');
  expect(terminal.failure).toBeUndefined();
  expect(terminal.result?.mode).toBe('model');
  await attach('terminal-command.json', terminal);
  return terminal;
}
function noFundsAction(command: ConversationCommand) {
  expect(command.result?.actions).toEqual([]);
  expect(command.result?.suggestions).toEqual([]);
  expect(command.result?.managementSuggestions ?? []).toEqual([]);
  expect(command.result?.investmentSuggestions ?? []).toEqual([]);
}

test.afterEach(async () => {
  const current = fixture; fixture = undefined;
  if (!current) return;
  try {
    await attach('controlled-model-calls.json', current.calls);
    await attach('isolation.json', { modelMode: current.modelMode, cloudCalls: current.cloudCalls, reviewerCalls,
      realApiPostgresPlannerWorker: true, schema: current.schema, timeDomains: current.timeDomains });
    expect(current.modelMode).toBe('controlled');
    expect(current.cloudCalls).toEqual([]);
    expect(reviewerCalls).toBe(2);
    const snapshot = await current.snapshot();
    expect(snapshot.tables.actions).toEqual([]);
    expect(snapshot.tables.providerTransfers).toEqual([]);
    expect(snapshot.tables.authorizationProofs).toEqual([]);
    await attach('action-snapshot.json', { actions: snapshot.tables.actions, transfers: snapshot.tables.providerTransfers,
      authorizationProofs: snapshot.tables.authorizationProofs });
  } finally {
    const cleanup = await current.close();
    await attach('cleanup.json', cleanup);
    expect(cleanup).toMatchObject({ success: true, clean: true, planningDrained: true, workerStopped: true,
      schemaDropped: true, jobsSchemaDropped: true, authUserDeleted: true, portsClosed: true,
      ownedConnectionsClosed: true, temporaryDirectoryRemoved: true, errors: [] });
  }
});

for (const refusal of ['query_alignment_false', 'evidence_concern'] as const) {
  test(`domain ${refusal} cannot be overridden by approving reviewer through API, browser, refresh and login`, async ({ page }) => {
    reviewerCalls = 0;
    fixture = await startG8hBrowserApp({ controlledBillDomainOverride: context => {
      const base = billDomainResponse(context);
      return refusal === 'query_alignment_false' ? { ...base, queryAligned: false } : { ...base, concerns: ['evidence_mismatch'] };
    }, controlledReviewerOverride: context => {
      reviewerCalls++;
      return reviewResponse(context, { approved: true, billQueryAligned: true });
    } });
    await login(page);
    const reportResponse = await page.request.get(`${fixture.origin}/api/bills`);
    expect(reportResponse.status()).toBe(200);
    const report = await reportResponse.json() as BillReport;
    expect(report.coverage?.status).toBe('partial');
    const merchant = report.transactions.find(item => item.merchant)?.merchant;
    expect(merchant).toBeTruthy();
    const command = await sendBillQuestion(page);
    noFundsAction(command);
    const result = command.result!;
    expect(result.billAnswerReview).toMatchObject({ status: 'withheld' });
    expect(result.billAnalysis).toBeUndefined();
    expect(result.billReport).toBeUndefined();
    expect(result.billReports).toBeUndefined();
    expect(result.summary).toContain(withheld);
    expect(result.clarification).toContain(withheld);
    expect(result.events.find(item => item.role === 'bills' && item.status === 'completed')?.summary).toContain(withheld);
    expect(result.diagnostics?.review?.rawApproved).toBe(true);
    expect(result.diagnostics?.review?.effectiveApproved).toBe(false);
    expect(result.evidence).toEqual([]);
    expect(result.findings).toContain('BILL_ANSWER_REVIEW_REJECTED');
    expect(result.findings).toContain('BILL_DOMAIN_ASSESSMENT_REJECTED');
    const exposed = [result.summary, ...result.events.map(item => item.summary), ...result.evidence.map(item => item.detail)].join(' ');
    expect(exposed).not.toContain(report.incomeMinor);
    expect(exposed).not.toContain(report.expenseMinor);
    expect(exposed).not.toContain(merchant!);
    expect(JSON.stringify(result)).not.toContain(merchant!);
    for (const transaction of report.transactions) expect(JSON.stringify(result)).not.toContain(transaction.id);
    const panel = page.locator('.plan-panel');
    await expect(panel.getByRole('region', { name: '账单答案待核对' })).toBeVisible();
    await expect(panel.getByRole('region', { name: '账单答案待核对' }).getByText(withheld, { exact: false })).toBeVisible();
    await expect(panel.getByRole('region', { name: '账单查询依据' })).toHaveCount(0);
    await expect(panel.getByText('账单联动')).toHaveCount(0);
    await expect(panel.getByRole('button', { name: '确认并执行' })).toHaveCount(0);
    const refusalReason = refusal === 'query_alignment_false' ? '本次账单结果的查询范围尚未核对一致。' : '账单流水依据尚未核对一致。';
    await expectReadableBillRefusal(page, refusalReason);
    await capture(page, `${refusal}-withheld`);

    await page.reload();
    await expect(page.getByRole('combobox', { name: '选择聊天' })).toBeEnabled();
    await page.getByRole('combobox', { name: '选择聊天' }).selectOption(command.conversationId);
    await expect(page.getByRole('region', { name: '账单答案待核对' })).toBeVisible();
    await expect(page.locator('.plan-panel').getByText('账单联动')).toHaveCount(0);
    expect((await readCommand(page, command.conversationId, command.commandId)).result).toEqual(result);
    await expectReadableBillRefusal(page, refusalReason);
    await capture(page, `${refusal}-refresh`);

    await page.getByRole('button', { name: '退出登录', exact: true }).click();
    await expect(page.getByRole('button', { name: '进入安全工作台' })).toBeVisible();
    await login(page);
    await page.getByRole('combobox', { name: '选择聊天' }).selectOption(command.conversationId);
    await expect(page.getByRole('region', { name: '账单答案待核对' })).toBeVisible();
    await expect(page.locator('.plan-panel').getByText('账单联动')).toHaveCount(0);
    expect((await readCommand(page, command.conversationId, command.commandId)).result).toEqual(result);
    await expectReadableBillRefusal(page, refusalReason);
    await capture(page, `${refusal}-relogin`);
    // A separate legal read-only card query still traverses its own actual semantic/domain/reviewer path.
    const before = await fixture.snapshot();
    const card = await sendBillQuestion(page, fixture.scenarios.cardQuery);
    expect(card.result?.billAnalysis).toBeUndefined();
    expect(card.result?.billAnswerReview).toBeUndefined();
    expect(card.result?.clarification).toBeUndefined();
    expect(card.conversationId).toBe(command.conversationId);
    expect(card.commandId).not.toBe(command.commandId);
    expect(card.requestSequence).toBeGreaterThan(command.requestSequence!);
    const cardCompleted = card.result!.events.find(item => item.role === 'card' && item.status === 'completed');
    expect(cardCompleted).toBeDefined();
    expect(card.result?.summary).toContain(before.management.cards[0]!.name);
    expect(card.result?.managementActions ?? []).toEqual([]);
    expect((await fixture.snapshot()).tables.managementCards).toEqual(before.tables.managementCards);
    // API completion can precede the chat poll/render. Await the later request's
    // actual UI completion and card facts, so this screenshot cannot capture pending.
    const latestRequest = page.locator('.persistent-chat .chat-command').last();
    await expect(latestRequest.getByText('规划已完成', { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(latestRequest.getByRole('button', { name: '查看计划 · 刷新动作状态', exact: true })).toBeEnabled();
    const cardStep = panel.locator('.agent-step').filter({ has: page.getByText('卡片 Agent', { exact: true }) });
    await expect(cardStep.getByText('已完成', { exact: true })).toBeVisible();
    await expect(cardStep.locator('p')).toHaveText(cardCompleted!.summary);
    for (const item of before.management.cards) {
      await expect(cardStep).toContainText(`${item.name}（${item.maskedNumber}）：${item.status === 'LOST' ? '已挂失' : '正常'}，版本${item.version}`);
    }
    await expect(panel.locator('.progress-waiting')).toHaveCount(0);
    await expect(page.locator('.persistent-chat .planning-indicator')).toHaveCount(0);
    await expect(panel.getByText('规划已返回', { exact: true })).toBeVisible();
    await expect(panel.getByRole('region', { name: '账单查询依据' })).toHaveCount(0);
    await expect(panel.getByText('账单联动')).toHaveCount(0);
    await expect(page.locator('.chat-message-assistant').filter({ hasText: withheld })).toBeVisible();
    await expect(page.locator('.persistent-chat')).not.toContainText(merchant!);
    for (const transaction of report.transactions) await expect(page.locator('.persistent-chat')).not.toContainText(transaction.id);
    expect((await readCommand(page, command.conversationId, command.commandId)).result).toEqual(result);
    await expectReadableBillRefusal(page, refusalReason);
    await capture(page, `${refusal}-legal-card-query`);
  });
}

test('controlled bill domain override cannot be mixed with cloud transport', async () => {
  await expect(startG8hBrowserApp({ controlledBillDomainOverride: () => ({}), cloudProvider: {
    baseURL: 'https://synthetic.invalid/v1', model: 'synthetic-model',
  } })).rejects.toThrow('G9H_CONTROLLED_BILL_DOMAIN_FORBIDS_CLOUD');
});
