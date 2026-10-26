import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Planner } from '../packages/contracts/src/index';
import { interpretSemanticIntent, validateSemanticIntent, type SemanticIntentDraft } from '../packages/agents/src/semantic-intent';
import type { ModelAttemptEvent, OpenAICompatibleConfig } from '../packages/agents/src/provider';

type Input = Parameters<Planner['plan']>[0];
type Task = SemanticIntentDraft['tasks'][number];
const base: Input = { taskId: 'goal-date-source-repair', message: '', accounts: [],
  payees: [{ id: 'payee-a', name: '陈禾', aliases: [], bank: '合成银行', maskedNumber: '****2468' }],
  investmentContext: { businessDate: '2026-10-24', calendar: 'DEMO_WEEKDAYS_V1', products: [], actions: [], positions: [
    { id: 'position-a', accountId: 'account-a', productId: 'product-a', productName: '雾岚稳健组合 T+1', principalMinor: '400000', availableMinor: '400000', reservedMinor: '0', version: 3, redemptionBusinessDays: 1, calendar: 'DEMO_WEEKDAYS_V1' },
  ] },
};
const provider: OpenAICompatibleConfig = { baseURL: 'https://goal-date-fixture.invalid/v1', model: 'fixture-model', outputMode: 'json_object', maxAttempts: 2, maxOutputTokens: 4096, retryDelayMs: 0 };
const normal = '给陈禾准备640元学费，2028-11-20前到账';
const funded = `${normal}；先从雾岚稳健组合赎回900元`;
function goal(message = normal, literal = false, funding = false): SemanticIntentDraft {
  return { tasks: [{ operation: 'goal_create', disposition: 'request', scope: literal ? { text: message } : { source: 'whole_message' },
    entity: { kind: 'payee', id: 'payee-a', mention: { text: '陈禾' } }, amount: { text: '640元' }, purpose: { text: '学费' }, date: { text: '2028-11-20' },
    ...(funding ? { funding: { entity: { kind: 'position', id: 'position-a', mention: { text: '雾岚稳健组合' } }, amount: { text: '900元' } } } : {}),
  }] };
}
function badDate(draft: SemanticIntentDraft, text?: string): SemanticIntentDraft {
  const result = structuredClone(draft);
  if (text === undefined) delete result.tasks[0]!.date;
  else result.tasks[0]!.date = { text };
  return result;
}
const response = (draft: unknown) => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(draft) } }], usage: { prompt_tokens: 11, completion_tokens: 13 } }));
const run = (message: string, config = provider, input = base) => interpretSemanticIntent({ ...input, message }, { provider: config });
afterEach(() => vi.unstubAllGlobals());

describe.each([false, true])('goal date regeneration with literal scope=%s', literal => {
  it.each([undefined, '2028-11-20前到账', '11-20', 'not-an-original-date'])('regenerates only a missing or invalid date from the unchanged original source: %s', async dateText => {
    const valid = goal(normal, literal), first = badDate(valid, dateText);
    const fetch = vi.fn().mockResolvedValueOnce(response(first)).mockResolvedValueOnce(response(valid)); vi.stubGlobal('fetch', fetch);
    const result = await run(normal);
    expect(result).toMatchObject({ status: 'ready', tasks: [{ operation: 'goal_create', source: { text: normal }, slots: { entityId: 'payee-a', amountMinor: '64000', purpose: '学费', targetDate: '2028-11-20' } }] });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(result.modelRuns.map(r => [r.attempt, r.status, r.errorCode])).toEqual([[1, 'failed', 'MODEL_SCHEMA_INVALID'], [2, 'success', undefined]]);
    expect(result.modelRuns[0]!.issues).toEqual([{ code: 'custom', path: ['tasks', '[]', 'date'] }]);
    const bodies = fetch.mock.calls.map(call => JSON.parse(String(call[1].body)));
    expect(bodies[0].messages[1]).toEqual(bodies[1].messages[1]);
    expect(bodies.map(body => body.max_tokens)).toEqual([4096, 4096]);
    expect(bodies[0].response_format).toEqual(bodies[1].response_format);
    // Regeneration receives the same original input and a safe field path,
    // never a server-filled date, a rewritten draft or raw failed model text.
    expect(bodies[1].messages[0].content).not.toContain('2028-11-20');
    expect(bodies[1].messages[0].content).not.toContain('not-an-original-date');
  });

  it('prevalidates both funding amounts and their source relationship before requesting a date retry', async () => {
    const valid = goal(funded, literal, true);
    const fetch = vi.fn().mockResolvedValueOnce(response(badDate(valid, '2028-11-20前到账'))).mockResolvedValueOnce(response(valid)); vi.stubGlobal('fetch', fetch);
    const result = await run(funded);
    expect(result).toMatchObject({ status: 'ready', tasks: [{ slots: { amountMinor: '64000', purpose: '学费', targetDate: '2028-11-20', funding: { positionId: 'position-a', amountMinor: '90000' } } }] });
    expect(result.tasks).toHaveLength(1); expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each(['2029年3月4日', '2029-3-4'])('uses an explicit source calendar expression without normalizing its date span: %s', async calendar => {
    const message = normal.replace('2028-11-20', calendar), valid = goal(message, literal);
    valid.tasks[0]!.date = { text: calendar };
    const fetch = vi.fn().mockResolvedValueOnce(response(badDate(valid, `${calendar}前到账`))).mockResolvedValueOnce(response(valid)); vi.stubGlobal('fetch', fetch);
    const result = await run(message);
    expect(result.status).toBe('ready'); expect(result.tasks[0]!.slots.targetDate).toBe('2029-03-04');
    expect(result.tasks[0]!.source.text).toBe(message); expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('does not retry an unrelated immediate redemption as if it funded the goal', async () => {
    const message = funded.replace('先从', '另外独立立即从');
    const fetch = vi.fn().mockResolvedValue(response(badDate(goal(message, literal, true)))); vi.stubGlobal('fetch', fetch);
    const result = await run(message);
    expect(result.status).toBe('clarification'); expect(result.tasks).toEqual([]); expect(fetch).toHaveBeenCalledTimes(1);
    expect(result.modelRuns[0]!.status).toBe('success');
  });
});

describe('goal date regeneration shares the existing attempt and structural-repair budget', () => {
  it.each([1, 2, 3])('does not exceed one structural repair or %i total attempts', async maxAttempts => {
    const first = badDate(goal(), '2028-11-20前到账');
    const fetch = vi.fn().mockImplementation(async () => response(first)); vi.stubGlobal('fetch', fetch);
    const events: ModelAttemptEvent[] = [];
    const result = await run(normal, { ...provider, maxAttempts, attemptObserver: async event => { events.push(event); } });
    const count = Math.min(2, maxAttempts);
    expect(fetch).toHaveBeenCalledTimes(count); expect(result.tasks).toEqual([]);
    expect(result).toMatchObject({ status: 'clarification', findings: ['SEMANTIC_TARGET_DATE_INVALID'], issues: [{ path: ['tasks', '0', 'date'], category: 'value' }] });
    expect(result.clarification).toContain('系统未能准确核对您已提供的目标截止日期'); expect(result.clarification).not.toContain('账单');
    expect(result.modelRuns.every(r => r.status === 'failed')).toBe(true);
    expect(result.modelRuns.reduce((sum, r) => sum + (r.requestMaxOutputTokens ?? 0), 0)).toBe(count * 4096);
    expect(events.filter(e => e.type === 'attempt_start')).toHaveLength(count);
    expect(events.filter(e => e.type === 'attempt_end')).toHaveLength(count);
  });

  it('honors a disabled structural repair budget', async () => {
    const fetch = vi.fn().mockResolvedValue(response(badDate(goal()))); vi.stubGlobal('fetch', fetch);
    const result = await run(normal, { ...provider, maxAttempts: 3, maxStructureRepairs: 0 });
    expect(fetch).toHaveBeenCalledTimes(1); expect(result.status).toBe('clarification'); expect(result.tasks).toEqual([]);
  });

  it('cannot allocate another repair after an earlier base-schema repair consumed the shared allowance', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(response({ tasks: 'invalid' })).mockResolvedValueOnce(response(badDate(goal()))); vi.stubGlobal('fetch', fetch);
    const result = await run(normal, { ...provider, maxAttempts: 3 });
    expect(fetch).toHaveBeenCalledTimes(2); expect(result.status).toBe('clarification'); expect(result.tasks).toEqual([]);
    expect(result.modelRuns.map(r => r.errorCode)).toEqual(['MODEL_SCHEMA_INVALID', 'MODEL_SCHEMA_INVALID']);
  });

  it('does not request regeneration when the first goal date is already valid', async () => {
    const fetch = vi.fn().mockResolvedValue(response(goal())); vi.stubGlobal('fetch', fetch);
    const result = await run(normal);
    expect(result.status).toBe('ready'); expect(fetch).toHaveBeenCalledTimes(1); expect(result.modelRuns[0]!.status).toBe('success');
  });

  it('keeps injected adapters single pass and never accepts the eligibility candidate as a fallback', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const adapter = vi.fn(async () => badDate(goal()));
    const result = await interpretSemanticIntent({ ...base, message: normal }, { provider, adapter });
    expect(adapter).toHaveBeenCalledTimes(1); expect(fetch).not.toHaveBeenCalled();
    expect(result.status).toBe('clarification'); expect(result.tasks).toEqual([]); expect(result.modelRuns).toEqual([]);
  });

  it('does not mistake a later base-schema failure for the previous value failure', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(response(badDate(goal()))).mockResolvedValueOnce(response({ tasks: [{ operation: 'invented' }] })); vi.stubGlobal('fetch', fetch);
    const result = await run(normal);
    expect(fetch).toHaveBeenCalledTimes(2); expect(result.status).toBe('failed'); expect(result.findings).toEqual(['MODEL_SCHEMA_INVALID']); expect(result.tasks).toEqual([]);
  });
});

describe('goal date retries bind all original non-date fields', () => {
  it.each([
    ['operation', (task: Task) => { task.operation = 'transfer'; }],
    ['disposition', (task: Task) => { task.disposition = 'ambiguous'; }],
    ['scope.source', (task: Task) => { task.scope = { text: funded }; }],
    ['entity.id', (task: Task) => { task.entity!.id = 'another-payee'; }],
    ['entity.mention.text', (task: Task) => { task.entity!.mention.text = '陈'; }],
    ['amount.text', (task: Task) => { task.amount!.text = '900元'; }],
    ['purpose', (task: Task) => { delete task.purpose; }],
    ['funding', (task: Task) => { delete task.funding; }],
    ['funding.entity.id', (task: Task) => { task.funding!.entity.id = 'another-position'; }],
    ['funding.amount.text', (task: Task) => { task.funding!.amount.text = '640元'; }],
    ['memo', (task: Task) => { task.memo = { text: '学费' }; }],
    ['period', (task: Task) => { task.period = { text: '2028-11' }; }],
    ['entity.mention.start', (task: Task) => { task.entity!.mention.start = funded.indexOf('陈禾'); }],
  ] as const)('rejects %s drift without a second repair allowance', async (field, change) => {
    const valid = goal(funded, false, true), second = structuredClone(valid); change(second.tasks[0]!);
    const fetch = vi.fn().mockResolvedValueOnce(response(badDate(valid))).mockResolvedValueOnce(response(second)); vi.stubGlobal('fetch', fetch);
    const result = await run(funded, { ...provider, maxAttempts: 3 });
    expect(fetch).toHaveBeenCalledTimes(2); expect(result.tasks).toEqual([]);
    expect(result).toMatchObject({ status: 'clarification', findings: ['SEMANTIC_SOURCE_REPAIR_DRIFT'], issues: [{ path: ['tasks', '0', ...field.split('.')], category: 'safety' }] });
  });

  it('rejects a regenerated task count change', async () => {
    const second = goal(); second.tasks.push(structuredClone(second.tasks[0]!));
    const fetch = vi.fn().mockResolvedValueOnce(response(badDate(goal()))).mockResolvedValueOnce(response(second)); vi.stubGlobal('fetch', fetch);
    const result = await run(normal, { ...provider, maxAttempts: 3 });
    expect(result.findings).toEqual(['SEMANTIC_SOURCE_REPAIR_DRIFT']); expect(result.tasks).toEqual([]); expect(fetch).toHaveBeenCalledTimes(2);
  });
});

describe('goal date eligibility does not repair actual ambiguity, missing facts or unsafe source', () => {
  it.each([
    normal.replace('2028-11-20', '1月18日'),
    normal.replace('2028-11-20', '明天'),
    normal.replace('2028-11-20', '2028-02-30'),
    normal.replace('2028-11-20', '2028-11-200'),
    normal.replace('2028-11-20', '2028-11-20或2028-12-20'),
    `${normal}；2月19日也可以`,
    normal.replace('陈禾', '王陈禾'),
    normal.replace('640元', '640元或900元'),
    `不要${normal}`,
    `如果${normal}`,
    `“${normal}”`,
    `历史记录：${normal}`,
    `${normal}；查询余额`,
    `${normal}；然后转账`,
    `${normal}；只有先确认收入时才办理`,
    `${normal}；余额是多少`,
    `${normal}；再建立另一个目标`,
    `${normal}；等奖金到账后再准备`,
    normal.replace('前到账', '这一天可能是生日'),
  ])('uses no regeneration allowance for %s', async message => {
    const first = badDate(goal(message));
    const fetch = vi.fn().mockResolvedValue(response(first)); vi.stubGlobal('fetch', fetch);
    const result = await run(message, { ...provider, maxAttempts: 3 });
    expect(fetch).toHaveBeenCalledTimes(1); expect(result.tasks).toEqual([]); expect(result.status).not.toBe('ready');
  });

  it('does not retry an ambiguous model disposition', async () => {
    const first = badDate(goal()); first.tasks[0]!.disposition = 'ambiguous';
    const fetch = vi.fn().mockResolvedValue(response(first)); vi.stubGlobal('fetch', fetch);
    const result = await run(normal);
    expect(fetch).toHaveBeenCalledTimes(1); expect(result.tasks).toEqual([]); expect(result.status).toBe('clarification');
  });

  it('does not retry duplicate saved beneficiaries', async () => {
    const input = { ...base, payees: [...base.payees, { ...base.payees[0]!, id: 'payee-b' }] };
    const fetch = vi.fn().mockResolvedValue(response(badDate(goal()))); vi.stubGlobal('fetch', fetch);
    const result = await run(normal, provider, input);
    expect(fetch).toHaveBeenCalledTimes(1); expect(result.tasks).toEqual([]); expect(result.findings).toContain('SEMANTIC_ENTITY_NOT_UNIQUE');
  });

  it('does not change a cropped literal source scope or incorrect scope offsets during date regeneration', async () => {
    for (const scope of [{ text: normal.split('，')[0]! }, { text: normal, start: 1, end: normal.length }]) {
      const first = badDate(goal()); first.tasks[0]!.scope = scope;
      const fetch = vi.fn().mockResolvedValue(response(first)); vi.stubGlobal('fetch', fetch);
      const result = await run(normal);
      expect(fetch).toHaveBeenCalledTimes(1); expect(result.tasks).toEqual([]);
    }
  });
});

describe.each([false, true])('missing-year field diagnosis with literal scope=%s', literal => {
  it.each(['1月18日', '1月18日前', '1月18日前攒好'])('asks specifically for the absent year with a pure source deadline span: %s', async dateText => {
    const message = '给陈禾准备640元学费，1月18日前攒好';
    const draft = badDate(goal(message, literal), dateText);
    const fetch = vi.fn().mockResolvedValue(response(draft)); vi.stubGlobal('fetch', fetch);
    const result = await run(message);
    expect(result).toMatchObject({ status: 'clarification', tasks: [], findings: ['SEMANTIC_TARGET_DATE_YEAR_REQUIRED'], issues: [{ path: ['tasks', '0', 'date'], category: 'value' }] });
    expect(result.clarification).toContain('年份'); expect(result.clarification).not.toContain('账单'); expect(result.clarification).not.toContain('收款人');
    expect(fetch).toHaveBeenCalledTimes(1); expect(result.modelRuns[0]!.status).toBe('success');
  });

  it('allows only pure source deadline prefixes when refining the year question', () => {
    const message = '给陈禾准备640元学费，截止日期为1月18日前攒好';
    const result = validateSemanticIntent({ ...base, message }, badDate(goal(message, literal), '截止日期为1月18日前攒好'));
    expect(result.findings).toContain('SEMANTIC_TARGET_DATE_YEAR_REQUIRED'); expect(result.tasks).toEqual([]);
  });

  it.each([
    ['给陈禾准备640元学费，1月18日前攒好200元', '1月18日前攒好200元'],
    ['给陈禾准备640元学费，1月18日前攒好并挂失', '1月18日前攒好并挂失'],
    ['给陈禾准备640元学费，1月18日或2月19日前攒好', '1月18日或2月19日前攒好'],
    ['给陈禾准备640元学费，1月18日前攒好', '学费'],
  ])('does not hide another value, command, choice or unrelated model date: %s', async (message, dateText) => {
    const draft = badDate(goal(message, literal), dateText); delete draft.tasks[0]!.purpose;
    const fetch = vi.fn().mockResolvedValue(response(draft)); vi.stubGlobal('fetch', fetch);
    const result = await run(message);
    expect(result.status).not.toBe('ready'); expect(result.tasks).toEqual([]); expect(result.findings).not.toContain('SEMANTIC_TARGET_DATE_YEAR_REQUIRED');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
