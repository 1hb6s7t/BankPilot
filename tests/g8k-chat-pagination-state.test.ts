import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Clarification, Conversation, ConversationCommand, ConversationRecoveryItem } from '../packages/contracts/src/conversations';
import { conversationView, createSubmission, GenerationGate, mergeClarifications, mergeConversationList, recoveryItemsForPage, recoveryItemView, recoveryPageTarget, restoreConversationSelection } from '../apps/web/src/chatState';
import { api, setApiSessionSignal } from '../apps/web/src/api';

const chat = (id: string, version = 1): Conversation => ({ id, title: id, version, createdAt: `2026-10-23T10:00:00.000Z`, updatedAt: '2026-10-23T10:00:00.000Z' });
const command = (patch: Partial<ConversationCommand> = {}): ConversationCommand => ({
  commandId: 'request-a', conversationId: 'chat-a', rootCommandId: 'request-a', revision: 0, requestSequence: 1, stateVersion: '5',
  originalMessage: '给林晓转100元', planningInput: { version: 1, message: '给林晓转100元', originalMessage: '给林晓转100元' }, status: 'pending', retryable: true,
  createdAt: '2026-10-23T10:00:00.000Z', updatedAt: '2026-10-23T10:00:01.000Z', ...patch,
});
const item = (patch: Partial<ConversationRecoveryItem> = {}): ConversationRecoveryItem => ({
  commandId: 'request-a', conversationId: 'chat-a', rootCommandId: 'request-a', revision: 0, requestSequence: 1, stateVersion: '5', status: 'pending', retryable: true,
  messagePreview: '给林晓转100元', createdAt: '2026-10-23T10:00:00.000Z', updatedAt: '2026-10-23T10:00:01.000Z', ...patch,
});
const clarification = (patch: Partial<Clarification> = {}): Clarification => ({
  id: 'clarification-a', conversationId: 'chat-a', parentCommandId: 'request-a', rootCommandId: 'request-a', version: 1, status: 'waiting',
  question: '请选择收款人', requestedSlots: ['payee'], operation: 'transfer', values: { amountMinor: '10000' }, sources: [], candidates: [], createdAt: '2026-10-23T10:00:00.000Z', ...patch,
});
afterEach(() => { vi.unstubAllGlobals(); setApiSessionSignal(undefined); });

describe('G8K paginated chat selection', () => {
  it('restores a selected chat beyond the first hundred by one exact lookup', async () => {
    const firstPage = Array.from({ length: 30 }, (_, i) => chat(`new-${i}`)), old = { ...chat('old-126'), createdAt: '2026-01-01T00:00:00.000Z' };
    const read = vi.fn(async () => old);
    const restored = await restoreConversationSelection(firstPage, old.id, read);
    expect(read.mock.calls).toEqual([[old.id]]); expect(restored.selected).toBe(old);
    expect(restored.conversations).toHaveLength(31);
  });
  it('uses an already loaded selected chat without another lookup or a page scan', async () => {
    const first = chat('first'), read = vi.fn();
    expect((await restoreConversationSelection([first], first.id, read)).selected).toBe(first);
    expect(read).not.toHaveBeenCalled();
  });
  it('falls back only when the caller has confirmed the selected chat is unavailable', async () => {
    const first = chat('first');
    expect((await restoreConversationSelection([first], 'removed', async () => undefined)).selected).toBe(first);
    await expect(restoreConversationSelection([first], 'old', async () => { throw new Error('read unavailable'); })).rejects.toThrow('read unavailable');
  });
  it('deduplicates appended list pages while preserving newer metadata and immutable creation order', () => {
    const old = { ...chat('old', 3), createdAt: '2026-01-01T00:00:00.000Z' }, fresh = chat('new');
    const merged = mergeConversationList([old, fresh], [{ ...old, title: 'stale', version: 2 }, fresh]);
    expect(merged).toEqual([fresh, old]);
  });
  it('does not accept a mismatched response as the saved selected chat', async () => {
    await expect(restoreConversationSelection([], 'old', async () => chat('different'))).rejects.toThrow('不一致');
  });
});

describe('G8K recovery page membership and command evidence', () => {
  it('shows an old pending request independently of whether its original message page is loaded', () => {
    expect(recoveryItemsForPage('chat-a', [item()], [])).toEqual([item()]);
  });
  it('deduplicates IDs and excludes foreign conversation rows', () => {
    expect(recoveryItemsForPage('chat-a', [item(), item(), item({ commandId: 'foreign', conversationId: 'chat-b' })], [])).toHaveLength(1);
  });
  it('removes a stale pending index row after a newer exact-command completion', () => {
    expect(recoveryItemsForPage('chat-a', [item()], [command({ status: 'complete', retryable: false, stateVersion: '6' })])).toEqual([]);
  });
  it('does not let an older complete detail remove a newer failed index row', () => {
    expect(recoveryItemsForPage('chat-a', [item({ status: 'failed', stateVersion: '6' })], [command({ status: 'complete', stateVersion: '5' })])[0]?.status).toBe('failed');
  });
  it('does not infer the end of a request from its absence on another page', () => {
    const saved = command();
    expect(recoveryItemsForPage('chat-a', [], [saved])).toEqual([]);
    expect(saved.status).toBe('pending');
    expect(recoveryItemsForPage('chat-a', [item()], [saved])).toHaveLength(1);
  });
  it.each(['resolved', 'cancelled'] as const)('rejects a held waiting index after clarification v2 is %s, even at the same parent command version', status => {
    const waiting = item({ status: 'complete', clarification: { id: 'clarification-a', version: 1, question: '旧问题' } });
    const known = command({ status: 'complete', clarification: clarification({ version: 2, status }) });
    expect(recoveryItemsForPage('chat-a', [waiting], [known])).toEqual([]);
  });
  it.each(['resolved', 'cancelled'] as const)('retains successful %s evidence when the old request detail was never loaded', status => {
    const waiting = item({ status: 'complete', clarification: { id: 'clarification-a', version: 1, question: '旧问题' } });
    const closure = clarification({ version: 2, status });
    expect(recoveryItemsForPage('chat-a', [waiting], [], [closure])).toEqual([]);
    expect(recoveryItemsForPage('chat-a', [waiting], [], [{ ...closure, conversationId: 'another-chat' }])).toEqual([waiting]);
  });
  it('preserves a newer waiting clarification and a previously constructed explicit answer', () => {
    const full = clarification({ version: 2 });
    const submission = createSubmission('chat-a', '尾号3361', full, { payeeId: 'payee-a', payeeSuffix: '3361' }, 'stable-answer-id');
    const page = recoveryItemsForPage('chat-a', [item({ status: 'complete', clarification: { id: full.id, version: 1, question: '旧问题' } })], [command({ status: 'complete', clarification: full })]);
    expect(page[0]?.clarification?.version).toBe(2);
    expect(submission.body).toMatchObject({ clientMessageId: 'stable-answer-id', expectedClarificationVersion: 2, answer: { payeeId: 'payee-a' } });
    expect(Object.isFrozen(submission.body)).toBe(true);
  });
  it('does not reintroduce an old waiting clarification into the full form state', () => {
    const ended = clarification({ version: 2, status: 'cancelled' });
    expect(mergeClarifications('chat-a', [ended], [clarification()])).toEqual([ended]);
  });
  it('does not display internal codes or offer automatic continuation for a failed index row', () => {
    const view = recoveryItemView(item({ status: 'failed', retryable: false, lastErrorCode: 'MODEL_HTTP_401' }));
    expect(view).toMatchObject({ title: '请求尚未完成', canRetry: false }); expect(JSON.stringify(view)).not.toContain('MODEL_HTTP_401');
  });
});

describe('G8K independent page cursors and plan selection', () => {
  it('keeps opaque forward/back cursors and preserves the current page if a request has not committed', () => {
    const first = { previous: [], nextCursor: 'opaque-next' };
    const target = recoveryPageTarget(first, 'next')!;
    expect(target).toEqual({ cursor: 'opaque-next', previous: [undefined] });
    expect(first).toEqual({ previous: [], nextCursor: 'opaque-next' });
    expect(recoveryPageTarget({ ...target, nextCursor: 'next-2' }, 'previous')).toEqual({ cursor: undefined, previous: [] });
    expect(recoveryPageTarget({ ...target, nextCursor: 'next-2' }, 'refresh')).toEqual(target);
    expect(recoveryPageTarget(target, 'first')).toEqual({ cursor: undefined, previous: [] });
  });
  it('never advances past the advertised last recovery page', () => {
    expect(recoveryPageTarget({ previous: [] }, 'next')).toBeUndefined();
    expect(recoveryPageTarget({ previous: [] }, 'previous')).toBeUndefined();
  });
  it('does not fall back to a loaded old success when latestCommandId is outside the message page', () => {
    const old = command({ status: 'complete', result: { taskId: 'old' } as any });
    expect(conversationView('chat-a', [old], false, undefined, 'latest-outside-page').result).toBeUndefined();
    expect(conversationView('chat-a', [old], false, old.commandId, 'latest-outside-page').result?.taskId).toBe('old');
  });
  it('rejects an old page after switching conversations even if transport ignores abort', async () => {
    const gate = new GenerationGate(), old = gate.capture();
    let resolve!: (value: ConversationRecoveryItem[]) => void;
    const response = new Promise<ConversationRecoveryItem[]>(done => { resolve = done; });
    let visible: ConversationRecoveryItem[] = [];
    const pending = response.then(items => { if (gate.isCurrent(old)) visible = recoveryItemsForPage('chat-a', items, []); });
    gate.renew(); resolve([item()]); await pending; expect(visible).toEqual([]);
  });
});

describe('G8K bounded browser API reads', () => {
  it('uses fixed page limits and one direct old-chat lookup without walking cursors', async () => {
    const fetch = vi.fn(async (_url: string) => new Response(JSON.stringify({ conversations: [], items: [] }), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    await api.conversations(undefined, 'opaque+/='); await api.conversation('old-126'); await api.conversationRecovery('chat-a', 'opaque+/=');
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      '/api/conversations?limit=30&cursor=opaque%2B%2F%3D', '/api/conversations/old-126', '/api/conversations/chat-a/recovery?limit=20&cursor=opaque%2B%2F%3D',
    ]);
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});
