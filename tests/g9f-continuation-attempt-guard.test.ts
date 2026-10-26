import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { guardContinuationModelAttempts } from '../apps/api/src/plan-runner';
import { invokeStructured, type OpenAICompatibleConfig } from '../packages/agents/src/provider';
import { CoreError } from '../packages/core/src/errors';

const provider: OpenAICompatibleConfig = { baseURL: 'https://g9f-pure.invalid/v1', model: 'synthetic', outputMode: 'json_object', maxAttempts: 2, maxStructureRepairs: 1, maxOutputTokens: 4096, retryDelayMs: 0 };
const schema = z.object({ ready: z.boolean() }).strict();
const envelope = (content = '{"ready":true}', finish = 'stop') => new Response(JSON.stringify({ choices: [{ finish_reason: finish, message: { content } }] }));
afterEach(() => vi.unstubAllGlobals());

describe('G9F exact continuation grant is checked at each actual model dispatch boundary', () => {
  it.each(['semantic_intent', 'subscription', 'reviewer'])('checks the grant before journaling and dispatching %s', async role => {
    const order: string[] = [];
    const guard = guardContinuationModelAttempts(async event => { order.push(event.type); expect(Object.isFrozen(event)).toBe(true); }, async () => { order.push('grant'); });
    const fetch = vi.fn(async () => { order.push('fetch'); return envelope(); }); vi.stubGlobal('fetch', fetch);
    await expect(invokeStructured({ ...provider, attemptObserver: guard.observe }, { role }, schema, 'pure')).resolves.toEqual({ ready: true });
    expect(order).toEqual(['grant', 'attempt_start', 'fetch', 'attempt_end']); expect(fetch).toHaveBeenCalledTimes(1); expect(() => guard.check()).not.toThrow();
  });
  it.each(['QUERY_ACCESS_EXPIRED', 'QUERY_AUTHORIZATION_REQUIRED', 'CONTINUATION_STOPPED'])('sends no HTTP or journal start after %s and retains the actual trusted cause', async code => {
    const cause = new CoreError(code, '控制失效'), journal = vi.fn(async () => {}), assertGrant = vi.fn(async () => { throw cause; });
    const guard = guardContinuationModelAttempts(journal, assertGrant), fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    await expect(invokeStructured({ ...provider, attemptObserver: guard.observe }, { role: 'semantic_intent' }, schema, 'pure')).rejects.toMatchObject({ code: 'MODEL_ATTEMPT_START_PERSIST_FAILED', requestOutcome: 'not_sent' });
    expect(fetch).not.toHaveBeenCalled(); expect(journal).not.toHaveBeenCalled(); expect(assertGrant).toHaveBeenCalledTimes(1);
    expect(() => guard.check()).toThrow(cause);
  });
  it.each(['schema', 'truncated', 'http-retry'] as const)('does not dispatch a second %s attempt after the first consumes the grant window', async kind => {
    let granted = true;
    const cause = new CoreError('QUERY_ACCESS_EXPIRED', '精确查询授权已过期'), journalEvents: string[] = [];
    const assertGrant = vi.fn(async () => { if (!granted) throw cause; });
    const guard = guardContinuationModelAttempts(async event => { journalEvents.push(`${event.type}:${event.attempt}`); }, assertGrant);
    const fetch = vi.fn(async () => {
      granted = false;
      return kind === 'schema' ? envelope('{"ready":"bad"}') : kind === 'truncated' ? envelope('{"ready":', 'length') : new Response('{}', { status: 503 });
    }); vi.stubGlobal('fetch', fetch);
    await expect(invokeStructured({ ...provider, attemptObserver: guard.observe }, { role: 'semantic_intent' }, schema, 'pure')).rejects.toMatchObject({ code: 'MODEL_ATTEMPT_START_PERSIST_FAILED' });
    expect(fetch).toHaveBeenCalledTimes(1); expect(assertGrant).toHaveBeenCalledTimes(2);
    expect(journalEvents).toEqual(['attempt_start:1', 'attempt_end:1']); expect(() => guard.check()).toThrow(cause);
  });
  it('closes a request already dispatched while valid even when the grant expires before the response', async () => {
    let granted = true;
    const events: string[] = [], assertGrant = vi.fn(async () => { if (!granted) throw new CoreError('QUERY_ACCESS_EXPIRED', '已过期'); });
    const guard = guardContinuationModelAttempts(async event => { events.push(event.type); }, assertGrant);
    vi.stubGlobal('fetch', vi.fn(async () => { granted = false; return envelope(); }));
    await expect(invokeStructured({ ...provider, attemptObserver: guard.observe }, { role: 'subscription' }, schema, 'pure')).resolves.toEqual({ ready: true });
    expect(assertGrant).toHaveBeenCalledTimes(1); expect(events).toEqual(['attempt_start', 'attempt_end']);
    // The existing phase/batch check still prevents publication. End telemetry
    // itself must not become an open attempt merely because access just ended.
    await expect(assertGrant()).rejects.toMatchObject({ code: 'QUERY_ACCESS_EXPIRED' });
  });
  it('blocks a later reviewer dispatch while preserving the completed domain attempt', async () => {
    let granted = true;
    const events: string[] = [], cause = new CoreError('QUERY_ACCESS_EXPIRED', '已过期');
    const guard = guardContinuationModelAttempts(async event => { events.push(`${event.role}:${event.type}`); }, async () => { if (!granted) throw cause; });
    const fetch = vi.fn(async () => { granted = false; return envelope(); }); vi.stubGlobal('fetch', fetch);
    await invokeStructured({ ...provider, attemptObserver: guard.observe }, { role: 'subscription' }, schema, 'pure');
    await expect(invokeStructured({ ...provider, attemptObserver: guard.observe }, { role: 'reviewer' }, schema, 'pure')).rejects.toMatchObject({ code: 'MODEL_ATTEMPT_START_PERSIST_FAILED' });
    expect(fetch).toHaveBeenCalledTimes(1); expect(events).toEqual(['subscription:attempt_start', 'subscription:attempt_end']); expect(() => guard.check()).toThrow(cause);
  });
  it('retains the first grant failure across sibling attempts instead of masking it with a later error', async () => {
    const first = new CoreError('QUERY_ACCESS_EXPIRED', 'first'), second = new CoreError('CONTINUATION_STOPPED', 'second');
    const assertGrant = vi.fn().mockRejectedValueOnce(first).mockRejectedValueOnce(second), journal = vi.fn(async () => {});
    const guard = guardContinuationModelAttempts(journal, assertGrant), fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    await Promise.allSettled(['subscription', 'reviewer'].map(role => invokeStructured({ ...provider, attemptObserver: guard.observe }, { role }, schema, 'pure')));
    expect(fetch).not.toHaveBeenCalled(); expect(journal).not.toHaveBeenCalled(); expect(() => guard.check()).toThrow(first);
  });
  it('passes the observer context through and leaves ordinary journal failures under journal ownership', async () => {
    const signal = new AbortController().signal, cause = new CoreError('PLAN_SUPERSEDED', 'lease changed');
    const journal = vi.fn(async () => { throw cause; }), guard = guardContinuationModelAttempts(journal, async () => {});
    const event = { type: 'attempt_start' as const, attemptId: 'a', invocationId: 'i', role: 'semantic_intent', attempt: 1, requestMaxOutputTokens: 4096, startedAtUtc: '2026-10-25T00:00:00Z' };
    await expect(guard.observe(event, { signal })).rejects.toBe(cause); expect(journal).toHaveBeenCalledWith(event, { signal });
    expect(() => guard.check()).not.toThrow();
  });
});
