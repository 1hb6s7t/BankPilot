import { randomUUID, createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { createConversationService } from '../apps/api/src/conversations.js';
import { createPlanRunner, plannerInputDigest } from '../apps/api/src/plan-runner.js';
import type { Actor, PlannerInput, SemanticPlan } from '../packages/contracts/src/index.js';

const connectionString = process.env.TEST_DATABASE_URL ?? 'postgres://bankpilot:bankpilot-local@127.0.0.1:55432/bankpilot';
const schema = `frozen_plan_${randomUUID().replaceAll('-', '')}`;
const admin = new Pool({ connectionString, max: 2 });
const pool = new Pool({ connectionString, options: `-c search_path=${schema}`, max: 10 });
const actor: Actor = { userId: 'freeze-owner' };
const payee = { id: 'payee-1', name: '林晓', aliases: [], bank: '演示银行', maskedNumber: '****1234' };
const account = (id: string) => ({ id, name: id, maskedNumber: '****8899', balanceMinor: '900000', reservedMinor: '0', currency: 'CNY' as const });
const billReport = (tag: string) => ({ period: '2026-09', source: 'SYNTHETIC' as const, incomeMinor: '900000', expenseMinor: tag === 'v1' ? '100000' : '200000', netMinor: '800000', previousExpenseMinor: '90000', categories: [], transactions: [], findings: [], generatedAt: `2026-10-23T00:00:0${tag === 'v1' ? '1' : '2'}.000Z` });
const funds = (tag: string) => ({ policy: { version: tag === 'v1' ? 1 : 2, minimumBalanceMinor: '1000', obligations: [], updatedAt: '2026-10-23T00:00:00.000Z' }, preview: { accountId: 'account-1', amountMinor: '10000', balanceMinor: '900000', reservedMinor: '0', availableBeforeMinor: '900000', availableAfterMinor: tag === 'v1' ? '890000' : '880000', protectedMinor: '1000', spendableMinor: '899000', shortfallMinor: '0', allowed: true, policyVersion: tag === 'v1' ? 1 : 2, horizonEnd: '2026-11-22', obligations: [], reasons: [] } });
const semantic = (message: string): SemanticPlan => ({ status: 'ready', tasks: [
  { operation: 'bills_query', role: 'bills', source: { text: message }, canonicalMessage: message, slots: { billPeriod: { kind: 'month', startPeriod: '2026-09', endPeriod: '2026-09', source: { text: '2026年9月' } } } },
  { operation: 'transfer', role: 'transfer', source: { text: message }, canonicalMessage: message, slots: { entityId: payee.id, amountMinor: '10000', memo: '生活费' } },
], findings: [], modelRuns: [{ role: 'intent', model: 'stub', status: 'success', durationMs: 1 }] });
const planResult = () => ({ taskId: 'task', planVersion: 1, mode: 'scripted' as const, summary: '已生成待审阅建议', events: [], suggestions: [{ payeeId: payee.id, amountMinor: '10000', memo: '生活费' }], evidence: [], findings: [] });
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
};

async function newRunner(overrides: { planner: any; generation?: () => string; calls?: Record<string, number>; accountList?: () => any[] }) {
  const generation = overrides.generation ?? (() => 'v1');
  const calls = overrides.calls ?? {};
  const count = (key: string) => { calls[key] = (calls[key] ?? 0) + 1; };
  const core: any = {
    dashboard: async () => { count('coreDashboard'); return { accounts: overrides.accountList?.() ?? [account('account-1'), account('account-2')], payees: [payee], actions: [], audit: [], dailyUsedMinor: '0' }; },
    createTransfer: async (_owner: Actor, input: any) => {
      count('createTransfer');
      return { id: 'draft-1', taskId: input.taskId, accountId: input.accountId, payeeId: input.payeeId, payeeName: payee.name, amountMinor: input.amountMinor, currency: 'CNY', memo: input.memo, status: 'AWAITING_CONFIRMATION', tier: 'YELLOW', actionVersion: 1, actionHash: 'hash', expiresAt: '2026-10-24T00:00:00.000Z', createdAt: '2026-10-23T00:00:00.000Z', updatedAt: '2026-10-23T00:00:00.000Z' };
    },
  };
  const finance: any = {
    billReport: async () => { count('billReport'); return billReport(generation()); },
    funds: async () => { count('funds'); return funds(generation()); },
  };
  const management: any = {
    contacts: async () => [payee],
    dashboard: async () => { count('managementDashboard'); return { cards: [{ id: `card-${generation()}`, accountId: 'account-1', name: '借记卡', maskedNumber: '****8899', status: 'ACTIVE', version: 1, updatedAt: '2026-10-23T00:00:00.000Z' }], actions: [] }; },
  };
  const investment: any = {
    dashboard: async () => { count('investmentDashboard'); return { businessDate: '2026-10-23', calendar: 'DEMO_WEEKDAYS_V1', products: [], positions: [{ id: `position-${generation()}`, accountId: 'account-1', productId: 'product-1', productName: '稳健理财', principalMinor: '100000', reservedMinor: '0', availableMinor: '100000', version: 1, redemptionBusinessDays: 1, calendar: 'DEMO_WEEKDAYS_V1' }], actions: [] }; },
  };
  return { runner: createPlanRunner({ pool, core, planner: overrides.planner, finance, management, investment }), calls, core };
}

async function insertExistingProposal(input: { commandId: string; message: string; proposal: unknown; preparedInput?: unknown; metadata?: { version: number; graph: string; schema: string; digest: string } }) {
  const messageHash = createHash('sha256').update(input.message).digest('hex');
  const taskId = `task-${createHash('sha256').update(`${actor.userId}:${input.commandId}`).digest('hex').slice(0, 24)}`;
  await pool.query(`INSERT INTO bp_plan_commands(user_id,command_id,message_hash,status,proposal,prepared_input,prepared_input_version,graph_version,graph_schema_version,graph_input_digest,original_message,planning_input)
    VALUES($1,$2,$3,'failed',$4,$5,$6,$7,$8,$9,$10,$11)`, [actor.userId, input.commandId, messageHash, JSON.stringify(input.proposal), input.preparedInput ? JSON.stringify(input.preparedInput) : null,
    input.metadata?.version ?? null, input.metadata?.graph ?? null, input.metadata?.schema ?? null, input.metadata?.digest ?? null, input.message, JSON.stringify({ version: 1, message: input.message, originalMessage: input.message })]);
  return taskId;
}

describe('G8B complete PlannerInput freeze and retry reuse', () => {
  beforeAll(async () => {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await pool.query(`CREATE TABLE bp_plan_commands (
      user_id text NOT NULL, command_id text NOT NULL, message_hash text NOT NULL,
      status text NOT NULL DEFAULT 'running', result jsonb,
      updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(user_id,command_id)
    )`);
    await pool.query(`INSERT INTO bp_plan_commands(user_id,command_id,message_hash,status) VALUES('legacy-owner','legacy-command','legacy-hash','pending')`);
    const conversations = createConversationService(pool);
    await conversations.migrate();
    await conversations.migrate();
    const legacy = (await pool.query(`SELECT prepared_input_version,graph_version,graph_schema_version,graph_input_digest FROM bp_plan_commands WHERE command_id='legacy-command'`)).rows[0];
    expect(legacy).toEqual({ prepared_input_version: null, graph_version: null, graph_schema_version: null, graph_input_digest: null });
  }, 30000);
  beforeEach(async () => { await pool.query('TRUNCATE bp_chat_messages,bp_clarifications,bp_plan_commands,bp_conversations CASCADE'); });
  afterAll(async () => { await pool.end(); await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await admin.end(); });

  it('persists every domain fact before planning, then retries with the same snapshot and a fresh deadline', async () => {
    const observed: PlannerInput[] = [];
    const calls: Record<string, number> = {};
    let failFirst = true;
    const planner: any = {
      interpret: async (input: PlannerInput) => { calls.interpret = (calls.interpret ?? 0) + 1; return semantic(input.message); },
      plan: async (input: PlannerInput) => {
        observed.push(structuredClone(input));
        const row = (await pool.query(`SELECT prepared_input,prepared_input_version,graph_version,graph_schema_version,graph_input_digest FROM bp_plan_commands WHERE command_id=$1`, ['frozen-retry-command'])).rows[0];
        expect(row.prepared_input).toBeTruthy();
        expect(row.prepared_input_version).toBe(1);
        expect(row.graph_input_digest).toBe(plannerInputDigest(input));
        expect(row.graph_version).toBeTruthy(); expect(row.graph_schema_version).toBeTruthy();
        if (failFirst) { failFirst = false; throw new Error('simulated planner interruption'); }
        return planResult();
      },
    };
    let generation = 'v1';
    const { runner } = await newRunner({ planner, calls, generation: () => generation });
    const message = '分析2026年9月账单，并建议给林晓转100元';
    await expect(runner.execute(actor, { commandId: 'frozen-retry-command', message })).rejects.toThrow('simulated planner interruption');
    generation = 'v2';
    await new Promise(resolve => setTimeout(resolve, 15));
    const result = await runner.execute(actor, { commandId: 'frozen-retry-command', message });
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]?.accountId).toBe('account-1');
    expect(calls).toMatchObject({ interpret: 1, billReport: 1, funds: 1, managementDashboard: 1, investmentDashboard: 1, createTransfer: 1 });
    expect(observed).toHaveLength(2);
    const { deadlineAt: firstDeadline, ...firstBusinessInput } = observed[0]!;
    const { deadlineAt: secondDeadline, ...secondBusinessInput } = observed[1]!;
    expect(secondBusinessInput).toEqual(firstBusinessInput);
    expect(secondDeadline).toBeGreaterThan(firstDeadline!);
    expect(observed[0]?.billReport?.expenseMinor).toBe('100000');
    expect(observed[0]?.fundsPreview?.policyVersion).toBe(1);
    expect(observed[0]?.managementContext?.cards[0]?.id).toBe('card-v1');
    expect(observed[0]?.investmentContext?.positions[0]?.id).toBe('position-v1');
    expect(observed[0]?.semanticIntent?.modelRuns[0]?.model).toBe('stub');
    const saved = (await pool.query(`SELECT prepared_input,graph_input_digest,status FROM bp_plan_commands WHERE command_id='frozen-retry-command'`)).rows[0];
    expect(saved.status).toBe('complete');
    expect(saved.prepared_input).toMatchObject({ billReport: { expenseMinor: '100000' }, fundsPreview: { policyVersion: 1 }, managementContext: { cards: [{ id: 'card-v1' }] }, investmentContext: { positions: [{ id: 'position-v1' }] } });
    expect(saved.graph_input_digest).toBe(plannerInputDigest(observed[0]!));
  }, 30000);

  it('rejects a stale attempt after takeover during semantic preparation, before it enters Planner.plan', async () => {
    const enteredFirstInterpret = deferred<void>();
    const releaseFirstInterpret = deferred<void>();
    const calls: Record<string, number> = {};
    const planner: any = {
      interpret: async (input: PlannerInput) => {
        calls.interpret = (calls.interpret ?? 0) + 1;
        if (calls.interpret === 1) { enteredFirstInterpret.resolve(); await releaseFirstInterpret.promise; }
        return semantic(input.message);
      },
      plan: async () => { calls.plan = (calls.plan ?? 0) + 1; return planResult(); },
    };
    let generation = 'v1';
    const { runner } = await newRunner({ planner, calls, generation: () => generation });
    const commandId = 'fenced-freeze-command';
    const message = '分析2026年9月账单，并建议给林晓转100元';
    const oldAttempt = runner.execute(actor, { commandId, message });
    await enteredFirstInterpret.promise;
    generation = 'v2';
    await pool.query(`UPDATE bp_plan_commands SET updated_at=now()-interval '5 minutes' WHERE command_id=$1`, [commandId]);
    const winner = await runner.execute(actor, { commandId, message });
    releaseFirstInterpret.resolve();
    await expect(oldAttempt).rejects.toMatchObject({ code: 'PLAN_SUPERSEDED' });
    expect(winner.actions).toHaveLength(1);
    expect(calls.plan).toBe(1);
    const saved = (await pool.query(`SELECT status,lease_token,prepared_input,graph_input_digest FROM bp_plan_commands WHERE command_id=$1`, [commandId])).rows[0];
    expect(saved.status).toBe('complete');
    // G8E freezes the recognition catalog before calling the model; takeover must reuse v1.
    expect(saved.prepared_input.managementContext.cards[0].id).toBe('card-v1');
    expect(saved.prepared_input.investmentContext.positions[0].id).toBe('position-v1');
    expect(saved.prepared_input.billReport.expenseMinor).toBe('200000');
    expect(saved.graph_input_digest).toBe(plannerInputDigest(saved.prepared_input));
  }, 30000);

  it('verifies a versioned frozen snapshot before resuming a saved proposal, even after graph version changes', async () => {
    const commandId = 'versioned-proposal-resume';
    const message = '给林晓转100元';
    const taskId = await insertExistingProposal({ commandId, message, proposal: planResult(), preparedInput: {
      taskId: '', message, accounts: [account('account-2')], payees: [payee], referenceDate: '2026-10-23', semanticIntent: semantic(message),
    }, metadata: { version: 1, graph: 'bankpilot-planner-old', schema: 'bankpilot-state-old', digest: '0'.repeat(64) } });
    const input: PlannerInput = { taskId, message, accounts: [account('account-2')], payees: [payee], referenceDate: '2026-10-23', semanticIntent: semantic(message) };
    const inputDigest = plannerInputDigest(input);
    await pool.query(`UPDATE bp_plan_commands SET prepared_input=$3,graph_input_digest=$4 WHERE command_id=$1 AND user_id=$2`, [commandId, actor.userId, JSON.stringify(input), inputDigest]);
    let plannerCalls = 0;
    const { runner, calls } = await newRunner({ planner: { plan: async () => { plannerCalls++; return planResult(); } }, accountList: () => [account('account-1'), account('account-2')] });
    const result = await runner.execute(actor, { commandId, message });
    expect(result.actions[0]?.accountId).toBe('account-2');
    expect(plannerCalls).toBe(0);
    expect(calls.createTransfer).toBe(1);
  }, 30000);

  it('rejects a tampered versioned snapshot before any resumed proposal can create a draft', async () => {
    const commandId = 'tampered-proposal-resume';
    const message = '给林晓转100元';
    const taskId = `task-${createHash('sha256').update(`${actor.userId}:${commandId}`).digest('hex').slice(0, 24)}`;
    const frozen: PlannerInput = { taskId, message, accounts: [account('account-1')], payees: [payee], referenceDate: '2026-10-23', semanticIntent: semantic(message) };
    await insertExistingProposal({ commandId, message, proposal: planResult(), preparedInput: frozen,
      metadata: { version: 1, graph: 'bankpilot-planner-old', schema: 'bankpilot-state-old', digest: plannerInputDigest(frozen) } });
    await pool.query(`UPDATE bp_plan_commands SET prepared_input=jsonb_set(prepared_input,'{accounts,0,id}','"account-2"') WHERE command_id=$1`, [commandId]);
    let plannerCalls = 0;
    const { runner, calls } = await newRunner({ planner: { plan: async () => { plannerCalls++; return planResult(); } } });
    await expect(runner.execute(actor, { commandId, message })).rejects.toMatchObject({ code: 'PLANNER_SNAPSHOT_DIGEST_MISMATCH' });
    expect(plannerCalls).toBe(0); expect(calls.createTransfer ?? 0).toBe(0);
    const saved = (await pool.query(`SELECT status,proposal FROM bp_plan_commands WHERE command_id=$1`, [commandId])).rows[0];
    expect(saved.status).toBe('failed'); expect(saved.proposal).toBeTruthy();
  }, 30000);

  it('resumes a legacy partial proposal only with its saved account and refuses one with no provable account', async () => {
    const message = '给林晓转100元';
    const partialCommand = 'legacy-partial-proposal';
    const partialTaskId = await insertExistingProposal({ commandId: partialCommand, message, proposal: planResult(), preparedInput: {
      taskId: '', message, accounts: [account('account-2')], payees: [payee], referenceDate: '2026-10-23',
    } });
    await pool.query(`UPDATE bp_plan_commands SET prepared_input=jsonb_set(prepared_input,'{taskId}',$3::jsonb) WHERE command_id=$1 AND user_id=$2`, [partialCommand, actor.userId, JSON.stringify(partialTaskId)]);
    const { runner, calls } = await newRunner({ planner: { plan: async () => { throw new Error('legacy proposal must not replan'); } } });
    const resumed = await runner.execute(actor, { commandId: partialCommand, message });
    expect(resumed.actions[0]?.accountId).toBe('account-2');
    expect(calls.createTransfer).toBe(1);

    const missingCommand = 'legacy-no-account-proposal';
    await insertExistingProposal({ commandId: missingCommand, message, proposal: planResult() });
    await expect(runner.execute(actor, { commandId: missingCommand, message })).rejects.toMatchObject({ code: 'LEGACY_PROPOSAL_ACCOUNT_UNRECOVERABLE' });
    expect(calls.createTransfer).toBe(1);
    const missing = (await pool.query(`SELECT status,result,proposal FROM bp_plan_commands WHERE command_id=$1`, [missingCommand])).rows[0];
    expect(missing.status).toBe('failed'); expect(missing.result).toBeNull(); expect(missing.proposal).toBeTruthy();

    const mismatchedCommand = 'legacy-mismatched-proposal';
    await insertExistingProposal({ commandId: mismatchedCommand, message, proposal: planResult(), preparedInput: {
      taskId: 'task-from-another-command', message, accounts: [account('account-1')], payees: [payee], referenceDate: '2026-10-23',
    } });
    await expect(runner.execute(actor, { commandId: mismatchedCommand, message })).rejects.toMatchObject({ code: 'PLANNER_SNAPSHOT_BINDING_MISMATCH' });
    expect(calls.createTransfer).toBe(1);
  }, 30000);
});
