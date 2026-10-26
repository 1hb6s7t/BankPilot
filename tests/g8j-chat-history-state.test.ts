import { describe, expect, it } from 'vitest';
import type { ChatMessage, ConversationCommand, ConversationEnvelope } from '../packages/contracts/src/conversations';
import { conversationView, GenerationGate, mergeConversationCommands, mergeConversationSummary, mergeHistoryMessages } from '../apps/web/src/chatState';

const envelope = (taskId: string) => ({ taskId, summary: taskId, mode: 'scripted', planVersion: 1,
  events: [], suggestions: [], evidence: [], findings: [], modelRuns: [] }) as ConversationEnvelope;
const command = (commandId: string, patch: Partial<ConversationCommand> = {}): ConversationCommand => ({
  commandId, conversationId: 'chat-a', rootCommandId: commandId, revision: 0, originalMessage: commandId,
  planningInput: { version: 1, message: commandId, originalMessage: commandId }, status: 'complete', retryable: false,
  result: envelope(commandId), createdAt: '2026-10-23T10:00:00.000Z', updatedAt: '2026-10-23T10:00:01.000Z', ...patch,
});

const messages = (from: number, to: number, conversationId = 'chat-a'): ChatMessage[] => Array.from({ length: Math.max(0, to - from + 1) }, (_, i) => ({
  id: `${conversationId}-message-${from + i}`, conversationId, sequence: from + i, role: 'user', kind: 'request', text: `原文${from + i}`,
  createdAt: '2026-10-23T10:00:00.000Z',
}));

describe('G8J paginated immutable timeline', () => {
  it('restores a cursor on the first successful manual reload after initial history failed', () => {
    const firstSuccess = mergeHistoryMessages('chat-a', [], messages(151, 200));
    expect(firstSuccess.beforeSequence).toBe(151);
    expect(firstSuccess.messages).toHaveLength(50);
  });
  it('fills the nearest new-message gap before walking toward the oldest page', () => {
    let page = mergeHistoryMessages('chat-a', messages(51, 100), messages(201, 250));
    expect(page.beforeSequence).toBe(201);
    page = mergeHistoryMessages('chat-a', page.messages, messages(151, 200), true);
    expect(page.beforeSequence).toBe(151);
    page = mergeHistoryMessages('chat-a', page.messages, messages(101, 150), true);
    expect(page.beforeSequence).toBe(51);
    page = mergeHistoryMessages('chat-a', page.messages, messages(1, 50), true);
    expect(page.beforeSequence).toBeUndefined();
    expect(page.messages.map(message => message.sequence)).toEqual(Array.from({ length: 250 }, (_, i) => i + 1));
  });
  it('reopens pagination when a refresh skips more than one page after all previous history was loaded', () => {
    const loaded = mergeHistoryMessages('chat-a', [], messages(1, 50));
    expect(loaded.beforeSequence).toBeUndefined();
    const refreshed = mergeHistoryMessages('chat-a', loaded.messages, messages(101, 150));
    expect(refreshed.beforeSequence).toBe(101);
    expect(mergeHistoryMessages('chat-a', refreshed.messages, messages(51, 100), true).beforeSequence).toBeUndefined();
  });
  it('does not discard loaded old pages or duplicate rows when refreshing the latest page', () => {
    const original = messages(1, 200);
    const refreshed = mergeHistoryMessages('chat-a', original, messages(151, 200));
    expect(refreshed.messages).toHaveLength(200);
    expect(refreshed.messages[0]).toBe(original[0]);
    expect(refreshed.beforeSequence).toBeUndefined();
  });
  it.each([{ incoming: [] }, { incoming: messages(151, 200) }])('reports an incomplete empty/duplicate early page without declaring the gap filled', ({ incoming }) => {
    const existing = messages(151, 200);
    expect(() => mergeHistoryMessages('chat-a', existing, incoming, true)).toThrow('这页聊天历史尚未读全，请重试加载更早消息。');
    expect(existing).toHaveLength(50);
    expect(mergeHistoryMessages('chat-a', existing, [], false).beforeSequence).toBe(151);
  });
  it('permits a later user retry to fill a previously empty page without changing saved text', () => {
    const existing = messages(51, 100);
    expect(() => mergeHistoryMessages('chat-a', existing, [], true)).toThrow();
    const recovered = mergeHistoryMessages('chat-a', existing, messages(1, 50), true);
    expect(recovered.messages).toHaveLength(100);
    expect(recovered.beforeSequence).toBeUndefined();
    expect(recovered.messages.at(-1)).toBe(existing.at(-1));
  });
  it('filters foreign chat messages and rejects a late page after a conversation switch', async () => {
    const gate = new GenerationGate(), ticket = gate.capture();
    let resolve!: (value: ChatMessage[]) => void;
    const response = new Promise<ChatMessage[]>(done => { resolve = done; });
    let current = messages(1, 2, 'chat-b');
    const apply = response.then(page => { if (gate.isCurrent(ticket)) current = mergeHistoryMessages('chat-a', current, page).messages; });
    gate.renew(); resolve(messages(1, 100)); await apply;
    expect(current.every(message => message.conversationId === 'chat-b')).toBe(true);
    expect(mergeHistoryMessages('chat-b', current, messages(1, 100)).messages).toEqual(current);
  });
});

describe('G8J conversation summary versions', () => {
  const newest = { id: 'chat-a', title: '新标题', version: 10, createdAt: '2026-10-23T09:00:00.000Z', updatedAt: '2026-10-23T10:00:00.000Z' };
  it('does not regress title/version when an old history page finishes after a poll', () => {
    expect(mergeConversationSummary(newest, { ...newest, title: '旧标题', version: 9, updatedAt: '2026-10-23T11:00:00.000Z' })).toBe(newest);
    expect(mergeConversationSummary(newest, { ...newest, title: '旧标题', updatedAt: '2026-10-23T09:00:00.000Z' })).toBe(newest);
  });
  it('accepts a newer server version and never substitutes another conversation', () => {
    const next = { ...newest, title: '更新标题', version: 11 };
    expect(mergeConversationSummary(newest, next)).toBe(next);
    expect(mergeConversationSummary(newest, { ...next, id: 'chat-b' })).toBe(newest);
  });
});

describe('G8J server ordering and monotonic command state', () => {
  it('orders equal-time commands by request sequence rather than random IDs or revision', () => {
    const first = Object.assign(command('zz-first', { revision: 8 }), { requestSequence: 11 });
    const second = Object.assign(command('aa-second'), { requestSequence: 13 });
    expect(conversationView('chat-a', [second, first]).command?.commandId).toBe('aa-second');
  });
  it('never lets a stale page regress a completed command when timestamps have the same millisecond', () => {
    const completed = Object.assign(command('same'), { stateVersion: '11' });
    const stale = Object.assign(command('same', { status: 'running', result: undefined }), { stateVersion: '10' });
    expect(mergeConversationCommands('chat-a', [completed], [stale])).toEqual([completed]);
  });
  it('compares bigint versions without rounding and permits a newer failed-to-running retry', () => {
    const failed = Object.assign(command('same', { status: 'failed', result: undefined }), { stateVersion: '9007199254740992' });
    const retry = Object.assign(command('same', { status: 'running', result: undefined }), { stateVersion: '9007199254740993' });
    expect(mergeConversationCommands('chat-a', [retry], [failed])).toEqual([retry]);
    expect(mergeConversationCommands('chat-a', [failed], [retry])).toEqual([retry]);
  });
  it('does not let an unversioned compatibility snapshot replace known versioned state', () => {
    const complete = Object.assign(command('same'), { stateVersion: '2' });
    const unknown = command('same', { status: 'pending', result: undefined, updatedAt: '2026-10-23T20:00:00.000Z' });
    expect(mergeConversationCommands('chat-a', [complete], [unknown])).toEqual([complete]);
  });
  it('keeps refreshed Core action state when an equal-version stored history envelope arrives', () => {
    const completed = Object.assign(command('same', { result: { ...envelope('same'), actions: [{ id: 'action-a', status: 'SUCCEEDED' }] } }), { stateVersion: '9' });
    const stored = Object.assign(command('same', { result: { ...envelope('same'), actions: [{ id: 'action-a', status: 'AWAITING_CONFIRMATION' }] } }), { stateVersion: '9' });
    expect(mergeConversationCommands('chat-a', [completed], [stored], 'history')[0]?.result?.actions).toEqual([{ id: 'action-a', status: 'SUCCEEDED' }]);
  });
  it.each(['actions', 'managementActions', 'investmentActions'] as const)('preserves same-ID terminal %s across a new history version without restoring removed actions', key => {
    const completed = Object.assign(command('same', { result: { ...envelope('same'), [key]: [{ id: 'done', status: 'SUCCEEDED', receipt: { proof: 'original' } }, { id: 'removed', status: 'SUCCEEDED' }] } }), { stateVersion: '9' });
    const history = Object.assign(command('same', { result: { ...envelope('same'), [key]: [{ id: 'done', status: 'AWAITING_CONFIRMATION' }, { id: 'new', status: 'AWAITING_CONFIRMATION' }] } }), { stateVersion: '10' });
    const merged = mergeConversationCommands('chat-a', [completed], [history], 'history')[0]!;
    expect(merged.stateVersion).toBe('10');
    expect(merged.result?.[key]).toEqual([{ id: 'done', status: 'SUCCEEDED', receipt: { proof: 'original' } }, { id: 'new', status: 'AWAITING_CONFIRMATION' }]);
  });
  it('accepts a fresh detail read at the same command version instead of freezing a stored pending action', () => {
    const stored = Object.assign(command('same', { result: { ...envelope('same'), actions: [{ id: 'action-a', status: 'UNKNOWN' }] } }), { stateVersion: '9' });
    const fresh = { ...stored, result: { ...envelope('same'), actions: [{ id: 'action-a', status: 'SUCCEEDED' }] } };
    expect(mergeConversationCommands('chat-a', [stored], [fresh], 'detail')[0]?.result).toBe(fresh.result);
  });
  it('clears an old result for a genuinely newer running retry rather than retaining a stale success', () => {
    const stored = Object.assign(command('same'), { stateVersion: '9' });
    const retry = Object.assign(command('same', { status: 'running', result: undefined }), { stateVersion: '10' });
    expect(mergeConversationCommands('chat-a', [stored], [retry], 'history')[0]?.result).toBeUndefined();
  });
});
const old = command('old', { createdAt: '2026-10-23T09:00:00.000Z' });
const latest = command('latest');

describe('G8J explicit history plan selection', () => {
  it('opens the selected old plan rather than republishing the latest plan', () => {
    const merged = mergeConversationCommands('chat-a', [old, latest], [{ ...old, result: envelope('old-refreshed') }]);
    expect(conversationView('chat-a', merged, false, 'old').result?.taskId).toBe('old-refreshed');
  });
  it('keeps an explicitly selected old plan when an older page or current poll arrives', () => {
    const earlier = command('earlier', { createdAt: '2026-10-23T08:00:00.000Z' });
    const merged = mergeConversationCommands('chat-a', [old, latest], [earlier, { ...latest, updatedAt: '2026-10-23T11:00:00.000Z' }]);
    expect(conversationView('chat-a', merged, false, 'old').command?.commandId).toBe('old');
  });
  it('never falls back to another plan if the requested old ID belongs to a different chat', () => {
    const foreign = command('foreign', { conversationId: 'chat-b' });
    expect(conversationView('chat-a', [old, latest, foreign], false, 'foreign').result).toBeUndefined();
  });
  it('restores newest-request ownership when a new submission clears explicit selection', () => {
    expect(conversationView('chat-a', [old, latest], true, 'old').result).toBeUndefined();
    expect(conversationView('chat-a', [old, latest]).command?.commandId).toBe('latest');
    const failed = { ...latest, status: 'failed' as const, result: undefined };
    expect(conversationView('chat-a', [old, failed]).result).toBeUndefined();
  });
});
