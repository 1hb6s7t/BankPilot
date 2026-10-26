import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage, Clarification } from '../packages/contracts/src/conversations';
import { createSubmission, GenerationGate, hasAcceptedSubmission, mergeMessages } from '../apps/web/src/chatState';
import { api, setApiSessionSignal } from '../apps/web/src/api';

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const row = (id: string, sequence: number, extra: Partial<ChatMessage> = {}): ChatMessage => ({ id, sequence, conversationId: 'chat-a', role: 'user', text: `message ${id}`, kind: 'request', createdAt: '2026-10-23T00:00:00Z', ...extra });
const clarification: Clarification = { id: 'clarification-a', conversationId: 'chat-a', parentCommandId: 'command-a', rootCommandId: 'command-a', version: 2, status: 'waiting', question: '请选择收款账户并补充金额', requestedSlots: ['payee', 'amount'], operation: 'transfer', values: {}, sources: [], candidates: [{ id: 'payee-a', name: '林晓', bank: '合成银行', maskedNumber: '****3361' }], createdAt: '2026-10-23T00:00:00Z' };
afterEach(() => { setApiSessionSignal(undefined); vi.unstubAllGlobals(); });

describe('server chat projection and stable submission identity', () => {
  it('merges overlapping history pages by stable message id and server sequence', () => {
    const current = [row('m3', 3), row('m4', 4)];
    const merged = mergeMessages('chat-a', current, [row('m1', 1), row('m2', 2), row('m3', 3)]);
    expect(merged.map(message => message.id)).toEqual(['m1', 'm2', 'm3', 'm4']);
    expect(merged[2]).toBe(current[0]);
  });
  it('does not rewrite historical assistant text with refreshed Core plan state or another conversation', () => {
    const message = row('answer', 5, { role: 'assistant', text: '当时的草稿已准备', kind: 'result' });
    const merged = mergeMessages('chat-a', [message], [row('answer', 5, { text: '付款成功' }), row('foreign', 1, { conversationId: 'chat-b' })]);
    expect(merged).toEqual([message]);
  });
  it('freezes clarification version and slot values once; a network retry reuses the same id and body', () => {
    const answer = { payeeId: 'payee-a', payeeSuffix: '3361', amount: '92.40元' };
    const pending = createSubmission('chat-a', '尾号3361，92.40元', clarification, answer, 'client-message-fixed');
    answer.amount = '100元';
    clarification.version = 3;
    expect(pending.body).toEqual({ clientMessageId: 'client-message-fixed', text: '尾号3361，92.40元', clarificationId: 'clarification-a', expectedClarificationVersion: 2, answer: { payeeId: 'payee-a', payeeSuffix: '3361', amount: '92.40元' } });
    expect(Object.isFrozen(pending.body)).toBe(true);
    expect(Object.isFrozen(pending.body.answer)).toBe(true);
    expect(pending.body.clientMessageId).toBe('client-message-fixed');
    clarification.version = 2;
  });
  it('a new request never implicitly binds an existing clarification', () => {
    expect(createSubmission('chat-a', '给周宁转100元', undefined, undefined, 'new-message-id').body).toEqual({ clientMessageId: 'new-message-id', text: '给周宁转100元' });
    expect(() => createSubmission('chat-a', '   ')).toThrow();
    expect(() => createSubmission('chat-a', '100元', { ...clarification, status: 'resolved' })).toThrow();
  });
  it('recovers an unknown POST only from its server client id in the same conversation', () => {
    const pending = createSubmission('chat-a', '给林晓转100元', undefined, undefined, 'unknown-message-id');
    expect(hasAcceptedSubmission([row('x', 1, { clientMessageId: 'unknown-message-id', conversationId: 'chat-b' })], pending)).toBe(false);
    expect(hasAcceptedSubmission([row('x', 1, { text: '给林晓转100元' })], pending)).toBe(false);
    expect(hasAcceptedSubmission([row('server-message-id', 8, { clientMessageId: 'unknown-message-id' })], pending)).toBe(true);
  });
});

describe('identity and conversation response fences', () => {
  it('rejects a late A response after logout/login B even if the transport ignores abort', async () => {
    const gate = new GenerationGate(); const a = gate.capture(); const late = deferred<string>();
    let screen = 'A';
    const load = late.promise.then(value => { if (gate.isCurrent(a)) screen = value; });
    gate.renew(); const b = gate.renew(); screen = 'B'; late.resolve('A private dashboard'); await load;
    expect(a.signal.aborted).toBe(true); expect(gate.isCurrent(a)).toBe(false); expect(gate.isCurrent(b)).toBe(true); expect(screen).toBe('B');
  });
  it('conversation switches invalidate old messages without invalidating the owning session', () => {
    const session = new GenerationGate(); const owner = session.capture(); const conversation = new GenerationGate(); const old = conversation.capture();
    const current = conversation.renew();
    expect(conversation.isCurrent(old)).toBe(false); expect(conversation.isCurrent(current)).toBe(true); expect(session.isCurrent(owner)).toBe(true);
    conversation.abort(); expect(conversation.isCurrent(current)).toBe(false);
  });
  it('API drops a stale dashboard response after the global session is rotated', async () => {
    const first = new AbortController(); setApiSessionSignal(first.signal); const response = deferred<Response>();
    vi.stubGlobal('fetch', vi.fn(() => response.promise));
    const oldRequest = api.dashboard(); const assertion = expect(oldRequest).rejects.toMatchObject({ name: 'AbortError' });
    first.abort(); setApiSessionSignal(new AbortController().signal);
    response.resolve(new Response(JSON.stringify({ accounts: [{ id: 'private-A' }] }), { status: 200 }));
    await assertion;
  });
  it('API checks abort again after reading response body and combines conversation with session cancellation', async () => {
    const session = new AbortController(); const conversation = new AbortController(); setApiSessionSignal(session.signal);
    const body = deferred<string>();
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => { expect(init.signal).toBeDefined(); return { ok: true, status: 200, text: () => body.promise }; });
    vi.stubGlobal('fetch', fetchMock);
    const request = api.conversationHistory('chat-a', undefined, conversation.signal); const assertion = expect(request).rejects.toMatchObject({ name: 'AbortError' });
    await Promise.resolve(); conversation.abort(); body.resolve(JSON.stringify({ messages: ['old chat'] })); await assertion;
    expect(session.signal.aborted).toBe(false);
  });
  it('retries an uncertain send with identical HTTP payload and no new client id', async () => {
    const pending = createSubmission('chat-a', '给林晓转100元', undefined, undefined, 'same-client-message');
    const fetchMock = vi.fn().mockRejectedValueOnce(new TypeError('lost response')).mockResolvedValueOnce(new Response(JSON.stringify({ replayed: true }), { status: 202 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(api.sendConversationMessage(pending.conversationId, pending.body)).rejects.toThrow('无法连接');
    await expect(api.sendConversationMessage(pending.conversationId, pending.body)).resolves.toEqual({ replayed: true });
    expect(fetchMock.mock.calls[0][1].body).toBe(fetchMock.mock.calls[1][1].body);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).clientMessageId).toBe('same-client-message');
  });
});

describe('sign-out intent survives navigation until server acknowledgement', () => {
  it('sends the actual sign-out endpoint an authenticated JSON empty object, satisfying the BetterAuth HTTP contract', async () => {
    const controller = new AbortController(); setApiSessionSignal(controller.signal);
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      const headers = new Headers(init.headers);
      const validJsonRequest = headers.get('content-type') === 'application/json' && init.body === '{}';
      return new Response(JSON.stringify(validJsonRequest ? { success: true } : { error: { message: 'Unsupported Media Type' } }), { status: validJsonRequest ? 200 : 415 });
    });
    vi.stubGlobal('fetch', fetchMock);
    await expect(api.signOut()).resolves.toEqual({ success: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/auth/sign-out');
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('include');
    expect(new Headers(init.headers).get('content-type')).toBe('application/json');
    expect(init.body).toBe('{}');
    expect(JSON.parse(init.body as string)).toEqual({});
    expect(init.signal).toBe(controller.signal);
  });
  const storage = () => { const values = new Map<string, string>(); return { values, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } }; };
  it('a fresh page sees pending logout and cannot treat the previous cookie as an intended login', async () => {
    const { LogoutIntent } = await import('../apps/web/src/chatState');
    const browser = storage(); const firstPage = new LogoutIntent(browser);
    firstPage.begin();
    const reloadedPage = new LogoutIntent(browser);
    expect(reloadedPage.isPending()).toBe(true);
    expect([...browser.values.values()]).toEqual(['1']);
    reloadedPage.complete();
    expect(new LogoutIntent(browser).isPending()).toBe(false);
  });
  it('keeps logout pending on a failed HTTP request and clears it only after a successful retry', async () => {
    const { LogoutIntent } = await import('../apps/web/src/chatState');
    const browser = storage(); const intent = new LogoutIntent(browser); intent.begin();
    const response = deferred<Response>();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(new TypeError('navigation interrupted sign-out')).mockImplementationOnce(() => response.promise));
    await expect(api.signOut()).rejects.toThrow('无法连接');
    expect(intent.isPending()).toBe(true); expect(new LogoutIntent(browser).isPending()).toBe(true);
    const completion = api.signOut().then(() => intent.complete());
    expect(intent.isPending()).toBe(true);
    response.resolve(new Response(JSON.stringify({ success: true }), { status: 200 })); await completion;
    expect(intent.isPending()).toBe(false);
  });
  it('an aborted old sign-out response cannot clear the intent of the current session generation', async () => {
    const { LogoutIntent } = await import('../apps/web/src/chatState');
    const intent = new LogoutIntent(storage()); const gate = new GenerationGate(); const old = gate.capture();
    intent.begin(); const response = deferred<void>();
    const completion = response.promise.then(() => { if (gate.isCurrent(old)) intent.complete(); });
    gate.renew(); response.resolve(); await completion;
    expect(intent.isPending()).toBe(true);
  });
  it('retains the in-memory sign-out barrier when browser storage is unavailable', async () => {
    const { LogoutIntent } = await import('../apps/web/src/chatState');
    const intent = new LogoutIntent({ getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); }, removeItem: () => { throw new Error('blocked'); } });
    intent.begin(); expect(intent.isPending()).toBe(true);
    intent.complete(); expect(intent.isPending()).toBe(false);
  });
});
