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
async function sendBillQuestion(page: Page) {
  await page.getByRole('textbox', { name: '描述转账需求' }).fill(fixture!.scenarios.billsCurrent);
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
    expect(reviewerCalls).toBe(1);
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

for (const refusal of ['approved_false', 'bill_scope_false'] as const) {
  test(`reviewer ${refusal} withholds bill answer through API, browser, refresh and login`, async ({ page }) => {
    reviewerCalls = 0;
    fixture = await startG8hBrowserApp({ controlledReviewerOverride: context => {
      reviewerCalls++;
      expect(context.originalRequest).toBe(fixture!.scenarios.billsCurrent);
      expect(context.deterministic?.bills).toBeDefined();
      const base = reviewResponse(context);
      return refusal === 'approved_false' ? { ...base, approved: false } : { ...base, billQueryAligned: false };
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
    expect(result.diagnostics?.review?.rawApproved).toBe(refusal !== 'approved_false');
    expect(result.diagnostics?.review?.effectiveApproved).toBe(false);
    expect(result.evidence).toEqual([]);
    expect(result.findings).toContain('BILL_ANSWER_REVIEW_REJECTED');
    if (refusal === 'bill_scope_false') expect(result.findings).toContain('BILL_QUERY_SCOPE_MISMATCH');
    const exposed = [result.summary, ...result.events.map(item => item.summary), ...result.evidence.map(item => item.detail)].join(' ');
    expect(exposed).not.toContain(report.incomeMinor);
    expect(exposed).not.toContain(report.expenseMinor);
    expect(exposed).not.toContain(merchant!);
    const panel = page.locator('.plan-panel');
    await expect(panel.getByRole('region', { name: '账单答案待核对' })).toBeVisible();
    await expect(panel.getByRole('region', { name: '账单答案待核对' }).getByText(withheld, { exact: false })).toBeVisible();
    await expect(panel.getByRole('region', { name: '账单查询依据' })).toHaveCount(0);
    await expect(panel.getByText('账单联动')).toHaveCount(0);
    await expect(panel.getByRole('button', { name: '确认并执行' })).toHaveCount(0);
    await capture(page, `${refusal}-withheld`);

    await page.reload();
    await expect(page.getByRole('combobox', { name: '选择聊天' })).toBeEnabled();
    await page.getByRole('combobox', { name: '选择聊天' }).selectOption(command.conversationId);
    await expect(page.getByRole('region', { name: '账单答案待核对' })).toBeVisible();
    await expect(page.locator('.plan-panel').getByText('账单联动')).toHaveCount(0);
    expect((await readCommand(page, command.conversationId, command.commandId)).result?.billReports).toBeUndefined();
    await capture(page, `${refusal}-refresh`);

    await page.getByRole('button', { name: '退出登录', exact: true }).click();
    await expect(page.getByRole('button', { name: '进入安全工作台' })).toBeVisible();
    await login(page);
    await page.getByRole('combobox', { name: '选择聊天' }).selectOption(command.conversationId);
    await expect(page.getByRole('region', { name: '账单答案待核对' })).toBeVisible();
    await expect(page.locator('.plan-panel').getByText('账单联动')).toHaveCount(0);
    expect((await readCommand(page, command.conversationId, command.commandId)).result?.billReport).toBeUndefined();
    await capture(page, `${refusal}-relogin`);
  });
}

test('approved and aligned bill review exposes the correct query only', async ({ page }) => {
  reviewerCalls = 0;
  fixture = await startG8hBrowserApp({ controlledReviewerOverride: context => {
    reviewerCalls++;
    expect(context.deterministic?.bills).toBeDefined();
    return reviewResponse(context, { approved: true, billQueryAligned: true });
  } });
  await login(page);
  const command = await sendBillQuestion(page);
  noFundsAction(command);
  expect(command.result?.billAnswerReview).toBeUndefined();
  expect(command.result?.billAnalysis?.status).toBe('partial');
  expect(command.result?.billAnalysis?.kind).toBe('summary');
  expect(command.result?.billAnalysis?.periods).toEqual([command.result!.billReport!.period]);
  expect(command.result?.billAnalysis?.missingPeriods).toEqual([]);
  expect(command.result?.billReport?.source).toBe('SYNTHETIC');
  expect(command.result?.diagnostics?.review?.rawApproved).toBe(true);
  expect(command.result?.diagnostics?.review?.effectiveApproved).toBe(true);
  const panel = page.locator('.plan-panel');
  await expect(panel.getByRole('region', { name: '账单查询依据' })).toBeVisible();
  await expect(panel.getByText('账单联动')).toBeVisible();
  await expect(panel.getByRole('region', { name: '账单答案待核对' })).toHaveCount(0);
  await capture(page, 'approved-query');
});

test('controlled reviewer override cannot be mixed with cloud transport', async () => {
  await expect(startG8hBrowserApp({ controlledReviewerOverride: () => ({}), cloudProvider: {
    baseURL: 'https://synthetic.invalid/v1', model: 'synthetic-model',
  } })).rejects.toThrow('G8H_CONTROLLED_REVIEWER_FORBIDS_CLOUD');
});
