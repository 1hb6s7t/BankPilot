import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPlanner } from '../packages/agents/src/index';
import { createPlanRunner, plannerInputDigest, PLANNER_GRAPH_VERSION, PLANNER_STATE_SCHEMA_VERSION } from '../apps/api/src/plan-runner';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { PlannerInput } from '../packages/contracts/src';
import type { ModelAttemptEvent } from '../packages/agents/src/provider';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const actor = { userId: 'observation-owner' }, commandId = 'observation-command', message = '给顾宁转账120元';
const prepared = (): PlannerInput => ({ taskId: `task-${digest(`${actor.userId}:${commandId}`).slice(0, 24)}`, message, referenceDate: '2026-10-23',
  accounts: [{ id: 'account', name: '合成账户', maskedNumber: '****1234', balanceMinor: '100000', reservedMinor: '0', currency: 'CNY' }],
  payees: [{ id: 'payee', name: '顾宁', aliases: [], bank: '合成银行', maskedNumber: '****6789' }],
  semanticIntent: { status: 'ready', tasks: [{ operation: 'transfer', role: 'transfer', source: { text: message }, canonicalMessage: message, slots: { entityId: 'payee', amountMinor: '12000', memo: '' } }], findings: [], modelRuns: [] },
});

/** In-memory SQL boundary double: exercises the actual API runner, no DB or DDL. */
function storage(input: PlannerInput) {
  const row: any = { user_id: actor.userId, command_id: commandId, message_hash: digest(message), status: 'failed', result: null, proposal: null, lease_token: null,
    prepared_input: input, prepared_input_version: 1, graph_version: PLANNER_GRAPH_VERSION, graph_schema_version: PLANNER_STATE_SCHEMA_VERSION,
    graph_input_digest: plannerInputDigest(input), model_attempts: [], model_output_reserved: 0, semantic_model_runs: [], planning_failures: [], planning_failure: null };
  const query = vi.fn(async (sql: string, values: any[] = []) => {
    if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql)) return { rows: [], rowCount: 0 };
    if (sql.startsWith('INSERT INTO bp_plan_commands')) return { rows: [], rowCount: 0 };
    if (sql.startsWith('SELECT * FROM bp_plan_commands')) {
      const owned = values.length < 3 || values[2] === row.lease_token && row.status === 'running' && !row.result;
      return { rows: owned ? [structuredClone(row)] : [], rowCount: owned ? 1 : 0 };
    }
    if (sql.includes("SET status='running'")) { row.status = 'running'; row.lease_token = values[2]; return { rows: [structuredClone(row)], rowCount: 1 }; }
    if (sql.includes('SET stage_results=')) { row.stage_results = JSON.parse(values[3]); row.stage_history = JSON.parse(values[4]); row.stage_state_digest = values[5]; return { rows: [], rowCount: 1 }; }
    if (sql.includes('SET stage_history=')) { row.stage_history = JSON.parse(values[3]); row.stage_state_digest = values[4]; return { rows: [], rowCount: 1 }; }
    if (sql.includes('SET model_output_reserved=')) { row.model_output_reserved = values[3]; row.model_attempts = JSON.parse(values[4]); return { rows: [], rowCount: 1 }; }
    if (sql.includes('SET updated_at=now()')) return { rows: [], rowCount: 1 };
    if (sql.includes("SET status='failed'")) {
      if (values[2] !== row.lease_token || row.result) return { rows: [], rowCount: 0 };
      row.status = 'failed'; row.last_error_code = values[3]; row.planning_failure = JSON.parse(values[4]); row.planning_failures.push(row.planning_failure);
      return { rows: [{ command_id: commandId }], rowCount: 1 };
    }
    throw new Error(`Unexpected SQL in observation runner test: ${sql.slice(0, 60)}`);
  });
  // pg clients also emit connection errors; the shared transaction wrapper owns
  // this EventEmitter lifecycle in addition to awaiting SQL query promises.
  return { row, pool: { query, connect: async () => Object.assign(new EventEmitter(), { query, release() {} }) } };
}
afterEach(() => vi.restoreAllMocks());
describe('G8E API runner preserves downstream observation failures', () => {
  for (const stage of ['transfer', 'reviewer']) for (const phase of ['attempt_start', 'attempt_end'] as const) {
    it(`persists failed planning for ${stage} ${phase}, with no proposal, result, dispatch retry or action`, async () => {
      const input = prepared(), db = storage(input), dispatched: string[] = [], observed: ModelAttemptEvent[] = [];
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
        const task = JSON.parse(JSON.parse(String(init!.body)).messages.find((item: any) => item.role === 'user').content);
        dispatched.push(task.role);
        const value = task.role === 'transfer' ? { role: 'transfer', planVersion: 1, summary: '待确认', suggestion: task.data.resolved.suggestion, findings: [], evidence: [] } : { approved: true, findings: [], summary: '完整' };
        return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value) } }] }));
      });
      const core = { dashboard: async () => ({ accounts: input.accounts, payees: input.payees, actions: [], audit: [], dailyUsedMinor: '0' }), createTransfer: vi.fn() };
      const onFailure = vi.fn(), onComplete = vi.fn();
      const planner = createPlanner({ provider: { baseURL: 'https://model.invalid', model: 'synthetic', outputMode: 'json_object', maxAttempts: 2, retryDelayMs: 0,
        attemptObserver: async event => { observed.push(event); if (event.role === stage && event.type === phase) throw new Error('controlled sink failure'); },
      } });
      const runner = createPlanRunner({ pool: db.pool as never, core: core as never, planner, onFailure, onComplete });
      const code = `MODEL_ATTEMPT_${phase === 'attempt_start' ? 'START' : 'END'}_PERSIST_FAILED`;
      await expect(runner.execute(actor, { commandId, message })).rejects.toMatchObject({ code, requestOutcome: phase === 'attempt_start' ? 'not_sent' : 'success' });
      expect(db.row).toMatchObject({ status: 'failed', proposal: null, result: null, last_error_code: code, planning_failure: { phase: 'planning', code, retryable: false } });
      expect(core.createTransfer).not.toHaveBeenCalled(); expect(onComplete).not.toHaveBeenCalled(); expect(onFailure).toHaveBeenCalledTimes(1);
      expect(dispatched.filter(role => role === stage)).toHaveLength(phase === 'attempt_start' ? 0 : 1);
      expect(observed.filter(event => event.role === stage && event.type === 'attempt_start')).toHaveLength(1);
      const attempt = db.row.model_attempts.find((item: any) => item.role === stage);
      expect(attempt.outcome).toBe(phase === 'attempt_start' ? 'unknown' : 'success');
      const priorDispatches = dispatched.length;
      await expect(runner.execute(actor, { commandId, message })).rejects.toMatchObject({ code });
      expect(dispatched).toHaveLength(priorDispatches); expect(core.createTransfer).not.toHaveBeenCalled();
      expect(db.row.planning_failures).toHaveLength(1);
    });
  }
});
