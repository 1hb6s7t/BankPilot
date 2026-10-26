import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConversationCommand, ConversationEnvelope } from '../packages/contracts/src/conversations';
import type { PlanningFailure } from '../packages/contracts/src';
import { conversationCommandView, conversationView, GenerationGate, mergeConversationCommands, planningFailureView } from '../apps/web/src/chatState';
import { api, setApiSessionSignal } from '../apps/web/src/api';

const failure: PlanningFailure = { phase: 'semantic_intent', code: 'MODEL_HTTP_502', retryable: true,
  message: '服务暂时不可用，这次识别尚未完成。可以重试原请求。', modelRuns: [] };
const result = { taskId: 'old-success', summary: '旧请求草稿已准备', mode: 'model', planVersion: 1, events: [], suggestions: [], evidence: [], findings: [], modelRuns: [] } as ConversationEnvelope;
const command = (patch: Partial<ConversationCommand> = {}): ConversationCommand => ({ commandId: 'request-a', conversationId: 'chat-a', rootCommandId: 'request-a', revision: 0,
  originalMessage: '给陈禾转账120元', planningInput: { version: 1, message: '给陈禾转账120元', originalMessage: '给陈禾转账120元' },
  status: 'failed', retryable: true, failure, createdAt: '2026-10-23T10:00:00Z', updatedAt: '2026-10-23T10:00:01Z', ...patch });
afterEach(() => { setApiSessionSignal(undefined); vi.unstubAllGlobals(); });

describe('server planning failures are not missing user information', () => {
  it('does not label a downstream planning budget failure as unfinished recognition', () => {
    const planning: PlanningFailure = { ...failure, phase: 'planning', code: 'MODEL_OUTPUT_BUDGET_EXHAUSTED', retryable: false,
      message: '本次请求的规划预算已用尽，不能继续重试；尚未执行新的动作。' };
    expect(conversationCommandView(command({ failure: planning, retryable: false }))).toMatchObject({ title: '规划尚未完成', canRetry: false, canViewPlan: false, needsRestatement: false });
  });
  it('shows the persisted service failure with same-command retry and no completed plan', () => {
    const view = conversationCommandView(command());
    expect(view).toMatchObject({ title: '识别尚未完成', message: failure.message, canRetry: true, canViewPlan: false, needsRestatement: false });
    expect(JSON.stringify(view)).not.toContain('MODEL_HTTP_502');
    expect(planningFailureView(failure)).toEqual({ title: '识别尚未完成', message: failure.message, retryable: true });
  });
  it.each([
    ['MODEL_HTTP_401', '服务验证未通过，暂时无法继续识别。请联系管理员检查服务配置。'],
    ['MODEL_OUTPUT_BUDGET_EXCEEDED', '本次请求的识别额度已用完，不能继续重试。'],
  ])('preserves accurate nonretryable server wording for %s', (code, message) => {
    const view = conversationCommandView(command({ retryable: false, failure: { ...failure, code, message, retryable: false } }));
    expect(view).toMatchObject({ message, canRetry: false, needsRestatement: false });
    expect(JSON.stringify(view)).not.toContain(code);
  });
  it.each([[false, true], [true, false], [false, false]])('requires both retry permissions (%s/%s)', (retryable, failureRetryable) => {
    expect(conversationCommandView(command({ retryable, failure: { ...failure, retryable: failureRetryable } })).canRetry).toBe(false);
  });
  it('does not infer a service failure from an internal code on an ordinary completed result', () => {
    expect(conversationCommandView(command({ status: 'complete', retryable: false, failure: undefined, lastErrorCode: 'MODEL_HTTP_502', result })).title).toBe('规划已完成');
  });
  it('handles an old failed command without publishing its internal code', () => {
    const view = conversationCommandView(command({ failure: undefined, lastErrorCode: 'INTERNAL_DATABASE_ERROR' }));
    expect(view.title).toBe('请求尚未完成'); expect(JSON.stringify(view)).not.toContain('INTERNAL_DATABASE_ERROR');
  });
  it('never offers unsupported-field restatement for a structured service failure', () => {
    expect(conversationCommandView(command({ result: { ...result, clarification: '请明确原本已提供的金额' } })).needsRestatement).toBe(false);
  });
  it('retains the supported typed clarification path for a completed semantic result', () => {
    const clarification = { status: 'waiting' } as NonNullable<ConversationCommand['clarification']>;
    expect(conversationCommandView(command({ status: 'complete', retryable: false, failure: undefined, result: { ...result, clarification: '请选择收款账户' }, clarification })))
      .toMatchObject({ title: '等待补充信息', canViewPlan: true, canRetry: false, needsRestatement: false });
  });
});

describe('the newest server request owns the selected conversation', () => {
  const oldSuccess = command({ commandId: 'old', status: 'complete', failure: undefined, result, createdAt: '2026-10-23T09:00:00Z', updatedAt: '2026-10-23T10:10:00Z' });
  it.each(['failed', 'pending', 'running'] as const)('does not fall back to an older success when the latest request is %s', status => {
    const latest = command({ status });
    const view = conversationView('chat-a', [latest, oldSuccess]);
    expect(view.command?.commandId).toBe(latest.commandId); expect(view.result).toBeUndefined();
    expect(view.failure).toBe(status === 'failed' ? failure : undefined);
  });
  it('restores the same server failure after refresh or signing in again', () => {
    const saved = JSON.parse(JSON.stringify([oldSuccess, command()])) as ConversationCommand[];
    expect(conversationView('chat-a', saved).failure).toEqual(failure);
    expect(conversationCommandView(conversationView('chat-a', saved).command!).canRetry).toBe(true);
  });
  it('does not let another conversation supply a successful pane', () => {
    expect(conversationView('chat-b', [oldSuccess, command()])).toEqual({ command: undefined, failure: undefined, result: undefined });
  });
  it('ignores stale failed history after a newer same-command retry starts', () => {
    const retry = command({ status: 'running', failure: undefined, updatedAt: '2026-10-23T10:00:02Z' });
    const merged = mergeConversationCommands('chat-a', [retry], [command()]);
    expect(merged).toEqual([retry]); expect(conversationView('chat-a', merged).failure).toBeUndefined();
  });
  it('replaces failure only after the same server command actually succeeds', () => {
    const success = command({ status: 'complete', retryable: false, failure: undefined, result: { ...result, taskId: 'recovered' }, updatedAt: '2026-10-23T10:00:03Z' });
    const merged = mergeConversationCommands('chat-a', [command()], [success]);
    expect(conversationView('chat-a', merged)).toMatchObject({ result: { taskId: 'recovered' }, failure: undefined });
    expect(merged[0]?.originalMessage).toBe(command().originalMessage);
  });
  it('does not erase a newer pending request when an earlier history page arrives', () => {
    const merged = mergeConversationCommands('chat-a', [command({ status: 'pending', failure: undefined })], [oldSuccess]);
    expect(conversationView('chat-a', merged).result).toBeUndefined();
    expect(merged).toHaveLength(2);
  });
  it('keeps the old success hidden while a new message acceptance is still unknown', () => {
    const view = conversationView('chat-a', [oldSuccess], true);
    expect(view.result).toBeUndefined(); expect(view.failure).toBeUndefined();
    expect(conversationView('chat-a', [oldSuccess], false).result).toBe(result);
  });
  it('does not mark a resolved clarification as still waiting for user information', () => {
    const resolved = command({ status: 'complete', failure: undefined, result: { ...result, clarification: '请选择收款账户' },
      clarification: { status: 'resolved' } as NonNullable<ConversationCommand['clarification']> });
    expect(conversationCommandView(resolved)).toMatchObject({ title: '规划已完成', needsRestatement: false });
  });
  it('ignores a complete envelope carrying an explicit failure rather than publishing a fake success', () => {
    const view = conversationView('chat-a', [command({ status: 'complete', failure: undefined, result: { ...result, failure } })]);
    expect(view.failure).toBe(failure); expect(view.result).toBeUndefined();
  });
  it('accepts no result or failure from an old conversation/account generation', async () => {
    const gate = new GenerationGate(); const old = gate.capture();
    let resolve!: (value: ConversationCommand[]) => void;
    const late = new Promise<ConversationCommand[]>(done => { resolve = done; });
    let selected = conversationView('chat-b', []);
    const task = late.then(commands => { if (gate.isCurrent(old)) selected = conversationView('chat-a', commands); });
    gate.renew(); resolve([oldSuccess, command()]); await task;
    expect(selected.command).toBeUndefined(); expect(selected.result).toBeUndefined(); expect(selected.failure).toBeUndefined();
  });
  it('retries the existing command endpoint without sending a new user message or copied input', async () => {
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(command({ status: 'running', failure: undefined })), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    const next = await api.retryConversationCommand('chat-a', 'request-a');
    expect(next.commandId).toBe('request-a'); expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[0]).toBe('/api/conversations/chat-a/commands/request-a/retry');
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ method: 'POST', body: '{}' });
  });
});
