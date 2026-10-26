import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { EVALUATION_OBSERVATION_VERSION, classifyEvaluationFailure, summarizeEvaluationObservation, summarizeEvaluationCases } from './evaluation-observation';
import { PlanningStageFailure } from '../packages/agents/src/planning-failures';
import { createModelAttemptJournal, type ModelAttemptJournalSummary } from '../packages/agents/src/attempt-journal';
import { MODEL_ATTEMPT_PROTOCOL_VERSION } from '../packages/agents/src/provider';
import { createEvaluationPlanner, evaluationRoles, normalizeBaseURL, providerFromEnv } from '../packages/agents/src/index';
import type { PlanResult } from '../packages/contracts/src/index';
import { holdoutFixtures as g5Fixtures, holdoutVersion as g5Version, type HoldoutFixture } from '../evals/holdout-fixtures';
import { ablationModes, conditionOrder, digest, outputBudget, scoreAblation, type AblationMode } from '../evals/ablation-score';

const sourceFiles = [
  'evals/holdout-fixtures.ts', 'evals/holdout-manifest.json', 'evals/ablation-score.ts', 'scripts/evaluate-ablation.ts', 'scripts/evaluation-observation.ts', 'packages/agents/src/stage-recovery.ts', 'packages/agents/src/planning-failures.ts', 'packages/agents/src/card-locator.ts', 'packages/agents/src/semantic-intent.ts', 'packages/agents/src/budget.ts', 'packages/agents/src/bills.ts', 'packages/agents/src/attempt-journal.ts',
  'packages/agents/src/index.ts', 'packages/agents/src/intent.ts', 'packages/agents/src/management.ts',
  'packages/agents/src/financial.ts', 'packages/agents/src/provider.ts', 'packages/contracts/src/index.ts',
  'packages/contracts/src/management.ts', 'packages/contracts/src/investment.ts', 'packages/contracts/src/goals.ts',
];
type RecordResult = {
  sequence: number; repeat: number; id: string; category: string; variant: AblationMode; startedAt: string;
  inputHash: string; expectedHash: string; plannedRoles: string[]; budget: ReturnType<typeof outputBudget>;
  durationMs: number; passed: boolean; failure?: ReturnType<typeof classifyEvaluationFailure>; failureSource?: 'returned-plan' | 'thrown'; attemptObservation?: ModelAttemptJournalSummary; observation?: ReturnType<typeof summarizeEvaluationObservation>; score?: ReturnType<typeof scoreAblation>; result?: PlanResult; errorCode?: string;
};
const fileHashes = async (files: string[]) => Object.fromEntries(await Promise.all(files.map(async file => [file, createHash('sha256').update(await readFile(file)).digest('hex')])));
export type EvaluationSuite = {
  fixtures: HoldoutFixture[]; version: string; fixtureFile: string; manifestFile: string;
  caseCount: number; liveCaseCount: number; phase: string; extraSourceFiles?: string[];
};
const defaultSuite: EvaluationSuite = {
  fixtures: g5Fixtures, version: g5Version, fixtureFile: 'evals/holdout-fixtures.ts',
  manifestFile: 'evals/holdout-manifest.json', caseCount: 40, liveCaseCount: 12, phase: 'g5',
};
function latency(values: number[]) {
  if (!values.length) return { medianMs: null, p95Ms: null };
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return { medianMs: sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2, p95Ms: sorted[Math.ceil(sorted.length * .95) - 1]! };
}
export function summarizeVariant(records: RecordResult[]) {
  const runs = records.flatMap(record => record.result?.modelRuns ?? []);
  const negative = records.filter(record => record.score && !record.score.modelComplete).length;
  return {
    modelCallsSource: 'returned-plan-model-runs', observedCases: summarizeEvaluationCases(records),
    total: records.length, passed: records.filter(record => record.passed).length,
    semanticMatch: records.filter(record => record.score?.semanticMatch).length,
    modelComplete: records.filter(record => record.score?.modelComplete).length,
    firstAttemptComplete: records.filter(record => record.score?.firstAttemptComplete).length,
    domainAcceptance: records.filter(record => record.score?.domainAcceptance).length,
    planningSafetyChecked: records.filter(record => record.score).length,
    planningSafetyFailures: records.filter(record => record.score && !record.score.planningSafety).length,
    unexpectedActionProposals: records.filter(record => record.score?.unexpectedActionProposal).length,
    unscoredRuns: records.filter(record => !record.score).length,
    modelIncomplete: negative, modelAttempts: runs.length,
    failedAttempts: runs.filter(run => run.status === 'failed').length,
    schemaFailedAttempts: records.reduce((sum, record) => sum + (record.score?.schemaFailedAttempts ?? 0), 0),
    latency: latency(records.map(record => record.durationMs)),
    tokens: {
      inputReportedSum: runs.reduce((sum, run) => sum + (run.inputTokens ?? 0), 0),
      outputReportedSum: runs.reduce((sum, run) => sum + (run.outputTokens ?? 0), 0),
      missingInputUsage: runs.filter(run => run.inputTokens === undefined).length,
      missingOutputUsage: runs.filter(run => run.outputTokens === undefined).length,
      zeroInputUsage: runs.filter(run => run.inputTokens === 0).length,
    },
    errorCodes: Object.fromEntries([...new Set(runs.flatMap(run => run.errorCode ? [run.errorCode] : []))].sort().map(code => [code, runs.filter(run => run.errorCode === code).length])),
  };
}

export async function runAblation(args = process.argv.slice(2), suite: EvaluationSuite = defaultSuite, options: { resultsDir?: string } = {}) {
  const { fixtures: holdoutFixtures, version: holdoutVersion } = suite;
  const option = (flag: string) => { const i = args.indexOf(flag); return i < 0 ? undefined : args[i + 1]; };
  const mode = option('--mode');
  if (mode !== 'scripted' && mode !== 'live') throw new Error('Explicit --mode scripted|live required');
  const selection = option('--selection') ?? (mode === 'live' ? 'pilot' : 'all');
  if (selection !== 'pilot' && selection !== 'all') throw new Error('Invalid selection');
  const topology = option('--topology') ?? 'comparison';
  if (topology !== 'comparison' && topology !== 'production') throw new Error('Invalid topology');
  const variants: readonly AblationMode[] = topology === 'production' ? ['parallel-review'] : ablationModes;
  const repeats = Number(option('--repeats') ?? '1');
  if (!Number.isSafeInteger(repeats) || repeats < 1 || repeats > 3) throw new Error('Repeats must be 1..3');
  const config = mode === 'live' ? providerFromEnv() : undefined;
  if (mode === 'live' && !config) throw new Error('Explicit BANKPILOT model configuration required');
  const startedAt = new Date().toISOString();
  const trackedFiles = [...new Set([...sourceFiles, suite.fixtureFile, suite.manifestFile, ...(suite.extraSourceFiles ?? []), 'package.json', 'pnpm-lock.yaml'])];
  const hashes = await fileHashes(trackedFiles);
  const manifest = JSON.parse(await readFile(suite.manifestFile, 'utf8')) as {
    version: string; frozenAt: string; fixtureSha256: string; caseIds: string[]; liveCaseIds: string[];
  };
  if (manifest.version !== holdoutVersion || manifest.fixtureSha256 !== hashes[suite.fixtureFile] ||
      !Number.isFinite(Date.parse(manifest.frozenAt)) || Date.parse(manifest.frozenAt) > Date.parse(startedAt) ||
      digest(manifest.caseIds) !== digest(holdoutFixtures.map(f => f.id)) ||
      new Set(manifest.caseIds).size !== manifest.caseIds.length || new Set(manifest.liveCaseIds).size !== manifest.liveCaseIds.length ||
      manifest.caseIds.length !== suite.caseCount || manifest.liveCaseIds.length !== suite.liveCaseCount || manifest.liveCaseIds.some(id => !manifest.caseIds.includes(id))) throw new Error('Frozen fixture manifest mismatch');
  const selected = selection === 'all' ? holdoutFixtures : manifest.liveCaseIds.map(id => holdoutFixtures.find(fixture => fixture.id === id)!);
  const directory = resolve(options.resultsDir ?? 'evals/results'); await mkdir(directory, { recursive: true });
  const prefix = `${startedAt.replace(/[:.]/g, '-')}-${suite.phase}-ablation-${mode}-${selection}-${topology}`;
  const jsonPath = resolve(directory, `${prefix}.json`), markdownPath = resolve(directory, `${prefix}.md`), journalPath = resolve(directory, `${prefix}.jsonl`), attemptsPath = resolve(directory, `${prefix}.attempts.jsonl`);
  const provider = config ? { baseURL: normalizeBaseURL(config.baseURL), model: config.model, outputMode: config.outputMode ?? 'tools' } : null;
  const protocol = {
    evaluationObservationVersion: EVALUATION_OBSERVATION_VERSION, attemptObservationProtocolVersion: MODEL_ATTEMPT_PROTOCOL_VERSION, scoringProtocolVersion: 'legacy-ablation-exact-score-unchanged',
    fixtureVersion: holdoutVersion, sourceHashes: hashes, selection, topology, caseIds: selected.map(fixture => fixture.id), repeats,
    conditionSchedule: topology === 'comparison' ? 'Rotating order per case, shifted for each repeat; no concurrent cases. Domain calls within parallel modes run concurrently.' : 'Production parallel-review only, cases serial; domain calls run concurrently.',
    caseDeadlineMs: 120000, providerTimeoutMs: 60000, maxAttempts: 2, maxStructureRepairs: 1 as const, temperature: 0, totalOutputTokenCeilingPerCase: 12288,
    budgetAllocation: 'floor(12288 / (plannedCalls * 2)) max_tokens per request; at most 2 total attempts per invocation, including transient retries and at most 1 structural regeneration (explicit maxStructureRepairs=1, matching existing provider default).',
    computeMatching: 'Same synthetic input, provider/model, deterministic resolvers, validation, auth boundary, output ceiling and wall deadline. Input tokens, actual output and call count are NOT equalized; report observed usage separately.',
    measuredScope: 'Planning proposals only. No database, authorization or execution tools are supplied. Unauthorized writes, actual wrong amounts, double debits and recovery are NOT measured by this matrix; use independent core/API/E2E tests.',
    modelScope: 'All modes consume the same deterministic pre-resolved domain facts and strict action schemas. This tests orchestration/structured-output reliability, not unconstrained intent understanding or autonomous end-to-end banking.',
  };
  const attemptJournal = await createModelAttemptJournal(attemptsPath);
  try {
  await appendFile(journalPath, JSON.stringify({ type: 'start', startedAt, mode, provider, protocol, attemptJournalPath: attemptsPath, attemptJournalId: attemptJournal.journalId }) + '\n');
  const records: RecordResult[] = [];
  let stopped = false, activeController: AbortController | undefined;
  const stop = () => { stopped = true; activeController?.abort(); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    outer: for (let repeat = 0; repeat < repeats; repeat++) for (let i = 0; i < selected.length; i++) {
      const fixture = selected[i]!;
      for (const variant of conditionOrder(i, repeat).filter(variant => variants.includes(variant))) {
        if (stopped) break outer;
        const input = structuredClone(fixture.input), inputHash = digest(input);
        const plannedRoles = evaluationRoles(input);
        const plannedCalls = variant === 'single' ? 1 : Math.max(1, plannedRoles.length + (variant === 'parallel-review' ? 1 : 0));
        const budget = outputBudget(plannedCalls);
        const record: RecordResult = { sequence: records.length + 1, repeat: repeat + 1, id: fixture.id, category: fixture.category, variant, startedAt: new Date().toISOString(), inputHash, expectedHash: digest(fixture.expected), plannedRoles, budget, durationMs: 0, passed: false };
        const start = performance.now();
        const controller = new AbortController(); activeController = controller;
        const deadline = setTimeout(() => controller.abort(), protocol.caseDeadlineMs);
        try {
          const planner = createEvaluationPlanner(variant, { provider: mode === 'scripted' ? false : { ...config!, timeoutMs: protocol.providerTimeoutMs, maxAttempts: budget.maxAttempts, maxStructureRepairs: protocol.maxStructureRepairs, attemptObserver: attemptJournal.observerForCase(record.sequence), maxOutputTokens: budget.maxOutputTokens, temperature: 0, signal: controller.signal } });
          const result = await planner.plan(input);
          const score = scoreAblation(fixture, result, variant, mode === 'live');
          if (controller.signal.aborted) { score.passed = false; score.failures.push('CASE_DEADLINE_EXCEEDED'); record.errorCode = 'CASE_DEADLINE_EXCEEDED'; }
          if (digest(input) !== inputHash) { score.passed = false; score.failures.push('INPUT_MUTATED'); record.errorCode = 'INPUT_MUTATED'; }
          record.result = result; record.score = score; record.passed = score.passed;
          if (result.failure) { record.failure = classifyEvaluationFailure(new PlanningStageFailure(result.failure)); record.failureSource = 'returned-plan'; record.passed = false; }
        } catch (error) {
          record.failure = classifyEvaluationFailure(error, { deadlineExceeded: controller.signal.aborted }); record.failureSource = 'thrown'; record.errorCode = record.failure.code;
        } finally { clearTimeout(deadline); controller.abort(); activeController = undefined; }
        record.durationMs = Math.round(performance.now() - start);
        if (digest(input) !== inputHash) { record.errorCode = 'INPUT_MUTATED'; record.passed = false; }
        await attemptJournal.flush().catch(() => {});
        record.attemptObservation = attemptJournal.summary(record.sequence);
        record.observation = summarizeEvaluationObservation(record.attemptObservation, { mode, caseSequence: record.sequence, maxOutputTokens: protocol.totalOutputTokenCeilingPerCase });
        if (!record.observation.complete || mode === 'live' && record.observation.budget.withinBudget !== true) { record.errorCode ??= record.failure?.code ?? 'EVAL_OBSERVATION_INCOMPLETE'; record.passed = false; }
        records.push(record);
        await appendFile(journalPath, JSON.stringify({ type: 'case', ...record }) + '\n');
        console.log(JSON.stringify({ sequence: record.sequence, id: fixture.id, variant, passed: record.passed, durationMs: record.durationMs, failures: record.score?.failures ?? [record.errorCode] }));
      }
    }
  } finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
  await attemptJournal.close().catch(() => {});
  const attemptObservation = attemptJournal.summary();
  const observedAttempts = summarizeEvaluationObservation(attemptObservation, { mode, maxOutputTokens: protocol.totalOutputTokenCeilingPerCase });
  const observedCases = summarizeEvaluationCases(records);
  const endHashes = await fileHashes(trackedFiles);
  const sourceDrift = trackedFiles.filter(file => hashes[file] !== endHashes[file]);
  const byVariant = Object.fromEntries(variants.map(variant => [variant, summarizeVariant(records.filter(record => record.variant === variant))]));
  const pairedDifferences = records.filter(record => record.variant === 'single').map(record => {
    const matched = records.filter(other => other.id === record.id && other.repeat === record.repeat);
    return { id: record.id, repeat: record.repeat, outcomes: Object.fromEntries(matched.map(other => [other.variant, other.passed])), identicalInput: matched.length === 3 && matched.every(other => other.inputHash === record.inputHash && other.expectedHash === record.expectedHash) };
  });
  const report = {
    startedAt, finishedAt: new Date().toISOString(), mode, provider, ...protocol,
    modelCallsSource: 'returned-plan-model-runs', attemptJournalPath: attemptsPath, attemptObservation, observedAttempts, observedCases,
    complete: records.length === selected.length * variants.length * repeats, stopped, sourceDrift,
    executionComplete: records.every(record => !!record.score && !record.errorCode),
    validRun: sourceDrift.length === 0 && records.length === selected.length * variants.length * repeats && records.every(record => !!record.score && !record.errorCode) && observedCases.complete && observedAttempts.complete && observedAttempts.budget.withinBudget !== false,
    validComparison: topology === 'comparison' && sourceDrift.length === 0 && records.length === selected.length * 3 * repeats && records.every(record => !!record.score && !record.errorCode) && pairedDifferences.every(pair => pair.identicalInput) && observedCases.complete && observedAttempts.complete && observedAttempts.budget.withinBudget !== false,
    endSourceHashes: endHashes, byVariant, pairedDifferences, records,
    interpretation: 'One preselected pilot pass is descriptive evidence, not statistical proof that any architecture is superior. Frozen failures are retained; no post-result label changes or success-only reruns. Once used, this set becomes regression data.',
    executionMetrics: { unauthorizedWrites: null, actualFundsErrors: null, duplicateDebits: null, recoverySuccess: null, reason: protocol.measuredScope },
    usageNote: 'Supplier-reported token usage only; missing and zero are separate. Zero prompt_tokens is not proof of zero input or zero cost. No monetary cost estimate.',
  };
  const markdown = [
    `# BankPilot ${suite.phase.toUpperCase()} 评测：${mode} / ${selection} / ${topology}`, '',
    `开始 ${startedAt}；结束 ${report.finishedAt}；冻结样本 ${selected.length}，每种条件 ${repeats} 次。运行完整有效：${report.validRun}；三种编排比较有效：${report.validComparison}。production 只测正式的并行加独立复核拓扑，不形成架构对照。`, '',
    mode === 'scripted' ? '这是无云端调用的脚本基线，不能作为模型效果。' : `提供方 ${provider?.baseURL}；模型 ${provider?.model}；输出 ${provider?.outputMode}；温度 0。`, '',
    `独立观测协议 ${EVALUATION_OBSERVATION_VERSION}；原评分定义保持。旧调用与usage统计仅来自返回计划，异常中局部ModelRun不拼入全局。attempts日志：${attemptsPath}。start只证明持久化发送意图，不证明远端收到。`, '',
    `已评分 ${observedCases.scoredCases}；未评分 ${observedCases.unscoredCases}；安全未评分 ${observedCases.safetyUnscoredCases}。`, '',
    `独立尝试与预算：${JSON.stringify(observedAttempts)}`, `独立case延迟与失败分母：${JSON.stringify(observedCases)}`, '',
    '| 条件 | 综合通过 | 语义匹配 | 模型最终完成 | 首次无失败 | 有效领域结果 | 不符合标签的动作提案 | 尝试/失败 | 中位延迟ms | P95 ms | 输出token |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
    ...variants.map(variant => { const s = byVariant[variant]!; return `| ${variant} | ${s.passed}/${s.total} | ${s.semanticMatch}/${s.total} | ${s.modelComplete}/${s.total} | ${s.firstAttemptComplete}/${s.total} | ${s.domainAcceptance}/${s.total} | ${s.unexpectedActionProposals} | ${s.modelAttempts}/${s.failedAttempts} | ${s.latency.medianMs ?? '—'} | ${s.latency.p95Ms ?? '—'} | ${s.tokens.outputReportedSum} |`; }), '',
    '模型最终完成只要求每个预定角色最终成功返回一次，不把已恢复的HTTP重试误记成最终失败；首次无失败、失败尝试和结构错误另外统计。结构有效仍可能业务语义不符。脚本模式的模型完成项是“不适用的基线条件通过”，没有真实模型调用。', '',
    '每例120秒截止、每次调用最多2次总尝试（含最多1次结构重生成，显式maxStructureRepairs=1）、12288输出token请求上限，按角色数和重试上限分摊；真实输入token、调用数与消耗不相等，不能据此声称等计算量。comparison 使用相同合成输入、模型、确定性解析/校验与资金规则，并轮换三种条件顺序；production 仅验证正式拓扑。样本间串行。', '',
    '本矩阵仅测提案；没有连接数据库或交易执行工具，所以不能将“无越权写入/无重复扣款”报告为测得的0。相关能力必须引用独立Core/API/浏览器验证。模型接收相同的确定性解析结果，结论限于编排与结构可靠性。', '',
    '| 序号 | 样本 | 条件 | 通过 | 延迟ms | 失败项 |', '|---:|---|---|---|---:|---|',
    ...records.map(record => `| ${record.sequence} | ${record.id} | ${record.variant} | ${record.passed} | ${record.durationMs} | ${(record.score?.failures.join(', ') ?? record.errorCode ?? '').replaceAll('|', '/')} |`), '',
    '每例原始提案、返回计划ModelRun与脱敏schema错误路径见同名JSON；独立attempts JSONL在dispatch前及结束时fsync，包含没有返回计划的失败。SIGKILL可能留下未闭合start，outcome未知，不能假设成功或零usage。case结果逐例落盘到JSONL。fixture和实现的起止哈希都保留。零输入token不表示无输入或免费；没有推算费用。', '',
    '12例一次运行只能提供描述性结果，不能证明某种架构稳定更优。失败不删除、不换标签、不用重复运行择优。使用后的保留集成为回归集，下一次泛化验收应另建新集。',
  ].join('\n');
  await writeFile(jsonPath, JSON.stringify(report, null, 2)); await writeFile(markdownPath, markdown);
  console.log(JSON.stringify({ jsonPath, markdownPath, journalPath, validRun: report.validRun, validComparison: report.validComparison, byVariant }));
  return report;
  } finally { await attemptJournal.close().catch(() => {}); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runAblation().then(report => { if (!report.validRun || report.records.some(record => !record.passed)) process.exitCode = 1; })
    .catch(() => { console.error('Ablation configuration or execution failed; no credentials logged.'); process.exitCode = 1; });
}
