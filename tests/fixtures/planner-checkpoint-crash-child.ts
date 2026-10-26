import { billDomainResponse } from './bill-domain-response.js';
/** Test-only OS-process fault boundary for the real checkpoint-enabled Planner. */
import { Pool } from 'pg';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { serve } from '@hono/node-server';
import { createApp } from '../../apps/api/src/app.js';
import { createPlanRunner } from '../../apps/api/src/plan-runner.js';
import { createPlanner } from '../../packages/agents/src/index.js';
import { registerCheckpointAttempt, transferCheckpointAttempt } from '../../packages/agents/src/checkpoint-fencing.js';
import type { Actor } from '../../packages/contracts/src/index.js';
import { reviewResponse } from './review-response.js';

export type PlannerCrashChildConfig = {
  connectionString: string;
  schema: string;
  checkpointSchema: string;
  userId: string;
  commandId: string;
  appName: string;
  mode: 'interrupt-reviewer' | 'resume-reviewer' | 'interrupt-domain' | 'resume-domain';
  transport?: 'runner' | 'http';
};
export type PlannerCrashChildEvent =
  | { type: 'ready'; pid: number; port: number }
  | { type: 'reviewer-started'; pid: number; mode: PlannerCrashChildConfig['mode'] }
  | { type: 'domain-blocked'; pid: number; role: 'bills'; mode: 'interrupt-domain' }
  | { type: 'completed'; pid: number; suggestions: number; actions: number }
  | { type: 'fatal'; code: string };

const send = (event: PlannerCrashChildEvent) => process.send?.(event);

process.once('message', value => {
  void start(value as PlannerCrashChildConfig).catch(() => {
    send({ type: 'fatal', code: 'PLANNER_CHILD_FAILED' });
    process.exitCode = 1;
  }).finally(() => { if (process.connected) process.disconnect?.(); });
});

async function start(config: PlannerCrashChildConfig) {
  if (!/^planner_kill_[a-f0-9]{32}$/.test(config.schema)
    || config.checkpointSchema !== `${config.schema}_checkpoints`
    || !['interrupt-reviewer', 'resume-reviewer', 'interrupt-domain', 'resume-domain'].includes(config.mode)) {
    throw new Error('Invalid child configuration');
  }

  const pool = new Pool({
    connectionString: config.connectionString,
    options: `-c search_path=${config.schema},public`,
    max: 1,
    application_name: config.appName,
  });
  try {
    const saver = new PostgresSaver(pool, undefined, { schema: config.checkpointSchema });
    const actor: Actor = { userId: config.userId };
    const payee = { id: 'payee-1', name: '林晓', aliases: [], bank: '演示银行', maskedNumber: '****1234' };
    const account = { id: 'account-1', name: '日常账户', maskedNumber: '****8899', balanceMinor: '900000', reservedMinor: '0', currency: 'CNY' as const };
    const log = async (stage: string, payload: Record<string, unknown> = {}) => {
      await pool.query('INSERT INTO planner_process_events(stage,pid,payload) VALUES($1,$2,$3)', [stage, process.pid, JSON.stringify(payload)]);
    };
    const core: any = {
      async dashboard() {
        return { accounts: [account], payees: [payee], actions: [], audit: [], dailyUsedMinor: '0' };
      },
      async createTransfer(_owner: Actor, input: any) {
        const proposalNo = (await pool.query(`INSERT INTO planner_process_proposals(command_id,account_id,payee_id,amount_minor,memo)
          VALUES($1,$2,$3,$4,$5) RETURNING id`, [input.commandId, input.accountId, input.payeeId, input.amountMinor, input.memo])).rows[0].id as string;
        return {
          id: proposalNo, taskId: input.taskId, accountId: input.accountId, payeeId: input.payeeId,
          payeeName: payee.name, amountMinor: input.amountMinor, currency: 'CNY', memo: input.memo,
          status: 'AWAITING_CONFIRMATION', tier: 'YELLOW', actionVersion: 1, actionHash: `hash-${proposalNo}`,
          expiresAt: '2026-10-24T00:00:00.000Z', createdAt: '2026-10-23T00:00:00.000Z', updatedAt: '2026-10-23T00:00:00.000Z',
        };
      },
    };
    const planner = createPlanner({
      provider: false,
      semantic: false,
      checkpointer: saver,
      domainAdapter: async context => {
        await log('domain-started', { role: context.role, mode: config.mode });
        if (config.mode === 'interrupt-domain' && context.role === 'bills') {
          send({ type: 'domain-blocked', pid: process.pid, role: 'bills', mode: config.mode });
          // Hold this sibling node while the parent verifies another node's pending write.
          await new Promise<never>(() => {});
        }
        const suggestion = context.role === 'transfer'
          ? (context.data.resolved as { suggestion?: { payeeId: string; amountMinor: string; memo: string } }).suggestion
          : undefined;
        const output = context.role === 'bills' ? billDomainResponse(context) : {
          role: context.role, planVersion: context.planVersion,
          summary: context.role === 'transfer' ? '跨进程恢复测试生成的待确认转账提案。' : '合成账单查询领域提案。',
          findings: [], evidence: [{ source: 'test-fixture', detail: '合成证据；未调用模型或银行服务。' }],
          ...(suggestion ? { suggestion } : {}),
        };
        await log('domain-returned', { role: context.role, mode: config.mode });
        if (context.role === 'transfer') await log('transfer-domain-completed', { role: context.role, mode: config.mode });
        return output;
      },
      reviewerAdapter: async context => {
        await log('reviewer-started', { mode: config.mode });
        if (config.mode === 'interrupt-reviewer') {
          send({ type: 'reviewer-started', pid: process.pid, mode: config.mode });
          // Parent kills this OS process while the reviewer node is in flight.
          await new Promise<never>(() => {});
        }
        return reviewResponse(context, { summary: '合成复核通过，仅允许创建待确认草稿。' });
      },
    });
    const checkpointAttempts = {
      register: (threadId: string, identity: Parameters<typeof registerCheckpointAttempt>[3]) => registerCheckpointAttempt(pool, { checkpointSchema: config.checkpointSchema, journalSchema: config.schema }, threadId, identity),
      transfer: (threadId: string, identity: Parameters<typeof transferCheckpointAttempt>[3]) => transferCheckpointAttempt(pool, { checkpointSchema: config.checkpointSchema, journalSchema: config.schema }, threadId, identity),
    };
    const message = config.mode === 'interrupt-domain' || config.mode === 'resume-domain'
      ? '给林晓转100元并查询2026年9月账单'
      : '给林晓转100元';
    if (config.transport === 'http') {
      const auth = { api: { async getSession({ headers }: { headers: Headers }) {
        return headers.get('cookie') === `planner_process_owner=${config.userId}`
          ? { user: { id: config.userId, email: 'planner-process@example.test' }, session: { id: 'planner-process-session', userId: config.userId } } : null;
      } } };
      const app = createApp({ pool, auth: auth as never, core, planner, checkpointAttempts,
        origin: 'http://localhost:5178', rpID: 'localhost', sandbox: false, plannerMode: 'scripted' });
      const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 }, info => {
        send({ type: 'ready', pid: process.pid, port: info.port });
      });
      let completionSent = false;
      const poll = setInterval(() => {
        void pool.query('SELECT status,result FROM bp_plan_commands WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1', [config.userId])
          .then(({ rows }) => {
            const row = rows[0];
            if (!completionSent && row?.status === 'complete' && row.result) {
              completionSent = true;
              send({ type: 'completed', pid: process.pid, suggestions: row.result.suggestions?.length ?? 0, actions: row.result.actions?.length ?? 0 });
            }
          }).catch(() => undefined);
      }, 25);
      poll.unref();
      try {
        await new Promise<void>((resolve, reject) => process.once('message', value => {
          if ((value as { type?: string } | null)?.type !== 'shutdown') return reject(new Error('Unexpected API child control message'));
          server.close(error => error ? reject(error) : resolve());
        }));
        await app.waitForPlanning();
      } finally { clearInterval(poll); }
      return;
    }
    const runner = createPlanRunner({ pool, core, planner, checkpointAttempts });
    const result = await runner.execute(actor, { commandId: config.commandId, message });
    send({ type: 'completed', pid: process.pid, suggestions: result.suggestions.length, actions: result.actions.length });
  } finally {
    await pool.end();
  }
}
