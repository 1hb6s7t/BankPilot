import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { invokeStructured, type ModelAttemptEvent, type ModelRequestObservation, type OpenAICompatibleConfig } from '../packages/agents/src/provider';
import { invokeStructured as frozenInvoke } from '../evals/baselines/g9h-candidate-2026-10-25T05-45-10-204Z/source/packages/agents/src/provider';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const schema = z.object({ ok: z.literal(true) }).strict();
const config: OpenAICompatibleConfig = { baseURL: 'https://independent.invalid/v1', model: 'synthetic-review', maxAttempts: 3, retryDelayMs: 0, maxStructureRepairs: 1 };
function completion(mode: 'tools' | 'json_object', ok: boolean) {
  const value = JSON.stringify({ ok });
  return new Response(JSON.stringify({ choices: [{ finish_reason: mode === 'tools' ? 'tool_calls' : 'stop', message: mode === 'tools' ? { tool_calls: [{ function: { name: 'review_probe', arguments: value } }] } : { content: value } }] }));
}
afterEach(() => vi.restoreAllMocks());

describe('G9I independent request observer review, controlled fetch only', () => {
  for (const mode of ['tools', 'json_object'] as const) for (const explicit of [false, true]) {
    it(`keeps frozen G9H ${mode} request bytes through repair with explicit options=${explicit}`, async () => {
      const options = { ...config, outputMode: mode, ...(explicit ? { temperature: 0, maxOutputTokens: 317, thinkingMode: 'disabled' as const, reasoningEffort: 'none' as const } : {}) };
      const capture = async (invoke: typeof invokeStructured, observed: boolean) => {
        const bodies: string[] = [], events: ModelRequestObservation[] = [];
        const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => { bodies.push(String(init?.body)); return completion(mode, bodies.length > 1); });
        try {
          await invoke({ ...options, ...(observed ? { attemptObserver: async () => {}, requestObserver: async (event: ModelRequestObservation) => { events.push(event); } } : {}) }, { role: 'bills', text: '独立合成请求' }, schema, 'review_probe');
          return { bodies, events };
        } finally { fetch.mockRestore(); }
      };
      const frozen = await capture(frozenInvoke, false), current = await capture(invokeStructured, false), observed = await capture(invokeStructured, true);
      expect(current.bodies).toEqual(frozen.bodies);
      expect(observed.bodies).toEqual(frozen.bodies);
      expect(observed.events.map(e => e.body.sha256)).toEqual(observed.bodies.map(hash));
      expect(observed.events.map(e => e.repairFeedbackIncluded)).toEqual([false, true]);
    });
  }

  it('does not let a second-attempt observation failure dispatch or create a third request', async () => {
    const attempts: ModelAttemptEvent[] = [], observations: ModelRequestObservation[] = [];
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => completion('json_object', false));
    await expect(invokeStructured({ ...config, outputMode: 'json_object', attemptObserver: async e => { attempts.push(e); }, requestObserver: async e => {
      observations.push(e); if (e.attempt === 2) throw new Error('PRIVATE_OBSERVER_CAUSE');
    } }, { role: 'card' }, schema, 'review_probe')).rejects.toMatchObject({ code: 'MODEL_REQUEST_OBSERVATION_FAILED', retryable: false });
    expect(fetch).toHaveBeenCalledOnce(); expect(observations).toHaveLength(2);
    expect(observations[1]?.repairFeedbackIncluded).toBe(true);
    expect(attempts.map(e => e.type)).toEqual(['attempt_start', 'attempt_end', 'attempt_start', 'attempt_end']);
    expect(attempts[3]).toMatchObject({ requestStarted: false, errorCode: 'MODEL_REQUEST_OBSERVATION_FAILED', attempt: 2 });
    expect(JSON.stringify(attempts)).not.toContain('PRIVATE_OBSERVER_CAUSE');
  });

  it('consumes a timed-out sink late rejection without dispatch, retry or a second end', async () => {
    let rejectLate!: (error: Error) => void;
    const attempts: ModelAttemptEvent[] = [], runs: unknown[] = [];
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('HTTP_MUST_NOT_RUN'));
    await expect(invokeStructured({ ...config, timeoutMs: 30, outputMode: 'json_object', attemptObserver: async e => { attempts.push(e); }, requestObserver: async () => new Promise<void>((_resolve, reject) => { rejectLate = reject; }) }, { role: 'bills' }, schema, 'review_probe', run => { runs.push(run); })).rejects.toMatchObject({ code: 'MODEL_REQUEST_OBSERVATION_FAILED' });
    rejectLate(new Error('PRIVATE_LATE_REJECTION'));
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(fetch).not.toHaveBeenCalled(); expect(attempts).toHaveLength(2); expect(runs).toHaveLength(1);
    expect(attempts[1]).toMatchObject({ requestStarted: false, status: 'failed', errorCode: 'MODEL_REQUEST_OBSERVATION_FAILED' });
    expect(JSON.stringify([attempts, runs])).not.toContain('PRIVATE_LATE_REJECTION');
  });

  it('closes shared cancellation while a sink is pending and ignores its later success', async () => {
    const controller = new AbortController(), attempts: ModelAttemptEvent[] = [];
    let release!: () => void, started!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('HTTP_MUST_NOT_RUN'));
    const result = invokeStructured({ ...config, signal: controller.signal, outputMode: 'json_object', attemptObserver: async e => { attempts.push(e); }, requestObserver: async () => { started(); return new Promise<void>(resolve => { release = resolve; }); } }, { role: 'bills' }, schema, 'review_probe');
    const rejected = expect(result).rejects.toMatchObject({ code: 'MODEL_REQUEST_OBSERVATION_FAILED' });
    await entered; controller.abort(); await rejected;
    release(); await new Promise(resolve => setTimeout(resolve, 5));
    expect(fetch).not.toHaveBeenCalled(); expect(attempts).toHaveLength(2);
    expect(attempts[1]).toMatchObject({ type: 'attempt_end', requestStarted: false, errorCode: 'MODEL_REQUEST_OBSERVATION_FAILED' });
  });

  it('normalizes an unknown role and keeps schema, task, credentials and endpoint out of metadata', async () => {
    const events: ModelRequestObservation[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => completion('json_object', true));
    await invokeStructured({ ...config, outputMode: 'json_object', apiKey: 'PRIVATE_API_KEY_SENTINEL', attemptObserver: async () => {}, requestObserver: async e => { events.push(e); } }, { role: 'PRIVATE_ROLE_SENTINEL', request: 'PRIVATE_USER_SENTINEL' }, schema.describe('PRIVATE_SCHEMA_SENTINEL'), 'review_probe');
    expect(events[0]?.role).toBe('unknown');
    const serialized = JSON.stringify(events);
    for (const value of ['PRIVATE_ROLE_SENTINEL', 'PRIVATE_USER_SENTINEL', 'PRIVATE_SCHEMA_SENTINEL', 'PRIVATE_API_KEY_SENTINEL', 'independent.invalid', 'Authorization']) expect(serialized).not.toContain(value);
    for (const component of [events[0]!.body, events[0]!.system, events[0]!.user, events[0]!.schema]) expect(Object.keys(component).sort()).toEqual(['bytes', 'sha256']);
  });
});
