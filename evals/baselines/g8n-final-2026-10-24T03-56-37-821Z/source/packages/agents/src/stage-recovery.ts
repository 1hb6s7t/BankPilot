import { createHash, randomUUID } from 'node:crypto';
import type { ModelRun, PlanningStageJournal, PlanningStageKey } from '../../contracts/src/index';
import { PlanningStageFailure, stageError, stageFailure } from './planning-failures';
export const stageDependencyDigest = (value: unknown) => createHash('sha256').update(JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item)).digest('hex');
/** Wait for every already-started node before the runner closes the command lease. */
export function createStageRecovery(journal?: PlanningStageJournal) {
  const pending = new Set<Promise<unknown>>();
  const failures: unknown[] = [];
  return {
    async completed(): Promise<PlanningStageKey[]> { return journal ? journal.completed() : []; },
    run<T extends { modelRuns?: ModelRun[]; rejected?: string[] }>(key: PlanningStageKey, dependency: unknown, work: () => Promise<T>, validate: (value: unknown) => T): Promise<T> {
      const promise = (async () => {
        const dependencyDigest = stageDependencyDigest(dependency);
        try {
          const saved = await journal?.load(key, dependencyDigest);
          if (saved !== undefined) return validate(saved);
          const result = await work();
          if (result.rejected?.length) throw new PlanningStageFailure({ phase: 'planning', stage: key, findings: result.rejected, code: 'MODEL_CANDIDATE_CONTRACT_INVALID', retryable: false,
            message: '模型提案与已核对的请求不一致，未创建动作。当前不能重试，请联系服务支持。', modelRuns: result.modelRuns ?? [] });
          const checked = validate(result);
          await journal?.save(key, dependencyDigest, checked, randomUUID());
          return checked;
        } catch (error) {
          const failure = stageFailure(error, key);
          try { await journal?.recordFailure(key, failure, randomUUID()); }
          catch (persistence) { failures.push(persistence); throw persistence; }
          const classified = stageError(error, key);
          failures.push(classified); throw classified;
        }
      })();
      pending.add(promise);
      void promise.finally(() => pending.delete(promise)).catch(() => {});
      return promise;
    },
    async settle(error: unknown): Promise<never> {
      while (pending.size) await Promise.allSettled([...pending]);
      // Never hide a permanent fault behind a faster transient sibling failure.
      const terminal = failures.find(item => !stageFailure(item, 'single').retryable);
      throw terminal ?? failures[0] ?? error;
    },
    async history() { return journal?.history(); },
  };
}
