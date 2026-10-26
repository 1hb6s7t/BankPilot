import { withTransaction } from './database.js';
import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { CoreError } from './errors.js';
import { financeMigration, readFunds } from './finance.js';
import { createPreparations, preparationRequestsMigration } from './preparations.js';
import {
  transferInputSchema,
  type Actor, type ActionView, type AuthorizationProof, type CoreService,
  type Dashboard, type FaultMode, type Receipt, type RiskTier, type TransferInput,
} from '../../contracts/src/index.js';

export { CoreError } from './errors.js';
export type CoreOptions = {
  schema?: string;
  clock?: () => Date;
  actionTtlMs?: number;
  reconcileDelayMs?: number;
};
type Row = Record<string, any>;
export const coreRuntime = new WeakMap<CoreService, { schema: string }>();
// JSONB reorders object keys. Hash semantic content, not incidental insertion order.
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value, (_key, item) =>
  item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item,
)).digest('hex');
const dateString = (value: Date | string) => new Date(value).toISOString();
const businessDay = (date: Date) => new Date(date.getTime() + 8 * 3600_000).toISOString().slice(0, 10);
const tierFor = (amount: bigint): RiskTier => amount <= 100000n ? 'YELLOW' : 'RED';
const terminal = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED', 'EXPIRED']);

export function createCore(pool: Pool, options: CoreOptions = {}): CoreService {
  const schema = options.schema ?? 'bankpilot_core';
  if (!/^[a-z_][a-z0-9_]{0,47}$/.test(schema)) throw new Error('Invalid core schema');
  const s = `"${schema}"`;
  const clock = options.clock ?? (() => new Date());
  const ttl = options.actionTtlMs ?? 15 * 60_000;
  const delay = options.reconcileDelayMs ?? 15_000;
  if (!Number.isSafeInteger(ttl) || ttl <= 0) throw new Error('Invalid action TTL');
  const transaction = <T>(fn: (tx: PoolClient) => Promise<T>): Promise<T> => withTransaction(pool, fn);
  const actorId = (actor: Actor) => {
    if (!actor?.userId || typeof actor.userId !== 'string') throw new CoreError('UNAUTHENTICATED', '请先登录', 401);
    return actor.userId;
  };
  // All user mutations take this lock first. This also serializes rollover between business days.
  const lockUser = async (tx: PoolClient, userId: string) => {
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`${schema}:${userId}`]);
  };
  const owned = async (tx: PoolClient, userId: string, id: string): Promise<Row> => {
    const result = await tx.query(`SELECT * FROM ${s}.actions WHERE id=$1 AND user_id=$2 FOR UPDATE`, [id, userId]);
    if (!result.rows[0]) throw new CoreError('NOT_FOUND', '未找到动作', 404);
    return result.rows[0];
  };
  const audit = async (tx: PoolClient, userId: string, actionId: string | null, type: string, detail: unknown = {}) => {
    await tx.query(`INSERT INTO ${s}.audit_events(id,user_id,action_id,type,detail,created_at) VALUES($1,$2,$3,$4,$5,$6)`,
      [randomUUID(), userId, actionId, type, JSON.stringify(detail), clock()]);
  };
  const actionHash = (row: Row) => hash({
    userId: row.user_id, id: row.id, version: row.action_version, accountId: row.account_id,
    payeeId: row.payee_id, amountMinor: String(row.amount_minor), currency: 'CNY', feeMinor: '0',
    memo: row.memo, tier: row.tier, expiresAt: dateString(row.expires_at), policyVersion: 'sandbox-cny-v1',
  });
  const view = (row: Row): ActionView => ({
    id: row.id, taskId: row.task_id, accountId: row.account_id, payeeId: row.payee_id,
    payeeName: row.payee_name, amountMinor: String(row.amount_minor), currency: 'CNY', memo: row.memo,
    status: row.status, tier: row.tier, actionVersion: row.action_version, actionHash: row.action_hash,
    expiresAt: dateString(row.expires_at), createdAt: dateString(row.created_at), updatedAt: dateString(row.updated_at),
    ...(row.receipt ? { receipt: row.receipt } : {}), ...(row.failure_reason ? { failureReason: row.failure_reason } : {}),
  });
  const daily = async (tx: PoolClient, userId: string, day: string): Promise<bigint> => {
    await tx.query(`INSERT INTO ${s}.daily_usage(user_id,business_day,used_minor) VALUES($1,$2,0) ON CONFLICT DO NOTHING`, [userId, day]);
    const r = await tx.query(`SELECT used_minor FROM ${s}.daily_usage WHERE user_id=$1 AND business_day=$2 FOR UPDATE`, [userId, day]);
    return BigInt(r.rows[0].used_minor);
  };
  const bumpDaily = async (tx: PoolClient, userId: string, day: string, delta: bigint) => {
    await daily(tx, userId, day);
    await tx.query(`UPDATE ${s}.daily_usage SET used_minor=used_minor+$3 WHERE user_id=$1 AND business_day=$2`, [userId, day, delta.toString()]);
  };
  const releaseReservation = async (tx: PoolClient, row: Row, keepDaily = false) => {
    if (!row.reserved) return;
    if (!keepDaily) await bumpDaily(tx, row.user_id, row.reserved_day, -BigInt(row.amount_minor));
    await tx.query(`UPDATE ${s}.actions SET reserved=false WHERE id=$1`, [row.id]);
    row.reserved = false;
  };
  const expire = async (tx: PoolClient, row: Row): Promise<Row> => {
    if (!terminal.has(row.status) && !['SUBMITTING', 'UNKNOWN'].includes(row.status) && new Date(row.expires_at) <= clock()) {
      await releaseReservation(tx, row);
      const r = await tx.query(`UPDATE ${s}.actions SET status='EXPIRED',updated_at=$2 WHERE id=$1 RETURNING *`, [row.id, clock()]);
      await audit(tx, row.user_id, row.id, 'ACTION_EXPIRED', { actionHash: row.action_hash });
      return r.rows[0];
    }
    return row;
  };
  const expirePending = async (tx: PoolClient, userId: string) => {
    const pending = await tx.query(`SELECT * FROM ${s}.actions WHERE user_id=$1
      AND status IN ('AWAITING_CONFIRMATION','AWAITING_VERIFICATION','AUTHORIZED') AND expires_at<=$2 FOR UPDATE`, [userId,clock()]);
    for (const row of pending.rows) await expire(tx,row);
  };
  const enqueue = async (tx: PoolClient, id: string, kind: 'execute' | 'reconcile', wait = 0) => {
    await tx.query(`INSERT INTO ${s}.outbox(action_id,kind,available_at) VALUES($1,$2,$3)
      ON CONFLICT(action_id,kind) DO UPDATE SET sent_at=NULL,available_at=EXCLUDED.available_at`,
    [id, kind, new Date(clock().getTime() + wait)]);
  };
  const upgradeRisk = async (tx: PoolClient, row: Row): Promise<Row> => {
    row.tier = 'RED'; row.action_version += 1; row.action_hash = actionHash(row);
    const r = await tx.query(`UPDATE ${s}.actions SET tier='RED',action_version=$2,action_hash=$3,
      status='AWAITING_VERIFICATION',auth_level=NULL,auth_proof_id=NULL,updated_at=$4 WHERE id=$1 RETURNING *`,
    [row.id, row.action_version, row.action_hash, clock()]);
    await audit(tx, row.user_id, row.id, 'RISK_ESCALATED', { actionHash: row.action_hash, policyVersion: 'sandbox-cny-v1' });
    return r.rows[0];
  };
  // Synthetic bank is an independent transaction. It has its own balance, immutable transfer and double-entry records.
  const providerSubmit = async (row: Row): Promise<Receipt> => {
    const result = await transaction(async tx => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`${schema}:provider:${row.account_id}`]);
      const prior = await tx.query(`SELECT * FROM ${s}.provider_transfers WHERE provider_key=$1`, [row.provider_key]);
      if (prior.rows[0]) {
        if (prior.rows[0].request_hash !== row.input_hash) throw new CoreError('PROVIDER_KEY_CONFLICT', '银行幂等键参数不一致');
        return { receipt: prior.rows[0].receipt as Receipt, mode: 'NORMAL' };
      }
      const faults = await tx.query(`DELETE FROM ${s}.provider_faults WHERE user_id=$1 RETURNING mode`, [row.user_id]);
      const mode: FaultMode = faults.rows[0]?.mode ?? 'NORMAL';
      const account = await tx.query(`SELECT * FROM ${s}.provider_accounts WHERE id=$1 FOR UPDATE`, [row.account_id]);
      if (mode === 'REJECT' || !account.rows[0] || BigInt(account.rows[0].balance_minor) < BigInt(row.amount_minor)) {
        return { rejected: true, mode };
      }
      const receipt: Receipt = {
        providerRequestId: row.provider_key, providerTransactionId: `sim-${randomUUID()}`,
        amountMinor: String(row.amount_minor), currency: 'CNY', payeeId: row.payee_id, settledAt: clock().toISOString(),
      };
      await tx.query(`INSERT INTO ${s}.provider_transfers(provider_key,request_hash,account_id,payee_id,amount_minor,receipt)
        VALUES($1,$2,$3,$4,$5,$6)`, [row.provider_key, row.input_hash, row.account_id, row.payee_id, row.amount_minor, JSON.stringify(receipt)]);
      await tx.query(`UPDATE ${s}.provider_accounts SET balance_minor=balance_minor-$2 WHERE id=$1`, [row.account_id, row.amount_minor]);
      await tx.query(`UPDATE ${s}.provider_accounts SET balance_minor=balance_minor+$2 WHERE id=$1`, [`external:${row.payee_id}`, row.amount_minor]);
      await tx.query(`INSERT INTO ${s}.provider_entries(provider_key,account_id,side,amount_minor) VALUES($1,$2,'DEBIT',$4),($1,$3,'CREDIT',$4)`,
        [row.provider_key, row.account_id, `external:${row.payee_id}`, row.amount_minor]);
      return { receipt, mode };
    });
    if (result.rejected) throw new CoreError('PROVIDER_REJECTED', '模拟银行明确拒绝交易');
    if (result.mode === 'TIMEOUT_AFTER_COMMIT') throw new CoreError('PROVIDER_TIMEOUT', '银行已受理但响应丢失');
    return result.receipt!;
  };
  const internalRow = async (id: string, db: Pool | PoolClient = pool): Promise<Row> => {
    const r = await db.query(`SELECT * FROM ${s}.actions WHERE id=$1`, [id]);
    if (!r.rows[0]) throw new CoreError('NOT_FOUND', '未找到动作', 404);
    return r.rows[0];
  };
  const settle = async (id: string, receipt: Receipt): Promise<ActionView> => transaction(async tx => {
    const original = await internalRow(id, tx);
    await lockUser(tx, original.user_id);
    const row = await owned(tx, original.user_id, id);
    if (terminal.has(row.status)) return view(row);
    if (!['SUBMITTING', 'UNKNOWN'].includes(row.status)) throw new CoreError('INVALID_STATE', '动作尚未派发');
    // Never trust a model or a client-provided receipt. Verify the complete immutable provider identity.
    const bank = await tx.query(`SELECT * FROM ${s}.provider_transfers WHERE provider_key=$1`, [row.provider_key]);
    const valid = bank.rows[0] && bank.rows[0].account_id === row.account_id && bank.rows[0].request_hash === row.input_hash
      && receipt.providerRequestId === row.provider_key && receipt.payeeId === row.payee_id
      && receipt.amountMinor === String(row.amount_minor) && receipt.currency === 'CNY'
      && hash(receipt) === hash(bank.rows[0].receipt);
    if (!valid) throw new CoreError('INVALID_RECEIPT', '银行回执与动作不匹配');
    await tx.query(`UPDATE ${s}.accounts SET balance_minor=balance_minor-$2 WHERE id=$1`, [row.account_id, row.amount_minor]);
    await releaseReservation(tx, row, true);
    const r = await tx.query(`UPDATE ${s}.actions SET status='SUCCEEDED',receipt=$2,failure_reason=NULL,updated_at=$3 WHERE id=$1 RETURNING *`,
      [id, JSON.stringify(receipt), clock()]);
    await audit(tx, row.user_id, id, 'TRANSFER_SUCCEEDED', { actionHash: row.action_hash, receiptHash: hash(receipt), providerRequestId: row.provider_key });
    return view(r.rows[0]);
  });
  const markUnknown = async (id: string, reason: string): Promise<ActionView> => transaction(async tx => {
    const original = await internalRow(id, tx);
    await lockUser(tx, original.user_id);
    const row = await owned(tx, original.user_id, id);
    if (terminal.has(row.status)) return view(row);
    if (!['SUBMITTING', 'UNKNOWN'].includes(row.status)) return view(row);
    const r = await tx.query(`UPDATE ${s}.actions SET status='UNKNOWN',failure_reason=$2,updated_at=$3 WHERE id=$1 RETURNING *`, [id, reason, clock()]);
    await enqueue(tx, id, 'reconcile', delay);
    await audit(tx, row.user_id, id, 'TRANSFER_UNKNOWN', { reason, providerRequestId: row.provider_key });
    return view(r.rows[0]);
  });

  const core: CoreService = {
    preparations: createPreparations(pool, { schema, clock }),
    async migrate() {
      await pool.query(`CREATE SCHEMA IF NOT EXISTS ${s};
        CREATE TABLE IF NOT EXISTS ${s}.accounts(id text PRIMARY KEY,user_id text NOT NULL,name text NOT NULL,masked_number text NOT NULL,balance_minor bigint NOT NULL CHECK(balance_minor>=0));
        CREATE TABLE IF NOT EXISTS ${s}.payees(id text PRIMARY KEY,name text NOT NULL,bank text NOT NULL,masked_number text NOT NULL,aliases jsonb NOT NULL);
        CREATE TABLE IF NOT EXISTS ${s}.daily_usage(user_id text NOT NULL,business_day text NOT NULL,used_minor bigint NOT NULL CHECK(used_minor>=0),PRIMARY KEY(user_id,business_day));
        CREATE TABLE IF NOT EXISTS ${s}.actions(
          id text PRIMARY KEY,user_id text NOT NULL,command_id text NOT NULL,input_hash text NOT NULL,task_id text NOT NULL,
          account_id text NOT NULL REFERENCES ${s}.accounts(id),payee_id text NOT NULL REFERENCES ${s}.payees(id),payee_name text NOT NULL,
          amount_minor bigint NOT NULL CHECK(amount_minor>0),memo text NOT NULL,status text NOT NULL,tier text NOT NULL,
          action_version integer NOT NULL,action_hash text NOT NULL,provider_key text NOT NULL UNIQUE,
          reserved boolean NOT NULL DEFAULT false,reserved_day text,auth_level text,auth_proof_id text,
          receipt jsonb,failure_reason text,expires_at timestamptz NOT NULL,created_at timestamptz NOT NULL,updated_at timestamptz NOT NULL,
          UNIQUE(user_id,command_id));
        CREATE INDEX IF NOT EXISTS actions_user_idx ON ${s}.actions(user_id,created_at);
        CREATE TABLE IF NOT EXISTS ${s}.authorization_proofs(proof_id text PRIMARY KEY,user_id text NOT NULL,action_id text NOT NULL REFERENCES ${s}.actions(id),action_hash text NOT NULL,level text NOT NULL,consumed_at timestamptz NOT NULL);
        CREATE TABLE IF NOT EXISTS ${s}.audit_events(id text PRIMARY KEY,user_id text NOT NULL,action_id text,type text NOT NULL,detail jsonb NOT NULL,created_at timestamptz NOT NULL);
        CREATE TABLE IF NOT EXISTS ${s}.outbox(id bigserial PRIMARY KEY,action_id text NOT NULL REFERENCES ${s}.actions(id),kind text NOT NULL CHECK(kind IN ('execute','reconcile')),available_at timestamptz NOT NULL,sent_at timestamptz,UNIQUE(action_id,kind));
        CREATE TABLE IF NOT EXISTS ${s}.provider_accounts(id text PRIMARY KEY,balance_minor bigint NOT NULL CHECK(balance_minor>=0));
        CREATE TABLE IF NOT EXISTS ${s}.provider_transfers(provider_key text PRIMARY KEY,request_hash text NOT NULL,account_id text NOT NULL,payee_id text NOT NULL,amount_minor bigint NOT NULL CHECK(amount_minor>0),receipt jsonb NOT NULL);
        CREATE TABLE IF NOT EXISTS ${s}.provider_entries(id bigserial PRIMARY KEY,provider_key text NOT NULL REFERENCES ${s}.provider_transfers(provider_key),account_id text NOT NULL REFERENCES ${s}.provider_accounts(id),side text NOT NULL CHECK(side IN ('DEBIT','CREDIT')),amount_minor bigint NOT NULL CHECK(amount_minor>0),UNIQUE(provider_key,side));
        CREATE TABLE IF NOT EXISTS ${s}.provider_faults(user_id text PRIMARY KEY,mode text NOT NULL);
        ${financeMigration(schema)}
        ${preparationRequestsMigration(schema)}
      `);
    },
    async seedDemo(actor) {
      const userId = actorId(actor);
      await transaction(async tx => {
        await lockUser(tx, userId);
        const payees = [
          ['payee-lin', '林晓', '合成招商银行', '**** 1208', ['小林', '林晓']],
          ['payee-chen', '陈宇', '合成建设银行', '**** 8821', ['小陈', '陈宇']],
          ['payee-zhang-a', '张伟', '合成工商银行', '**** 3361', ['张伟']],
          ['payee-zhang-b', '张伟', '合成农业银行', '**** 9072', ['张伟']],
        ];
        for (const p of payees) {
          await tx.query(`INSERT INTO ${s}.payees(id,name,bank,masked_number,aliases) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`, [...p.slice(0,4), JSON.stringify(p[4])]);
          await tx.query(`INSERT INTO ${s}.provider_accounts(id,balance_minor) VALUES($1,0) ON CONFLICT DO NOTHING`, [`external:${p[0]}`]);
        }
        await tx.query(`INSERT INTO ${s}.accounts(id,user_id,name,masked_number,balance_minor) VALUES($1,$2,'日常账户','**** 2026',800000) ON CONFLICT DO NOTHING`, [`acc-main-${userId}`, userId]);
        await tx.query(`INSERT INTO ${s}.provider_accounts(id,balance_minor) VALUES($1,800000) ON CONFLICT DO NOTHING`, [`acc-main-${userId}`]);
      });
    },
    async dashboard(actor): Promise<Dashboard> {
      const userId = actorId(actor);
      return transaction(async tx => {
        await lockUser(tx, userId);
        const pending = await tx.query(`SELECT * FROM ${s}.actions WHERE user_id=$1 AND status IN ('AWAITING_CONFIRMATION','AWAITING_VERIFICATION','AUTHORIZED') FOR UPDATE`, [userId]);
        for (const row of pending.rows) await expire(tx, row);
        const accounts = await tx.query(`SELECT a.*,COALESCE((SELECT sum(amount_minor) FROM ${s}.actions x WHERE x.account_id=a.id AND reserved),0)::text AS reserved_minor FROM ${s}.accounts a WHERE user_id=$1`, [userId]);
        const payees = await tx.query(`SELECT * FROM ${s}.payees ORDER BY id`);
        const actions = await tx.query(`SELECT * FROM ${s}.actions WHERE user_id=$1 ORDER BY created_at DESC,id DESC LIMIT 100`, [userId]);
        const events = await tx.query(`SELECT * FROM ${s}.audit_events WHERE user_id=$1 ORDER BY created_at DESC,id DESC LIMIT 100`, [userId]);
        return {
          accounts: accounts.rows.map(a => ({ id: a.id, name: a.name, maskedNumber: a.masked_number, balanceMinor: String(a.balance_minor), reservedMinor: a.reserved_minor, currency: 'CNY' })),
          payees: payees.rows.map(p => ({ id: p.id, name: p.name, bank: p.bank, maskedNumber: p.masked_number, aliases: p.aliases })),
          actions: actions.rows.map(view),
          audit: events.rows.map(e => ({ id: e.id, actionId: e.action_id, type: e.type, detail: e.detail, createdAt: dateString(e.created_at) })),
          dailyUsedMinor: (await daily(tx, userId, businessDay(clock()))).toString(),
        };
      });
    },
    async createTransfer(actor, input: TransferInput) {
      const userId = actorId(actor);
      const parsed = transferInputSchema.safeParse(input);
      if (!parsed.success) throw new CoreError('INVALID_INPUT', '金额必须是正整数分，且字段格式正确', 400);
      const data = parsed.data;
      const fingerprint = hash({ accountId: data.accountId, payeeId: data.payeeId, amountMinor: data.amountMinor, memo: data.memo, taskId: data.taskId ?? null });
      return transaction(async tx => {
        await lockUser(tx, userId);
        await expirePending(tx,userId);
        const prior = await tx.query(`SELECT * FROM ${s}.actions WHERE user_id=$1 AND command_id=$2`, [userId, data.commandId]);
        if (prior.rows[0]) {
          if (prior.rows[0].input_hash !== fingerprint) throw new CoreError('IDEMPOTENCY_CONFLICT', '相同指令编号不能修改交易参数');
          return view(await expire(tx, prior.rows[0]));
        }
        const account = await tx.query(`SELECT id FROM ${s}.accounts WHERE id=$1 AND user_id=$2`, [data.accountId, userId]);
        if (!account.rows[0]) throw new CoreError('NOT_FOUND', '账户不存在', 404);
        const payee = await tx.query(`SELECT * FROM ${s}.payees WHERE id=$1`, [data.payeeId]);
        if (!payee.rows[0]) throw new CoreError('INVALID_PAYEE', '收款人不存在', 400);
        const used = await daily(tx, userId, businessDay(clock()));
        const tier = tierFor(used + BigInt(data.amountMinor));
        const row: Row = {
          id: randomUUID(), user_id: userId, command_id: data.commandId, input_hash: fingerprint,
          task_id: data.taskId ?? `task-${data.commandId}`, account_id: data.accountId, payee_id: data.payeeId,
          payee_name: payee.rows[0].name, amount_minor: data.amountMinor, memo: data.memo,
          status: tier === 'RED' ? 'AWAITING_VERIFICATION' : 'AWAITING_CONFIRMATION', tier,
          action_version: 1, expires_at: new Date(clock().getTime() + ttl), created_at: clock(), updated_at: clock(),
        };
        row.action_hash = actionHash(row); row.provider_key = `bankpilot:${row.id}`;
        await tx.query(`INSERT INTO ${s}.actions(id,user_id,command_id,input_hash,task_id,account_id,payee_id,payee_name,amount_minor,memo,status,tier,action_version,action_hash,provider_key,expires_at,created_at,updated_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
        [row.id,userId,data.commandId,fingerprint,row.task_id,data.accountId,data.payeeId,row.payee_name,data.amountMinor,data.memo,row.status,tier,1,row.action_hash,row.provider_key,row.expires_at,row.created_at,row.updated_at]);
        await audit(tx, userId, row.id, 'ACTION_PREPARED', { actionHash: row.action_hash, tier, amountMinor: data.amountMinor });
        return view(row);
      });
    },
    async getAction(actor, id, options) {
      const userId = actorId(actor);
      if (options?.readOnly) {
        const result = await pool.query(`SELECT * FROM ${s}.actions WHERE id=$1 AND user_id=$2`, [id, userId]);
        if (!result.rows[0]) throw new CoreError('NOT_FOUND', '动作不存在', 404);
        return view(result.rows[0]);
      }
      return transaction(async tx => { await lockUser(tx, userId); return view(await expire(tx, await owned(tx, userId, id))); });
    },
    async authorize(actor, id, proof: AuthorizationProof) {
      const userId = actorId(actor);
      if (!proof || !['CONFIRMATION', 'STRONG'].includes(proof.level) || typeof proof.proofId !== 'string' || !proof.proofId || proof.proofId.length > 256) {
        throw new CoreError('INVALID_PROOF', '无效授权凭据', 400);
      }
      const outcome = await transaction(async tx => {
        await lockUser(tx, userId);
        await expirePending(tx,userId);
        let row = await expire(tx, await owned(tx, userId, id));
        if (row.status === 'EXPIRED') return { error: new CoreError('ACTION_EXPIRED', '动作已过期') };
        if (!['AWAITING_CONFIRMATION','AWAITING_VERIFICATION'].includes(row.status)) throw new CoreError('INVALID_STATE', '动作不接受重复授权');
        if (proof.actionHash !== row.action_hash) throw new CoreError('STALE_ACTION', '动作版本已变化，请重新确认');
        const used = await daily(tx, userId, businessDay(clock()));
        const recomputed = tierFor(used + BigInt(row.amount_minor));
        if (recomputed === 'RED' && row.tier !== 'RED') {
          row = await upgradeRisk(tx, row);
          return { action: view(row) }; // old proof can never authorize the newly hashed action
        }
        if (row.tier === 'RED' && proof.level !== 'STRONG') return { action: view(row) };
        const alreadyUsed = await tx.query(`SELECT 1 FROM ${s}.authorization_proofs WHERE proof_id=$1`, [proof.proofId]);
        if (alreadyUsed.rows[0]) throw new CoreError('PROOF_REPLAY', '授权凭据已经使用');
        const funds = await tx.query(`SELECT a.balance_minor,COALESCE((SELECT SUM(amount_minor) FROM ${s}.actions WHERE account_id=a.id AND reserved),0)::text AS reserved FROM ${s}.accounts a WHERE id=$1 AND user_id=$2 FOR UPDATE`, [row.account_id,userId]);
        if (!funds.rows[0] || BigInt(funds.rows[0].balance_minor) - BigInt(funds.rows[0].reserved) < BigInt(row.amount_minor)) throw new CoreError('INSUFFICIENT_FUNDS', '可用余额不足');
        const protection = await readFunds(tx,schema,userId,row.account_id,String(row.amount_minor),clock());
        if (!protection.preview.allowed) throw new CoreError('FUNDS_PROTECTED','本次转账会占用生活保留或待付义务资金');
        const day = businessDay(clock());
        await bumpDaily(tx, userId, day, BigInt(row.amount_minor));
        const consumed = await tx.query(`INSERT INTO ${s}.authorization_proofs(proof_id,user_id,action_id,action_hash,level,consumed_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING proof_id`, [proof.proofId,userId,id,row.action_hash,proof.level,clock()]);
        if (!consumed.rows[0]) throw new CoreError('PROOF_REPLAY','授权凭据已经使用');
        const updated = await tx.query(`UPDATE ${s}.actions SET status='AUTHORIZED',reserved=true,reserved_day=$2,auth_level=$3,auth_proof_id=$4,updated_at=$5 WHERE id=$1 RETURNING *`, [id,day,proof.level,proof.proofId,clock()]);
        await enqueue(tx, id, 'execute');
        await audit(tx, userId, id, 'ACTION_AUTHORIZED', { actionHash: row.action_hash, proofId: proof.proofId, level: proof.level, policyVersion: 'sandbox-cny-v1', fundsPolicyVersion:protection.policy.version, dailyUsedMinor: (used+BigInt(row.amount_minor)).toString() });
        return { action: view(updated.rows[0]) };
      });
      if (outcome.error) throw outcome.error;
      return outcome.action!;
    },
    async cancel(actor, id) {
      const userId = actorId(actor);
      return transaction(async tx => {
        await lockUser(tx,userId);
        const row = await expire(tx, await owned(tx,userId,id));
        if (['SUBMITTING','UNKNOWN'].includes(row.status)) throw new CoreError('OUTCOME_UNCERTAIN', '交易已派发，只能查单，不可直接取消或释放占额');
        if (terminal.has(row.status)) throw new CoreError('INVALID_STATE', '终态动作不可取消');
        await releaseReservation(tx,row);
        const r = await tx.query(`UPDATE ${s}.actions SET status='CANCELLED',auth_level=NULL,updated_at=$2 WHERE id=$1 RETURNING *`, [id,clock()]);
        await audit(tx,userId,id,'ACTION_CANCELLED',{ actionHash: row.action_hash });
        return view(r.rows[0]);
      });
    },
    async execute(id) {
      const initial = await internalRow(id);
      const prepared = await transaction(async tx => {
        await lockUser(tx,initial.user_id);
        await expirePending(tx,initial.user_id);
        let row = await expire(tx, await owned(tx,initial.user_id,id));
        if (['SUBMITTING','UNKNOWN'].includes(row.status)) return { row, queryOnly: true };
        if (row.status !== 'AUTHORIZED') return { row, skip: true };
        const protection = await readFunds(tx,schema,row.user_id,row.account_id,String(row.amount_minor),clock(),id);
        if (!protection.preview.allowed) {
          await releaseReservation(tx,row);
          const failed = await tx.query(`UPDATE ${s}.actions SET status='FAILED',auth_level=NULL,failure_reason=$2,updated_at=$3 WHERE id=$1 RETURNING *`,
            [id,'资金保护规则已变化：转账将占用生活保留或待付义务资金',clock()]);
          await audit(tx,row.user_id,id,'TRANSFER_BLOCKED_BY_FUNDS_POLICY',{ fundsPolicyVersion:protection.policy.version,shortfallMinor:protection.preview.shortfallMinor });
          return { row:failed.rows[0] as Row,skip:true };
        }
        const day = businessDay(clock());
        if (row.reserved_day !== day) {
          await releaseReservation(tx,row);
          const used = await daily(tx,row.user_id,day);
          if (tierFor(used+BigInt(row.amount_minor)) === 'RED' && row.tier !== 'RED') {
            row = await upgradeRisk(tx,row);
            return { row, skip: true };
          }
          await bumpDaily(tx,row.user_id,day,BigInt(row.amount_minor));
          await tx.query(`UPDATE ${s}.actions SET reserved=true,reserved_day=$2 WHERE id=$1`,[id,day]);
        }
        if (row.tier === 'RED' && row.auth_level !== 'STRONG') throw new CoreError('AUTHORIZATION_REQUIRED','交易缺少强验证');
        const validProof = await tx.query(`SELECT 1 FROM ${s}.authorization_proofs WHERE proof_id=$1 AND action_id=$2 AND action_hash=$3 AND user_id=$4`, [row.auth_proof_id,id,row.action_hash,row.user_id]);
        if (!validProof.rows[0]) throw new CoreError('AUTHORIZATION_REQUIRED','交易授权不匹配');
        const r = await tx.query(`UPDATE ${s}.actions SET status='SUBMITTING',updated_at=$2 WHERE id=$1 RETURNING *`, [id,clock()]);
        await audit(tx,row.user_id,id,'TRANSFER_DISPATCHED',{ providerRequestId: row.provider_key,actionHash: row.action_hash,fundsPolicyVersion:protection.policy.version });
        return { row: r.rows[0] as Row };
      });
      if (prepared.queryOnly) return core.reconcile(id);
      if (prepared.skip) return view(prepared.row);
      try { return await settle(id, await providerSubmit(prepared.row)); }
      catch (error) {
        if (error instanceof CoreError && error.code === 'PROVIDER_REJECTED') {
          return transaction(async tx => {
            await lockUser(tx,initial.user_id);
            const row = await owned(tx,initial.user_id,id);
            if (terminal.has(row.status)) return view(row);
            await releaseReservation(tx,row);
            const r = await tx.query(`UPDATE ${s}.actions SET status='FAILED',failure_reason=$2,updated_at=$3 WHERE id=$1 RETURNING *`,[id,error.message,clock()]);
            await audit(tx,row.user_id,id,'TRANSFER_FAILED',{ reason:error.code });
            return view(r.rows[0]);
          });
        }
        return markUnknown(id,error instanceof CoreError ? error.code : 'PROVIDER_UNCERTAIN');
      }
    },
    async reconcile(id) {
      const row = await internalRow(id);
      if (terminal.has(row.status) || !['UNKNOWN','SUBMITTING'].includes(row.status)) return view(row);
      const bank = await pool.query(`SELECT receipt FROM ${s}.provider_transfers WHERE provider_key=$1`,[row.provider_key]);
      if (bank.rows[0]) return settle(id,bank.rows[0].receipt);
      return markUnknown(id,'QUERY_NOT_FOUND_NOT_FINAL');
    },
    async setNextFault(actor, mode) {
      const userId = actorId(actor);
      if (!['NORMAL','TIMEOUT_AFTER_COMMIT','REJECT'].includes(mode)) throw new CoreError('INVALID_INPUT','无效故障模式',400);
      await transaction(async tx => {
        await lockUser(tx,userId);
        await tx.query(`INSERT INTO ${s}.provider_faults(user_id,mode) VALUES($1,$2) ON CONFLICT(user_id) DO UPDATE SET mode=EXCLUDED.mode`,[userId,mode]);
        await audit(tx,userId,null,'SANDBOX_FAULT_SET',{ mode });
      });
    },
  };
  coreRuntime.set(core,{ schema });
  return core;
}

export { startWorker } from './worker.js';
export { createFinance } from './finance.js';
export { createManagement } from './management.js';
export { createGoals } from './goals.js';
export { createInvestment, estimateSettlementAt } from './investment.js';
export { createPreparations, migratePreparationRequests, assertPreparationRequestsReady } from './preparations.js';
