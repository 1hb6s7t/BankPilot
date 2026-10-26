import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createConversationService } from '../apps/api/src/conversations';
import { createPlanRunner } from '../apps/api/src/plan-runner';
import { createPlanner } from '../packages/agents/src/index';
import { ModelProviderError } from '../packages/agents/src/provider';
import { registerCheckpointAttempt, setupCheckpointFencing, transferCheckpointAttempt } from '../packages/agents/src/checkpoint-fencing';

const connectionString = process.env.TEST_DATABASE_URL ?? 'postgres://bankpilot:bankpilot-local@127.0.0.1:55432/bankpilot';
const schema = `g8f_cp_${randomUUID().replaceAll('-', '').slice(0, 20)}`, checkpointSchema = `${schema}_cp`;
const admin = new Pool({ connectionString, max: 2 }), pool = new Pool({ connectionString, options: `-c search_path=${schema}`, max: 8 });
const actor = { userId: 'g8f-checkpoint-owner' };
const payee = { id: 'p', name: '林晓', aliases: [], bank: '合成银行', maskedNumber: '****1234' };
const account = { id: 'a', name: '合成账户', maskedNumber: '****8899', balanceMinor: '100000', reservedMinor: '0', currency: 'CNY' };

describe('G8F settled failure starts fresh PostgresSaver lineage with durable stage reuse', () => {
  beforeAll(async () => { await admin.query(`CREATE SCHEMA "${schema}"`); await createConversationService(pool).migrate(); await setupCheckpointFencing(pool, { journalSchema: schema, checkpointSchema }); }, 30000);
  afterAll(async () => { await pool.end(); await admin.query(`DROP SCHEMA IF EXISTS "${checkpointSchema}" CASCADE`); await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await admin.end(); });
  for (const failedRole of ['transfer', 'reviewer']) it(`recovers ${failedRole} service failure instead of resuming a completed failed node`, async () => {
    let broken = true, draftCount = 0, transferCount = 0; const calls: string[] = [];
    const commandId = randomUUID(), message = '给林晓转100元';
    const core: any = {
      async dashboard() { return { accounts: [account], payees: [payee], actions: [], audit: [], dailyUsedMinor: '0' }; },
      async createTransfer(_actor: any, input: any) { draftCount++; return { id: 'draft', taskId: input.taskId, accountId: 'a', payeeId: 'p', payeeName: '林晓', amountMinor: input.amountMinor, currency: 'CNY', memo: input.memo, status: 'AWAITING_CONFIRMATION', tier: 'YELLOW', actionVersion: 1, actionHash: 'hash', expiresAt: '2026-10-24T00:00:00Z', createdAt: '2026-10-23T00:00:00Z', updatedAt: '2026-10-23T00:00:00Z' }; },
    };
    const build = () => createPlanRunner({ pool, core, planner: createPlanner({ provider: false, semantic: false,
      checkpointer: new PostgresSaver(pool, undefined, { schema: checkpointSchema }),
      domainAdapter: async context => { calls.push(context.role); if (broken && failedRole === context.role) throw new ModelProviderError('MODEL_HTTP_502', true); return { role: context.role, planVersion: 1, summary: '待确认', findings: [], evidence: [], suggestion: (context.data.resolved as any).suggestion }; },
      reviewerAdapter: async () => { calls.push('reviewer'); if (broken && failedRole === 'reviewer') throw new ModelProviderError('MODEL_HTTP_502', true); return { approved: true, findings: [], summary: '待本人确认' }; },
    }), checkpointAttempts: { register: (thread, identity) => registerCheckpointAttempt(pool, { journalSchema: schema, checkpointSchema }, thread, identity), transfer: (thread, identity) => { transferCount++; return transferCheckpointAttempt(pool, { journalSchema: schema, checkpointSchema }, thread, identity); } } });
    await expect(build().execute(actor, { commandId, message })).rejects.toMatchObject({ failure: { code: 'MODEL_HTTP_502', retryable: true } });
    const failed = (await pool.query('SELECT * FROM bp_plan_commands WHERE command_id=$1', [commandId])).rows[0];
    expect(failed).toMatchObject({ status: 'failed', proposal: null, result: null, graph_restart_required: true });
    expect(failed.graph_checkpoint_id).toBeTruthy(); expect(draftCount).toBe(0);
    if (failedRole === 'reviewer') expect(Object.keys(failed.stage_results)).toEqual(['domain:transfer']);
    broken = false;
    const result = await build().execute(actor, { commandId, message });
    expect(result.actions).toHaveLength(1); expect(draftCount).toBe(1);
    const done = (await pool.query('SELECT * FROM bp_plan_commands WHERE command_id=$1', [commandId])).rows[0];
    expect(done).toMatchObject({ status: 'complete', graph_restart_required: false });
    expect(done.graph_checkpoint_thread_id).not.toBe(failed.graph_checkpoint_thread_id);
    expect(done.graph_attempt_history).toEqual([{ threadId: failed.graph_checkpoint_thread_id, checkpointNs: '', checkpointId: failed.graph_checkpoint_id, reason: 'settled_planning_failure' }]);
    expect(calls.filter(x => x === 'transfer')).toHaveLength(failedRole === 'transfer' ? 2 : 1);
    expect(calls.filter(x => x === 'reviewer')).toHaveLength(failedRole === 'reviewer' ? 2 : 1);
    // A known service failure must not transfer the old failed graph head.
    expect(transferCount).toBe(0);
  }, 30000);
});
