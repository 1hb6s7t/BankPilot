import { expectPlanningFailure } from './g8f-failure-assertions';
// Legacy domain/reviewer protocol mocks opt out of the separately tested semantic interpretation stage.
import { describe, expect, it, vi } from 'vitest';
import { createPlanner, resolveCard, resolveSubscription, type LocalContext, type ReviewContext } from '../packages/agents/src/index';
import type { ManagementContext, ManagementSpec, Planner, SubscriptionSnapshot } from '../packages/contracts/src/index';
import { evaluationBillReport, evaluationFunds } from '../evals/fixtures';
import { managementEvaluationFixtures } from '../evals/management-fixtures';

const cards: ManagementContext['cards'] = [
  { id: 'card-a', accountId: 'PRIVATE_CARD_ACCOUNT', name: '日常借记卡', maskedNumber: '****1234', status: 'ACTIVE', version: 2, updatedAt: '2026-10-22T00:00:00Z' },
  { id: 'card-b', accountId: 'PRIVATE_SECOND_ACCOUNT', name: '备用卡', maskedNumber: '****5678', status: 'LOST', version: 5, updatedAt: '2026-10-22T00:00:00Z' },
];
const snapshot: SubscriptionSnapshot = {
  queryActionId: 'query-confirmed-123', queriedAt: '2026-10-22T00:00:00Z', accessExpiresAt: '2100-01-01T00:00:00Z',
  items: [
    { id: 'sub-video', merchant: '星海视频', amountMinor: '2500', currency: 'CNY', nextChargeDate: '2026-11-01', cardId: 'card-a', merchantStatus: 'ACTIVE', bankStatus: 'ALLOWED', collectionStatus: 'ENABLED', version: 4, cancellationSupported: true, source: 'SYNTHETIC_MERCHANT' },
    { id: 'sub-music', merchant: '清泉音乐', amountMinor: '1800', currency: 'CNY', nextChargeDate: '2026-11-03', cardId: 'card-b', merchantStatus: 'ACTIVE', bankStatus: 'ALLOWED', collectionStatus: 'BLOCKED_BY_CARD', version: 7, cancellationSupported: true, source: 'SYNTHETIC_MERCHANT' },
  ],
};
const context = (subscriptions?: SubscriptionSnapshot): ManagementContext => ({ cards: structuredClone(cards), ...(subscriptions ? { subscriptions: structuredClone(subscriptions) } : {}) });
const input = (message: string, managementContext = context()): Parameters<Planner['plan']>[0] => ({
  taskId: 'management-test-task', message, managementContext,
  accounts: [{ id: 'eval-account-1', name: 'PRIVATE_BALANCE_NAME', maskedNumber: '****8888', balanceMinor: '800000', reservedMinor: '0', currency: 'CNY' }],
  payees: [{ id: 'payee-lin', name: '林晓', bank: '合成银行', maskedNumber: '****9999', aliases: ['小林'] }],
});
const proposed = (local: LocalContext) => ({ role: local.role, planVersion: local.planVersion, summary: 'model fixture explanation, never execution', findings: [], evidence: [], managementSuggestions: (local.data.management as { managementSuggestions: ManagementSpec[] }).managementSuggestions });
const modelConfig = { baseURL: 'https://management-model-fixture.invalid', model: 'synthetic-mocked-model', outputMode: 'json_object' as const, maxAttempts: 1 };

describe('fixed phase 3 management evaluation inputs', () => {
  it.each(managementEvaluationFixtures)('$id preserves the scripted semantic baseline', async fixture => {
    const result = await createPlanner({ provider: false }).plan(structuredClone(fixture.input));
    expect(result.managementSuggestions).toEqual(fixture.expected.managementSuggestions);
    expect(result.suggestions).toEqual([]);
    expect(Boolean(result.clarification)).toBe(fixture.expected.clarification);
    expect(result.events.filter(e => e.status === 'started').map(e => e.role).sort()).toEqual([...fixture.expected.roles, 'reviewer'].sort());
    for (const text of fixture.expected.summaryIncludes ?? []) expect(result.summary).toContain(text);
    for (const source of fixture.expected.evidenceSources ?? []) expect(result.evidence.some(e => e.source === source)).toBe(true);
    if (fixture.expected.billAttached) expect(result.billReport).toEqual(fixture.input.billReport);
  });
});

describe('deterministic card management planning', () => {
  it('shows green card facts without preparing a write operation or transferring funds', async () => {
    const result = await createPlanner({ provider: false }).plan(input('查询银行卡状态'));
    expect(result.managementSuggestions).toEqual([]); expect(result.suggestions).toEqual([]);
    expect(result.summary).toContain('日常借记卡'); expect(result.summary).toContain('已挂失');
    expect(result.evidence.some(e => e.source === 'card:card-b:v5')).toBe(true);
  });
  it.each(['不要挂失银行卡', '银行卡未挂失', '银行卡没有挂失', '查询银行卡挂失状态', '查询挂失银行卡', '查看解挂银行卡', '银行卡挂失了吗', '如何挂失银行卡', '不需要解挂卡片', '我不是要挂失银行卡'])('does not turn a negation, question or explanation into mutation: %s', message => {
    expect(resolveCard(message, context()).managementSuggestions).toEqual([]);
  });
  it.each(['挂失银行卡这件事先不要做', '挂失日常借记卡这件事先不要做', '解挂备用卡这件事先不要执行', '不再挂失银行卡', '不再解挂备用卡', '我不打算在今天处理完所有事情以后再挂失银行卡'])('does not prepare a card operation after negation or retraction: %s', message => {
    expect(resolveCard(message, { cards: [message.includes('解挂') ? cards[1]! : cards[0]!] }).managementSuggestions).toEqual([]);
  });
  it('requires a unique card for mutation and uses immutable card version', async () => {
    const ambiguous = await createPlanner({ provider: false }).plan(input('挂失银行卡'));
    expect(ambiguous.managementSuggestions).toEqual([]); expect(ambiguous.clarification).toContain('唯一');
    const resolved = await createPlanner({ provider: false }).plan(input('挂失尾号1234银行卡'));
    expect(resolved.managementSuggestions).toEqual([{ kind: 'CARD_REPORT_LOST', cardId: 'card-a', expectedVersion: 2 }]);
    const restore = await createPlanner({ provider: false }).plan(input('解挂备用卡'));
    expect(restore.managementSuggestions).toEqual([{ kind: 'CARD_UNREPORT_LOST', cardId: 'card-b', expectedVersion: 5 }]);
  });
  it('supports a single available card, but not an explicit wrong suffix or multiple requested cards', () => {
    expect(resolveCard('挂失银行卡', { cards: [cards[0]!] }).managementSuggestions).toEqual([{ kind: 'CARD_REPORT_LOST', cardId: 'card-a', expectedVersion: 2 }]);
    expect(resolveCard('挂失尾号0000银行卡', { cards: [cards[0]!] }).managementSuggestions).toEqual([]);
    expect(resolveCard('挂失尾号1234和5678的银行卡', context()).managementSuggestions).toEqual([]);
    expect(resolveCard('挂失并解挂银行卡', context()).managementSuggestions).toEqual([]);
    expect(resolveCard('挂失另一张卡', { cards: [cards[0]!] }).managementSuggestions).toEqual([]);
  });
  it('clarifies duplicate names and does not repeat a mutation already reflected in card facts', () => {
    expect(resolveCard('挂失日常借记卡', { cards: [cards[0]!, { ...cards[1]!, name: cards[0]!.name }] }).clarification).toContain('唯一');
    expect(resolveCard('挂失备用卡', context()).managementSuggestions).toEqual([]);
    expect(resolveCard('解挂日常借记卡', context()).managementSuggestions).toEqual([]);
  });
  it.each(['挂失交通银行卡', '挂失工资卡', '挂失交通银行卡尾号1234'])('does not replace an explicit unknown card name with the only available card: %s', message => {
    const result = resolveCard(message, { cards: [cards[0]!] });
    expect(result.managementSuggestions).toEqual([]); expect(result.clarification).toContain('名称');
  });
  it.each(['挂失这张卡', '请帮我把这张银行卡挂失', '请挂失日常借记卡'])('still accepts generic or exactly matched single-card references: %s', message => {
    expect(resolveCard(message, { cards: [cards[0]!] }).managementSuggestions).toEqual([{ kind: 'CARD_REPORT_LOST', cardId: 'card-a', expectedVersion: 2 }]);
  });
});

describe('subscription query grants and distinct contract/bank operations', () => {
  it.each(['查询订阅', '取消星海视频订阅', '阻止星海视频银行扣款'])('without confirmed grant prepares only a yellow query request: %s', async message => {
    const result = await createPlanner({ provider: false }).plan(input(message));
    expect(result.managementSuggestions).toEqual([{ kind: 'SUBSCRIPTION_QUERY' }]);
    expect(result.summary).toContain('黄色确认'); expect(result.summary).toContain('未查询');
    expect(result.suggestions).toEqual([]); expect(result.evidence.some(e => e.detail.includes('2500'))).toBe(false);
  });
  it('does not promote negated cancellation or blocking to a query or action', () => {
    for (const text of ['不要取消订阅', '不需要阻止订阅扣款', '不用查询订阅']) expect(resolveSubscription(text, context(snapshot)).managementSuggestions).toEqual([]);
  });
  it.each(['取消星海视频订阅这件事先不要做', '取消云音乐订阅这件事先不要做', '阻止星海视频银行扣款这件事先不要执行', '不再取消星海视频订阅', '不再取消云音乐订阅', '不再阻止星海视频银行扣款', '我不打算在今天处理完所有事情以后再取消星海视频订阅'])('does not turn a retracted subscription request into an action or query: %s', message => {
    for (const managementContext of [context(), context(snapshot)]) expect(resolveSubscription(message, managementContext).managementSuggestions).toEqual([]);
  });
  it.each(['查账单，取消星海视频订阅这件事先不要做', '查银行卡状态，并且不再取消星海视频订阅', '查账单并取消星海视频订阅这件事先不要做'])('does not borrow another domain query for a negated subscription request: %s', message => {
    for (const managementContext of [context(), context(snapshot)]) expect(resolveSubscription(message, managementContext).managementSuggestions).toEqual([]);
  });
  it('keeps a separate explicit subscription query while refusing the retracted cancellation', () => {
    expect(resolveSubscription('取消星海视频订阅这件事先不要做，查询订阅', context(snapshot)).managementSuggestions).toEqual([{ kind: 'SUBSCRIPTION_QUERY' }]);
  });
  it('an expired snapshot cannot produce cancel/block and is not extended; service still owns final expiry checks', () => {
    const expired = { ...structuredClone(snapshot), accessExpiresAt: '2000-01-01T00:00:00Z' };
    const result = resolveSubscription('取消星海视频订阅', context(expired));
    expect(result.managementSuggestions).toEqual([{ kind: 'SUBSCRIPTION_QUERY' }]);
    expect(expired.accessExpiresAt).toBe('2000-01-01T00:00:00Z'); expect(expired.queryActionId).toBe(snapshot.queryActionId);
    expect(JSON.stringify(result)).not.toContain('sub-video');
  });
  it('explicit query still requires a new yellow query confirmation even with a valid prior snapshot', () => {
    expect(resolveSubscription('查询订阅', context(snapshot)).managementSuggestions).toEqual([{ kind: 'SUBSCRIPTION_QUERY' }]);
  });
  it('binds cancel to a unique merchant/version/query action, while bank block never claims contract cancellation', async () => {
    const cancel = await createPlanner({ provider: false }).plan(input('取消星海视频订阅', context(snapshot)));
    expect(cancel.managementSuggestions).toEqual([{ kind: 'SUBSCRIPTION_CANCEL', subscriptionId: 'sub-video', expectedVersion: 4, queryActionId: snapshot.queryActionId }]);
    const block = await createPlanner({ provider: false }).plan(input('阻止星海视频银行扣款', context(snapshot)));
    expect(block.managementSuggestions).toEqual([{ kind: 'SUBSCRIPTION_BLOCK', subscriptionId: 'sub-video', expectedVersion: 4, queryActionId: snapshot.queryActionId }]);
    expect(block.summary).toContain('不会取消商户合同');
  });
  it('requires one merchant and one operation and clarifies cancel-debit ambiguity', () => {
    for (const message of ['取消订阅', '取消星海视频和清泉音乐订阅', '取消星海视频订阅并阻止银行扣款', '取消星海视频扣款']) {
      const result = resolveSubscription(message, context(snapshot)); expect(result.managementSuggestions).toEqual([]); expect(result.clarification).toBeTruthy();
    }
    const duplicate = structuredClone(snapshot); duplicate.items.push({ ...duplicate.items[0]!, id: 'sub-video-2' });
    expect(resolveSubscription('取消星海视频订阅', context(duplicate)).clarification).toContain('同名');
  });
  it('does not silently change unsupported merchant cancellation into bank blocking', () => {
    const unsupported = structuredClone(snapshot); unsupported.items[0]!.cancellationSupported = false;
    const result = resolveSubscription('取消星海视频订阅', context(unsupported));
    expect(result.managementSuggestions).toEqual([]); expect(result.findings).toContain('SUBSCRIPTION_CANCELLATION_UNSUPPORTED');
  });
  it('card-side blocking does not imply a cancelled merchant contract', () => {
    const result = resolveSubscription('取消清泉音乐订阅', context(snapshot));
    expect(result.managementSuggestions[0]?.kind).toBe('SUBSCRIPTION_CANCEL');
    expect(result.evidence.find(e => e.source === 'subscription:sub-music:v7')?.detail).toContain('merchantStatus=ACTIVE');
  });
});

describe('management models validate deterministic specs and preserve independent review', () => {
  it('uses exact required schema for target, version and queryActionId without exposing financial account context', async () => {
    let scopedSchema: Record<string, any> | undefined; const observed: Record<string, any>[] = [];
    const mock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body)); const task = JSON.parse(body.messages[1].content); observed.push(task);
      const answer = task.role === 'reviewer' ? { approved: true, findings: [], summary: 'valid pending management proposal' } : proposed(task);
      if (task.role === 'subscription') scopedSchema = JSON.parse(body.messages[0].content.split('Required JSON schema: ')[1]);
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(answer) } }] }), { status: 200 });
    });
    try {
      const result = await createPlanner({ semantic: false, provider: modelConfig }).plan(input('取消星海视频订阅', context(snapshot)));
      expect(result.managementSuggestions?.[0]?.kind).toBe('SUBSCRIPTION_CANCEL');
      expect(scopedSchema?.required).toContain('managementSuggestions');
      const exact = scopedSchema?.properties.managementSuggestions.prefixItems[0].properties;
      expect(exact.subscriptionId.const).toBe('sub-video'); expect(exact.expectedVersion.const).toBe(4); expect(exact.queryActionId.const).toBe(snapshot.queryActionId);
      expect(JSON.stringify(observed)).not.toContain('PRIVATE_CARD_ACCOUNT'); expect(JSON.stringify(observed)).not.toContain('PRIVATE_BALANCE_NAME');
    } finally { mock.mockRestore(); }
  });
  it.each([
    { kind: 'SUBSCRIPTION_BLOCK', subscriptionId: 'sub-video', expectedVersion: 4, queryActionId: snapshot.queryActionId },
    { kind: 'SUBSCRIPTION_CANCEL', subscriptionId: 'invented', expectedVersion: 4, queryActionId: snapshot.queryActionId },
    { kind: 'SUBSCRIPTION_CANCEL', subscriptionId: 'sub-video', expectedVersion: 99, queryActionId: snapshot.queryActionId },
    { kind: 'SUBSCRIPTION_CANCEL', subscriptionId: 'sub-video', expectedVersion: 4, queryActionId: 'forged-query' },
  ])('rejects adapter changes to management operation: %j', async spec => {
    const result = await expectPlanningFailure(createPlanner({ provider: false, domainAdapter: async local => ({ ...proposed(local), managementSuggestions: [spec] }), reviewerAdapter: async () => ({ approved: true, findings: [], summary: 'cannot override deterministic mismatch' }) }).plan(input('取消星海视频订阅', context(snapshot))), 'MODEL_CANDIDATE_CONTRACT_INVALID', 'domain:subscription');
    expect(result.findings?.join()).toContain('MANAGEMENT_SPEC_MISMATCH');
  });
  it('cannot bypass yellow query confirmation by inventing a cancellation without snapshot', async () => {
    const result = await expectPlanningFailure(createPlanner({ provider: false, domainAdapter: async local => ({ ...proposed(local), managementSuggestions: [{ kind: 'SUBSCRIPTION_CANCEL', subscriptionId: 'sub-video', expectedVersion: 4, queryActionId: 'invented-grant' }] }) }).plan(input('取消星海视频订阅')), 'MODEL_CANDIDATE_CONTRACT_INVALID', 'domain:subscription');
    expect(result.findings?.join()).toContain('MANAGEMENT_SPEC_MISMATCH');
  });
  it('model failure or reviewer rejection never produces executable management suggestions', async () => {
    const mock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 401 }));
    try {
      const failed = await expectPlanningFailure(createPlanner({ semantic: false, provider: modelConfig }).plan(input('挂失尾号1234银行卡')), 'MODEL_HTTP_401', 'domain:card');
      expect(failed.modelRuns.every(run => run.status === 'failed' && run.errorCode === 'MODEL_HTTP_401')).toBe(true); expect(mock).toHaveBeenCalledTimes(1);
    } finally { mock.mockRestore(); }
    const rejected = await createPlanner({ provider: false, reviewerAdapter: async () => ({ approved: false, findings: ['evidence conflict'], summary: 'not approved' }) }).plan(input('挂失尾号1234银行卡'));
    expect(rejected.managementSuggestions).toEqual([]); expect(rejected.diagnostics?.review?.rawApproved).toBe(false);
  });
  it('renders the same authoritative card facts in model mode instead of trusting a model claim of execution', async () => {
    const mock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body)); const task = JSON.parse(body.messages[1].content);
      const answer = task.role === 'reviewer' ? { approved: true, findings: [], summary: 'read-only facts accepted' } : { ...proposed(task), summary: '已挂失所有银行卡，全部执行成功。' };
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(answer) } }] }), { status: 200 });
    });
    try {
      const model = await createPlanner({ semantic: false, provider: modelConfig }).plan(input('查银行卡状态'));
      const scripted = await createPlanner({ provider: false }).plan(input('查银行卡状态'));
      expect(model.summary).toBe(scripted.summary.replace('【脚本化验证模式，非真实 LLM】', ''));
      expect(model.managementSuggestions).toEqual([]); expect(model.summary).not.toContain('执行成功');
      expect(model.evidence.filter(e => !e.source.startsWith('model-explanation:'))).toEqual(scripted.evidence);
    } finally { mock.mockRestore(); }
  });
  it('does not borrow an unrelated bills query to turn a negated subscription operation into a query action', async () => {
    const result = await createPlanner({ provider: false }).plan({ ...input('查账单，不要取消订阅'), billReport: evaluationBillReport });
    expect(result.managementSuggestions).toEqual([]); expect(result.suggestions).toEqual([]);
  });
  it('can match an explicit merchant operation from an already granted snapshot without requiring the word subscription', async () => {
    const result = await createPlanner({ provider: false }).plan(input('取消星海视频', context(snapshot)));
    expect(result.managementSuggestions).toEqual([{ kind: 'SUBSCRIPTION_CANCEL', subscriptionId: 'sub-video', expectedVersion: 4, queryActionId: snapshot.queryActionId }]);
  });
  it.each(['查账单和银行卡状态', '查订阅和账单'])('activates only related domains in a combined query: %s', async message => {
    const result = await createPlanner({ provider: false }).plan({ ...input(message), billReport: evaluationBillReport });
    const started = result.events.filter(e => e.status === 'started').map(e => e.role).sort();
    expect(started).toEqual(['bills', message.includes('银行卡') ? 'card' : 'subscription', 'reviewer'].sort());
    expect(result.suggestions).toEqual([]);
    expect(result.managementSuggestions).toEqual(message.includes('银行卡') ? [] : [{ kind: 'SUBSCRIPTION_QUERY' }]);
    expect(result.billReport).toEqual(evaluationBillReport);
  });
  it('does not let an unrelated failed funds preview deny a non-financial management request', async () => {
    const result = await createPlanner({ provider: false }).plan({ ...input('挂失尾号1234银行卡'), fundsPreview: evaluationFunds('600000') });
    expect(result.managementSuggestions).toEqual([{ kind: 'CARD_REPORT_LOST', cardId: 'card-a', expectedVersion: 2 }]);
  });
  it('preserves existing transfer/goal planning alongside a read-only card branch without cross-domain suggestions', async () => {
    const result = await createPlanner({ provider: false }).plan({ ...input('给林晓转账300元，并查银行卡状态，不影响房租预算'), fundsPreview: evaluationFunds('30000') });
    expect(result.suggestions[0]?.amountMinor).toBe('30000'); expect(result.managementSuggestions).toEqual([]);
    expect(result.events.filter(e => e.status === 'started').map(e => e.role).sort()).toEqual(['transfer', 'goal', 'card', 'reviewer'].sort());
  });
});
