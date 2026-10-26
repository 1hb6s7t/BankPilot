import { MemorySaver } from '@langchain/langgraph';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEvaluationPlanner, createPlanner, type EvaluationOrchestrationMode, type LocalContext, type PlannerOptions } from '../packages/agents/src/index';
import { createPlanner as frozenG9GPlanner } from '../evals/baselines/g9g-candidate-2026-10-25T05-06-12-781Z/source/packages/agents/src/index';
import type { PlannerInput, PlanningStageJournal, PlanningStageKey } from '../packages/contracts/src/index';
import { billDomainResponse } from './fixtures/bill-domain-response';
import { reviewResponse } from './fixtures/review-response';

const modes: EvaluationOrchestrationMode[] = ['single', 'parallel', 'parallel-review'];
const provider = { baseURL: 'https://g9h-controlled.invalid', model: 'controlled-only', outputMode: 'json_object' as const, maxAttempts: 1 };
function input(coverage: 'complete'|'partial'|'missing' = 'complete'): PlannerInput {
  const message = '查询2026年7月合成琥珀书屋消费多少';
  return { taskId: 'g9h-domain-calibration', message, accounts: [], payees: [],
    billReport: { period: '2026-07', source: 'SYNTHETIC', coverage: { status: coverage }, incomeMinor: '0', expenseMinor: '54321', netMinor: '-54321', previousExpenseMinor: '0', categories: [], findings: [], generatedAt: '2026-08-01T00:00:00Z',
      transactions: [{ id: 'private-g9h-row', accountId: 'private-account', bookedAt: '2026-07-04T00:00:00Z', merchant: '合成琥珀书屋', amountMinor: '54321', direction: 'OUT', category: '购物', source: 'SYNTHETIC_STATEMENT' }] },
    semanticIntent: { status: 'ready', findings: [], modelRuns: [], tasks: [{ role: 'bills', operation: 'bills_query', source: { text: message }, canonicalMessage: '查询账单', slots: { billPeriod: { kind: 'month', startPeriod: '2026-07', endPeriod: '2026-07', source: { text: '2026年7月' } } } }] } };
}
function transport(transform: (context: LocalContext) => unknown = billDomainResponse) {
  const tasks: any[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    const request = JSON.parse(String(init?.body)); const task = JSON.parse(request.messages.find((m:any) => m.role === 'user').content); tasks.push(task);
    const value = task.role === 'single' ? { proposals: task.contexts.map(transform) } : task.role === 'reviewer' ? reviewResponse(task, { approved: true, billQueryAligned: true }) : transform(task);
    return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value) } }], usage: { prompt_tokens: 40, completion_tokens: 30 } }));
  });
  return tasks;
}
function withheld(result: Awaited<ReturnType<ReturnType<typeof createPlanner>['plan']>>) {
  expect(result.billAnswerReview?.status).toBe('withheld');
  expect(result.billAnalysis).toBeUndefined(); expect(result.billReport).toBeUndefined(); expect(result.billReports).toBeUndefined();
  expect(JSON.stringify(result)).not.toMatch(/54321|543\.21|private-g9h-row|合成琥珀书屋/);
  expect(result.suggestions).toEqual([]); expect(result.evidence).toEqual([]);
  expect(result.findings).toContain('BILL_DOMAIN_ASSESSMENT_REJECTED');
}
function memoryJournal() {
  const rows = new Map<PlanningStageKey, { dependency: string; value: unknown }>();
  const journal: PlanningStageJournal = {
    async completed() { return [...rows.keys()]; }, async load(key, dependency) { const row = rows.get(key); if (row && row.dependency !== dependency) throw Object.assign(new Error('STAGE_DEPENDENCY_MISMATCH'), { code: 'STAGE_DEPENDENCY_MISMATCH' }); return row && structuredClone(row.value); },
    async save(key, dependency, value) { rows.set(key, { dependency, value: structuredClone(value) }); }, async recordFailure() {}, async history() { return []; },
  }; return { rows, journal };
}
afterEach(() => vi.restoreAllMocks());

describe('G9H typed bill domain actual planner / transport / recovery integration, no database', () => {
  for (const mode of modes) {
    it(`${mode} exposes server amounts and all citations only after a valid compact assessment`, async () => {
      const tasks = transport(); const result = await createEvaluationPlanner(mode, { provider }).plan(input());
      expect(result.billAnalysis?.amountMinor).toBe('54321'); expect(result.summary).toContain('543.21');
      expect(result.evidence.some(e => e.source === 'bill-transaction:private-g9h-row')).toBe(true);
      expect(result.billAnswerReview).toBeUndefined(); expect(tasks.map(t => t.role)).toEqual(mode === 'single' ? ['single'] : mode === 'parallel' ? ['bills'] : ['bills', 'reviewer']);
    });
    for (const refusal of ['query', 'concern'] as const) it(`${mode} retains domain ${refusal} veto even with approving independent review`, async () => {
      const tasks = transport(c => ({ ...billDomainResponse(c), ...(refusal === 'query' ? { queryAligned: false } : { concerns: ['evidence_mismatch'] }) }));
      const result = await createEvaluationPlanner(mode, { provider }).plan(input()); withheld(result);
      if (mode === 'parallel-review') { expect(tasks.map(t => t.role)).toEqual(['bills', 'reviewer']); expect(result.diagnostics?.review).toMatchObject({ rawApproved: true, effectiveApproved: false }); }
    });
  }
  it.each([
    ['single', 'domain'], ['parallel', 'domain'], ['parallel-review', 'domain'], ['parallel-review', 'reviewer'],
  ] as const)('%s %s refusal strips every model explanation while retaining another domain server facts', async (mode, refusal) => {
    const value = input(); const billScope = value.message; const cardScope = '查询银行卡状态'; value.message += '；' + cardScope;
    value.managementContext = { cards: [{ id: 'card-safe', accountId: 'private-card-account', name: '合成安全卡', maskedNumber: '****6170', status: 'ACTIVE', version: 4, updatedAt: '2026-07-01T00:00:00Z' }] };
    value.semanticIntent!.tasks.push({ role: 'card', operation: 'card_query', source: { text: cardScope }, canonicalMessage: cardScope, slots: {} });
    const copied = '合成琥珀书屋支出543.21元，流水private-g9h-row；opaque-sentinel-α-771';
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const request = JSON.parse(String(init?.body)); const task = JSON.parse(request.messages.find((m:any) => m.role === 'user').content);
      const domain = (c:LocalContext) => c.role === 'bills' ? { ...billDomainResponse(c), queryAligned: refusal !== 'domain' }
        : { role: c.role, planVersion: c.planVersion, ...c.data.management as object, summary: copied, findings: [], evidence: [] };
      const response = task.role === 'single' ? { proposals: task.contexts.map(domain) } : task.role === 'reviewer'
        ? reviewResponse(task, { approved: refusal !== 'reviewer', billQueryAligned: true }) : domain(task);
      return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(response) } }] }));
    });
    const result = await createEvaluationPlanner(mode, { provider }).plan(value);
    expect(result.billAnswerReview?.status).toBe('withheld'); expect(result.billReport).toBeUndefined(); expect(result.billAnalysis).toBeUndefined();
    expect(result.evidence.some(e => e.source.startsWith('model-explanation:'))).toBe(false);
    expect(result.evidence).toContainEqual({ source: 'card:card-safe:v4', detail: '合成安全卡;****6170;status=ACTIVE;version=4;updatedAt=2026-07-01T00:00:00Z' });
    expect(result.summary).toContain('合成安全卡'); expect(result.events.some(e => e.role === 'card' && e.status === 'completed')).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/琥珀书屋|54321|543\.21|private-g9h-row|opaque-sentinel/);
    expect(result.suggestions).toEqual([]); expect(result.managementSuggestions).toEqual([]);
    if (mode === 'parallel-review') expect(result.diagnostics?.review).toMatchObject({ rawApproved: refusal !== 'reviewer', effectiveApproved: false });
    expect(value.semanticIntent!.tasks[0]!.source.text).toBe(billScope);
  });
  it.each(['complete', 'partial', 'missing'] as const)('does not confuse aligned %s status with a domain refusal', async coverage => {
    const result = await createPlanner({ provider: false }).plan(input(coverage));
    expect(result.billAnalysis?.status).toBe(coverage === 'missing' ? 'missing_data' : coverage);
    if (coverage === 'missing') expect(result.billAnalysis?.amountMinor).toBeUndefined(); else expect(result.billAnalysis?.amountMinor).toBe('54321');
    expect(result.findings).not.toContain('BILL_DOMAIN_ASSESSMENT_REJECTED');
  });
  it('rejects legacy prose and fake money through the HTTP boundary, before review or publication', async () => {
    const tasks = transport(c => ({ role: 'bills', planVersion: c.planVersion, summary: '虚构扣款998877.66元', findings: [], evidence: [] }));
    await expect(createPlanner({ provider }).plan(input())).rejects.toMatchObject({ failure: { code: 'MODEL_SCHEMA_INVALID', stage: 'domain:bills', retryable: false } });
    expect(tasks.map(t => t.role)).toEqual(['bills']);
  });
  it.each([true, false])('reuses new completed typed domain approved=%s and reviewer exactly once across a fresh planner', async approved => {
    const saved = memoryJournal(), saver = new MemorySaver();
    const domain = vi.fn(async (c:LocalContext) => ({ ...billDomainResponse(c), queryAligned: approved })), review = vi.fn(async (c:any) => reviewResponse(c));
    const build = () => createPlanner({ provider: false, checkpointer: saver as unknown as PlannerOptions['checkpointer'], domainAdapter: domain, reviewerAdapter: review });
    const first = await build().plan(input(), { stageJournal: saved.journal, checkpointAttempt: { threadId: 'g9h-reuse', checkpointNs: '', resume: false } });
    const second = await build().plan(input(), { stageJournal: saved.journal, checkpointAttempt: { threadId: 'g9h-reuse', checkpointNs: '', resume: true } });
    expect(domain).toHaveBeenCalledTimes(1); expect(review).toHaveBeenCalledTimes(1);
    if (approved) expect(second.billAnalysis).toEqual(first.billAnalysis); else { withheld(first); withheld(second); }
  });
  it('rejects an actual frozen G9G completed graph which never judged the typed domain contract', async () => {
    const saver = new MemorySaver(); await frozenG9GPlanner({ provider: false, checkpointer: saver as any }).plan(input(), { checkpointAttempt: { threadId: 'g9g-old', checkpointNs: '', resume: false } });
    const domain = vi.fn(billDomainResponse), reviewer = vi.fn((c:any) => reviewResponse(c));
    await expect(createPlanner({ provider: false, checkpointer: saver as unknown as PlannerOptions['checkpointer'], domainAdapter: async c => domain(c), reviewerAdapter: async c => reviewer(c) }).plan(input(), { checkpointAttempt: { threadId: 'g9g-old', checkpointNs: '', resume: true } })).rejects.toMatchObject({ failure: { stage: 'domain:bills', code: 'STAGE_DEPENDENCY_MISMATCH', retryable: false } });
    expect(domain).not.toHaveBeenCalled(); expect(reviewer).not.toHaveBeenCalled();
  });
  it('rejects a cached node with matching dependency but missing typed attestation, before another adapter call', async () => {
    const saved = memoryJournal(), domain = vi.fn(async (c:LocalContext) => billDomainResponse(c));
    const planner = () => createPlanner({ provider: false, domainAdapter: domain });
    await planner().plan(input(), { stageJournal: saved.journal });
    const row = saved.rows.get('domain:bills')!; const value:any = structuredClone(row.value); delete value.billDomainAssessment; delete value.billDomainApproved; delete value.billDomainBinding;
    saved.rows.set('domain:bills', { ...row, value });
    await expect(planner().plan(input(), { stageJournal: saved.journal })).rejects.toMatchObject({ failure: { code: 'STAGE_DEPENDENCY_MISMATCH', retryable: false } });
    expect(domain).toHaveBeenCalledTimes(1);
  });
});
