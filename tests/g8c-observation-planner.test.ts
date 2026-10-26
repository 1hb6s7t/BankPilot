import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPlanner } from '../packages/agents/src/index';
import { ModelAttemptPersistenceError, type ModelAttemptEvent, type OpenAICompatibleConfig } from '../packages/agents/src/provider';

afterEach(() => vi.restoreAllMocks());
const input = { taskId: 'observation-propagation', message: '给顾宁转账120元', accounts: [], payees: [{ id: 'payee', name: '顾宁', aliases: [], bank: '合成银行', maskedNumber: '**** 6789' }] };
const provider: OpenAICompatibleConfig = { baseURL: 'http://unused.invalid/v1', model: 'synthetic', outputMode: 'json_object', maxAttempts: 2, retryDelayMs: 0, timeoutMs: 1000 };

describe('production orchestration preserves the attempt journal boundary', () => {
  for (const stage of ['semantic_intent', 'transfer', 'reviewer']) for (const phase of ['attempt_start', 'attempt_end'] as const) {
    it(`keeps ${stage} ${phase} persistence failure distinct and produces no draft`, async () => {
      const dispatched: string[] = [], observed: ModelAttemptEvent[] = [];
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
        const task = JSON.parse(JSON.parse(String(init!.body)).messages.find((message: { role: string }) => message.role === 'user').content);
        dispatched.push(task.role);
        const value = task.role === 'semantic_intent' ? { tasks: [{ operation: 'transfer', disposition: 'request', scope: { source: 'whole_message' }, entity: { kind: 'payee', id: 'payee', mention: { text: '顾宁' } }, amount: { text: '120元' } }] }
          : task.role === 'transfer' ? { role: 'transfer', planVersion: 1, summary: '待确认', suggestion: task.data.resolved.suggestion, findings: [], evidence: [] }
            : { approved: true, findings: [], summary: '结构完整' };
        return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(value) }, finish_reason: 'stop' }] }));
      });
      const pending = createPlanner({ provider: { ...provider, attemptObserver: async event => {
        observed.push(event);
        if (event.role === stage && event.type === phase) throw new Error('storage unavailable');
      } } }).plan(input);
      const code = `MODEL_ATTEMPT_${phase === 'attempt_start' ? 'START' : 'END'}_PERSIST_FAILED`;
      if (stage === 'semantic_intent') {
        const result = await pending;
        expect(result.suggestions).toEqual([]);
        expect(result.clarification).toBeUndefined();
        expect(result.failure).toMatchObject({ phase: 'semantic_intent', code, retryable: false });
        expect(result.findings).toContain(code);
      } else {
        // G8E propagates a downstream persistence fault to the durable runner.
        // Returning a normal PlanResult here would let the runner freeze a failed
        // attempt as a complete proposal, preventing recovery classification.
        let returned: unknown;
        const checked = pending.then(value => { returned = value; });
        await expect(checked).rejects.toBeInstanceOf(ModelAttemptPersistenceError);
        await expect(checked).rejects.toMatchObject({ code, retryable: false, requestOutcome: phase === 'attempt_start' ? 'not_sent' : 'success' });
        expect(returned).toBeUndefined(); // No consumable proposal or draft escapes.
      }
      expect(dispatched.filter(role => role === stage)).toHaveLength(phase === 'attempt_start' ? 0 : 1);
      expect(observed.filter(event => event.role === stage && event.type === 'attempt_start')).toHaveLength(1);
      expect(observed.filter(event => event.role === stage && event.type === 'attempt_end')).toHaveLength(phase === 'attempt_start' ? 0 : 1);
      const failedStage = ['semantic_intent', 'transfer', 'reviewer'].indexOf(stage);
      expect(dispatched.every(role => ['semantic_intent', 'transfer', 'reviewer'].indexOf(role) <= failedStage)).toBe(true);
    });
  }
});
