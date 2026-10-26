import { billDomainResponse } from './fixtures/bill-domain-response';
import { expectPlanningFailure } from './g8f-failure-assertions';
// Legacy domain/reviewer protocol mocks opt out of the separately tested semantic interpretation stage.
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { activeRoles, createPlanner, invokeStructured, normalizeBaseURL, proposalSchema, resolveTransfer, reviewSchema, type LocalContext, type ReviewContext } from '../packages/agents/src/index';
import { evaluationBillReport, evaluationFixtures, evaluationFunds, evaluationPayees } from '../evals/fixtures';
import { scorePlan } from '../scripts/evaluate-model';
import type { ModelRun } from '../packages/contracts/src/index';
import { reviewResponse } from './fixtures/review-response';

const schema = z.object({ answer: z.string() }).strict();
const config = { baseURL: 'https://provider-protocol-fixture.invalid', model: 'explicit-fixture-model', apiKey: 'DO_NOT_LEAK_FIXTURE_KEY', maxAttempts: 2, retryDelayMs: 1 };
const completion = (answer: unknown, name = 'submit_fixture', usage = { prompt_tokens: 0, completion_tokens: 9 }) => new Response(JSON.stringify({ usage, choices: [{ message: { tool_calls: [{ function: { name, arguments: JSON.stringify(answer) } }] } }] }), { status: 200 });
const domainProposal = (context: LocalContext) => context.role === 'bills' ? billDomainResponse(context) : ({ role: context.role, planVersion: context.planVersion, summary: '模型解释不拥有确定性资金决策', findings: [], evidence: [], ...(context.role === 'transfer' ? { suggestion: (context.data.resolved as { suggestion?: unknown }).suggestion } : {}) });

describe('phase 2 model transport and explicit failure evidence', () => {
  it.each(['tools', 'json_object'] as const)('sends a context-specific required suggestion schema for a resolved transfer in %s mode', async outputMode => {
    let outbound: { required: string[]; properties: Record<string, { const?: unknown; required?: string[]; properties?: Record<string, { const?: unknown }> }> } | undefined;
    const mock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      const task = JSON.parse(body.messages[1].content);
      const json = outputMode === 'tools' ? body.tools[0].function.parameters : JSON.parse(body.messages[0].content.split('Required JSON schema: ')[1]);
      const answer = task.role === 'reviewer' ? { approved: true, findings: [], summary: 'proposal-completeness only' } : domainProposal(task);
      if (task.role === 'transfer') outbound = json;
      return outputMode === 'tools' ? completion(answer, task.role === 'reviewer' ? 'submit_review' : 'submit_domain_proposal') : new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(answer) } }] }), { status: 200 });
    });
    try {
      const result = await createPlanner({ semantic: false, provider: { ...config, outputMode } }).plan(evaluationFixtures[1]!.input);
      expect(outbound?.required).toContain('suggestion');
      expect(outbound?.properties.role?.const).toBe('transfer'); expect(outbound?.properties.planVersion?.const).toBe(1);
      expect(outbound?.properties.suggestion?.required).toEqual(expect.arrayContaining(['payeeId', 'amountMinor', 'memo']));
      expect(outbound?.properties.suggestion?.properties?.amountMinor?.const).toBe('123456');
      expect(result.suggestions[0]?.amountMinor).toBe('123456');
    } finally { mock.mockRestore(); }
  });

  it('requires clarification and forbids invented suggestion in JSON schema for deterministic ambiguity', async () => {
    let outbound: { required: string[]; properties: Record<string, unknown>; additionalProperties: boolean } | undefined;
    const mock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body)); const task = JSON.parse(body.messages[1].content);
      if (task.role === 'transfer') outbound = JSON.parse(body.messages[0].content.split('Required JSON schema: ')[1]);
      const answer = task.role === 'reviewer' ? { approved: false, findings: [], summary: 'ambiguous proposal' } : { role: task.role, planVersion: task.planVersion, summary: 'requires clarification', clarification: task.data.resolved.clarification, evidence: [], findings: [] };
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(answer) } }] }), { status: 200 });
    });
    try {
      const result = await createPlanner({ semantic: false, provider: { ...config, outputMode: 'json_object' } }).plan(evaluationFixtures[6]!.input);
      expect(outbound?.required).toContain('clarification'); expect(outbound?.properties).not.toHaveProperty('suggestion'); expect(outbound?.additionalProperties).toBe(false);
      expect(result.suggestions).toEqual([]); expect(result.clarification).toContain('唯一金额');
    } finally { mock.mockRestore(); }
  });

  it('rejects a summary-only live transfer at provider schema validation while retaining generic adapter compatibility', async () => {
    const onlySummary = { role: 'transfer', planVersion: 1, summary: 'Transfer 123456 minor units to payee-lin', evidence: [], findings: [] };
    expect(proposalSchema.safeParse(onlySummary).success).toBe(true);
    const mock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body)); const task = JSON.parse(body.messages[1].content);
      const answer = task.role === 'reviewer' ? { approved: false, findings: [], summary: 'missing structured proposal' } : onlySummary;
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(answer) } }] }), { status: 200 });
    });
    try {
      const failure = await expectPlanningFailure(createPlanner({ semantic: false, provider: { ...config, outputMode: 'json_object' } }).plan(evaluationFixtures[1]!.input), 'MODEL_SCHEMA_INVALID', 'domain:transfer');
      expect(failure.modelRuns.find(run => run.role === 'transfer')).toMatchObject({ status: 'failed', errorCode: 'MODEL_SCHEMA_INVALID' });
      expect(mock.mock.calls.every(call => JSON.parse(JSON.parse(String(call[1]?.body)).messages[1].content).role !== 'reviewer')).toBe(true);
    } finally { mock.mockRestore(); }
  });

  it.each([
    ['https://ai.anna.tf', 'https://ai.anna.tf/v1'], ['https://ai.anna.tf/', 'https://ai.anna.tf/v1'],
    ['https://ai.anna.tf/v1', 'https://ai.anna.tf/v1'], ['https://ai.anna.tf/v1/', 'https://ai.anna.tf/v1'],
    ['http://127.0.0.1:1234/v1', 'http://127.0.0.1:1234/v1'],
  ])('normalizes %s without duplicating /v1', (given, expected) => expect(normalizeBaseURL(given)).toBe(expected));

  it('retries only transient failure, bounds attempts, and records original provider usage without cost inference', async () => {
    const runs: ModelRun[] = [];
    const mock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('', { status: 503 })).mockResolvedValueOnce(completion({ answer: 'ok' }));
    try {
      expect(await invokeStructured(config, { role: 'bills' }, schema, 'submit_fixture', run => runs.push(run))).toEqual({ answer: 'ok' });
      expect(mock).toHaveBeenCalledTimes(2);
      expect(runs.map(run => [run.status, run.errorCode])).toEqual([['failed', 'MODEL_HTTP_503'], ['success', undefined]]);
      expect(runs[1]).toMatchObject({ role: 'bills', model: config.model, inputTokens: 0, outputTokens: 9 });
      expect(runs.every(run => run.durationMs >= 0)).toBe(true); expect(JSON.stringify(runs)).not.toContain(config.apiKey);
    } finally { mock.mockRestore(); }
  });

  it('does not retry permanent authentication or opted-out structure failures, nor silently accept content-only JSON in tools mode', async () => {
    for (const response of [new Response('', { status: 401 }), completion({ answer: 3 }), new Response(JSON.stringify({ choices: [{ message: { content: '{"answer":"should-not-fallback"}' } }] }), { status: 200 })]) {
      const runs: ModelRun[] = [];
      const mock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response);
      try {
        await expect(invokeStructured({ ...config, maxStructureRepairs: 0 }, { role: 'transfer' }, schema, 'submit_fixture', run => runs.push(run))).rejects.toThrow(/MODEL_HTTP_401|MODEL_SCHEMA_INVALID|MODEL_TOOL_OUTPUT_INVALID/);
        expect(mock).toHaveBeenCalledTimes(1); expect(runs[0]?.status).toBe('failed');
      } finally { mock.mockRestore(); }
    }
  });

  it('supports json_object only through an explicit configured branch with the same schema validation', async () => {
    const mock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: '{"answer":"explicit-json-mode"}' } }] }), { status: 200 }));
    try {
      expect(await invokeStructured({ ...config, outputMode: 'json_object' }, {}, schema, 'unused')).toEqual({ answer: 'explicit-json-mode' });
      const request = JSON.parse(String(mock.mock.calls[0]?.[1]?.body));
      expect(request.response_format).toEqual({ type: 'json_object' }); expect(request.tools).toBeUndefined();
    } finally { mock.mockRestore(); }
  });

  it('aborts on the case deadline, preserves a terminal error code and does not spend retry budget after cancellation', async () => {
    const controller = new AbortController(), runs: ModelRun[] = [];
    const mock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      return new Promise<Response>((_resolve, reject) => { init?.signal?.addEventListener('abort', () => reject(new DOMException('fixture deadline', 'AbortError')), { once: true }); });
    });
    try {
      const operation = invokeStructured({ ...config, signal: controller.signal }, { role: 'goal' }, schema, 'submit_fixture', run => runs.push(run));
      controller.abort();
      await expect(operation).rejects.toThrow('MODEL_DEADLINE_EXCEEDED');
      expect(mock).toHaveBeenCalledTimes(1); expect(runs[0]?.errorCode).toBe('MODEL_DEADLINE_EXCEEDED');
    } finally { mock.mockRestore(); }
  });

  it('exhausts finite timeout attempts and records every attempt', async () => {
    const runs: ModelRun[] = [];
    const mock = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new DOMException('synthetic timeout', 'TimeoutError'));
    try {
      await expect(invokeStructured(config, { role: 'reviewer' }, schema, 'submit_fixture', run => runs.push(run))).rejects.toThrow('MODEL_TIMEOUT');
      expect(mock).toHaveBeenCalledTimes(2); expect(runs.map(r => r.errorCode)).toEqual(['MODEL_TIMEOUT', 'MODEL_TIMEOUT']);
    } finally { mock.mockRestore(); }
  });

  it('retains provider failure metadata and stops before review without scripted success', async () => {
    const mock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 401 }));
    try {
      const failure = await expectPlanningFailure(createPlanner({ semantic: false, provider: config }).plan(evaluationFixtures[0]!.input), 'MODEL_HTTP_401');
      expect(failure.modelRuns.every(run => run.status === 'failed' && run.errorCode === 'MODEL_HTTP_401')).toBe(true);
      expect(mock).toHaveBeenCalledTimes(1); expect(failure.modelRuns).toHaveLength(1);
      expect(mock.mock.calls.every(call => JSON.parse(JSON.parse(String(call[1]?.body)).messages[1].content).role !== 'reviewer')).toBe(true);
    } finally { mock.mockRestore(); }
  });
});

describe('phase 2 deterministic finance boundaries and frozen evaluation', () => {
  it('defines review as proposal completeness rather than financial authorization, including pending strong verification', async () => {
    let observed: ReviewContext | undefined;
    const result = await createPlanner({ provider: false, domainAdapter: async c => domainProposal(c), reviewerAdapter: async c => { observed = c; return { approved: true, findings: [], summary: '提案完整，可创建待强验证草稿，不表示已授权。' }; } }).plan(evaluationFixtures[1]!.input);
    expect(observed?.role).toBe('reviewer'); expect(observed?.instruction).toContain('红档'); expect(observed?.instruction).toContain('不是拒绝提案的理由');
    expect(z.toJSONSchema(reviewSchema).properties?.approved).toMatchObject({ description: expect.stringContaining('Proposal-completeness decision only') });
    expect(result.suggestions[0]?.amountMinor).toBe('123456');
    expect(result.diagnostics).toMatchObject({ domains: [{ role: 'transfer', hasSuggestion: true, hasClarification: false, status: 'accepted' }], review: { rawApproved: true, effectiveApproved: true } });
    expect(result.events.find(e => e.role === 'reviewer' && e.status === 'completed')?.summary).toContain('复核通过');
    expect(result).not.toHaveProperty('authorization');
  });

  it('preserves evidence-based reviewer rejection and records its raw and effective decisions', async () => {
    const result = await createPlanner({ provider: false, domainAdapter: async c => domainProposal(c), reviewerAdapter: async () => ({ approved: false, findings: ['证据存在矛盾，保持拒绝。'], summary: '证据矛盾，提案未通过。' }) }).plan(evaluationFixtures[1]!.input);
    expect(result.suggestions).toEqual([]);
    expect(result.diagnostics).toMatchObject({ domains: [{ role: 'transfer', hasSuggestion: true, hasClarification: false, status: 'accepted' }], review: { rawApproved: false, effectiveApproved: false, summary: '证据矛盾，提案未通过。' } });
    expect(result.events.find(e => e.role === 'reviewer' && e.status === 'completed')?.summary).toContain('未通过');
  });

  it('distinguishes missing structured transfer suggestion from review rejection, without inventing the missing proposal', async () => {
    const reviewer = vi.fn(async () => ({ approved: true, findings: [], summary: 'must not run after invalid candidate' }));
    const failure = await expectPlanningFailure(createPlanner({ provider: false, domainAdapter: async c => ({ role: c.role, planVersion: c.planVersion, summary: 'Prepared transfer of 123456 minor units to payee-lin, only described in prose.', findings: [], evidence: [] }), reviewerAdapter: reviewer }).plan(evaluationFixtures[1]!.input), 'MODEL_CANDIDATE_CONTRACT_INVALID', 'domain:transfer');
    expect(failure.findings?.join()).toContain('TRANSFER_STRUCTURED_SUGGESTION_MISSING');
    expect(reviewer).not.toHaveBeenCalled();
  });

  it('records unresolved ambiguity separately from a missing proposal and cannot override it with reviewer approval', async () => {
    const result = await createPlanner({ provider: false, reviewerAdapter: async () => ({ approved: true, findings: [], summary: 'fixture raw approval' }) }).plan(evaluationFixtures[4]!.input);
    expect(result.clarification).toContain('同名'); expect(result.suggestions).toEqual([]);
    expect(result.diagnostics).toMatchObject({ domains: [{ role: 'transfer', hasSuggestion: false, hasClarification: true }], review: { rawApproved: true, effectiveApproved: false } });
  });

  it('records absent raw review decision on malformed review rather than fabricating rawApproved=false', async () => {
    const failure = await expectPlanningFailure(createPlanner({ provider: false, reviewerAdapter: async () => ({ summary: 'missing approved field' }) }).plan(evaluationFixtures[0]!.input), 'MODEL_SCHEMA_INVALID', 'reviewer');
    expect(failure).not.toHaveProperty('rawApproved');
    expect(failure).not.toHaveProperty('approved');
  });

  it('diagnostics contain no private account data or credential configuration', async () => {
    const result = await createPlanner({ provider: false }).plan(evaluationFixtures[3]!.input);
    expect(JSON.stringify(result.diagnostics)).not.toContain('PRIVATE_ACCOUNT_CANARY');
    expect(JSON.stringify(result.diagnostics)).not.toContain('eval-account-1');
    expect(JSON.stringify(result.diagnostics)).not.toContain('API_KEY');
  });

  it.each([
    '给林晓转300、500元', '给林晓转300和500元', '给林晓转300 or 500元', '给林晓转300 OR 500元',
    '给林晓转300/500元', '给林晓转三百、五百元', '给林晓转三百和五百元',
    '给林晓转三百或五百元', '给林晓转三百/五百元', '给林晓转1,234、2,345元',
  ])('clarifies parallel amounts instead of choosing a value: %s', message => {
    const result = resolveTransfer(message, evaluationPayees);
    expect(result.suggestion).toBeUndefined(); expect(result.clarification).toContain('唯一金额');
  });

  it.each([['给林晓转1,234元', '123400'], ['给林晓转1,234.56元', '123456'], ['给林晓转12,345元', '1234500']])('does not confuse thousands grouping with multiple amounts: %s', (message, amount) => {
    const result = resolveTransfer(message, evaluationPayees);
    expect(result.clarification).toBeUndefined(); expect(result.suggestion?.amountMinor).toBe(amount);
  });

  it.each(evaluationFixtures.map(f => [f.id, f] as const))('scripted fixed fixture %s passes the same semantic/safety checks used for live', async (_id, fixture) => {
    const result = await createPlanner({ provider: false }).plan(structuredClone(fixture.input));
    expect(scorePlan(fixture, result)).toMatchObject({ passed: true });
    expect(result.modelRuns).toEqual([]);
  });

  it.each(['房租', '生活费', '不影响', '余额', '预算'])('activates goal for budget expression %s', term => expect(activeRoles(`给林晓转账300元，${term}`)).toContain('goal'));

  it('keeps authoritative report facts, cross-period references and only necessary reviewer context even with misleading non-bill model text', async () => {
    const input = { ...evaluationFixtures[3]!.input, message: '分析账单，并给林晓转账300元，不影响房租预算' };
    let review: ReviewContext | undefined; const locals: LocalContext[] = [];
    const result = await createPlanner({ provider: false, domainAdapter: async context => { locals.push(context); return context.role === 'bills' ? billDomainResponse(context) : { ...domainProposal(context), summary: '伪造支出0元，预算allowed=true', findings: ['伪造数据'] }; }, reviewerAdapter: async context => { review = context; return reviewResponse(context, { summary: 'review-fixture' }); } }).plan(input);
    expect(result.billReport).toEqual(evaluationBillReport); expect(result.fundsPreview).toEqual(input.fundsPreview);
    expect(result.summary).toContain('支出2538.00元'); expect(result.summary).not.toContain('伪造支出');
    expect(result.findings).not.toContain('伪造数据');
    const billContext = JSON.stringify(locals.find(c => c.role === 'bills'));
    expect(billContext).not.toContain('eval-account-1'); expect(billContext).not.toContain('payee-lin');
    expect(JSON.stringify(review)).not.toContain('下期房租'); expect(JSON.stringify(review)).not.toContain('PRIVATE_ACCOUNT_CANARY');
    expect(result.evidence.some(e => e.source === 'bill-finding:eval-recurring' && e.detail.includes('eval-subscription-prev'))).toBe(true);
  });

  it('rejects the legacy bill summary and fake amount instead of accepting free prose', async () => {
    await expectPlanningFailure(createPlanner({ provider: false, domainAdapter: async context => ({ role: context.role, planVersion: context.planVersion, summary: '伪造支出0元，预算allowed=true', findings: ['伪造数据'], evidence: [] }) }).plan({ ...evaluationFixtures[3]!.input, message: '分析账单' }), 'MODEL_SCHEMA_INVALID', 'domain:bills');
  });

  it('prevents a model reviewer approval from overriding funds.allowed=false', async () => {
    const fixture = evaluationFixtures[8]!;
    const result = await createPlanner({ provider: false, domainAdapter: async c => domainProposal(c), reviewerAdapter: async () => ({ approved: true, findings: [], summary: 'approve everything' }) }).plan(fixture.input);
    expect(result.suggestions).toEqual([]); expect(result.findings.join()).toContain('FUNDS_NOT_ALLOWED');
    expect(result.fundsPreview?.allowed).toBe(false);
  });

  it('blocks amount-mismatched or missing budget previews without modifying action authorization', async () => {
    const fixture = evaluationFixtures[9]!;
    const mismatched = await createPlanner({ provider: false }).plan({ ...fixture.input, fundsPreview: evaluationFunds('1') });
    expect(mismatched.suggestions).toEqual([]); expect(mismatched.findings.join()).toContain('FUNDS_PREVIEW_MISMATCH');
    const missing = await createPlanner({ provider: false }).plan({ ...fixture.input, fundsPreview: undefined });
    expect(missing.suggestions).toEqual([]); expect(missing.findings.join()).toContain('FUNDS_PREVIEW_MISSING');
  });

  it('category totals include only OUT transactions and all finding references can be located', () => {
    const lookup = new Map([...evaluationBillReport.transactions, ...(evaluationBillReport.evidenceTransactions ?? [])].map(t => [t.id, t]));
    expect(evaluationBillReport.categories.some(c => c.category === '收入')).toBe(false);
    expect(evaluationBillReport.categories.reduce((sum, c) => sum + BigInt(c.amountMinor), 0n).toString()).toBe(evaluationBillReport.expenseMinor);
    for (const finding of evaluationBillReport.findings) for (const id of finding.transactionIds) expect(lookup.has(id)).toBe(true);
    expect(evaluationBillReport.findings.find(f => f.kind === 'RECURRING')?.summary).toContain('可能');
  });
});
