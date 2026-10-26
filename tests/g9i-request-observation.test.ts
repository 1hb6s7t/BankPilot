import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { invokeStructured, MODEL_REQUEST_OBSERVATION_VERSION, type ModelAttemptEvent, type ModelRequestObservation, type OpenAICompatibleConfig } from '../packages/agents/src/provider';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const shape = z.object({ ok: z.literal(true) }).strict();
const config: OpenAICompatibleConfig = { baseURL: 'https://synthetic.invalid/v1', model: 'synthetic', apiKey: 'PRIVATE_KEY_CANARY', outputMode: 'json_object', maxAttempts: 2, retryDelayMs: 0, maxOutputTokens: 128, temperature: 0 };
const response = (value: unknown) => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value) } }], usage: { prompt_tokens: 10, completion_tokens: 4 } }));
const task = { role: 'bills', text: 'PRIVATE_REQUEST_CANARY' };
afterEach(() => vi.restoreAllMocks());

describe('G9I request observation bound to actual production dispatch', () => {
  it('does not change the serialized wire and exposes only immutable digest metadata', async () => {
    const bodies: string[] = [], events: ModelRequestObservation[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => { bodies.push(String(init?.body)); return response({ ok: true }); });
    const observed = { ...config, attemptObserver: async () => {} };
    await invokeStructured(observed, task, shape, 'submit');
    await invokeStructured({ ...observed, requestObserver: async event => { events.push(event); } }, task, shape, 'submit');
    expect(bodies[1]).toBe(bodies[0]); expect(events).toHaveLength(1);
    const event = events[0]!; const body = JSON.parse(bodies[1]!);
    expect(event).toMatchObject({ version: MODEL_REQUEST_OBSERVATION_VERSION, role: 'bills', attempt: 1, outputMode: 'json_object', requestMaxOutputTokens: 128, schemaIncluded: true, schemaLocation: 'system', repairFeedbackIncluded: false,
      body: { sha256: hash(bodies[1]!), bytes: Buffer.byteLength(bodies[1]!) },
      system: { sha256: hash(body.messages[0].content) }, user: { sha256: hash(body.messages[1].content) } });
    expect(Object.isFrozen(event)).toBe(true);
    for (const component of [event.body, event.system, event.user, event.schema]) expect(Object.isFrozen(component)).toBe(true);
    const serialized = JSON.stringify(event);
    for (const secret of ['PRIVATE_KEY_CANARY', 'PRIVATE_REQUEST_CANARY', 'Authorization', 'synthetic.invalid']) expect(serialized).not.toContain(secret);
  });
  it('binds both repair requests to durable attempt identities and changed system bytes', async () => {
    const attempts: ModelAttemptEvent[] = [], events: ModelRequestObservation[] = [], bodies: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => { bodies.push(String(init?.body)); return response({ ok: bodies.length > 1 }); });
    await invokeStructured({ ...config, attemptObserver: async event => { attempts.push(event); }, requestObserver: async event => { events.push(event); } }, task, shape, 'submit');
    expect(events).toHaveLength(2); expect(attempts).toHaveLength(4);
    expect(events.map(event => event.repairFeedbackIncluded)).toEqual([false, true]);
    expect(events[0]!.body.sha256).not.toBe(events[1]!.body.sha256);
    expect(events[0]!.system.sha256).not.toBe(events[1]!.system.sha256);
    expect(events[0]!.user).toEqual(events[1]!.user); expect(events[0]!.schema).toEqual(events[1]!.schema);
    expect(events[0]!.invocationId).toBe(events[1]!.invocationId);
    expect(events[0]!.attemptId).not.toBe(events[1]!.attemptId);
    events.forEach((event, index) => {
      expect(event.body.sha256).toBe(hash(bodies[index]!));
      expect(attempts.filter(attempt => attempt.attemptId === event.attemptId).map(attempt => attempt.type)).toEqual(['attempt_start', 'attempt_end']);
    });
  });
  it('keeps parallel domains bound to their own starts and requests despite reordered sinks', async () => {
    const attempts: ModelAttemptEvent[] = [], events: ModelRequestObservation[] = [], bodies: any[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => { bodies.push(JSON.parse(String(init?.body))); return response({ ok: true }); });
    const observed: OpenAICompatibleConfig = { ...config, attemptObserver: async event => { attempts.push(event); }, requestObserver: async event => {
      if (event.role === 'bills') await new Promise(resolve => setTimeout(resolve, 10)); events.push(event);
    } };
    await Promise.all(['bills', 'card'].map(role => invokeStructured(observed, { role }, shape, 'submit')));
    expect(events.map(event => event.role)).toEqual(['card', 'bills']);
    expect(new Set(events.map(event => event.attemptId)).size).toBe(2);
    for (const event of events) {
      expect(attempts.find(attempt => attempt.type === 'attempt_start' && attempt.attemptId === event.attemptId)?.role).toBe(event.role);
      const body = bodies.find(item => JSON.parse(item.messages[1].content).role === event.role);
      expect(event.user.sha256).toBe(hash(body.messages[1].content));
    }
  });
  it('closes a rejected request sink as not sent with no HTTP retry or private error', async () => {
    const attempts: ModelAttemptEvent[] = [], events: ModelRequestObservation[] = [];
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('NETWORK_MUST_NOT_RUN'));
    await expect(invokeStructured({ ...config, attemptObserver: async event => { attempts.push(event); }, requestObserver: async event => { events.push(event); throw new Error('PRIVATE_SINK_ERROR'); } }, task, shape, 'submit')).rejects.toMatchObject({ code: 'MODEL_REQUEST_OBSERVATION_FAILED', retryable: false });
    expect(fetchMock).not.toHaveBeenCalled(); expect(events).toHaveLength(1);
    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toMatchObject({ type: 'attempt_end', requestStarted: false, status: 'failed', errorCode: 'MODEL_REQUEST_OBSERVATION_FAILED' });
    expect(JSON.stringify(attempts)).not.toContain('PRIVATE_SINK_ERROR');
  });
  it('never dispatches when a timed-out request sink resolves late', async () => {
    let release!: () => void; const attempts: ModelAttemptEvent[] = [];
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('NETWORK_MUST_NOT_RUN'));
    await expect(invokeStructured({ ...config, timeoutMs: 20, attemptObserver: async event => { attempts.push(event); }, requestObserver: async () => new Promise<void>(resolve => { release = resolve; }) }, task, shape, 'submit')).rejects.toMatchObject({ code: 'MODEL_REQUEST_OBSERVATION_FAILED' });
    release(); await new Promise(resolve => setTimeout(resolve, 10));
    expect(fetchMock).not.toHaveBeenCalled(); expect(attempts).toHaveLength(2);
    expect(attempts[1]).toMatchObject({ requestStarted: false, errorCode: 'MODEL_REQUEST_OBSERVATION_FAILED' });
  });
  it('rejects an unbound observer before any dispatch', async () => {
    const sink = vi.fn(), fetchMock = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('NETWORK_MUST_NOT_RUN'));
    await expect(invokeStructured({ ...config, requestObserver: sink }, task, shape, 'submit')).rejects.toThrow('MODEL_REQUEST_OBSERVER_REQUIRES_ATTEMPT_OBSERVER');
    expect(sink).not.toHaveBeenCalled(); expect(fetchMock).not.toHaveBeenCalled();
  });
  it('reports the real tool schema location without changing tools-mode execution', async () => {
    const events: ModelRequestObservation[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ function: { name: 'submit', arguments: '{"ok":true}' } }] } }] })));
    await expect(invokeStructured({ ...config, outputMode: 'tools', attemptObserver: async () => {}, requestObserver: async event => { events.push(event); } }, task, shape, 'submit')).resolves.toEqual({ ok: true });
    expect(events[0]).toMatchObject({ outputMode: 'tools', schemaLocation: 'tool', schemaIncluded: true, repairFeedbackIncluded: false });
    expect(events[0]!.schema.sha256).toBe(hash(JSON.stringify(z.toJSONSchema(shape))));
  });
});
