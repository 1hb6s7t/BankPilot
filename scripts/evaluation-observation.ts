import type { ModelRun, PlanningFailure, PlanningStageKey } from '../packages/contracts/src/index.js';
import { PlanningStageFailure } from '../packages/agents/src/planning-failures.js';
import { PlanningBudgetError, PLANNING_OUTPUT_TOKEN_LIMIT } from '../packages/agents/src/budget.js';
import { ModelAttemptJournalError, type ModelAttemptJournalSummary, type ConfirmedModelAttempt } from '../packages/agents/src/attempt-journal.js';
import { ModelAttemptPersistenceError, ModelProviderError, modelAttemptRoles, safeModelAttemptErrorCode } from '../packages/agents/src/provider.js';

export const EVALUATION_OBSERVATION_VERSION = 'bankpilot-evaluation-observation-g8g-v1';
const MAX_LOCAL_RUNS = 32;
const stableCodes = new Set(['CASE_DEADLINE_EXCEEDED', 'INPUT_MUTATED', 'EVAL_OBSERVATION_INCOMPLETE', 'EVAL_UNCLASSIFIED_STAGE_FAILURE', 'EVAL_RUN_ERROR', 'MODEL_CANDIDATE_CONTRACT_INVALID', 'MODEL_PLANNING_FAILED', 'MODEL_ATTEMPTS_EXHAUSTED', 'MODEL_PROVIDER_ERROR',
  'MODEL_OUTPUT_BUDGET_EXHAUSTED', 'MODEL_OUTPUT_BUDGET_INVALID', 'MODEL_ATTEMPT_START_PERSIST_FAILED', 'MODEL_ATTEMPT_END_PERSIST_FAILED',
  'MODEL_ATTEMPT_JOURNAL_FAILED', 'MODEL_ATTEMPT_PERSIST_FAILED', 'MODEL_ATTEMPT_PERSIST_CANCELLED', 'MODEL_ATTEMPT_BINDING_INVALID',
  'STAGE_INPUT_BINDING_INVALID', 'STAGE_SNAPSHOT_INVALID', 'STAGE_SNAPSHOT_INCOMPATIBLE', 'STAGE_SNAPSHOT_DIGEST_MISMATCH',
  'STAGE_HISTORY_INVALID', 'STAGE_DEPENDENCY_MISMATCH', 'STAGE_RESULT_CONFLICT', 'STAGE_RESTART_CONFLICT', 'STAGE_RESTART_POINTER_INVALID', 'PLAN_SUPERSEDED']);
const safeFindingCodes = new Set(['GOAL_SPEC_MISMATCH','INVESTMENT_SPEC_MISMATCH','INVESTMENT_WRONG_DOMAIN','MANAGEMENT_SPEC_MISMATCH','MANAGEMENT_WRONG_DOMAIN','TRANSFER_MEMO_MISMATCH','TRANSFER_NO_ACTION_MISMATCH','TRANSFER_STRUCTURED_SUGGESTION_MISSING','FUNDS_NOT_ALLOWED','FUNDS_PREVIEW_MISMATCH','FUNDS_PREVIEW_MISSING']);
const safeFindings = (values: unknown) => Array.isArray(values) ? [...new Set(values.slice(0, 32).flatMap(value => { const code = typeof value === 'string' ? /^([A-Z][A-Z0-9_]*)(?:[：:\s]|$)/.exec(value)?.[1] : undefined; return code && safeFindingCodes.has(code) ? [code] : []; }))] : [];
const knownCode = (code: unknown): string | undefined => typeof code === 'string' && (stableCodes.has(code) || safeModelAttemptErrorCode(code) === code) ? code : undefined;
const safeCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const validCap = (value: unknown): value is number => safeCount(value) && value > 0 && value <= PLANNING_OUTPUT_TOKEN_LIMIT;
const validStage = (value: unknown): value is PlanningStageKey => typeof value === 'string' && /^(?:domain:(?:transfer|bills|investment|card|subscription|goal)|reviewer|single)$/.test(value);
const safeRole = (value: unknown) => modelAttemptRoles.includes(value as any) ? String(value) : 'unknown';

/** This is a bounded local diagnostic appendix, never the case-wide attempt count. */
function localRuns(runs: unknown): { localModelRuns: ModelRun[]; omittedLocalModelRuns: number } {
  if (!Array.isArray(runs)) return { localModelRuns: [], omittedLocalModelRuns: 0 };
  const selected = runs.slice(0, MAX_LOCAL_RUNS).filter(run => run && typeof run === 'object' && ['success','failed'].includes(run.status));
  return { omittedLocalModelRuns: runs.length - selected.length, localModelRuns: selected.map(run => {
    const value: ModelRun = { role: safeRole(run.role), model: '[configured-model-redacted]', status: run.status,
      durationMs: safeCount(run.durationMs) ? run.durationMs : 0 };
    for (const key of ['inputTokens','outputTokens','reasoningTokens','outputLength','reasoningLength'] as const) if (safeCount(run[key])) value[key] = run[key];
    if (safeCount(run.attempt) && run.attempt >= 1 && run.attempt <= 3) value.attempt = run.attempt;
    if (validCap(run.requestMaxOutputTokens)) value.requestMaxOutputTokens = run.requestMaxOutputTokens;
    if (knownCode(run.errorCode)) value.errorCode = knownCode(run.errorCode);
    if (['request','response_json','tool_output','output_json','schema'].includes(run.failureStage)) value.failureStage = run.failureStage;
    if (['stop','length','tool_calls','function_call','content_filter','other'].includes(run.finishReason)) value.finishReason = run.finishReason;
    if (typeof run.outputDigest === 'string' && /^[a-f0-9]{64}$/.test(run.outputDigest)) value.outputDigest = run.outputDigest;
    return value;
  }) };
}
export type ClassifiedEvaluationFailure = {
  code: string; kind: 'planning_stage' | 'attempt_persistence' | 'deadline' | 'provider' | 'budget' | 'journal' | 'unknown';
  phase?: PlanningFailure['phase']; stage?: PlanningStageKey; retryable: boolean; findings?: string[]; caseDeadlineExceeded?: true;
  localModelRuns: ModelRun[]; omittedLocalModelRuns: number; modelRunsScope: 'selected-failure-stage-only';
  requestOutcome?: 'not_sent' | 'success' | 'failed'; requestErrorCode?: string;
};
export function classifyEvaluationFailure(error: unknown, options: { deadlineExceeded?: boolean } = {}): ClassifiedEvaluationFailure {
  const base = { localModelRuns: [], omittedLocalModelRuns: 0, modelRunsScope: 'selected-failure-stage-only' as const, retryable: false, ...(options.deadlineExceeded ? { caseDeadlineExceeded: true as const } : {}) };
  if (error instanceof PlanningStageFailure) {
    const failure = error.failure, code = knownCode(failure.code), findings = safeFindings(failure.findings);
    return { ...base, ...localRuns(failure.modelRuns), ...(findings.length ? { findings } : {}), kind: 'planning_stage', code: code ?? 'EVAL_UNCLASSIFIED_STAGE_FAILURE',
      ...(failure.phase === 'planning' || failure.phase === 'semantic_intent' ? { phase: failure.phase } : {}),
      ...(validStage(failure.stage) ? { stage: failure.stage } : {}), retryable: !!code && failure.retryable === true };
  }
  if (error instanceof ModelAttemptPersistenceError) return { ...base, kind: 'attempt_persistence', code: knownCode(error.code) ?? 'MODEL_ATTEMPT_PERSIST_FAILED',
    ...(['not_sent','success','failed'].includes(error.requestOutcome) ? { requestOutcome: error.requestOutcome } : {}),
    ...(knownCode(error.requestErrorCode) ? { requestErrorCode: knownCode(error.requestErrorCode) } : {}) };
  if (error instanceof ModelAttemptJournalError) return { ...base, kind: 'journal', code: 'MODEL_ATTEMPT_JOURNAL_FAILED' };
  if (error instanceof PlanningBudgetError) return { ...base, kind: 'budget', code: knownCode(error.code) ?? 'MODEL_OUTPUT_BUDGET_INVALID' };
  if (error instanceof ModelProviderError) return { ...base, kind: 'provider', code: knownCode(error.code) ?? 'MODEL_PROVIDER_ERROR',
    retryable: /^(?:MODEL_HTTP_(?:408|429|5\d{2})|MODEL_TIMEOUT|MODEL_NETWORK_ERROR|MODEL_DEADLINE_EXCEEDED)$/.test(error.code) };
  if (options.deadlineExceeded) return { ...base, kind: 'deadline', code: 'CASE_DEADLINE_EXCEEDED' };
  return { ...base, kind: 'unknown', code: 'EVAL_RUN_ERROR' };
}

export type EvaluationCaseBudget = { caseSequence: number; confirmedStarts: number; requestedOutputTokens: number;
  missingRequestCaps: number; invalidRequestCaps: number; ceiling: number; withinBudget: boolean | null; verified: boolean };
export type EvaluationObservation = {
  protocolVersion: typeof EVALUATION_OBSERVATION_VERSION; source: 'durable-attempt-journal'; applicable: boolean;
  complete: boolean; verified: boolean | null; reason?: 'scripted-zero-calls' | 'journal-unavailable' | 'journal-incomplete' | 'journal-summary-invalid' | 'unexpected-scripted-calls';
  confirmedStarts: number; confirmedEnds: number; successful: number; failed: number; dispatchAttempted: number; cancelledBeforeDispatch: number; openCount: number;
  persistenceFailed: boolean; errorCodes: Record<string, number>;
  budget: { withinBudget: boolean | null; verified: boolean | null; ceilingPerCase: number; requestedOutputTokens: number;
    missingRequestCaps: number; invalidRequestCaps: number; caseBudgets: EvaluationCaseBudget[] };
  usage: { inputTokensReportedSum: number; outputTokensReportedSum: number; missingInputUsage: number; missingOutputUsage: number;
    inputUsageUnaccountedAttempts: number; outputUsageUnaccountedAttempts: number; inputTokensTotal: number | null; outputTokensTotal: number | null };
};
const histogram = (codes: string[]) => Object.fromEntries([...new Set(codes)].sort().map(code => [code, codes.filter(value => value === code).length]));
/** Only fsync-confirmed journal entries contribute. Local ModelRuns are never added. */
export function summarizeEvaluationObservation(summary: ModelAttemptJournalSummary | undefined, options: { mode: 'live' | 'scripted'; caseSequence?: number; maxOutputTokens?: number }): EvaluationObservation {
  const ceiling = options.maxOutputTokens ?? PLANNING_OUTPUT_TOKEN_LIMIT;
  const raw = summary?.confirmedAttempts;
  const detailsAvailable = Array.isArray(raw);
  const allRows: readonly ConfirmedModelAttempt[] = detailsAvailable ? raw : [];
  const seen = new Set<string>(); let integrity = detailsAvailable && validCap(ceiling);
  for (const row of allRows) {
    if (!row?.start || !safeCount(row.caseSequence) || row.caseSequence < 1 || typeof row.start.attemptId !== 'string' || seen.has(row.start.attemptId)) { integrity = false; continue; }
    seen.add(row.start.attemptId);
    if (row.end && (!['success','failed'].includes(row.end.status) || typeof row.end.requestStarted !== 'boolean' || row.end.status === 'success' && (!row.end.requestStarted || row.end.errorCode) || row.end.status === 'failed' && !knownCode(row.end.errorCode))) integrity = false;
    if (row.end && ['attemptId','invocationId','role','attempt','requestMaxOutputTokens','startedAtUtc'].some(key => (row.start as any)[key] !== (row.end as any)[key])) integrity = false;
  }
  if (summary && (summary.confirmedStarts !== allRows.length || summary.confirmedEnds !== allRows.filter(row => row?.end).length)) integrity = false;
  const unique = new Map<string, ConfirmedModelAttempt>();
  for (const row of allRows) if (row?.start && typeof row.start.attemptId === 'string' && !unique.has(row.start.attemptId)) unique.set(row.start.attemptId, row);
  const rows = [...unique.values()].filter(row => options.caseSequence === undefined || row.caseSequence === options.caseSequence);
  const ends = rows.flatMap(row => row.end ? [row.end] : []);
  const openCount = rows.length - ends.length;
  const complete = !!summary && summary.complete && !summary.persistenceFailed && integrity && openCount === 0;
  const sequences = [...new Set(rows.map(row => row.caseSequence))].sort((a,b) => a-b);
  if (!sequences.length && options.caseSequence !== undefined) sequences.push(options.caseSequence);
  const caseBudgets = sequences.map(caseSequence => {
    const selected = rows.filter(row => row.caseSequence === caseSequence);
    const missingRequestCaps = selected.filter(row => row.start.requestMaxOutputTokens == null).length;
    const invalidRequestCaps = selected.filter(row => row.start.requestMaxOutputTokens != null && !validCap(row.start.requestMaxOutputTokens)).length;
    const requestedOutputTokens = selected.reduce((sum,row) => sum + (validCap(row.start.requestMaxOutputTokens) ? row.start.requestMaxOutputTokens : 0), 0);
    const validSum = Number.isSafeInteger(requestedOutputTokens);
    const verified = complete && !missingRequestCaps && !invalidRequestCaps && validSum;
    const withinBudget = invalidRequestCaps || !validSum || requestedOutputTokens > ceiling ? false : verified ? true : null;
    return { caseSequence, confirmedStarts: selected.length, requestedOutputTokens, missingRequestCaps, invalidRequestCaps, ceiling, verified, withinBudget };
  });
  const missingRequestCaps = caseBudgets.reduce((sum,row) => sum + row.missingRequestCaps, 0), invalidRequestCaps = caseBudgets.reduce((sum,row) => sum + row.invalidRequestCaps, 0);
  const budgetVerified = complete && !missingRequestCaps && !invalidRequestCaps && caseBudgets.every(row => row.verified);
  const unexpectedScriptedCalls = options.mode === 'scripted' && rows.length > 0;
  const scripted = options.mode === 'scripted' && !rows.length && (!summary || complete);
  const inputReported = ends.filter(end => safeCount(end.inputTokens)), outputReported = ends.filter(end => safeCount(end.outputTokens));
  const inputTokensReportedSum = inputReported.reduce((sum,end) => sum + end.inputTokens!, 0), outputTokensReportedSum = outputReported.reduce((sum,end) => sum + end.outputTokens!, 0);
  return { protocolVersion: EVALUATION_OBSERVATION_VERSION, source: 'durable-attempt-journal', applicable: !scripted,
    complete: scripted || complete && !unexpectedScriptedCalls, verified: scripted ? null : complete && !unexpectedScriptedCalls,
    ...(scripted ? { reason: 'scripted-zero-calls' as const } : !summary ? { reason: 'journal-unavailable' as const } : !integrity ? { reason: 'journal-summary-invalid' as const } : unexpectedScriptedCalls ? { reason: 'unexpected-scripted-calls' as const } : !complete ? { reason: 'journal-incomplete' as const } : {}),
    confirmedStarts: rows.length, confirmedEnds: ends.length, successful: ends.filter(end => end.status === 'success').length, failed: ends.filter(end => end.status === 'failed').length,
    dispatchAttempted: ends.filter(end => end.requestStarted).length, cancelledBeforeDispatch: ends.filter(end => !end.requestStarted).length, openCount,
    persistenceFailed: summary?.persistenceFailed ?? false, errorCodes: histogram(ends.flatMap(end => end.errorCode ? [knownCode(end.errorCode) ?? 'MODEL_PROVIDER_ERROR'] : [])),
    budget: { verified: scripted ? null : budgetVerified && !unexpectedScriptedCalls, withinBudget: scripted ? null : caseBudgets.some(row => row.withinBudget === false) ? false : budgetVerified && !unexpectedScriptedCalls ? true : null,
      ceilingPerCase: ceiling, requestedOutputTokens: caseBudgets.reduce((sum,row) => sum + row.requestedOutputTokens, 0), missingRequestCaps, invalidRequestCaps, caseBudgets },
    usage: { inputTokensReportedSum, outputTokensReportedSum, missingInputUsage: ends.length - inputReported.length, missingOutputUsage: ends.length - outputReported.length,
      inputUsageUnaccountedAttempts: rows.length - inputReported.length, outputUsageUnaccountedAttempts: rows.length - outputReported.length,
      inputTokensTotal: complete && inputReported.length === rows.length ? inputTokensReportedSum : null,
      outputTokensTotal: complete && outputReported.length === rows.length ? outputTokensReportedSum : null },
  };
}

export type EvaluationCaseObservationRecord = { sequence: number; durationMs: number; score?: unknown; errorCode?: string; failure?: ClassifiedEvaluationFailure; failureSource?: 'returned-plan' | 'thrown'; observation?: EvaluationObservation };
function latency(values: number[]) { const sorted = values.filter(value => Number.isFinite(value) && value >= 0).sort((a,b) => a-b); return { count: sorted.length,
  medianMs: sorted.length ? (sorted[Math.floor((sorted.length - 1) / 2)]! + sorted[Math.floor(sorted.length / 2)]!) / 2 : null, p95Ms: sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * .95) - 1)] : null }; }
export function summarizeEvaluationCases(records: readonly EvaluationCaseObservationRecord[]) {
  const uniqueRecords = new Map<number, EvaluationCaseObservationRecord>();
  for (const record of records) if (!uniqueRecords.has(record.sequence)) uniqueRecords.set(record.sequence, record);
  const observations = [...uniqueRecords.values()].flatMap(record => record.observation ? [record.observation] : []), applicable = observations.filter(value => value.applicable);
  const observationComplete = records.length > 0 && observations.length === records.length && observations.every(value => value.complete);
  const usageSum = (field: keyof EvaluationObservation['usage']) => observations.reduce((sum,value) => sum + (value.usage[field] ?? 0), 0);
  const sum = (field: 'confirmedStarts'|'confirmedEnds'|'successful'|'failed'|'dispatchAttempted'|'openCount') => observations.reduce((total,value) => total + value[field], 0);
  const businessResultCases = records.filter(record => record.score != null && !record.failure).length;
  return { protocolVersion: EVALUATION_OBSERVATION_VERSION, cases: records.length,
    scoringBoundary: 'scoredCases means only that the existing scorer ran. System failures are not business results, and safe empty output is not business completion. Existing scores and passed labels are unchanged. validRun describes evaluation validity, not business success.',
    scoredSystemFailureCases: records.filter(record => record.score != null && !!record.failure).length,
    businessResultCases, businessUnavailableCases: records.length - businessResultCases,
    returnedPlanFailureCases: records.filter(record => !!record.failure && record.failureSource === 'returned-plan').length,
    thrownFailureCases: records.filter(record => !!record.failure && record.failureSource === 'thrown').length,
    scoredCases: records.filter(record => record.score != null).length,
    unscoredCases: records.filter(record => record.score == null).length, safetyUnscoredCases: records.filter(record => record.score == null).length,
    typedStageFailures: records.filter(record => record.failure?.kind === 'planning_stage').length,
    errorCodes: histogram(records.flatMap(record => record.failure ? [knownCode(record.failure.code) ?? (['CASE_DEADLINE_EXCEEDED','EVAL_UNCLASSIFIED_STAGE_FAILURE'].includes(record.failure.code) ? record.failure.code : 'EVAL_RUN_ERROR')] : record.errorCode ? [knownCode(record.errorCode) ?? (record.errorCode === 'CASE_DEADLINE_EXCEEDED' ? record.errorCode : 'EVAL_RUN_ERROR')] : [])),
    observationComplete,
    complete: observationComplete && applicable.every(value => value.budget.verified === true && value.budget.withinBudget === true),
    latency: { allCases: latency(records.map(record => record.durationMs)), casesWithConfirmedStarts: latency(records.filter(record => (record.observation?.confirmedStarts ?? 0) > 0).map(record => record.durationMs)),
      casesWithConfirmedDispatch: latency(records.filter(record => (record.observation?.dispatchAttempted ?? 0) > 0).map(record => record.durationMs)) },
    attempts: { confirmedStarts: sum('confirmedStarts'), confirmedEnds: sum('confirmedEnds'), successful: sum('successful'), failed: sum('failed'), dispatchAttempted: sum('dispatchAttempted'), openCount: sum('openCount'), errorCodes: Object.fromEntries([...new Set(observations.flatMap(value => Object.keys(value.errorCodes)))].sort().map(code => [code, observations.reduce((sum,value) => sum + (value.errorCodes[code] ?? 0), 0)])) },
    usage: { inputTokensReportedSum: usageSum('inputTokensReportedSum'), outputTokensReportedSum: usageSum('outputTokensReportedSum'), missingInputUsage: usageSum('missingInputUsage'), missingOutputUsage: usageSum('missingOutputUsage'),
      inputUsageUnaccountedAttempts: usageSum('inputUsageUnaccountedAttempts'), outputUsageUnaccountedAttempts: usageSum('outputUsageUnaccountedAttempts'),
      inputTokensTotal: observationComplete && applicable.every(value => value.usage.inputTokensTotal !== null) ? usageSum('inputTokensTotal') : null,
      outputTokensTotal: observationComplete && applicable.every(value => value.usage.outputTokensTotal !== null) ? usageSum('outputTokensTotal') : null },
    budget: { verifiedCases: applicable.filter(value => value.budget.verified).length, unverifiedCases: records.length - observations.length + applicable.filter(value => !value.budget.verified).length,
      withinBudget: applicable.some(value => value.budget.withinBudget === false) ? false : applicable.length && observations.length === records.length && applicable.every(value => value.budget.withinBudget === true) ? true : null,
      requestedOutputTokens: observations.reduce((sum,value) => sum + value.budget.requestedOutputTokens, 0) },
  };
}
