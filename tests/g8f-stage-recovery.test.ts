import { billDomainResponse } from './fixtures/bill-domain-response';
import { MemorySaver } from '@langchain/langgraph';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPlanner, type LocalContext, type PlannerOptions } from '../packages/agents/src/index';
import { ModelProviderError } from '../packages/agents/src/provider';
import { PlanningStageFailure } from '../packages/agents/src/planning-failures';
import { createStageRecovery } from '../packages/agents/src/stage-recovery';
import type { ModelRun, PlanningStageJournal, PlanningStageKey } from '../packages/contracts/src/index';
import { reviewResponse } from './fixtures/review-response';

function memoryJournal() {
  const values = new Map<PlanningStageKey, { dependency: string; value: any }>();
  const history: ModelRun[] = [];
  const journal: PlanningStageJournal = {
    async completed() { return [...values.keys()]; },
    async load(key, dependency) {
      const saved = values.get(key);
      if (saved && saved.dependency !== dependency) throw Object.assign(new Error('STAGE_DEPENDENCY_MISMATCH'), { code: 'STAGE_DEPENDENCY_MISMATCH' });
      return saved && structuredClone(saved.value);
    },
    async save(key, dependency, value: any) { values.set(key, { dependency, value: structuredClone(value) }); history.push(...(value.modelRuns ?? [])); },
    async recordFailure(_key, failure) { history.push(...failure.modelRuns); },
    async history() { return [...history]; },
  };
  return { journal, values, history };
}
const input = { taskId: 'g8f-stages', message: '给林晓转100元', accounts: [], payees: [{ id: 'p', name: '林晓', aliases: [], bank: '合成银行', maskedNumber: '****1234' }] };
const proposal = (context: LocalContext) => context.role === 'bills' ? billDomainResponse(context) : ({ role: context.role, planVersion: context.planVersion, summary: '完成核对', findings: [], evidence: [], ...(context.role === 'transfer' ? { suggestion: (context.data.resolved as any).suggestion } : {}) });
const approved = { approved: true, findings: [], summary: '待本人确认' };
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
afterEach(() => vi.restoreAllMocks());

describe('G8F durable stage recovery without a checkpoint saver', () => {
  it('waits for a slower successful sibling before rejecting and reuses it on retry', async () => {
    const saved = memoryJournal(), entered = deferred(), release = deferred();
    const calls: string[] = []; let failed = true, settled = false;
    const planner = createPlanner({ provider: false, semantic: false, domainAdapter: async context => {
      calls.push(context.role);
      if (context.role === 'transfer' && failed) throw new ModelProviderError('MODEL_HTTP_502', true);
      if (context.role === 'bills') { entered.resolve(); await release.promise; }
      return proposal(context);
    }, reviewerAdapter: async context => reviewResponse(context, { summary: approved.summary }) });
    const combined = { ...input, message: '查询账单，给林晓转100元' };
    const pending = planner.plan(combined, { stageJournal: saved.journal });
    const caught = pending.catch(error => { settled = true; return error; });
    await entered.promise; await new Promise(r => setTimeout(r, 15));
    expect(settled).toBe(false); release.resolve();
    expect(await caught).toMatchObject({ failure: { code: 'MODEL_HTTP_502', retryable: true } });
    expect(saved.values.has('domain:bills')).toBe(true);
    expect(saved.values.has('domain:transfer')).toBe(false);
    failed = false; await planner.plan(combined, { stageJournal: saved.journal });
    expect(calls.filter(x => x === 'bills')).toHaveLength(1);
    expect(calls.filter(x => x === 'transfer')).toHaveLength(2);
  });

  it('rebuilds the planner and retries only independent review', async () => {
    const saved = memoryJournal(); let domains = 0, reviews = 0;
    const options: PlannerOptions = { provider: false, semantic: false, domainAdapter: async context => { domains++; return proposal(context); }, reviewerAdapter: async () => { reviews++; if (reviews === 1) throw new ModelProviderError('MODEL_HTTP_503', true); return approved; } };
    await expect(createPlanner(options).plan(input, { stageJournal: saved.journal })).rejects.toMatchObject({ failure: { stage: 'reviewer', retryable: true } });
    const result = await createPlanner(options).plan(input, { stageJournal: saved.journal });
    expect(result.suggestions).toHaveLength(1); expect(domains).toBe(1); expect(reviews).toBe(2);
  });

  for (const code of ['MODEL_HTTP_401', 'MODEL_SCHEMA_INVALID', 'MODEL_OUTPUT_JSON_INVALID', 'MODEL_OUTPUT_EMPTY', 'MODEL_RESPONSE_JSON_INVALID']) {
    it(`does not turn ${code} into a business rejection or retryable service error`, async () => {
      const saved = memoryJournal();
      const planner = createPlanner({ provider: false, semantic: false, domainAdapter: async () => { throw new ModelProviderError(code, true); } });
      await expect(planner.plan(input, { stageJournal: saved.journal })).rejects.toMatchObject({ failure: { phase: 'planning', code, retryable: false } });
      expect(saved.values.size).toBe(0);
    });
  }
  it('keeps a genuine reviewer refusal as a reusable completed result', async () => {
    const saved = memoryJournal(); let reviews = 0;
    const planner = createPlanner({ provider: false, semantic: false, reviewerAdapter: async () => { reviews++; return { ...approved, approved: false, findings: ['业务证据不足'] }; } });
    const first = await planner.plan(input, { stageJournal: saved.journal });
    const second = await planner.plan(input, { stageJournal: saved.journal });
    expect(first.failure).toBeUndefined(); expect(first.suggestions).toEqual([]); expect(second.findings).toContain('业务证据不足'); expect(reviews).toBe(1);
  });
  it('makes a contract mismatch permanent and never caches the invalid candidate', async () => {
    const saved = memoryJournal();
    const planner = createPlanner({ provider: false, semantic: false, domainAdapter: async context => ({ ...proposal(context), planVersion: 9 }) });
    await expect(planner.plan(input, { stageJournal: saved.journal })).rejects.toMatchObject({ failure: { code: 'MODEL_CANDIDATE_CONTRACT_INVALID', retryable: false } });
    expect(saved.values.size).toBe(0);
  });
  it('rejects changed stage dependencies before any new adapter call', async () => {
    const saved = memoryJournal(); let calls = 0;
    const planner = createPlanner({ provider: false, semantic: false, domainAdapter: async context => { calls++; return proposal(context); } });
    await planner.plan(input, { stageJournal: saved.journal });
    await expect(planner.plan({ ...input, message: '给林晓转200元' }, { stageJournal: saved.journal })).rejects.toMatchObject({ failure: { code: 'STAGE_DEPENDENCY_MISMATCH', retryable: false } });
    expect(calls).toBe(1);
  });
  it('does not hide a later permanent sibling fault behind a transient failure', async () => {
    const recovery = createStageRecovery(); const release = deferred();
    const a = recovery.run('domain:transfer', {}, async () => { throw new ModelProviderError('MODEL_HTTP_502', true); }, x => x as any);
    const b = recovery.run('domain:bills', {}, async () => { await release.promise; throw new ModelProviderError('MODEL_SCHEMA_INVALID'); }, x => x as any);
    const completion = a.catch(error => recovery.settle(error)); void b.catch(() => {}); release.resolve();
    await expect(completion).rejects.toMatchObject({ failure: { code: 'MODEL_SCHEMA_INVALID', retryable: false } });
  });
});

describe('G8F graph failure and checkpoint recovery', () => {
  for (const nativeResume of [false, true]) it(`retries failed review without repeating domains with ${nativeResume ? 'native crash resume' : 'a fresh explicit-retry graph attempt'}`, async () => {
    const saved = memoryJournal(); const saver = new MemorySaver(); let domains = 0, reviews = 0;
    const options: PlannerOptions = { provider: false, semantic: false, checkpointer: saver as unknown as PlannerOptions['checkpointer'], domainAdapter: async context => { domains++; return proposal(context); }, reviewerAdapter: async () => { reviews++; if (reviews === 1) throw new ModelProviderError('MODEL_HTTP_502', true); return approved; } };
    await expect(createPlanner(options).plan(input, { stageJournal: saved.journal, checkpointAttempt: { threadId: 'first', checkpointNs: '', resume: false } })).rejects.toBeInstanceOf(PlanningStageFailure);
    const result = await createPlanner(options).plan(input, { stageJournal: saved.journal, checkpointAttempt: { threadId: nativeResume ? 'first' : 'retry', checkpointNs: '', resume: nativeResume } });
    expect(result.suggestions).toHaveLength(1); expect(domains).toBe(1); expect(reviews).toBe(2);
  });
});

describe('G8F provider history and cumulative planning budget', () => {
  it('retains failed and successful HTTP run records while reserving only unfinished stages', async () => {
    const saved = memoryJournal(); let broken = true, reserved = 4096;
    const dispatched: { role: string; cap: number }[] = [];
    const observed: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body)), task = JSON.parse(body.messages.find((m: any) => m.role === 'user').content);
      dispatched.push({ role: task.role, cap: body.max_tokens });
      if (broken && task.role === 'reviewer') return new Response('', { status: 502 });
      const value = task.role === 'reviewer' ? approved : proposal(task);
      return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value) } }] }));
    });
    const prepared = { ...input, semanticIntent: { status: 'ready' as const, tasks: [{ operation: 'transfer', role: 'transfer' as const, source: { text: input.message }, canonicalMessage: input.message, slots: { entityId: 'p', amountMinor: '10000', memo: '' } }], findings: [], modelRuns: [{ role: 'semantic_intent', model: 'stub', status: 'success' as const, durationMs: 1 }] } };
    const options: PlannerOptions = { provider: { baseURL: 'https://model.invalid', model: 'g8f-stub', outputMode: 'json_object', maxAttempts: 2, retryDelayMs: 0 } };
    const context = () => ({ stageJournal: saved.journal, priorReservedOutputTokens: reserved, modelAttemptObserver: async (event: any) => { if (event.type === 'attempt_start') { reserved += event.requestMaxOutputTokens; expect(reserved).toBeLessThanOrEqual(32768); observed.push(event.role); } } });
    await expect(createPlanner(options).plan(prepared, context())).rejects.toMatchObject({ failure: { stage: 'reviewer', code: 'MODEL_HTTP_502' } });
    expect(dispatched.map(x => x.role)).toEqual(['transfer','reviewer','reviewer']);
    broken = false;
    const result = await createPlanner(options).plan(prepared, context());
    expect(dispatched.map(x => x.role)).toEqual(['transfer','reviewer','reviewer','reviewer']);
    expect(result.modelRuns?.map(x => `${x.role}:${x.status}`)).toEqual(['semantic_intent:success','transfer:success','reviewer:failed','reviewer:failed','reviewer:success']);
    expect(observed).toHaveLength(4); expect(reserved).toBeLessThanOrEqual(32768);
    // Once every stage is durably complete, even zero remaining budget permits
    // rebuilding the final result without another reservation or model call.
    const replay = await createPlanner(options).plan(prepared, { ...context(), priorReservedOutputTokens: 32768 });
    expect(replay.suggestions).toEqual(result.suggestions); expect(dispatched).toHaveLength(4);
  });
  it('refuses exhausted cumulative budget before an unfinished stage can dispatch', async () => {
    const saved = memoryJournal(), fetch = vi.spyOn(globalThis, 'fetch');
    const prepared = { ...input, semanticIntent: { status: 'ready' as const, tasks: [{ operation: 'transfer', role: 'transfer' as const, source: { text: input.message }, canonicalMessage: input.message, slots: { entityId: 'p', amountMinor: '10000', memo: '' } }], findings: [], modelRuns: [] } };
    await expect(createPlanner({ provider: { baseURL: 'https://model.invalid', model: 'stub' } }).plan(prepared, { stageJournal: saved.journal, priorReservedOutputTokens: 32768 })).rejects.toMatchObject({ code: 'MODEL_OUTPUT_BUDGET_EXHAUSTED' });
    expect(fetch).not.toHaveBeenCalled();
  });
});
