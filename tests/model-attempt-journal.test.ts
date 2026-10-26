import { mkdtemp, readFile, rm, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createModelAttemptJournal } from '../packages/agents/src/attempt-journal';
import { invokeStructured, MODEL_ATTEMPT_PROTOCOL_VERSION, MODEL_ATTEMPT_PERSIST_TIMEOUT_MS, ModelProviderError,
  type ModelAttemptEvent, type ModelAttemptStart, type OpenAICompatibleConfig } from '../packages/agents/src/provider';
import type { ModelRun } from '../packages/contracts/src/index';

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, open: vi.fn(actual.open) };
});

const config: OpenAICompatibleConfig = { baseURL: 'https://private-provider.invalid/v1', model: 'private-model-label', apiKey: 'private-api-key',
  outputMode: 'json_object', maxAttempts: 3, retryDelayMs: 0, maxOutputTokens: 1024 };
const schema = z.object({ ok: z.literal(true) }).strict();
const completion = (content = '{"ok":true}') => new Response(JSON.stringify({ usage: { prompt_tokens: 11, completion_tokens: 7,
  completion_tokens_details: { reasoning_tokens: 3 } }, choices: [{ finish_reason: 'stop', message: { content, reasoning_content: 'private-reasoning-content' } }] }));
const directories: string[] = [];
const journals: Awaited<ReturnType<typeof createModelAttemptJournal>>[] = [];
async function journal() {
  const directory = await mkdtemp(join(tmpdir(), 'bp-attempts-')); directories.push(directory);
  const path = join(directory, 'attempts.jsonl');
  const log = await createModelAttemptJournal(path); journals.push(log);
  return { log, path, lines: async () => (await readFile(path, 'utf8')).trim().split('\n').map(line => JSON.parse(line)) };
}
function startEvent(): ModelAttemptStart {
  return { protocolVersion: MODEL_ATTEMPT_PROTOCOL_VERSION, type: 'attempt_start', dispatch: 'pending', invocationId: randomUUID(),
    attemptId: randomUUID(), role: 'transfer', attempt: 1, requestMaxOutputTokens: 1024, startedAtUtc: new Date().toISOString() };
}
afterEach(async () => {
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  await Promise.all(journals.splice(0).map(log => log.close().catch(() => {})));
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('durable per-HTTP-attempt boundaries', () => {
  it('awaits the persisted start before fetch and persists a correlated sanitized end before returning', async () => {
    const { log, lines, path } = await journal();
    const fetch = vi.fn().mockImplementation(async (_url, init) => {
      const persisted = await lines();
      expect(persisted.map(line => line.type)).toEqual(['journal_start', 'attempt_start']);
      expect(persisted[1]).toMatchObject({ dispatch: 'pending', role: 'transfer', attempt: 1, requestMaxOutputTokens: JSON.parse(init.body).max_tokens, caseSequence: 4 });
      return completion();
    });
    vi.stubGlobal('fetch', fetch);
    expect(await invokeStructured({ ...config, attemptObserver: log.observerForCase(4) }, { role: 'transfer', taskId: 'private-task-id', text: 'private-user-content' }, schema, 'private-tool-name')).toEqual({ ok: true });
    const persisted = await lines(), started = persisted[1], ended = persisted[2];
    expect(ended).toMatchObject({ type: 'attempt_end', attemptId: started.attemptId, invocationId: started.invocationId,
      caseSequence: 4, status: 'success', requestStarted: true, httpStatus: 200, inputTokens: 11, outputTokens: 7, reasoningTokens: 3 });
    expect(Date.parse(ended.endedAtUtc)).toBeGreaterThanOrEqual(Date.parse(started.startedAtUtc));
    expect(log.summary(4)).toMatchObject({ confirmedStarts: 1, confirmedEnds: 1, successful: 1, dispatchAttempted: 1, complete: true, reservedOutputTokenCeilingSum: 1024 });
    const serialized = await readFile(path, 'utf8');
    for (const secret of ['private-provider', 'private-model-label', 'private-api-key', 'private-task-id', 'private-user-content', 'private-tool-name', 'private-reasoning-content', 'Authorization', 'messages', 'completion', 'prompt']) expect(serialized).not.toContain(secret);
  });

  it('does not dispatch or retry when the start observer rejects', async () => {
    const fetch = vi.fn(), events: ModelAttemptEvent[] = [], runs: ModelRun[] = [];
    vi.stubGlobal('fetch', fetch);
    const attemptObserver = async (event: ModelAttemptEvent) => { events.push(event); throw new Error('private-disk-error'); };
    await expect(invokeStructured({ ...config, attemptObserver }, { role: 'transfer' }, schema, 'submit', run => runs.push(run)))
      .rejects.toMatchObject({ code: 'MODEL_ATTEMPT_START_PERSIST_FAILED', retryable: false, requestOutcome: 'not_sent' });
    expect(fetch).not.toHaveBeenCalled(); expect(events.map(event => event.type)).toEqual(['attempt_start']); expect(runs).toEqual([]);
  });

  it.each([undefined, null, false, 0, ''])('fails closed for a falsey observer rejection value: %j', async rejection => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    await expect(invokeStructured({ ...config, attemptObserver: async () => { throw rejection; } }, {}, schema, 'submit'))
      .rejects.toMatchObject({ code: 'MODEL_ATTEMPT_START_PERSIST_FAILED', requestOutcome: 'not_sent' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(['success', 'failed'] as const)('does not retry HTTP or fabricate another end when an end write fails after request %s', async outcome => {
    const { log, lines } = await journal();
    const fetch = vi.fn().mockResolvedValue(outcome === 'success' ? completion() : new Response('private-http-error-body', { status: 503 }));
    const events: ModelAttemptEvent[] = [], runs: ModelRun[] = [];
    vi.stubGlobal('fetch', fetch);
    const persist = log.observerForCase(1);
    const attemptObserver = async (event: ModelAttemptEvent) => {
      events.push(event);
      if (event.type === 'attempt_end') throw new Error('private-end-write-error');
      await persist(event);
    };
    await expect(invokeStructured({ ...config, attemptObserver }, { role: 'reviewer' }, schema, 'submit', run => runs.push(run)))
      .rejects.toMatchObject({ code: 'MODEL_ATTEMPT_END_PERSIST_FAILED', requestOutcome: outcome,
        ...(outcome === 'failed' ? { requestErrorCode: 'MODEL_HTTP_503' } : {}) });
    expect(fetch).toHaveBeenCalledTimes(1); expect(runs).toEqual([]);
    expect(events.map(event => event.type)).toEqual(['attempt_start', 'attempt_end']);
    expect(events[1]).toMatchObject({ status: outcome });
    expect((await lines()).map(line => line.type)).toEqual(['journal_start', 'attempt_start']);
    expect(log.summary()).toMatchObject({ confirmedStarts: 1, confirmedEnds: 0, complete: false, openAttempts: [{ outcome: 'unknown' }] });
  });

  it('fails closed when cancellation wins the observer acknowledgement after a durable start', async () => {
    const { log, lines } = await journal();
    const controller = new AbortController(), fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const persist = log.observerForCase(1);
    const attemptObserver = async (event: ModelAttemptEvent) => { await persist(event); if (event.type === 'attempt_start') controller.abort(); };
    await expect(invokeStructured({ ...config, attemptObserver, signal: controller.signal }, { role: 'semantic_intent' }, schema, 'submit'))
      .rejects.toMatchObject({ code: 'MODEL_ATTEMPT_START_PERSIST_FAILED', requestOutcome: 'not_sent' });
    expect(fetch).not.toHaveBeenCalled();
    expect((await lines()).map(line => line.type)).toEqual(['journal_start', 'attempt_start']);
    expect(log.summary()).toMatchObject({ confirmedStarts: 1, confirmedEnds: 0, dispatchAttempted: 0, complete: false, openAttempts: [{ outcome: 'unknown' }] });
  });

  it.each(['attempt_start', 'attempt_end'] as const)('bounds a hanging %s observer by shared cancellation and ignores its late resolution', async phase => {
    const controller = new AbortController(), fetch = vi.fn().mockResolvedValue(completion()); vi.stubGlobal('fetch', fetch);
    let reached!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { reached = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const events: ModelAttemptEvent[] = [], runs: ModelRun[] = [];
    const attemptObserver = async (event: ModelAttemptEvent) => { events.push(event); if (event.type === phase) { reached(); await gate; } };
    const job = invokeStructured({ ...config, signal: controller.signal, attemptObserver }, { role: 'transfer' }, schema, 'submit', run => runs.push(run));
    await started;
    controller.abort();
    await expect(job).rejects.toMatchObject({ code: phase === 'attempt_start' ? 'MODEL_ATTEMPT_START_PERSIST_FAILED' : 'MODEL_ATTEMPT_END_PERSIST_FAILED',
      requestOutcome: phase === 'attempt_start' ? 'not_sent' : 'success' });
    release(); await Promise.resolve(); await Promise.resolve();
    expect(fetch).toHaveBeenCalledTimes(phase === 'attempt_start' ? 0 : 1);
    expect(events.map(event => event.type)).toEqual(phase === 'attempt_start' ? ['attempt_start'] : ['attempt_start', 'attempt_end']);
    expect(runs).toEqual([]);
  });

  it.each(['attempt_start', 'attempt_end'] as const)('bounds an uncancelled never-settling %s observer without retrying HTTP', async phase => {
    vi.useFakeTimers();
    const fetch = vi.fn().mockResolvedValue(completion()); vi.stubGlobal('fetch', fetch);
    const attemptObserver = async (event: ModelAttemptEvent) => { if (event.type === phase) await new Promise<void>(() => {}); };
    const failure = expect(invokeStructured({ ...config, attemptObserver }, { role: 'transfer' }, schema, 'submit'))
      .rejects.toMatchObject({ code: phase === 'attempt_start' ? 'MODEL_ATTEMPT_START_PERSIST_FAILED' : 'MODEL_ATTEMPT_END_PERSIST_FAILED' });
    await vi.advanceTimersByTimeAsync(MODEL_ATTEMPT_PERSIST_TIMEOUT_MS + 1);
    await failure;
    expect(fetch).toHaveBeenCalledTimes(phase === 'attempt_start' ? 0 : 1);
  });

  it('does not create dispatch intents for an already aborted invocation', async () => {
    const { log, lines } = await journal();
    const controller = new AbortController(), fetch = vi.fn(); controller.abort(); vi.stubGlobal('fetch', fetch);
    await expect(invokeStructured({ ...config, signal: controller.signal, attemptObserver: log.observerForCase(1) }, {}, schema, 'submit')).rejects.toMatchObject({ code: 'MODEL_DEADLINE_EXCEEDED' });
    expect(fetch).not.toHaveBeenCalled(); expect(await lines()).toHaveLength(1); expect(log.summary().confirmedStarts).toBe(0);
  });

  it('uses exactly the existing transport/structure retry budget and records actual caps for all attempts', async () => {
    const { log, lines } = await journal();
    const fetch = vi.fn().mockResolvedValueOnce(new Response('private-http-error-body', { status: 503 }))
      .mockResolvedValueOnce(completion('{')).mockResolvedValueOnce(completion());
    vi.stubGlobal('fetch', fetch);
    expect(await invokeStructured({ ...config, attemptObserver: log.observerForCase(2) }, { role: 'investment' }, schema, 'submit')).toEqual({ ok: true });
    const rows = await lines(), starts = rows.filter(row => row.type === 'attempt_start'), ends = rows.filter(row => row.type === 'attempt_end');
    expect(fetch).toHaveBeenCalledTimes(3); expect(starts.map(row => row.attempt)).toEqual([1, 2, 3]);
    expect(new Set(starts.map(row => row.invocationId)).size).toBe(1); expect(new Set(starts.map(row => row.attemptId)).size).toBe(3);
    expect(ends.map(row => [row.status, row.errorCode])).toEqual([['failed', 'MODEL_HTTP_503'], ['failed', 'MODEL_OUTPUT_JSON_INVALID'], ['success', undefined]]);
    expect(log.summary(2)).toMatchObject({ confirmedStarts: 3, confirmedEnds: 3, successful: 1, failed: 2, reservedOutputTokenCeilingSum: 3072, complete: true });
  });

  it('keeps parallel branches correlated while all starts can be outstanding', async () => {
    const { log, lines } = await journal();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const fetch = vi.fn().mockImplementation(async () => { await gate; return completion(); }); vi.stubGlobal('fetch', fetch);
    const roles = ['transfer', 'bills', 'investment', 'card', 'subscription', 'goal'] as const;
    const jobs = roles.map(role => invokeStructured({ ...config, attemptObserver: log.observerForCase(3) }, { role }, schema, 'submit'));
    try {
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(roles.length));
      expect(log.summary(3)).toMatchObject({ confirmedStarts: roles.length, confirmedEnds: 0, complete: false });
      release(); await Promise.all(jobs);
      const rows = await lines();
      expect(rows).toHaveLength(1 + roles.length * 2);
      expect(new Set(rows.filter(row => row.type === 'attempt_start').map(row => row.invocationId)).size).toBe(roles.length);
      expect(log.summary(3)).toMatchObject({ confirmedStarts: roles.length, confirmedEnds: roles.length, complete: true });
      expect(log.summary(4)).toMatchObject({ confirmedStarts: 0, confirmedEnds: 0 });
    } finally { release(); await Promise.allSettled(jobs); }
  });

  it('keeps omitted caps/usage unknown and redacts arbitrary role and exception text', async () => {
    const { log, lines, path } = await journal();
    const fetch = vi.fn().mockRejectedValue(new ModelProviderError('private-exception-code'));
    vi.stubGlobal('fetch', fetch);
    await expect(invokeStructured({ ...config, maxAttempts: 1, maxOutputTokens: undefined, attemptObserver: log.observerForCase(1) }, { role: 'private-role-text' }, schema, 'submit')).rejects.toMatchObject({ code: 'private-exception-code' });
    expect((await lines())[1]).toMatchObject({ role: 'unknown', requestMaxOutputTokens: null });
    expect((await lines())[2]).toMatchObject({ status: 'failed', errorCode: 'MODEL_PROVIDER_ERROR' });
    expect((await lines())[2]).not.toHaveProperty('inputTokens'); expect((await lines())[2]).not.toHaveProperty('outputTokens');
    expect(log.summary()).toMatchObject({ missingRequestCaps: 1, missingInputUsage: 1, missingOutputUsage: 1 });
    expect(await readFile(path, 'utf8')).not.toContain('private-role-text'); expect(await readFile(path, 'utf8')).not.toContain('private-exception-code');
  });
});

describe('journal integrity and durability failures', () => {
  it('bounds a hung fsync/flush and never certifies its late completion', async () => {
    const { log, path } = await journal();
    const handle = await open(path, 'r');
    let reached!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { reached = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const sync = vi.spyOn(Object.getPrototypeOf(handle), 'sync').mockImplementationOnce(async () => { reached(); await gate; });
    vi.useFakeTimers();
    const writing = expect(log.observerForCase(1)(startEvent())).rejects.toMatchObject({ code: 'MODEL_ATTEMPT_JOURNAL_FAILED' });
    await started;
    const flushing = expect(log.flush()).rejects.toMatchObject({ code: 'MODEL_ATTEMPT_JOURNAL_FAILED' });
    await vi.advanceTimersByTimeAsync(MODEL_ATTEMPT_PERSIST_TIMEOUT_MS + 1);
    await writing; await flushing;
    release(); await Promise.resolve(); await Promise.resolve();
    expect(log.summary()).toMatchObject({ confirmedStarts: 0, persistenceFailed: true, complete: false });
    vi.useRealTimers(); sync.mockRestore(); await handle.close();
  });

  it('bounds a hung close and reports incomplete even when the underlying close finishes late', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'bp-attempts-close-')); directories.push(directory);
    const path = join(directory, 'attempts.jsonl');
    const handle = await open(path, 'wx', 0o600), originalClose = handle.close.bind(handle);
    let finishClose!: () => Promise<void>;
    const close = vi.spyOn(handle, 'close').mockImplementationOnce(() => {
      return new Promise<void>(resolve => { finishClose = async () => { await originalClose(); resolve(); }; });
    });
    vi.mocked(open).mockResolvedValueOnce(handle);
    const log = await createModelAttemptJournal(path); journals.push(log);
    vi.useFakeTimers();
    const closing = expect(log.close()).rejects.toMatchObject({ code: 'MODEL_ATTEMPT_JOURNAL_FAILED' });
    await vi.advanceTimersByTimeAsync(MODEL_ATTEMPT_PERSIST_TIMEOUT_MS + 1); await closing;
    expect(log.summary()).toMatchObject({ closed: false, persistenceFailed: true, complete: false });
    vi.useRealTimers(); await finishClose(); close.mockRestore();
    expect(log.summary()).toMatchObject({ closed: false, persistenceFailed: true, complete: false });
  });

  it('latches an fsync failure and prevents both the current HTTP request and later requests', async () => {
    const { log, path } = await journal();
    const handle = await open(path, 'r');
    const sync = vi.spyOn(Object.getPrototypeOf(handle), 'sync').mockRejectedValueOnce(new Error('private-fsync-failure'));
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    try {
      await expect(invokeStructured({ ...config, attemptObserver: log.observerForCase(1) }, {}, schema, 'submit')).rejects.toMatchObject({ code: 'MODEL_ATTEMPT_START_PERSIST_FAILED' });
      await expect(invokeStructured({ ...config, attemptObserver: log.observerForCase(2) }, {}, schema, 'submit')).rejects.toMatchObject({ code: 'MODEL_ATTEMPT_START_PERSIST_FAILED' });
      expect(sync).toHaveBeenCalledTimes(1); expect(fetch).not.toHaveBeenCalled();
      expect(log.summary()).toMatchObject({ persistenceFailed: true, complete: false, confirmedStarts: 0 });
    } finally { sync.mockRestore(); await handle.close(); }
  });

  it('rejects extra sensitive fields before writing them and latches the failure', async () => {
    const { log, path } = await journal();
    const persist = log.observerForCase(1);
    await expect(persist({ ...startEvent(), prompt: 'private-untrusted-payload' } as ModelAttemptStart)).rejects.toMatchObject({ code: 'MODEL_ATTEMPT_JOURNAL_FAILED' });
    await expect(persist(startEvent())).rejects.toMatchObject({ code: 'MODEL_ATTEMPT_JOURNAL_FAILED' });
    expect(await readFile(path, 'utf8')).not.toContain('private-untrusted-payload');
    expect(log.summary()).toMatchObject({ persistenceFailed: true, complete: false });
  });

  it('does not overwrite an existing log and never manufactures ends for unclosed starts', async () => {
    const { log, path, lines } = await journal();
    await log.observerForCase(1)(startEvent());
    await log.close();
    expect(log.summary()).toMatchObject({ closed: true, confirmedStarts: 1, confirmedEnds: 0, complete: false, openAttempts: [{ outcome: 'unknown' }] });
    await expect(createModelAttemptJournal(path)).rejects.toMatchObject({ code: 'MODEL_ATTEMPT_JOURNAL_FAILED' });
    expect((await lines()).map(row => row.type)).toEqual(['journal_start', 'attempt_start']);
  });

  it('does not turn a legacy diagnostic observer error into an implicit HTTP retry', async () => {
    const fetch = vi.fn().mockResolvedValue(completion()); vi.stubGlobal('fetch', fetch);
    await expect(invokeStructured(config, {}, schema, 'submit', () => { throw new Error('diagnostic sink failed'); })).rejects.toThrow('diagnostic sink failed');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
