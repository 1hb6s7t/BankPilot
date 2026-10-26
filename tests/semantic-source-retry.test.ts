import { afterEach, describe, expect, it, vi } from 'vitest';
import { interpretSemanticIntent, type SemanticIntentDraft } from '../packages/agents/src/semantic-intent';
import type { Planner } from '../packages/contracts/src/index';

const base: Parameters<Planner['plan']>[0] = { taskId: 'source-copy', message: '', accounts: [], payees: [
  { id: 'p1', name: '林晓', aliases: [], bank: '合成银行', maskedNumber: '****1234' },
] };
const provider = { baseURL: 'https://source-retry.invalid/v1', model: 'synthetic', outputMode: 'json_object' as const, maxAttempts: 2, retryDelayMs: 0, maxOutputTokens: 4096 };
const envelope = (raw: unknown) => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(raw) } }], usage: { prompt_tokens: 13, completion_tokens: 17 } }));
const transfer = (message: string, amount = '120元', memo?: string): SemanticIntentDraft => ({ tasks: [{ operation: 'transfer', disposition: 'request', scope: { text: message }, entity: { kind: 'payee', id: 'p1', mention: { text: '林晓' } }, amount: { text: amount }, ...(memo ? { memo: { text: memo } } : {}) }] });
const damaged = (raw: SemanticIntentDraft): SemanticIntentDraft => ({ tasks: raw.tasks.map(task => ({ ...task, scope: { text: 'private-model-paraphrase-not-in-input' } })) });
afterEach(() => vi.unstubAllGlobals());

describe('source copy failures share the structured attempt budget', () => {
  it.each([
    ['给林晓转账317.25元，备注会话恢复', '317.25元', '会话恢复', '31725'],
    ['给林晓打点钱，就三百零七块五，备注书展票', '三百零七块五', '书展票', '30750'],
  ])('freshly regenerates a missing scope with exact money and memo: %s', async (message, amount, memo, minor) => {
    const valid = transfer(message!, amount!, memo!);
    const fetch = vi.fn().mockResolvedValueOnce(envelope(damaged(valid))).mockResolvedValueOnce(envelope(valid)); vi.stubGlobal('fetch', fetch);
    const result = await interpretSemanticIntent({ ...base, message: message! }, { provider });
    expect(result.status).toBe('ready'); expect(result.tasks[0]?.slots).toMatchObject({ amountMinor: minor, memo });
    expect(result.modelRuns.map(run => [run.status, run.attempt])).toEqual([['failed', 1], ['success', 2]]);
    const bodies = fetch.mock.calls.map(call => JSON.parse(call[1].body));
    expect(bodies[0].messages[1]).toEqual(bodies[1].messages[1]);
    expect(bodies[0].max_tokens).toBe(bodies[1].max_tokens);
    expect(bodies[0].response_format).toEqual(bodies[1].response_format);
    expect(JSON.stringify(bodies[1])).not.toContain('private-model-paraphrase-not-in-input');
    expect(result.modelRuns[0]?.issues).toEqual([{ code: 'custom', path: ['tasks', '[]', 'scope', 'text'] }]);
  });
  it('regenerates a read-only funds question without adding slots or actions', async () => {
    const message = '帮我查一下扣除房租、生活费和最低余额之后，还能安排多少钱？';
    const valid: SemanticIntentDraft = { tasks: [{ operation: 'funds_query', disposition: 'query', scope: { text: message } }] };
    const fetch = vi.fn().mockResolvedValueOnce(envelope(damaged(valid))).mockResolvedValueOnce(envelope(valid)); vi.stubGlobal('fetch', fetch);
    const result = await interpretSemanticIntent({ ...base, message }, { provider });
    expect(result.status).toBe('ready'); expect(result.tasks[0]).toMatchObject({ operation: 'funds_query', slots: {} }); expect(fetch).toHaveBeenCalledTimes(2);
  });
  it.each([1, 2, 3])('retains safe source diagnostics after exhausting %i total attempts', async maxAttempts => {
    const message = '给林晓120元'; const fetch = vi.fn().mockImplementation(async () => envelope(damaged(transfer(message)))); vi.stubGlobal('fetch', fetch);
    const result = await interpretSemanticIntent({ ...base, message }, { provider: { ...provider, maxAttempts } });
    expect(fetch).toHaveBeenCalledTimes(Math.min(2, maxAttempts));
    expect(result).toMatchObject({ status: 'clarification', tasks: [], recognizedRoles: ['transfer'], findings: ['SEMANTIC_SPAN_NOT_FOUND'], issues: [{ path: ['tasks', '0', 'scope'], category: 'source', code: 'SEMANTIC_SPAN_NOT_FOUND' }] });
    expect(result.modelRuns.every(run => run.status === 'failed')).toBe(true);
  });
  it.each(['不要给林晓120元', '给林晓120元只是个示例', '请翻译给林晓120元', '历史记录：给林晓120元', '给王林晓120元', '给林晓的姐姐120元', '给林晓-120元', '给林晓120元或130元'])('does not retry a missing scope hiding another unsafe field: %s', async message => {
    const fetch = vi.fn().mockImplementation(async () => envelope(damaged(transfer(message)))); vi.stubGlobal('fetch', fetch);
    const result = await interpretSemanticIntent({ ...base, message }, { provider });
    expect(fetch).toHaveBeenCalledTimes(1); expect(result.tasks).toEqual([]); expect(result.status).toBe('clarification');
  });
  it('does not retry cropped existing scopes or missing amount spans', async () => {
    for (const raw of [transfer('林晓120元'), { tasks: [{ ...transfer('给林晓120元').tasks[0]!, scope: { text: 'not in input' }, amount: { text: '130元' } }] }]) {
      const fetch = vi.fn().mockImplementation(async () => envelope(raw)); vi.stubGlobal('fetch', fetch);
      const result = await interpretSemanticIntent({ ...base, message: '给林晓120元' }, { provider });
      expect(fetch).toHaveBeenCalledTimes(1); expect(result.tasks).toEqual([]);
    }
  });
  it('does not reuse stale source diagnostics after a later base-schema failure', async () => {
    const message = '给林晓120元'; const fetch = vi.fn().mockResolvedValueOnce(envelope(damaged(transfer(message)))).mockResolvedValueOnce(envelope({ tasks: [{ operation: 'invented' }] })); vi.stubGlobal('fetch', fetch);
    const result = await interpretSemanticIntent({ ...base, message }, { provider });
    expect(result.findings).toEqual(['MODEL_SCHEMA_INVALID']); expect(result.tasks).toEqual([]); expect(fetch).toHaveBeenCalledTimes(2);
  });
  it.each([
    ['operation', (task: SemanticIntentDraft['tasks'][number]) => ({ ...task, operation: 'funds_query' as const, disposition: 'query' as const, entity: undefined, amount: undefined, memo: undefined })],
    ['disposition', (task: SemanticIntentDraft['tasks'][number]) => ({ ...task, disposition: 'historical' as const })],
    ['entity.id', (task: SemanticIntentDraft['tasks'][number]) => ({ ...task, entity: { ...task.entity!, id: 'another-id' } })],
    ['entity.mention.text', (task: SemanticIntentDraft['tasks'][number]) => ({ ...task, entity: { ...task.entity!, mention: { text: '林' } } })],
    ['amount.text', (task: SemanticIntentDraft['tasks'][number]) => ({ ...task, amount: { text: '20元' } })],
    ['memo', (task: SemanticIntentDraft['tasks'][number]) => ({ ...task, memo: undefined })],
  ] as const)('rejects non-scope %s drift with a distinct issue and no extra repair budget', async (field, change) => {
    const message = '给林晓120元，备注午餐', valid = transfer(message, '120元', '午餐');
    const changed = { tasks: [change(valid.tasks[0]!)] };
    const fetch = vi.fn().mockResolvedValueOnce(envelope(damaged(valid))).mockResolvedValueOnce(envelope(changed)); vi.stubGlobal('fetch', fetch);
    const result = await interpretSemanticIntent({ ...base, message }, { provider: { ...provider, maxAttempts: 3 } });
    expect(result.status).toBe('clarification'); expect(result.tasks).toEqual([]);
    expect(result.findings).toEqual(['SEMANTIC_SOURCE_REPAIR_DRIFT']);
    expect(result.issues?.[0]).toEqual({ path: ['tasks', '0', ...field.split('.')], category: 'safety', code: 'SEMANTIC_SOURCE_REPAIR_DRIFT' });
    expect(result.modelRuns.map(run => run.status)).toEqual(['failed', 'failed']); expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('allows optional offset representation to change while retaining every non-scope text', async () => {
    const message = '给林晓120元', valid = transfer(message);
    const first = damaged(valid); first.tasks[0]!.entity!.mention = { text: '林晓', start: 1, end: 3 }; first.tasks[0]!.amount = { text: '120元', start: 3, end: 7 };
    const fetch = vi.fn().mockResolvedValueOnce(envelope(first)).mockResolvedValueOnce(envelope(valid)); vi.stubGlobal('fetch', fetch);
    const result = await interpretSemanticIntent({ ...base, message }, { provider });
    expect(result.status).toBe('ready'); expect(result.tasks[0]?.slots.amountMinor).toBe('12000'); expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('keeps scripted adapters single-pass and never calls the provider', async () => {
    const message = '给林晓120元', adapter = vi.fn(async () => damaged(transfer(message))), fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const result = await interpretSemanticIntent({ ...base, message }, { provider, adapter });
    expect(adapter).toHaveBeenCalledTimes(1); expect(fetch).not.toHaveBeenCalled(); expect(result.findings).toEqual(['SEMANTIC_SPAN_NOT_FOUND']); expect(result.modelRuns).toEqual([]);
  });
});
