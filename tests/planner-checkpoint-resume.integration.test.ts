import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { createConversationService } from '../apps/api/src/conversations.js';
import { createPlanRunner } from '../apps/api/src/plan-runner.js';
import { createPlanner } from '../packages/agents/src/index.js';
import { registerCheckpointAttempt, setupCheckpointFencing, transferCheckpointAttempt } from '../packages/agents/src/checkpoint-fencing.js';
import type { Actor } from '../packages/contracts/src/index.js';

const connectionString = process.env.TEST_DATABASE_URL ?? 'postgres://bankpilot:bankpilot-local@127.0.0.1:55432/bankpilot';
const admin = new Pool({ connectionString, max: 2 });
const schema = `planner_resume_${randomUUID().replaceAll('-', '')}`;
const checkpointSchema = `${schema}_checkpoints`;
const pool = new Pool({ connectionString, options: `-c search_path=${schema},public`, max: 8 });
const actor: Actor = { userId: 'planner-resume-owner' };
const account = { id: 'account-1', name: '日常账户', maskedNumber: '****8899', balanceMinor: '900000', reservedMinor: '0', currency: 'CNY' as const };
const payee = { id: 'payee-1', name: '林晓', aliases: [], bank: '演示银行', maskedNumber: '****1234' };

describe('production planner checkpoint resume', () => {
  beforeAll(async () => {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await createConversationService(pool).migrate();
    await setupCheckpointFencing(pool, { checkpointSchema, journalSchema: schema });
  }, 30000);

  afterAll(async () => {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS "${checkpointSchema}" CASCADE`);
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  });

  it('resumes the real planner graph after a crash before proposal freeze without rerunning completed agents', async () => {
    let reviewerCalls = 0;
    let createTransferCalls = 0;
    let crashAfterFirstGraph = true;
    const reviewerAdapter = async () => {
      reviewerCalls += 1;
      return { approved: true, findings: [], summary: '结构、证据与确定性资金事实一致。' };
    };
    const core: any = {
      async dashboard() { return { accounts: [account], payees: [payee], actions: [], audit: [], dailyUsedMinor: '0' }; },
      async createTransfer(_owner: Actor, input: any) {
        createTransferCalls += 1;
        return {
          id: `draft-${createTransferCalls}`, taskId: input.taskId, accountId: input.accountId, payeeId: input.payeeId,
          payeeName: payee.name, amountMinor: input.amountMinor, currency: 'CNY', memo: input.memo,
          status: 'AWAITING_CONFIRMATION', tier: 'YELLOW', actionVersion: 1, actionHash: 'stable-hash',
          expiresAt: '2026-10-24T00:00:00.000Z', createdAt: '2026-10-23T00:00:00.000Z', updatedAt: '2026-10-23T00:00:00.000Z',
        };
      },
    };
    const createRunner = (runnerPool: Pool, planner: any) => createPlanRunner({
      pool: runnerPool,
      core,
      planner,
      checkpointAttempts: {
        register: (threadId, identity) => registerCheckpointAttempt(runnerPool, { checkpointSchema, journalSchema: schema }, threadId, identity),
        transfer: (threadId, identity) => transferCheckpointAttempt(runnerPool, { checkpointSchema, journalSchema: schema }, threadId, identity),
      },
    });
    const firstSaver = await setupCheckpointFencing(pool, { checkpointSchema, journalSchema: schema });
    const firstGraphPlanner = createPlanner({ provider: false, semantic: false, checkpointer: firstSaver, reviewerAdapter });
    const firstPlanner = {
      async plan(input: Parameters<typeof firstGraphPlanner.plan>[0], context: Parameters<typeof firstGraphPlanner.plan>[1]) {
        const result = await firstGraphPlanner.plan(input, context);
        if (crashAfterFirstGraph) {
          crashAfterFirstGraph = false;
          throw new Error('INJECTED_CRASH_AFTER_GRAPH_CHECKPOINT');
        }
        return result;
      },
    };
    const runner = createRunner(pool, firstPlanner);
    const commandId = `planner-recovery-${randomUUID()}`;
    const message = '给林晓转100元';

    await expect(runner.execute(actor, { commandId, message })).rejects.toThrow('INJECTED_CRASH_AFTER_GRAPH_CHECKPOINT');
    expect(reviewerCalls).toBe(1);
    expect(createTransferCalls).toBe(0);
    const interrupted = (await pool.query(`SELECT status,proposal,graph_checkpoint_thread_id,graph_checkpoint_ns,graph_checkpoint_id
      FROM bp_plan_commands WHERE user_id=$1 AND command_id=$2`, [actor.userId, commandId])).rows[0];
    expect(interrupted).toMatchObject({ status: 'failed', proposal: null, graph_checkpoint_ns: '' });
    expect(interrupted.graph_checkpoint_thread_id).toBeTruthy();
    expect(interrupted.graph_checkpoint_id).toBeTruthy();

    const recoveryPool = new Pool({ connectionString, options: `-c search_path=${schema},public`, max: 8 });
    let resumedResult: Awaited<ReturnType<ReturnType<typeof createPlanRunner>['execute']>>;
    try {
      const recoverySaver = new PostgresSaver(recoveryPool, undefined, { schema: checkpointSchema });
      const recoveryGraphPlanner = createPlanner({ provider: false, semantic: false, checkpointer: recoverySaver, reviewerAdapter });
      const recoveryRunner = createRunner(recoveryPool, recoveryGraphPlanner);
      resumedResult = await recoveryRunner.execute(actor, { commandId, message });
      expect(resumedResult.suggestions).toHaveLength(1);
      expect(resumedResult.actions).toHaveLength(1);
      expect(reviewerCalls).toBe(1);
      expect(createTransferCalls).toBe(1);
    } finally {
      await recoveryPool.end();
    }
    const completed = (await pool.query(`SELECT status,proposal,graph_checkpoint_thread_id,graph_checkpoint_id
      FROM bp_plan_commands WHERE user_id=$1 AND command_id=$2`, [actor.userId, commandId])).rows[0];
    expect(completed.status).toBe('complete');
    expect(completed.proposal.suggestions).toEqual(resumedResult!.suggestions);
    expect(completed.graph_checkpoint_thread_id).not.toBe(interrupted.graph_checkpoint_thread_id);
    expect(completed.graph_checkpoint_id).toBe(interrupted.graph_checkpoint_id);
  }, 30000);
});
