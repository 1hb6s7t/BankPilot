import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { canonical, digest } from '../evals/ablation-score';
import type { G9Dataset } from '../evals/g9-contract';
import { G9_SCORE_VERSION, scoreG9 } from '../evals/g9-score';
import { G9E_SCORE_VERSION, scoreG9E } from '../evals/g9e-score';
import { G9G_LABEL_POLICY_VERSION, G9G_SCORE_VERSION, g9gExpected, scoreG9G } from '../evals/g9g-score';
import { MODEL_ATTEMPT_PROTOCOL_VERSION, MODEL_STRUCTURED_OUTPUT_MAX_BYTES, MODEL_STRUCTURED_OUTPUT_OBSERVATION_VERSION, modelAttemptRoles, safeModelAttemptErrorCode, type ModelAttemptEnd, type ModelAttemptStart } from '../packages/agents/src/provider';
import type { ConfirmedModelAttempt, ModelAttemptJournalSummary } from '../packages/agents/src/attempt-journal';
import { G9_LIMITS, resolveG9CaseInput, summarizeG9Scores, type G9CaseRecord } from './evaluate-g9';
import { summarizeEvaluationCases, summarizeEvaluationObservation } from './evaluation-observation';

const INVALID = 'G9G_PRIOR_EVIDENCE_INVALID';
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
const hexDigest = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function requireEvidence(ok: unknown): asserts ok { if (!ok) throw new Error(INVALID); }

async function jsonLines(path: string): Promise<any[]> {
  const contents = await readFile(path, 'utf8');
  requireEvidence(contents.endsWith('\n'));
  const rows = contents.slice(0, -1).split('\n');
  requireEvidence(rows.length > 0 && rows.every(row => row.length > 0));
  return rows.map(row => JSON.parse(row));
}

type Attempt = { caseSequence: number; start: ModelAttemptStart; end: ModelAttemptEnd };
function parseAttempts(rows: any[], journalId: string, cases: number): Attempt[] {
  requireEvidence(rows.length >= 3 && rows[0]?.type === 'journal_start' && rows[0]?.journalId === journalId
    && rows[0]?.protocolVersion === MODEL_ATTEMPT_PROTOCOL_VERSION
    && typeof rows[0]?.createdAtUtc === 'string' && Number.isFinite(Date.parse(rows[0].createdAtUtc)));
  const starts = new Map<string, { caseSequence: number; start: ModelAttemptStart; end?: ModelAttemptEnd }>();
  const identity = ['protocolVersion', 'invocationId', 'attemptId', 'role', 'attempt', 'requestMaxOutputTokens', 'startedAtUtc'] as const;
  for (const row of rows.slice(1)) {
    requireEvidence(row && (row.type === 'attempt_start' || row.type === 'attempt_end')
      && row.protocolVersion === MODEL_ATTEMPT_PROTOCOL_VERSION && row.journalId === journalId
      && Number.isSafeInteger(row.caseSequence) && row.caseSequence >= 1 && row.caseSequence <= cases
      && typeof row.attemptId === 'string' && typeof row.invocationId === 'string'
      && modelAttemptRoles.includes(row.role)
      && Number.isSafeInteger(row.attempt) && row.attempt >= 1 && row.attempt <= G9_LIMITS.maxAttempts
      && Number.isSafeInteger(row.requestMaxOutputTokens) && row.requestMaxOutputTokens > 0 && row.requestMaxOutputTokens <= G9_LIMITS.totalOutputTokenCeilingPerCase
      && typeof row.startedAtUtc === 'string' && Number.isFinite(Date.parse(row.startedAtUtc)));
    const { journalId: _journalId, caseSequence, ...event } = row;
    if (row.type === 'attempt_start') {
      requireEvidence(row.dispatch === 'pending' && !starts.has(row.attemptId));
      starts.set(row.attemptId, { caseSequence, start: event as ModelAttemptStart });
    } else {
      const entry = starts.get(row.attemptId);
      requireEvidence(entry && !entry.end && entry.caseSequence === caseSequence
        && identity.every(key => row[key] === entry.start[key])
        && typeof row.endedAtUtc === 'string' && Number.isFinite(Date.parse(row.endedAtUtc))
        && Date.parse(row.endedAtUtc) >= Date.parse(row.startedAtUtc)
        && Number.isSafeInteger(row.durationMs) && row.durationMs >= 0
        && typeof row.requestStarted === 'boolean' && ['success', 'failed'].includes(row.status)
        && (row.httpStatus === undefined || Number.isSafeInteger(row.httpStatus) && row.httpStatus >= 100 && row.httpStatus <= 599)
        && (row.failureStage === undefined || ['request', 'response_json', 'tool_output', 'output_json', 'schema'].includes(row.failureStage))
        && ['inputTokens', 'outputTokens', 'reasoningTokens'].every(key => row[key] === undefined || Number.isSafeInteger(row[key]) && row[key] >= 0)
        && (row.status === 'success' ? row.requestStarted && row.errorCode === undefined && row.failureStage === undefined
          : typeof row.errorCode === 'string' && safeModelAttemptErrorCode(row.errorCode) === row.errorCode));
      entry.end = event as ModelAttemptEnd;
    }
  }
  requireEvidence(starts.size > 0 && [...starts.values()].every(entry => !!entry.end));
  return [...starts.values()] as Attempt[];
}

function summary(attempts: Attempt[], journalId: string, closed: boolean, sequence?: number): ModelAttemptJournalSummary {
  const rows = attempts.filter(item => sequence === undefined || item.caseSequence === sequence);
  const ends = rows.map(item => item.end);
  const confirmedAttempts: ConfirmedModelAttempt[] = rows.map(item => ({ caseSequence: item.caseSequence, start: item.start, end: item.end }));
  return { confirmedAttempts, protocolVersion: MODEL_ATTEMPT_PROTOCOL_VERSION, journalId: journalId as `${string}-${string}-${string}-${string}-${string}`,
    confirmedStarts: rows.length, confirmedEnds: ends.length,
    successful: ends.filter(end => end.status === 'success').length, failed: ends.filter(end => end.status === 'failed').length,
    dispatchAttempted: ends.filter(end => end.requestStarted).length, cancelledBeforeDispatch: ends.filter(end => !end.requestStarted).length,
    missingRequestCaps: 0, reservedOutputTokenCeilingSum: rows.reduce((sum, row) => sum + row.start.requestMaxOutputTokens!, 0),
    inputTokensReportedSum: ends.reduce((sum, end) => sum + (end.inputTokens ?? 0), 0),
    outputTokensReportedSum: ends.reduce((sum, end) => sum + (end.outputTokens ?? 0), 0),
    missingInputUsage: ends.filter(end => end.inputTokens === undefined).length,
    missingOutputUsage: ends.filter(end => end.outputTokens === undefined).length,
    errorCodes: Object.fromEntries([...new Set(ends.flatMap(end => end.errorCode ? [end.errorCode] : []))].map(code => [code, ends.filter(end => end.errorCode === code).length])),
    openAttempts: [], complete: true, persistenceFailed: false, closed };
}

function checkTraces(traces: any[], attempts: Attempt[], report: any, dataset: G9Dataset): void {
  const semantic = attempts.filter(item => item.start.role === 'semantic_intent');
  requireEvidence(traces.length === semantic.length);
  const byId = new Map(semantic.map(item => [item.start.attemptId, item]));
  const seen = new Set<string>();
  for (const trace of traces) {
    const attempt = byId.get(trace?.attemptId);
    requireEvidence(attempt && !seen.has(trace.attemptId));
    seen.add(trace.attemptId);
    requireEvidence(trace.type === 'semantic_extraction' && trace.version === MODEL_STRUCTURED_OUTPUT_OBSERVATION_VERSION
      && trace.stage === report.stage && trace.role === 'semantic_intent' && trace.toolName === 'interpret_banking_intent'
      && trace.caseSequence === attempt.caseSequence && trace.caseId === dataset.cases[attempt.caseSequence - 1]?.id
      && trace.fixtureSha256 === report.fixtureSha256 && trace.sourceManifestSha256 === report.sourceManifestSha256
      && trace.attempt === attempt.start.attempt && trace.status === attempt.end.status && trace.errorCode === attempt.end.errorCode);
    if (typeof trace.outputText === 'string') {
      requireEvidence(trace.outputOmitted === undefined && Buffer.byteLength(trace.outputText, 'utf8') <= MODEL_STRUCTURED_OUTPUT_MAX_BYTES
        && trace.outputLength === trace.outputText.length && trace.outputDigest === sha256(trace.outputText));
    } else if (trace.outputOmitted === 'not_text') {
      requireEvidence(trace.outputLength === undefined && trace.outputDigest === undefined);
    } else {
      requireEvidence(trace.outputOmitted === 'size_limit' && Number.isSafeInteger(trace.outputLength)
        && trace.outputLength >= 0 && hexDigest(trace.outputDigest));
    }
  }
}

/** Verify a completed known-stage report against its adjacent fsynced artifacts before allowing the quality stage. */
export async function verifyG9GPriorEvidence(report: any, dataset: G9Dataset, reportPath: string): Promise<void> {
  try {
    const directory = dirname(resolve(reportPath));
    requireEvidence(same(JSON.parse(await readFile(reportPath, 'utf8')), report));
    requireEvidence(report && Array.isArray(report.records) && Array.isArray(dataset?.cases) && dataset.cases.length > 0
      && report.validRun === true && report.executionComplete === true && report.stopped === false
      && report.sourceDrift === false && report.semanticTraceFailed === false && report.semanticTraceStatus === 'complete'
      && report.mode === 'live' && report.condition === 'default' && report.records.length === dataset.cases.length
      && report.caseCount === dataset.cases.length && report.datasetVersion === dataset.version
      && report.scoreVersion === G9_SCORE_VERSION && report.previousScoreVersion === G9E_SCORE_VERSION
      && report.currentScoreVersion === G9G_SCORE_VERSION && report.currentLabelPolicyVersion === G9G_LABEL_POLICY_VERSION
      && same(report.caseIds, dataset.cases.map(item => item.id))
      && report.templateInputsSha256 === digest(dataset.cases.map(item => item.input))
      && report.originalExpectedLabelsSha256 === digest(dataset.cases.map(item => item.expected))
      && report.currentExpectedLabelsSha256 === digest(dataset.cases.map(g9gExpected))
      && resolve(report.jsonPath) === resolve(reportPath)
      && resolve(report.jsonlPath) === resolve(directory, 'cases.jsonl')
      && resolve(report.attemptsPath) === resolve(directory, 'attempts.jsonl')
      && resolve(report.semanticPath) === resolve(directory, 'semantic-extraction.jsonl'));

    const cases = await jsonLines(report.jsonlPath);
    requireEvidence(cases.length === report.records.length + 2);
    const start = cases[0], finish = cases.at(-1);
    requireEvidence(start?.type === 'start' && start.runId === report.runId && start.startedAt === report.startedAt
      && start.mode === report.mode && start.attemptsPath === report.attemptsPath
      && start.semanticPath === report.semanticPath && typeof start.journalId === 'string');
    for (const key of ['protocolVersion', 'scoreVersion', 'previousScoreVersion', 'currentScoreVersion', 'stage', 'condition',
      'cohort', 'caseIds', 'caseCount', 'templateInputsSha256', 'originalExpectedLabelsSha256', 'currentExpectedLabelsSha256',
      'fixtureSha256', 'manifestSha256', 'sourceManifestSha256', 'provider', 'limits', 'evaluatorHashes', 'priorReportSha256']) {
      requireEvidence(Object.hasOwn(start.protocol ?? {}, key) && same(start.protocol[key], report[key]));
    }
    requireEvidence(Object.entries(start.protocol).every(([key, value]) => same(value, report[key])));
    for (let index = 0; index < report.records.length; index++) {
      const fixture = dataset.cases[index]!, record = report.records[index], event = cases[index + 1];
      requireEvidence(event?.type === 'case' && same({ type: 'case', ...record }, event)
        && record.sequence === index + 1 && record.id === fixture.id && record.domain === fixture.domain && record.kind === fixture.kind
        && record.evaluationValid === true && record.inputUnchanged === true && record.templateInputUnchanged === true
        && record.labelsUnchanged === true && record.currentLabelsUnchanged === true);
      const resolved = resolveG9CaseInput(fixture, Date.parse(record.startedAt));
      requireEvidence(record.startedAt === new Date(Date.parse(record.startedAt)).toISOString()
        && record.templateInputHash === resolved.templateInputHash && record.inputHash === resolved.inputHash
        && same(record.snapshotClockBinding, resolved.snapshotClockBinding)
        && record.expectedHash === digest(fixture.expected) && record.currentExpectedHash === digest(g9gExpected(fixture)));
      const scoringFixture = { ...fixture, input: resolved.input };
      const scorable = !!record.result && !record.failure;
      requireEvidence(same(record.score, scorable ? scoreG9(scoringFixture, record.result) : undefined)
        && same(record.previousContractScore, scorable ? scoreG9E(scoringFixture, record.result) : undefined)
        && same(record.currentContractScore, scorable ? scoreG9G(scoringFixture, record.result) : undefined)
        && record.passed === (record.score?.passed === true && !record.failure)
        && record.previousContractPassed === (record.previousContractScore?.passed === true && !record.failure)
        && record.currentContractPassed === (record.currentContractScore?.passed === true && !record.failure));
    }
    requireEvidence(finish?.type === 'finish' && finish.finishedAt === report.finishedAt
      && finish.executionComplete === report.executionComplete && finish.stopped === report.stopped
      && finish.sourceDrift === report.sourceDrift && finish.semanticTraceFailed === report.semanticTraceFailed
      && finish.validRun === report.validRun && same(finish.scoreSummary, report.scoreSummary)
      && same(finish.previousScoreSummary, report.previousScoreSummary)
      && same(finish.currentScoreSummary, report.currentScoreSummary));

    const original = summarizeG9Scores(report.records, dataset.cases.length);
    const previous = summarizeG9Scores(report.records.map((record: any) => ({ ...record, score: record.previousContractScore, passed: record.previousContractPassed }) as G9CaseRecord), dataset.cases.length);
    const current = summarizeG9Scores(report.records.map((record: any) => ({ ...record, score: record.currentContractScore, passed: record.currentContractPassed }) as G9CaseRecord), dataset.cases.length);
    requireEvidence(same(report.scoreSummary, original) && same(report.previousScoreSummary, previous) && same(report.currentScoreSummary, current));

    const attempts = parseAttempts(await jsonLines(report.attemptsPath), start.journalId, dataset.cases.length);
    const full = summary(attempts, start.journalId, true);
    requireEvidence(same(report.attemptObservation, full)
      && same(report.observedAttempts, summarizeEvaluationObservation(full, { mode: 'live', maxOutputTokens: G9_LIMITS.totalOutputTokenCeilingPerCase }))
      && same(report.observedCases, summarizeEvaluationCases(report.records))
      && report.observedCases.complete === true && report.observedAttempts.complete === true);
    for (let index = 0; index < report.records.length; index++) {
      const record = report.records[index], caseSummary = summary(attempts, start.journalId, false, index + 1);
      requireEvidence(caseSummary.confirmedStarts > 0 && same(record.attemptObservation, caseSummary)
        && same(record.observation, summarizeEvaluationObservation(caseSummary, { mode: 'live', caseSequence: index + 1, maxOutputTokens: G9_LIMITS.totalOutputTokenCeilingPerCase })));
      const observedRoles = attempts.filter(item => item.caseSequence === index + 1 && item.end.status === 'success').map(item => item.start.role).sort();
      const returnedRoles = (record.result?.modelRuns ?? []).filter((item: any) => item.status === 'success').map((item: any) => item.role).sort();
      requireEvidence(record.exactCallEvidenceAgreement === (!!record.result && same(observedRoles, returnedRoles)));
    }
    checkTraces(await jsonLines(report.semanticPath), attempts, report, dataset);
  } catch { throw new Error(INVALID); }
}
