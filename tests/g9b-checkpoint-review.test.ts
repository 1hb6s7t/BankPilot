import { billDomainResponse } from './fixtures/bill-domain-response';
import { MemorySaver } from '@langchain/langgraph';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createPlanner, type PlannerOptions } from '../packages/agents/src/index';
import { createPlanner as createG8NFrozenPlanner } from '../evals/baselines/g8n-final-2026-10-24T03-56-37-821Z/source/packages/agents/src/index';
import { createPlanRunner, plannerInputDigest, PLANNER_GRAPH_VERSION, PLANNER_STATE_SCHEMA_VERSION } from '../apps/api/src/plan-runner';
import type { BillReport, PlannerInput } from '../packages/contracts/src/index';
import { reviewResponse } from './fixtures/review-response';

// Author-written local calibration, genuine frozen G8N implementation, and an
// in-memory checkpointer. No G9 fixture, provider request or database connection.
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
function input(): PlannerInput {
  const report: BillReport = { period: '2026-06',source: 'SYNTHETIC',coverage: { status: 'complete' },incomeMinor: '0',expenseMinor: '1250',netMinor: '-1250',previousExpenseMinor: '0',categories: [],findings: [],generatedAt: '2026-07-01T00:00:00.000Z',
    transactions: [{ id: 'calibration-expense',accountId: 'calibration-account',bookedAt: '2026-06-03T01:00:00.000Z',merchant: '本地校准商户',amountMinor: '1250',direction: 'OUT',category: '购物',source: 'SYNTHETIC_STATEMENT' }] };
  return { taskId: 'g9b-checkpoint-calibration',message: '查询账单',referenceDate: '2026-10-24',accounts: [],payees: [],billReport: report };
}
const checkpoint = (threadId: string,resume: boolean) => ({ checkpointAttempt: { threadId,checkpointNs: '' as const,resume } });
function networkForbidden() { vi.spyOn(globalThis,'fetch').mockImplementation(async () => { throw new Error('NETWORK_FORBIDDEN_IN_CHECKPOINT_CALIBRATION'); }); }
afterEach(() => vi.restoreAllMocks());

describe('G9B billing contract binding on native completed checkpoint recovery', () => {
  it.each([true,false])('rejects completed legacy G8N review approved=%s before publishing its free text or invoking a replacement reviewer', async approved => {
    networkForbidden(); const saver = new MemorySaver(), received = input();
    await createG8NFrozenPlanner({ provider: false,semantic: false,checkpointer: saver as never,
      reviewerAdapter: async () => ({ approved,summary: '旧自由文案中的虚构商户与金额999999元',findings: ['旧自由文案不能自动继承'] }),
    }).plan(received,checkpoint('legacy-head',false));
    const review = vi.fn(async () => { throw new Error('OLD_COMPLETED_HEAD_MUST_NOT_REENTER_REVIEWER'); });
    const planner = createPlanner({ provider: false,semantic: false,checkpointer: saver as unknown as PlannerOptions['checkpointer'],reviewerAdapter: review });
    await expect(planner.plan(received,checkpoint('legacy-head',true))).rejects.toMatchObject({ failure: { stage: 'domain:bills',code: 'STAGE_DEPENDENCY_MISMATCH',retryable: false } });
    expect(review).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });

  it.each([true,false])('reuses a new typed completed review approved=%s without repeated domain/review calls or losing refusal', async approved => {
    networkForbidden(); const saver = new MemorySaver(), received = input();
    const domain = vi.fn(async (context: Parameters<NonNullable<PlannerOptions['domainAdapter']>>[0]) => billDomainResponse(context));
    const review = vi.fn(async (context: Parameters<NonNullable<PlannerOptions['reviewerAdapter']>>[0]) => reviewResponse(context,{ approved }));
    const planner = () => createPlanner({ provider: false,semantic: false,checkpointer: saver as unknown as PlannerOptions['checkpointer'],domainAdapter: domain,reviewerAdapter: review });
    const first = await planner().plan(received,checkpoint('typed-head',false));
    const recovered = await planner().plan(received,checkpoint('typed-head',true));
    expect(domain).toHaveBeenCalledTimes(1); expect(review).toHaveBeenCalledTimes(1);
    expect(first.diagnostics?.review).toMatchObject({ rawApproved: approved,effectiveApproved: approved });
    expect(recovered.diagnostics?.review).toEqual(first.diagnostics?.review); expect(recovered.findings).toEqual(first.findings);
    // G9C withholds rejected answers; the archived G9B test retains its historical expectation.
    if (approved) expect(recovered.diagnostics?.review?.summary).toContain('净额-12.50元');
    else { expect(recovered.diagnostics?.review?.summary).not.toContain('净额-12.50元'); expect(recovered.billAnswerReview?.status).toBe('withheld'); } expect(recovered.findings).toContain(approved ? 'BILL_REVIEW_STATUS_COMPLETE' : 'BILL_ANSWER_REVIEW_REJECTED');
    if (!approved) expect(recovered.diagnostics?.review?.summary).toContain('独立复核未通过');
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(['amount','coverage','merchant'])('rejects changed %s facts on completed native resume before returning stale review', async change => {
    networkForbidden(); const saver = new MemorySaver(), received = input();
    const review = vi.fn(async (context: Parameters<NonNullable<PlannerOptions['reviewerAdapter']>>[0]) => reviewResponse(context));
    const planner = createPlanner({ provider: false,semantic: false,checkpointer: saver as unknown as PlannerOptions['checkpointer'],reviewerAdapter: review });
    await planner.plan(received,checkpoint('facts-head',false));
    const changed = structuredClone(received);
    if (change === 'amount') { changed.billReport!.expenseMinor = '1300'; changed.billReport!.netMinor = '-1300'; changed.billReport!.transactions[0]!.amountMinor = '1300'; }
    if (change === 'coverage') changed.billReport!.coverage = { status: 'missing' };
    if (change === 'merchant') changed.billReport!.transactions[0]!.merchant = '改变后的校准商户';
    await expect(planner.plan(changed,checkpoint('facts-head',true))).rejects.toMatchObject({ failure: { stage: 'domain:bills',code: 'STAGE_DEPENDENCY_MISMATCH',retryable: false } });
    expect(review).toHaveBeenCalledTimes(1); expect(fetch).not.toHaveBeenCalled();
  });
});

describe('G9B API rejects legacy frozen graph snapshots through an in-memory SQL boundary', () => {
  it.each(['graph','g9h-graph','schema'])('rejects legacy %s identity before recognition, planner or action execution', async field => {
    networkForbidden(); const actor = { userId: 'g9b-calibration-owner' },commandId = 'g9b-calibration-command';
    const received = input(); received.taskId = `task-${sha256(`${actor.userId}:${commandId}`).slice(0,24)}`;
    const row: Record<string,any> = { user_id: actor.userId,command_id: commandId,message_hash: sha256(received.message),status: 'failed',result: null,proposal: null,
      prepared_input: received,prepared_input_version: 1,graph_input_digest: plannerInputDigest(received),graph_version: field === 'graph' ? 'bankpilot-planner-g8f-v1-lg1.5.2-cp1.2.1-pg1.1.2' : field === 'g9h-graph' ? 'bankpilot-planner-g9h-v1-lg1.5.2-cp1.2.1-pg1.1.2' : PLANNER_GRAPH_VERSION,
      graph_schema_version: field === 'schema' ? 'bankpilot-planner-state-v2' : PLANNER_STATE_SCHEMA_VERSION };
    const query = vi.fn(async (sql: string,values: unknown[] = []) => {
      if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql)) return { rows: [],rowCount: 0 };
      if (sql.startsWith('INSERT INTO bp_plan_commands')) return { rows: [],rowCount: 0 };
      if (sql.startsWith('SELECT * FROM bp_plan_commands')) return { rows: [structuredClone(row)],rowCount: 1 };
      if (sql.includes("SET status='running'")) { row.status = 'running'; row.lease_token = values[2]; return { rows: [structuredClone(row)],rowCount: 1 }; }
      if (sql.includes("SET status='failed'")) { row.status = 'failed'; row.last_error_code = values[3]; row.planning_failure = JSON.parse(String(values[4])); return { rows: [{ command_id: commandId }],rowCount: 1 }; }
      throw new Error(`Unexpected SQL in local snapshot boundary: ${sql.slice(0,50)}`);
    });
    const pool = { query,connect: async () => Object.assign(new EventEmitter(),{ query,release() {} }) };
    const core = { dashboard: vi.fn(async () => ({ accounts: [],payees: [],actions: [],audit: [],dailyUsedMinor: '0' })),createTransfer: vi.fn() };
    const planner = { plan: vi.fn(),interpret: vi.fn() };
    const runner = createPlanRunner({ pool: pool as never,core: core as never,planner });
    await expect(runner.execute(actor,{ commandId,message: received.message })).rejects.toMatchObject({ code: 'PLANNER_SNAPSHOT_INCOMPATIBLE' });
    expect(row.planning_failure).toMatchObject({ code: 'PLANNER_SNAPSHOT_INCOMPATIBLE',phase: 'planning',retryable: false });
    expect(planner.interpret).not.toHaveBeenCalled(); expect(planner.plan).not.toHaveBeenCalled(); expect(core.createTransfer).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });
});
