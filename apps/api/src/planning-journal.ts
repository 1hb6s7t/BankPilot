import { withTransaction } from '../../../packages/core/src/database.js';
import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { Actor, ModelRun, PlannerInput, PlanningFailure, PlanningModelAttempt, PlanningModelAttemptEvent, SemanticPlan, PlanningStageJournal, PlanningStageKey } from '../../../packages/contracts/src/index.js';
import { CoreError } from '../../../packages/core/src/index.js';
import { PLANNING_OUTPUT_TOKEN_LIMIT, SEMANTIC_OUTPUT_TOKEN_LIMIT } from '../../../packages/agents/src/budget.js';

export const RECOGNITION_SNAPSHOT_VERSION = 1;
export const SEMANTIC_RULE_VERSION = 'bankpilot-semantic-g9i-v1';
export type RecognitionVersions = { graphVersion: string; schemaVersion: string };
const stable = (value: unknown) => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const hash = (value: unknown) => createHash('sha256').update(stable(value)).digest('hex');
export const recognitionInputDigest = (input: PlannerInput) => { const { deadlineAt: _deadline, ...value } = input; return hash(value); };
export const recognitionSnapshotDigest = (input: PlannerInput, versions: RecognitionVersions) => hash({ input: recognitionInputDigest(input), snapshotVersion: RECOGNITION_SNAPSHOT_VERSION, semanticVersion: SEMANTIC_RULE_VERSION, versions });
export class PlanningServiceFailure extends CoreError {
  constructor(public readonly failure: PlanningFailure) { super(failure.code, failure.message, failure.retryable ? 503 : 409); }
}
export const permanentPlanningSnapshotFailure = (code: string) => /^(?:STAGE_|RECOGNITION_|SEMANTIC_(?:SNAPSHOT_INVALID|PHASE_CONFLICT)$|PLANNER_SNAPSHOT_|LEGACY_PROPOSAL_ACCOUNT_UNRECOVERABLE$)/.test(code);
export const planningFailure = (code: string, modelRuns: ModelRun[] = [], retryable = false, phase: PlanningFailure['phase'] = 'semantic_intent'): PlanningFailure => ({ phase, code, retryable, modelRuns,
  message: permanentPlanningSnapshotFailure(code) ? '原请求保存的规划资料无法安全恢复，不能重试。请联系服务支持；系统不会重新解释或执行此请求。'
    : code === 'MODEL_OUTPUT_BUDGET_EXHAUSTED' ? '本次请求的规划预算已用尽，不能继续重试；尚未执行新的动作。'
    : retryable ? `服务暂时不可用，这次${phase === 'planning' ? '规划' : '识别'}尚未完成。可以重试原请求。`
    : `${phase === 'planning' ? '规划' : '识别'}服务未能完成请求，当前不能重试。请稍后联系服务支持。` });


/** All writes fence the same command lease and never refund an issued reservation. */
export function createPlanningJournal(pool: Pool, actor: Actor, commandId: string, leaseToken: string, versions: RecognitionVersions) {
  let observerError: unknown;
  async function transaction<T>(fn: (tx: PoolClient, row: any) => Promise<T>, signal?: AbortSignal): Promise<T> {
    return withTransaction(pool, async tx => {
      const row = (await tx.query(`SELECT * FROM bp_plan_commands WHERE user_id=$1 AND command_id=$2 AND lease_token=$3 AND status='running' AND result IS NULL AND updated_at>now()-interval '4 minutes' FOR UPDATE`, [actor.userId, commandId, leaseToken])).rows[0];
      if (!row) throw new CoreError('PLAN_SUPERSEDED', '此规划已由新的恢复请求接管');
      const attempts: PlanningModelAttempt[] = row.model_attempts ?? [];
      if (!Array.isArray(attempts) || attempts.some(item => !Number.isSafeInteger(item.requestMaxOutputTokens) || item.requestMaxOutputTokens <= 0 || !['unknown','success','failed'].includes(item.outcome))
        || new Set(attempts.map(item => item.attemptId)).size !== attempts.length
        || attempts.reduce((sum, item) => sum + item.requestMaxOutputTokens, 0) !== Number(row.model_output_reserved ?? 0)) {
        throw new CoreError('MODEL_OUTPUT_BUDGET_INVALID', '调用预留记录不一致，未发出新的请求');
      }
      if (signal?.aborted) throw new CoreError('MODEL_ATTEMPT_PERSIST_CANCELLED', '调用记录写入已取消');
      const result = await fn(tx, row);
      if (signal?.aborted) throw new CoreError('MODEL_ATTEMPT_PERSIST_CANCELLED', '调用记录写入已取消');
      await tx.query('UPDATE bp_plan_commands SET updated_at=now() WHERE user_id=$1 AND command_id=$2 AND lease_token=$3', [actor.userId, commandId, leaseToken]);
      return result;
    });
  }
  const verify = (row: any, expected: { taskId: string; message: string }) => {
    if (row.recognition_input == null && row.recognition_version == null && row.recognition_digest == null && row.recognition_graph_version == null && row.recognition_schema_version == null && row.recognition_semantic_version == null) return undefined;
    if (row.recognition_graph_version !== versions.graphVersion || row.recognition_schema_version !== versions.schemaVersion || row.recognition_semantic_version !== SEMANTIC_RULE_VERSION) {
      throw new CoreError('RECOGNITION_SNAPSHOT_INCOMPATIBLE', '原请求识别规则版本不兼容，未重新解释或复用旧结果');
    }
    const input = row.recognition_input;
    if (row.recognition_version !== RECOGNITION_SNAPSHOT_VERSION || !input || input.taskId !== expected.taskId || input.message !== expected.message || !Array.isArray(input.accounts) || !Array.isArray(input.payees) || typeof input.referenceDate !== 'string' || input.semanticIntent || recognitionSnapshotDigest(input, versions) !== row.recognition_digest) {
      throw new CoreError('RECOGNITION_SNAPSHOT_INVALID', '原请求识别快照不一致，未重新解释请求');
    }
    return { ...input, deadlineAt: Date.now() + 180_000 } as PlannerInput;
  };
  return {
    assertCurrent: () => transaction(async () => undefined),
    checkObserver() { if (observerError) throw observerError; },
    async load(expected: { taskId: string; message: string }) { return transaction(async (_tx, row) => verify(row, expected)); },
    async freeze(input: PlannerInput) {
      return transaction(async (tx, row) => {
        const existing = verify(row, input);
        if (existing) return existing;
        if (row.proposal || row.prepared_input_version != null) throw new CoreError('RECOGNITION_PHASE_CONFLICT', '规划阶段不允许重新识别');
        if (input.semanticIntent) throw new CoreError('RECOGNITION_SNAPSHOT_INVALID', '识别输入不能包含未验证结果');
        await tx.query('UPDATE bp_plan_commands SET recognition_input=$4,recognition_version=$5,recognition_digest=$6,recognition_graph_version=$7,recognition_schema_version=$8,recognition_semantic_version=$9 WHERE user_id=$1 AND command_id=$2 AND lease_token=$3', [actor.userId, commandId, leaseToken, JSON.stringify(input), RECOGNITION_SNAPSHOT_VERSION, recognitionSnapshotDigest(input, versions), versions.graphVersion, versions.schemaVersion, SEMANTIC_RULE_VERSION]);
        return JSON.parse(JSON.stringify(input)) as PlannerInput;
      });
    },
    async semantic(input: PlannerInput): Promise<SemanticPlan | undefined> {
      return transaction(async (_tx, row) => {
        if (!verify(row, input)) throw new CoreError('RECOGNITION_SNAPSHOT_INVALID', '缺少已冻结识别输入');
        if (row.semantic_result == null && row.semantic_digest == null) return undefined;
        const value = row.semantic_result;
        if (!value || value.status === 'failed' || !['ready', 'clarification', 'no_action'].includes(value.status) || !Array.isArray(value.tasks) || hash({ input: row.recognition_digest, versions, semanticVersion: SEMANTIC_RULE_VERSION, semantic: value }) !== row.semantic_digest) throw new CoreError('SEMANTIC_SNAPSHOT_INVALID', '已验证意图快照不一致');
        return value as SemanticPlan;
      });
    },
    async saveSemantic(input: PlannerInput, semantic: SemanticPlan): Promise<SemanticPlan> {
      return transaction(async (tx, row) => {
        if (!verify(row, input)) throw new CoreError('RECOGNITION_SNAPSHOT_INVALID', '缺少已冻结识别输入');
        if (recognitionSnapshotDigest(input, versions) !== row.recognition_digest) throw new CoreError('RECOGNITION_INPUT_DRIFT', '识别期间输入发生变化，未接受模型结果');
        if (row.semantic_result || row.proposal) throw new CoreError('SEMANTIC_PHASE_CONFLICT', '意图阶段已完成，不能重新解释');
        const runs: ModelRun[] = [...(row.semantic_model_runs ?? []), ...semantic.modelRuns];
        await tx.query('UPDATE bp_plan_commands SET semantic_model_runs=$4 WHERE user_id=$1 AND command_id=$2 AND lease_token=$3', [actor.userId, commandId, leaseToken, JSON.stringify(runs)]);
        if (semantic.status === 'failed') {
          const exhausted = Number(row.model_output_reserved) + SEMANTIC_OUTPUT_TOKEN_LIMIT > PLANNING_OUTPUT_TOKEN_LIMIT;
          const failure = exhausted ? planningFailure('MODEL_OUTPUT_BUDGET_EXHAUSTED', runs) : { ...semantic.failure!, modelRuns: runs };
          return { ...semantic, modelRuns: runs, failure };
        }
        const saved = { ...semantic, modelRuns: runs };
        await tx.query('UPDATE bp_plan_commands SET semantic_result=$4,semantic_digest=$5,planning_failure=NULL WHERE user_id=$1 AND command_id=$2 AND lease_token=$3', [actor.userId, commandId, leaseToken, JSON.stringify(saved), hash({ input: row.recognition_digest, versions, semanticVersion: SEMANTIC_RULE_VERSION, semantic: saved })]);
        return saved;
      });
    },
    /** Explicitly settled service failures start a new graph; process crashes retain native resume. */
    async prepareGraphAttempt() {
      return transaction(async (tx, row) => {
        if (!row.graph_restart_required) return { graph_checkpoint_thread_id: row.graph_checkpoint_thread_id, graph_checkpoint_ns: row.graph_checkpoint_ns, graph_checkpoint_id: row.graph_checkpoint_id };
        if (row.proposal || row.result) throw new CoreError('STAGE_RESTART_CONFLICT', '已有提案不允许重新运行规划图');
        const pointer = { threadId: row.graph_checkpoint_thread_id, checkpointNs: row.graph_checkpoint_ns, checkpointId: row.graph_checkpoint_id };
        if ((pointer.threadId != null || pointer.checkpointId != null || pointer.checkpointNs != null) && (typeof pointer.threadId !== 'string' || pointer.checkpointNs !== '' || typeof pointer.checkpointId !== 'string')) throw new CoreError('STAGE_RESTART_POINTER_INVALID', '原规划恢复指针不完整');
        await tx.query(`UPDATE bp_plan_commands SET graph_attempt_history=graph_attempt_history || $4::jsonb,
          graph_checkpoint_thread_id=NULL,graph_checkpoint_ns=NULL,graph_checkpoint_id=NULL,graph_restart_required=false
          WHERE user_id=$1 AND command_id=$2 AND lease_token=$3`, [actor.userId, commandId, leaseToken, JSON.stringify([{ ...pointer, reason: 'settled_planning_failure' }])]);
        return { graph_checkpoint_thread_id: null, graph_checkpoint_ns: null, graph_checkpoint_id: null };
      });
    },
    stages(inputDigest: string): PlanningStageJournal {
      const validKey = (key: string): key is PlanningStageKey => /^(?:domain:(?:transfer|bills|investment|card|subscription|goal)|reviewer|single)$/.test(key);
      const verifyStages = (row: any) => {
        if (row.graph_input_digest !== inputDigest || row.graph_version !== versions.graphVersion || row.graph_schema_version !== versions.schemaVersion
          || !row.prepared_input || recognitionInputDigest(row.prepared_input) !== inputDigest) throw new CoreError('STAGE_INPUT_BINDING_INVALID', '已完成阶段与原请求快照不匹配');
        const values = row.stage_results ?? {}, history = row.stage_history ?? [];
        if (!values || typeof values !== 'object' || Array.isArray(values) || !Array.isArray(history)) throw new CoreError('STAGE_SNAPSHOT_INVALID', '阶段记录不完整');
        const empty = Object.keys(values).length === 0 && history.length === 0;
        if (!(empty && row.stage_state_digest == null) && row.stage_state_digest !== hash({ values, history })) throw new CoreError('STAGE_SNAPSHOT_DIGEST_MISMATCH', '阶段记录集合摘要不一致');
        const verifyRecord = (record: any, key: string) => {
          if (!record || !validKey(key) || record.key !== key || record.version !== 1 || record.inputDigest !== inputDigest || record.graphVersion !== versions.graphVersion || record.schemaVersion !== versions.schemaVersion) throw new CoreError('STAGE_SNAPSHOT_INCOMPATIBLE', '阶段记录版本或归属不一致');
          const { digest, ...body } = record;
          if (digest !== hash(body)) throw new CoreError('STAGE_SNAPSHOT_DIGEST_MISMATCH', '阶段记录摘要不一致');
        };
        for (const [key, record] of Object.entries(values)) {
          verifyRecord(record, key);
          if (typeof (record as any).dependencyDigest !== 'string' || !/^[a-f0-9]{64}$/.test((record as any).dependencyDigest) || !(record as any).value) throw new CoreError('STAGE_SNAPSHOT_INVALID', '阶段输入或结果不完整');
        }
        for (const record of history) {
          if (!record || typeof record !== 'object' || typeof record.eventId !== 'string' || !Array.isArray(record.modelRuns)) throw new CoreError('STAGE_HISTORY_INVALID', '阶段历史不完整');
          verifyRecord(record, record.key);
          if (record.resultDigest && values[record.key]?.digest !== record.resultDigest) throw new CoreError('STAGE_HISTORY_INVALID', '成功阶段记录缺失或被更改');
          if (!record.resultDigest && !record.failure) throw new CoreError('STAGE_HISTORY_INVALID', '阶段历史缺少结果');
        }
        for (const [key, saved] of Object.entries(values)) {
          if (history.filter((item: any) => item.key === key && item.resultDigest === (saved as any).digest).length !== 1) throw new CoreError('STAGE_HISTORY_INVALID', '成功阶段缺少独立保存记录');
        }
        if (new Set(history.map((record: any) => record.eventId)).size !== history.length) throw new CoreError('STAGE_HISTORY_INVALID', '阶段历史重复');
        return { values, history };
      };
      const record = (key: PlanningStageKey, fields: Record<string, unknown>) => {
        const body = { version: 1, key, inputDigest, graphVersion: versions.graphVersion, schemaVersion: versions.schemaVersion, ...fields };
        return { ...body, digest: hash(body) };
      };
      return {
        completed: () => transaction(async (_tx, row) => Object.keys(verifyStages(row).values) as PlanningStageKey[]),
        load: (key, dependencyDigest) => transaction(async (_tx, row) => {
          const saved = verifyStages(row).values[key];
          if (!saved) return undefined;
          if (saved.dependencyDigest !== dependencyDigest) throw new CoreError('STAGE_DEPENDENCY_MISMATCH', '已完成阶段的依赖发生变化');
          return saved.value;
        }),
        save: (key, dependencyDigest, value, eventId) => transaction(async (tx, row) => {
          const { values, history } = verifyStages(row);
          if (!validKey(key) || !/^[a-f0-9]{64}$/.test(dependencyDigest) || !value || typeof value !== 'object') throw new CoreError('STAGE_SNAPSHOT_INVALID', '阶段保存内容不合法');
          const saved = record(key, { dependencyDigest, value });
          if (values[key]) {
            if (values[key].digest !== saved.digest) throw new CoreError('STAGE_RESULT_CONFLICT', '已完成阶段不能被不同结果覆盖');
            return;
          }
          values[key] = saved;
          history.push(record(key, { eventId, resultDigest: saved.digest, modelRuns: (value as any).modelRuns ?? [] }));
          await tx.query('UPDATE bp_plan_commands SET stage_results=$4,stage_history=$5,stage_state_digest=$6 WHERE user_id=$1 AND command_id=$2 AND lease_token=$3', [actor.userId, commandId, leaseToken, JSON.stringify(values), JSON.stringify(history), hash({ values, history })]);
        }),
        recordFailure: (key, failure, eventId) => transaction(async (tx, row) => {
          const { values, history } = verifyStages(row);
          if (!validKey(key)) throw new CoreError('STAGE_SNAPSHOT_INVALID', '未知规划阶段');
          if (history.some((item: any) => item.eventId === eventId)) return;
          history.push(record(key, { eventId, failure, modelRuns: failure.modelRuns }));
          await tx.query('UPDATE bp_plan_commands SET stage_history=$4,stage_state_digest=$5 WHERE user_id=$1 AND command_id=$2 AND lease_token=$3', [actor.userId, commandId, leaseToken, JSON.stringify(history), hash({ values, history })]);
        }),
        history: () => transaction(async (_tx, row) => verifyStages(row).history.flatMap((item: any) => item.modelRuns ?? [])),
      };
    },
    async observation(): Promise<{ reserved: number; attempts: PlanningModelAttempt[] }> {
      return transaction(async (_tx, row) => ({ reserved: Number(row.model_output_reserved ?? 0), attempts: row.model_attempts ?? [] }));
    },
    async observe(event: Readonly<PlanningModelAttemptEvent>, context?: { signal: AbortSignal }) {
      try {
        await transaction(async (tx, row) => {
          const attempts: PlanningModelAttempt[] = row.model_attempts ?? [];
          let reserved = Number(row.model_output_reserved ?? 0);
          const prior = attempts.find(item => item.attemptId === event.attemptId);
          if (event.type === 'attempt_start') {
            const cap = event.requestMaxOutputTokens;
            if (prior || !Number.isSafeInteger(cap) || cap! <= 0 || !Number.isSafeInteger(reserved)) throw new CoreError('MODEL_OUTPUT_BUDGET_INVALID', '模型调用预算不合法');
            if (reserved + cap! > PLANNING_OUTPUT_TOKEN_LIMIT) throw new PlanningServiceFailure(planningFailure('MODEL_OUTPUT_BUDGET_EXHAUSTED', row.semantic_model_runs ?? [], false, event.role === 'semantic_intent' ? 'semantic_intent' : 'planning'));
            reserved += cap!;
            attempts.push({ attemptId: event.attemptId, invocationId: event.invocationId, role: event.role, attempt: event.attempt, requestMaxOutputTokens: cap!, startedAtUtc: event.startedAtUtc, outcome: 'unknown' });
          } else {
            if (!prior || prior.outcome !== 'unknown' || prior.invocationId !== event.invocationId || prior.role !== event.role || prior.attempt !== event.attempt || prior.requestMaxOutputTokens !== event.requestMaxOutputTokens || !event.status) throw new CoreError('MODEL_ATTEMPT_BINDING_INVALID', '模型调用记录不匹配');
            prior.outcome = event.status; prior.endedAtUtc = event.endedAtUtc;
            if (event.errorCode) prior.errorCode = event.errorCode;
            if (event.inputTokens !== undefined) prior.inputTokens = event.inputTokens;
            if (event.outputTokens !== undefined) prior.outputTokens = event.outputTokens;
          }
          await tx.query('UPDATE bp_plan_commands SET model_output_reserved=$4,model_attempts=$5 WHERE user_id=$1 AND command_id=$2 AND lease_token=$3', [actor.userId, commandId, leaseToken, reserved, JSON.stringify(attempts)]);
        }, context?.signal);
      } catch (error) {
        const phase = event.role === 'semantic_intent' ? 'semantic_intent' : 'planning';
        observerError = error instanceof PlanningServiceFailure || error instanceof CoreError && error.code === 'PLAN_SUPERSEDED'
          ? error : new PlanningServiceFailure(planningFailure(error instanceof CoreError ? error.code : 'MODEL_ATTEMPT_PERSIST_FAILED', [], false, phase));
        throw observerError;
      }
    },
  };
}
