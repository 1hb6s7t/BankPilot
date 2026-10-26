import { open } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { MODEL_ATTEMPT_PROTOCOL_VERSION, MODEL_ATTEMPT_PERSIST_TIMEOUT_MS, modelAttemptRoles, safeModelAttemptErrorCode,
  type ModelAttemptEvent, type ModelAttemptObserver, type ModelAttemptStart, type ModelAttemptEnd } from './provider.js';

const identity = {
  protocolVersion: z.literal(MODEL_ATTEMPT_PROTOCOL_VERSION), invocationId: z.uuid(), attemptId: z.uuid(),
  role: z.enum(modelAttemptRoles), attempt: z.number().int().min(1).max(3),
  requestMaxOutputTokens: z.number().int().min(1).max(32768).nullable(), startedAtUtc: z.iso.datetime(),
};
const eventSchema = z.discriminatedUnion('type', [
  z.object({ ...identity, type: z.literal('attempt_start'), dispatch: z.literal('pending') }).strict(),
  z.object({ ...identity, type: z.literal('attempt_end'), endedAtUtc: z.iso.datetime(), durationMs: z.number().int().nonnegative(),
    requestStarted: z.boolean(), status: z.enum(['success', 'failed']), httpStatus: z.number().int().min(100).max(599).optional(),
    errorCode: z.string().refine(code => safeModelAttemptErrorCode(code) === code).optional(),
    failureStage: z.enum(['request', 'response_json', 'tool_output', 'output_json', 'schema']).optional(),
    inputTokens: z.number().int().nonnegative().optional(), outputTokens: z.number().int().nonnegative().optional(), reasoningTokens: z.number().int().nonnegative().optional(),
  }).strict(),
]);
type Entry = { caseSequence: number; start: ModelAttemptStart; end?: ModelAttemptEnd };
export type ConfirmedModelAttempt = Readonly<{ caseSequence: number; start: Readonly<ModelAttemptStart>; end?: Readonly<ModelAttemptEnd> }>;
export class ModelAttemptJournalError extends Error {
  readonly code = 'MODEL_ATTEMPT_JOURNAL_FAILED';
  constructor() { super('MODEL_ATTEMPT_JOURNAL_FAILED'); this.name = 'ModelAttemptJournalError'; }
}
/** Node filesystem operations cannot always be cancelled; late completion is consumed, never certified. */
async function boundedIo<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => finish(new ModelAttemptJournalError()), MODEL_ATTEMPT_PERSIST_TIMEOUT_MS);
    const stop = () => finish(new ModelAttemptJournalError());
    const finish = (error?: unknown, value?: T) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', stop);
      if (error) reject(error); else resolve(value!);
    };
    signal?.addEventListener('abort', stop, { once: true });
    void operation.then(value => finish(undefined, value), () => finish(new ModelAttemptJournalError()));
    if (signal?.aborted) stop();
  });
}

/**
 * Append-only, serialized and fsynced before the observer resolves. The header is
 * the only non-attempt line. Identifiers are generated internally; case scope is
 * a numeric ordinal, never a prompt, task ID, provider URL or user identifier.
 * A start proves durable dispatch intent, not receipt by the remote server.
 */
export async function createModelAttemptJournal(path: string) {
  const journalId = randomUUID();
  const createdAtUtc = new Date().toISOString();
  const opening = open(path, 'wx', 0o600);
  const file = await boundedIo(opening).catch(() => {
    void opening.then(handle => handle.close()).catch(() => {});
    throw new ModelAttemptJournalError();
  });
  try {
    await boundedIo(file.appendFile(JSON.stringify({ type: 'journal_start', protocolVersion: MODEL_ATTEMPT_PROTOCOL_VERSION, journalId, createdAtUtc }) + '\n'));
    await boundedIo(file.sync());
  } catch { await boundedIo(file.close()).catch(() => {}); throw new ModelAttemptJournalError(); }
  let tail: Promise<void> = Promise.resolve();
  let failed = false, accepting = true, closed = false;
  let closing: Promise<void> | undefined;
  const entries = new Map<string, Entry>();
  const persist = (caseSequence: number, input: Readonly<ModelAttemptEvent>, signal?: AbortSignal): Promise<void> => {
    if (!accepting) { failed = true; return Promise.reject(new ModelAttemptJournalError()); }
    const operation = tail.then(async () => {
      if (failed) throw new ModelAttemptJournalError();
      try {
        if (signal?.aborted || !Number.isSafeInteger(caseSequence) || caseSequence < 1) throw new ModelAttemptJournalError();
        // Reject unknown fields rather than persisting arbitrary caller payloads.
        const event = eventSchema.parse(input) as ModelAttemptEvent;
        const existing = entries.get(event.attemptId);
        if (event.type === 'attempt_start') {
          if (existing) throw new ModelAttemptJournalError();
        } else {
          if (!existing || existing.end || existing.caseSequence !== caseSequence) throw new ModelAttemptJournalError();
          const start = existing.start;
          if (['invocationId', 'role', 'attempt', 'requestMaxOutputTokens', 'startedAtUtc'].some(key => event[key as keyof ModelAttemptEnd] !== start[key as keyof ModelAttemptStart])) throw new ModelAttemptJournalError();
          if (event.status === 'success' && (!event.requestStarted || event.errorCode || event.failureStage)) throw new ModelAttemptJournalError();
          if (event.status === 'failed' && !event.errorCode) throw new ModelAttemptJournalError();
        }
        await boundedIo(file.appendFile(JSON.stringify({ ...event, journalId, caseSequence }) + '\n'), signal);
        if (failed || signal?.aborted) throw new ModelAttemptJournalError();
        await boundedIo(file.sync(), signal);
        if (failed || signal?.aborted) throw new ModelAttemptJournalError();
        // Counters describe writes whose sync completed, never optimistic/in-flight appends.
        if (event.type === 'attempt_start') entries.set(event.attemptId, { caseSequence, start: event });
        else existing!.end = event;
      } catch { failed = true; throw new ModelAttemptJournalError(); }
    });
    tail = operation.catch(() => {});
    return operation;
  };
  const summary = (caseSequence?: number) => {
    const rows = [...entries.values()].filter(row => caseSequence === undefined || row.caseSequence === caseSequence);
    const ends = rows.flatMap(row => row.end ? [row.end] : []);
    const openAttempts = rows.filter(row => !row.end).map(row => ({ caseSequence: row.caseSequence,
      invocationId: row.start.invocationId, attemptId: row.start.attemptId, role: row.start.role, attempt: row.start.attempt,
      requestMaxOutputTokens: row.start.requestMaxOutputTokens, startedAtUtc: row.start.startedAtUtc, outcome: 'unknown' as const }));
    const confirmedAttempts: readonly ConfirmedModelAttempt[] = Object.freeze(rows.map(row => Object.freeze({ caseSequence: row.caseSequence, start: Object.freeze({ ...row.start }), ...(row.end ? { end: Object.freeze({ ...row.end }) } : {}) })));
    return { confirmedAttempts, protocolVersion: MODEL_ATTEMPT_PROTOCOL_VERSION, journalId, confirmedStarts: rows.length, confirmedEnds: ends.length,
      successful: ends.filter(end => end.status === 'success').length, failed: ends.filter(end => end.status === 'failed').length,
      dispatchAttempted: ends.filter(end => end.requestStarted).length, cancelledBeforeDispatch: ends.filter(end => !end.requestStarted).length,
      missingRequestCaps: rows.filter(row => row.start.requestMaxOutputTokens === null).length,
      reservedOutputTokenCeilingSum: rows.reduce((sum, row) => sum + (row.start.requestMaxOutputTokens ?? 0), 0),
      inputTokensReportedSum: ends.reduce((sum, end) => sum + (end.inputTokens ?? 0), 0),
      outputTokensReportedSum: ends.reduce((sum, end) => sum + (end.outputTokens ?? 0), 0),
      missingInputUsage: ends.filter(end => end.inputTokens === undefined).length,
      missingOutputUsage: ends.filter(end => end.outputTokens === undefined).length,
      errorCodes: Object.fromEntries([...new Set(ends.flatMap(end => end.errorCode ? [end.errorCode] : []))].map(code => [code, ends.filter(end => end.errorCode === code).length])),
      openAttempts, complete: !failed && openAttempts.length === 0, persistenceFailed: failed, closed };
  };
  return {
    journalId,
    observerForCase: (caseSequence: number): ModelAttemptObserver => (event, context) => persist(caseSequence, event, context?.signal),
    summary,
    flush: async () => { try { await boundedIo(tail); } catch { failed = true; throw new ModelAttemptJournalError(); } if (failed) throw new ModelAttemptJournalError(); },
    close: () => {
      if (closing) return closing;
      accepting = false;
      closing = (async () => {
        try { await boundedIo(tail); } catch { failed = true; }
        try { await boundedIo(file.close()); closed = true; }
        catch { failed = true; throw new ModelAttemptJournalError(); }
        if (failed) throw new ModelAttemptJournalError();
      })();
      return closing;
    },
  };
}
export type ModelAttemptJournalSummary = ReturnType<Awaited<ReturnType<typeof createModelAttemptJournal>>['summary']>;
