import { billDomainResponse } from './fixtures/bill-domain-response';
import { reviewResponse } from './fixtures/review-response';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runEvaluation } from '../scripts/evaluate-model';
import { runG7 } from '../scripts/evaluate-g7';
import { runAblation, type EvaluationSuite } from '../scripts/evaluate-ablation';
import { holdoutFixtures } from '../evals/holdout-fixtures';

// Real planners, HTTP provider validation, attempt journal, scoring and report
// writers run here. Only transport and selected filesystem failures are controlled.
const faults = vi.hoisted(() => ({ syncAt: 0, drift: false, sourceReads: 0, caseAppend: false }));
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual,
    appendFile: async (...args: Parameters<typeof actual.appendFile>) => {
      if (faults.caseAppend && String(args[1]).startsWith('{"type":"case"')) throw new Error('CONTROLLED_CASE_REPORT_WRITE_FAILED');
      return actual.appendFile(...args);
    },
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      if (String(args[0]).endsWith('.attempts.jsonl')) {
        const sync = handle.sync.bind(handle); let count = 0;
        handle.sync = async () => {
          if (++count === faults.syncAt) throw new Error('PRIVATE_FSYNC_ERROR_CANARY');
          return sync();
        };
      }
      return handle;
    },
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      const value = await actual.readFile(...args);
      if (faults.drift && String(args[0]) === 'packages/agents/src/stage-recovery.ts' && ++faults.sourceReads > 1) {
        return Buffer.isBuffer(value) ? Buffer.concat([value, Buffer.from('\n// controlled drift\n')]) : value + '\n// controlled drift\n';
      }
      return value;
    },
  };
});

const directories: string[] = [];
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const completion = (value: unknown, usage = true) => new Response(JSON.stringify({
  ...(usage ? { usage: { prompt_tokens: 13, completion_tokens: 7 } } : {}),
  choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value) } }],
}));
const rawFailure = () => new Response('<html>controlled unavailable</html>', { status: 200 });
type Call = { role: string; taskId: string; cap: number; task: any };
let calls: Call[] = [];
let respond: (task: any) => Promise<Response>;
async function directory() { const path = await mkdtemp(join(tmpdir(), 'bp-g8g-runner-')); directories.push(path); return path; }
function semantic(task: any) {
  const g701 = task.taskId.includes('g701');
  const second = task.taskId === 'eval-02-chinese';
  const cross = task.taskId.includes('g704');
  return { tasks: [
    ...(cross ? [{ operation: 'bills_query', disposition: 'query', scope: { text: '先列出2026年9月账单中金额最大的消费' }, period: { text: '2026年9月' } }] : []),
    { operation: 'transfer', disposition: 'request', scope: cross ? { text: '再给陆星遥汇 246.80 元' } : { source: 'whole_message' },
      entity: { kind: 'payee', id: g701 ? 'g7-g701-payee-primary' : cross ? 'g7-g704-payee-primary' : 'payee-lin', mention: { text: g701 ? '小陆同学' : cross ? '陆星遥' : '林晓' } },
      amount: { text: g701 ? '一千零二十六元零九分' : cross ? '246.80 元' : second ? '一千二百三十四元五角六分' : '300元' },
      ...(g701 ? { memo: { text: '设备维修' } } : {}),
    },
  ] };
}
function proposal(task: any) {
  if (task.role === 'bills') return billDomainResponse(task);
  return { role: task.role, planVersion: task.planVersion, summary: '核对合成数据，尚待用户确认', findings: [], evidence: [],
    ...(task.role === 'transfer' ? task.data.resolved.suggestion ? { suggestion: task.data.resolved.suggestion } : task.data.resolved.clarification ? { clarification: task.data.resolved.clarification } : {} : {}),
    ...(task.role === 'bills' && task.data.analysis.clarification ? { clarification: task.data.analysis.clarification } : {}),
  };
}
function successful(task: any): Response {
  return completion(task.role === 'semantic_intent' ? semantic(task) : task.role === 'reviewer'
    ? reviewResponse(task, { summary: '仅形成待确认提案' })
    : task.role === 'single' ? { proposals: task.contexts.map(proposal) } : proposal(task));
}
async function saved(dir: string) {
  const files = await readdir(dir);
  const read = async (suffix: string) => readFile(join(dir, files.find(file => file.endsWith(suffix))!), 'utf8');
  return { attempts: (await read('.attempts.jsonl')).trim().split('\n').map(line => JSON.parse(line)),
    markdown: await read('.md'),
    cases: (await readFile(join(dir, files.find(file => file.endsWith('.jsonl') && !file.endsWith('.attempts.jsonl'))!), 'utf8')).trim().split('\n').map(line => JSON.parse(line)).filter(row => row.type === 'case') };
}
function starts(record: any) { return record.attemptObservation.confirmedStarts as number; }
function assertJournal(record: any, expectedRoles: string[]) {
  expect(starts(record)).toBe(expectedRoles.length);
  expect(record.attemptObservation.confirmedEnds).toBe(expectedRoles.length);
  expect(record.attemptObservation.complete).toBe(true);
  const entries = record.attemptObservation.confirmedAttempts;
  expect(entries.map((row: any) => row.start.role).sort()).toEqual([...expectedRoles].sort());
  expect(new Set(entries.map((row: any) => row.start.attemptId)).size).toBe(expectedRoles.length);
  expect(record.observation).toMatchObject({ source: 'durable-attempt-journal', confirmedStarts: expectedRoles.length, complete: true });
  expect(record.observation.budget).toMatchObject({ verified: true, withinBudget: true });
}
async function isolatedAblationSuite(dir: string, cross = false): Promise<EvaluationSuite> {
  const fixture = structuredClone(holdoutFixtures.find(f => f.id === (cross ? 'h36-cross-bills-transfer' : 'h01-transfer-decimal'))!);
  const fixtureFile = join(dir, 'controlled-fixture.json'), manifestFile = join(dir, 'controlled-manifest.json');
  const content = JSON.stringify([fixture]); await writeFile(fixtureFile, content);
  await writeFile(manifestFile, JSON.stringify({ version: 'g8g-controlled-v1', frozenAt: '2026-10-22T00:00:00Z', fixtureSha256: createHash('sha256').update(content).digest('hex'), caseIds: [fixture.id], liveCaseIds: [fixture.id] }));
  return { fixtures: [fixture], version: 'g8g-controlled-v1', fixtureFile, manifestFile, caseCount: 1, liveCaseCount: 1, phase: 'g8g-controlled' };
}

beforeEach(() => {
  faults.syncAt = 0; faults.drift = false; faults.sourceReads = 0; faults.caseAppend = false; calls = [];
  vi.stubEnv('BANKPILOT_MODEL_BASE_URL', 'https://g8g-controlled.invalid/v1');
  vi.stubEnv('BANKPILOT_MODEL_NAME', 'g8g-controlled-provider');
  vi.stubEnv('BANKPILOT_MODEL_API_KEY', 'PRIVATE_TEST_KEY_CANARY');
  vi.stubEnv('BANKPILOT_MODEL_OUTPUT_MODE', 'json_object');
  vi.stubEnv('BANKPILOT_MODEL_MAX_ATTEMPTS', '2');
  respond = async task => successful(task);
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    if (String(url) !== 'https://g8g-controlled.invalid/v1/chat/completions') throw new Error('Unexpected external network destination');
    const body = JSON.parse(String(init?.body)), task = JSON.parse(body.messages.find((m: any) => m.role === 'user').content);
    calls.push({ role: task.role, taskId: task.taskId, cap: body.max_tokens, task });
    return respond(task);
  });
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  await Promise.all(directories.splice(0).map(dir => rm(dir, { force: true, recursive: true })));
});

describe('G8G real evaluation entrypoints with controlled transport', () => {
  it.each([
    { role: 'transfer', status: 502, code: 'MODEL_HTTP_502', retryable: true, attempts: 2 },
    { role: 'reviewer', status: 502, code: 'MODEL_HTTP_502', retryable: true, attempts: 2 },
    { role: 'transfer', status: 401, code: 'MODEL_HTTP_401', retryable: false, attempts: 1 },
    { role: 'transfer', status: 200, code: 'MODEL_SCHEMA_INVALID', retryable: false, attempts: 2 },
  ])('model preserves $role/$code without losing preceding attempts', async scenario => {
    const dir = await directory();
    respond = async task => task.role === scenario.role ? scenario.status === 200 ? completion({}) : new Response('', { status: scenario.status }) : successful(task);
    const report: any = await runEvaluation(['--mode', 'live', '--limit', '1'], { resultsDir: dir });
    const record = report.records[0], roles = ['semantic_intent', ...(scenario.role === 'reviewer' ? ['transfer'] : []), ...Array(scenario.attempts).fill(scenario.role)];
    expect(record.status).toBe('failed'); expect(record.result).toBeUndefined(); expect(record.score).toBeUndefined();
    expect(record.errorCode).toBe(scenario.code);
    expect(record.failure).toMatchObject({ phase: 'planning', stage: scenario.role === 'reviewer' ? 'reviewer' : 'domain:transfer', code: scenario.code, retryable: scenario.retryable });
    assertJournal(record, roles);
    expect(report.attemptObservation.confirmedStarts).toBe(calls.length);
    expect(report.validRun).toBe(false);
    expect(report.observedCases).toMatchObject({ cases: 1, scoredCases: 0, unscoredCases: 1, safetyUnscoredCases: 1 });
    expect(report.observedCases.latency.casesWithConfirmedStarts.medianMs).toBe(record.durationMs);
    const raw = await saved(dir);
    expect(raw.attempts.filter(row => row.type === 'attempt_start')).toHaveLength(roles.length);
    expect(raw.cases[0].sequence).toBe(1);
    expect(JSON.stringify(report)).not.toContain('PRIVATE_TEST_KEY_CANARY');
    expect(raw.markdown).toContain('未评分');
    expect(record.attemptObservation.reservedOutputTokenCeilingSum).toBe(calls.reduce((sum, call) => sum + call.cap, 0));
    if (scenario.status !== 200) {
      expect(record.attemptObservation.missingOutputUsage).toBe(scenario.attempts);
      expect(record.observation.usage.outputTokensTotal).toBeNull();
      expect(record.observation.usage.outputTokensReportedSum).toBe(7 * (scenario.role === 'reviewer' ? 2 : 1));
    }
  });

  it('model gives cases stable claim-order sequences even when the second finishes first', async () => {
    const dir = await directory();
    respond = async task => {
      if (task.taskId === 'eval-02-chinese') return rawFailure();
      if (task.role === 'semantic_intent') await sleep(75);
      return successful(task);
    };
    const report: any = await runEvaluation(['--mode', 'live', '--limit', '2', '--concurrency', '2'], { resultsDir: dir });
    const raw = await saved(dir);
    expect(raw.cases.map(row => row.sequence)).toEqual([2, 1]);
    expect(report.records.map((row: any) => [row.id, row.sequence])).toEqual([['01-normal', 1], ['02-chinese', 2]]);
    expect(raw.attempts.filter(row => row.type === 'attempt_start' && row.caseSequence === 1).map(row => row.role)).toEqual(['semantic_intent', 'transfer', 'reviewer']);
    expect(raw.attempts.filter(row => row.type === 'attempt_start' && row.caseSequence === 2).map(row => row.role)).toEqual(['semantic_intent']);
    expect(report.records[0].status).toBe('passed'); expect(report.records[1].status).toBe('failed');
    expect(report.records[1].failure).toMatchObject({ phase: 'semantic_intent', code: 'MODEL_RESPONSE_JSON_INVALID', retryable: false });
    expect(report.records[1].failureSource).toBe('returned-plan');
    expect(report.records[1].score).toMatchObject({ passed: false, modelExecution: false });
    expect(report.observedCases).toMatchObject({ scoredCases: 2, scoredSystemFailureCases: 1, businessResultCases: 1, businessUnavailableCases: 1 });
    expect(report.attemptObservation.confirmedStarts).toBe(4);
  });

  it('a valid reviewer refusal stays scored and separate from HTTP or stage failure', async () => {
    const dir = await directory();
    respond = async task => task.role === 'reviewer' ? completion({ approved: false, findings: ['合成证据不足'], summary: '不能采纳此提案' }) : successful(task);
    const report: any = await runEvaluation(['--mode', 'live', '--limit', '1'], { resultsDir: dir });
    const record = report.records[0];
    expect(record.failure).toBeUndefined(); expect(record.errorCode).toBeUndefined();
    expect(record.score).toBeDefined(); expect(record.result.suggestions).toEqual([]);
    expect(record.status).toBe('failed'); expect(record.score.passed).toBe(false);
    expect(report.validRun).toBe(true);
    assertJournal(record, ['semantic_intent', 'transfer', 'reviewer']);
    expect(report.observedAttempts).toMatchObject({ successful: 3, failed: 0 });
    expect(report.observedCases).toMatchObject({ scoredCases: 1, unscoredCases: 0, typedStageFailures: 0 });
  });

  it('model waits for its concurrent worker to settle before returning a case-report write failure', async () => {
    const dir = await directory(); faults.caseAppend = true;
    let slowResponseSettled = false;
    respond = async task => {
      if (task.taskId === 'eval-02-chinese') { await sleep(80); slowResponseSettled = true; }
      return rawFailure();
    };
    let rejected = false, settledAtReturn = false;
    try { await runEvaluation(['--mode', 'live', '--limit', '2', '--concurrency', '2'], { resultsDir: dir }); }
    catch { rejected = true; settledAtReturn = slowResponseSettled; }
    // Give a broken implementation's late continuation time to finish before
    // cleaning the temporary directory; it must still fail the settled boundary.
    await sleep(100);
    expect(rejected).toBe(true); expect(settledAtReturn).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it.each([{ syncAt: 2, code: 'MODEL_ATTEMPT_START_PERSIST_FAILED', sent: 0 }, { syncAt: 3, code: 'MODEL_ATTEMPT_END_PERSIST_FAILED', sent: 1 }])('model preserves $code with no automatic resend', async ({ syncAt, code, sent }) => {
    const dir = await directory(); faults.syncAt = syncAt;
    const report: any = await runEvaluation(['--mode', 'live', '--limit', '1'], { resultsDir: dir });
    expect(calls).toHaveLength(sent); expect(report.records[0].errorCode).toBe(code);
    expect(report.attemptObservation).toMatchObject({ confirmedStarts: sent, confirmedEnds: 0, persistenceFailed: true, complete: false });
    expect(report.validRun).toBe(false);
    expect(report.records[0].observation.budget.verified).toBe(false);
    expect(report.records[0].observation.budget.withinBudget).toBeNull();
    expect(JSON.stringify(report)).not.toContain('PRIVATE_FSYNC_ERROR_CANARY');
    if (sent) expect(report.attemptObservation.openAttempts).toHaveLength(1);
  });

  it('G7 counts semantic and the successful slow sibling when another domain fails', async () => {
    const dir = await directory();
    respond = async task => {
      if (!task.taskId.includes('g704')) return rawFailure();
      if (task.role === 'transfer') return new Response('', { status: 502 });
      if (task.role === 'bills') await sleep(400);
      return successful(task);
    };
    const report: any = await runG7(['--mode', 'live', '--selection', 'all'], { resultsDir: dir });
    const record = report.records.find((r: any) => r.id === 'g704');
    expect(record.errorCode).toBe('MODEL_HTTP_502'); expect(record.score).toBeUndefined(); expect(record.durationMs).toBeGreaterThanOrEqual(390);
    assertJournal(record, ['semantic_intent', 'bills', 'transfer', 'transfer']);
    expect(record.failure).toMatchObject({ stage: 'domain:transfer', code: 'MODEL_HTTP_502' });
    expect(report.modelCallsSource).toBe('returned-plan-model-runs');
    expect(report.modelCalls.total).toBe(23); expect(report.attemptObservation.confirmedStarts).toBe(27);
    expect(report.records).toHaveLength(24); expect(report.validRun).toBe(false);
    expect(report.observedCases).toMatchObject({ cases: 24, scoredCases: 23, unscoredCases: 1, safetyUnscoredCases: 1 });
    expect(report.observedCases).toMatchObject({ scoredSystemFailureCases: 23, businessResultCases: 0, businessUnavailableCases: 24 });
    for (const returnedFailure of report.records.filter((row: any) => row.failureSource === 'returned-plan')) {
      expect(returnedFailure.score).toMatchObject({ observedStatus: 'failed', passed: false, intentRecognition: false, modelComplete: false, businessSemanticsPass: false });
    }
    expect(calls.filter(call => call.role === 'reviewer')).toHaveLength(0);
    expect(report.latency.casesWithCalls.medianMs).not.toBeNull();
    const raw = await saved(dir);
    const caseStarts = raw.attempts.filter(row => row.type === 'attempt_start' && row.caseSequence === record.sequence);
    expect(new Set(caseStarts.map(row => row.attemptId)).size).toBe(4);
  });

  it('G7 retains reviewer failure stage while keeping earlier HTTP successes', async () => {
    const dir = await directory();
    respond = async task => !task.taskId.includes('g701') ? rawFailure() : task.role === 'reviewer' ? new Response('', { status: 502 }) : successful(task);
    const report: any = await runG7(['--mode', 'live', '--selection', 'pilot'], { resultsDir: dir });
    const record = report.records.find((row: any) => row.id === 'g701');
    expect(record.failure).toMatchObject({ phase: 'planning', stage: 'reviewer', code: 'MODEL_HTTP_502', retryable: true });
    assertJournal(record, ['semantic_intent', 'transfer', 'reviewer', 'reviewer']);
    expect(report.modelCalls.total).toBe(11); expect(report.attemptObservation.confirmedStarts).toBe(15);
    expect(report.records).toHaveLength(12); expect(report.validRun).toBe(false);
  });

  it('ablation reports repeated variants and unscored domain failures without double counting', async () => {
    const dir = await directory(), suite = await isolatedAblationSuite(dir);
    respond = async task => task.role === 'single' ? completion({}) : task.role === 'transfer' ? new Response('', { status: 502 }) : successful(task);
    const report: any = await runAblation(['--mode', 'live', '--selection', 'all', '--repeats', '2'], suite, { resultsDir: dir });
    expect(report.records).toHaveLength(6); expect(report.validComparison).toBe(false); expect(report.validRun).toBe(false);
    expect(report.maxStructureRepairs).toBe(1);
    expect(report.attemptObservation.confirmedStarts).toBe(12);
    for (const record of report.records) {
      expect(record.score).toBeUndefined(); expect(record.passed).toBe(false);
      expect(record.errorCode).toBe(record.variant === 'single' ? 'MODEL_SCHEMA_INVALID' : 'MODEL_HTTP_502');
      assertJournal(record, Array(2).fill(record.variant === 'single' ? 'single' : 'transfer'));
      expect(record.attemptObservation.reservedOutputTokenCeilingSum).toBeLessThanOrEqual(12288);
    }
    for (const stats of Object.values(report.byVariant) as any[]) {
      expect(stats.modelAttempts).toBe(0); expect(stats.unscoredRuns).toBe(2);
    }
    const raw = await saved(dir);
    expect(raw.cases.map(row => row.sequence)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(new Set(raw.attempts.filter(row => row.type === 'attempt_start').map(row => row.attemptId)).size).toBe(12);
  });

  it('ablation includes a late successful sibling in the failed production case', async () => {
    const dir = await directory(), suite = await isolatedAblationSuite(dir, true);
    respond = async task => {
      if (task.role === 'transfer') return new Response('', { status: 502 });
      await sleep(400); return successful(task);
    };
    const report: any = await runAblation(['--mode', 'live', '--selection', 'all', '--topology', 'production'], suite, { resultsDir: dir });
    assertJournal(report.records[0], ['bills', 'transfer', 'transfer']);
    expect(report.records[0].durationMs).toBeGreaterThanOrEqual(390);
    expect(report.attemptObservation.confirmedStarts).toBe(3); expect(report.records[0].score).toBeUndefined();
  });

  it.each(['model', 'g7', 'ablation'])('%s rejects new dependency drift without editing a repository source', async entry => {
    const dir = await directory(); faults.drift = true;
    const report: any = entry === 'model' ? await runEvaluation(['--mode', 'scripted', '--limit', '1'], { resultsDir: dir })
      : entry === 'g7' ? await runG7(['--mode', 'scripted', '--selection', 'pilot'], { resultsDir: dir })
      : await runAblation(['--mode', 'scripted', '--selection', 'all'], await isolatedAblationSuite(dir), { resultsDir: dir });
    expect(report.sourceDrift).toContain('packages/agents/src/stage-recovery.ts'); expect(report.validRun).toBe(false);
    expect(report.sourceHashes['packages/agents/src/planning-failures.ts']).toMatch(/^[a-f0-9]{64}$/);
    expect(report.sourceHashes['packages/agents/src/card-locator.ts']).toMatch(/^[a-f0-9]{64}$/);
    expect(calls).toHaveLength(0);
  });
});
