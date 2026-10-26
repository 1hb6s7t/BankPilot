import { withTransaction } from './database.js';
import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  redemptionInputSchema,
  syntheticInvestmentProducts,
  type Actor,
  type InvestmentService,
  type InvestmentAction,
  type InvestmentReceipt,
  type InvestmentProduct,
  type FundsTimeline,
} from "../../contracts/src/index.js";
import { CoreError } from "./errors.js";
import { readFunds } from "./finance.js";
import { lockPreparationRequest, markPreparationPrepared } from './preparations.js';

type Row = Record<string, any>;
export type InvestmentOptions = {
  schema?: string;
  clock?: () => Date;
  reconcileDelayMs?: number;
};
export const investmentRuntime = new WeakMap<
  InvestmentService,
  { schema: string }
>();
const calendar = "DEMO_WEEKDAYS_V1" as const;
const day = (d: Date) =>
  new Date(d.getTime() + 8 * 3600_000).toISOString().slice(0, 10);
const iso = (d: Date | string) => new Date(d).toISOString();
const hash = (v: unknown) =>
  createHash("sha256")
    .update(
      JSON.stringify(v, (_k, x) =>
        x && typeof x === "object" && !Array.isArray(x)
          ? Object.fromEntries(
              Object.entries(x).sort(([a], [b]) => a.localeCompare(b)),
            )
          : x,
      ),
    )
    .digest("hex");
const terminal = new Set(["SUCCEEDED", "FAILED", "CANCELLED", "EXPIRED"]);
const products: InvestmentProduct[] = syntheticInvestmentProducts.map(product => ({ ...product }));
/** Synthetic weekdays only, NOT a statutory Chinese exchange calendar. Preserves Shanghai time of day. */
export function estimateSettlementAt(at: Date, businessDays: number): string {
  if (
    !Number.isFinite(at.getTime()) ||
    !Number.isSafeInteger(businessDays) ||
    businessDays < 0 ||
    businessDays > 365
  )
    throw new CoreError("INVALID_INPUT", "无效到账日期或工作日数", 400);
  const d = new Date(at.getTime() + 8 * 3600_000);
  const weekend = () => d.getUTCDay() === 0 || d.getUTCDay() === 6;
  while (weekend()) d.setUTCDate(d.getUTCDate() + 1);
  for (let n = 0; n < businessDays; n++) {
    d.setUTCDate(d.getUTCDate() + 1);
    while (weekend()) d.setUTCDate(d.getUTCDate() + 1);
  }
  return new Date(d.getTime() - 8 * 3600_000).toISOString();
}
export function createInvestment(
  pool: Pool,
  options: InvestmentOptions = {},
): InvestmentService {
  const schema = options.schema ?? "bankpilot_core";
  if (!/^[a-z_][a-z0-9_]{0,47}$/.test(schema))
    throw new Error("Invalid investment schema");
  const s = `"${schema}"`,
    clock = options.clock ?? (() => new Date()),
    delay = options.reconcileDelayMs ?? 15000;
  if (!Number.isSafeInteger(delay) || delay < 0)
    throw new Error("Invalid reconcile delay");
  const owner = (actor: Actor) => {
    if (!actor?.userId || typeof actor.userId !== "string")
      throw new CoreError("UNAUTHENTICATED", "请先登录", 401);
    return actor.userId;
  };
  const transaction = <T>(fn: (tx: PoolClient) => Promise<T>): Promise<T> => withTransaction(pool, fn);
  const lock = async (tx: PoolClient, userId: string) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `${schema}:${userId}`,
    ]);
  };
  const owned = async (tx: PoolClient, userId: string, id: string) => {
    const r = await tx.query(
      `SELECT * FROM ${s}.investment_actions WHERE id=$1 AND user_id=$2 FOR UPDATE`,
      [id, userId],
    );
    if (!r.rows[0]) throw new CoreError("NOT_FOUND", "赎回动作不存在", 404);
    return r.rows[0];
  };
  const internal = async (id: string) => {
    const r = await pool.query(
      `SELECT user_id FROM ${s}.investment_actions WHERE id=$1`,
      [id],
    );
    if (!r.rows[0]) throw new CoreError("NOT_FOUND", "赎回动作不存在", 404);
    return r.rows[0].user_id as string;
  };
  const audit = async (
    tx: PoolClient,
    r: Row,
    type: string,
    detail: unknown,
  ) => {
    await tx.query(
      `INSERT INTO ${s}.audit_events(id,user_id,action_id,type,detail,created_at) VALUES($1,$2,$3,$4,$5,$6)`,
      [randomUUID(), r.user_id, r.id, type, JSON.stringify(detail), clock()],
    );
  };
  const view = (r: Row): InvestmentAction => ({
    id: r.id,
    taskId: r.task_id,
    positionId: r.position_id,
    accountId: r.account_id,
    productId: r.product_id,
    productName: r.product_name,
    amountMinor: String(r.amount_minor),
    feeMinor: "0",
    netAmountMinor: String(r.amount_minor),
    tier: "RED",
    status:
      r.status === "AWAITING_VERIFICATION" && new Date(r.expires_at) <= clock()
        ? "EXPIRED"
        : r.status,
    expectedVersion: r.expected_version,
    actionVersion: 1,
    actionHash: r.action_hash,
    expiresAt: iso(r.expires_at),
    expectedSettlementAt: iso(r.expected_settlement_at),
    calendar,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
    ...(r.accepted_at ? { acceptedAt: iso(r.accepted_at) } : {}),
    ...(r.receipt ? { receipt: r.receipt } : {}),
    ...(r.failure_reason ? { failureReason: r.failure_reason } : {}),
  });
  const enqueue = async (
    tx: PoolClient,
    id: string,
    kind: "execute" | "reconcile",
    wait = 0,
  ) => {
    await tx.query(
      `INSERT INTO ${s}.investment_outbox(action_id,kind,available_at) VALUES($1,$2,$3) ON CONFLICT(action_id,kind) DO UPDATE SET available_at=EXCLUDED.available_at,sent_at=NULL`,
      [id, kind, new Date(clock().getTime() + wait)],
    );
  };
  const release = async (tx: PoolClient, r: Row) => {
    if (r.reserved) {
      await tx.query(
        `UPDATE ${s}.investment_positions SET reserved_minor=reserved_minor-$2 WHERE id=$1`,
        [r.position_id, r.amount_minor],
      );
      await tx.query(
        `UPDATE ${s}.investment_actions SET reserved=false WHERE id=$1`,
        [r.id],
      );
    }
  };
  const expire = async (tx: PoolClient, userId: string) => {
    const rows = await tx.query(
      `SELECT * FROM ${s}.investment_actions WHERE user_id=$1 AND status='AUTHORIZED' AND expires_at<=$2 FOR UPDATE`,
      [userId, clock()],
    );
    for (const r of rows.rows) {
      await release(tx, r);
      await tx.query(
        `UPDATE ${s}.investment_actions SET status='EXPIRED',updated_at=$2 WHERE id=$1`,
        [r.id, clock()],
      );
      await audit(tx, r, "REDEMPTION_EXPIRED", {});
    }
  };
  const providerLock = async (tx: PoolClient, accountId: string) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `${schema}:provider:${accountId}`,
    ]);
  };
  // Provider acceptance is its own durable transaction. No business user lock is held during submission.
  const submit = async (r: Row) =>
    transaction(async (tx) => {
      await providerLock(tx, r.account_id);
      const prior = await tx.query(
        `SELECT * FROM ${s}.provider_redemptions WHERE provider_key=$1`,
        [r.provider_key],
      );
      if (prior.rows[0]) {
        if (prior.rows[0].request_hash !== r.input_hash)
          throw new CoreError(
            "PROVIDER_KEY_CONFLICT",
            "提供方幂等键参数不一致",
          );
        return prior.rows[0];
      }
      const fault =
        (
          await tx.query(
            `DELETE FROM ${s}.investment_faults WHERE user_id=$1 RETURNING mode`,
            [r.user_id],
          )
        ).rows[0]?.mode ?? "NORMAL";
      const pos = (
        await tx.query(
          `SELECT * FROM ${s}.provider_positions WHERE id=$1 FOR UPDATE`,
          [r.position_id],
        )
      ).rows[0];
      const held = (
        await tx.query(
          `SELECT COALESCE(sum(amount_minor),0)::text AS amount FROM ${s}.provider_redemptions WHERE position_id=$1 AND status='ACCEPTED'`,
          [r.position_id],
        )
      ).rows[0].amount;
      const rejected =
        fault === "REJECT" ||
        !pos ||
        BigInt(pos.principal_minor) - BigInt(held) < BigInt(r.amount_minor);
      // Acceptance and its derived settlement date are one provider event.
      const acceptedAt = clock();
      const due = estimateSettlementAt(acceptedAt, r.business_days);
      return (
        await tx.query(
          `INSERT INTO ${s}.provider_redemptions(provider_key,request_hash,user_id,position_id,account_id,product_id,amount_minor,status,accepted_at,due_at,fault_mode)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
          [
            r.provider_key,
            r.input_hash,
            r.user_id,
            r.position_id,
            r.account_id,
            r.product_id,
            r.amount_minor,
            rejected ? "REJECTED" : "ACCEPTED",
            acceptedAt,
            due,
            fault,
          ],
        )
      ).rows[0];
    });
  const unknown = async (id: string, reason: string) => {
    const userId = await internal(id);
    return transaction(async (tx) => {
      await lock(tx, userId);
      const r = await owned(tx, userId, id);
      if (terminal.has(r.status)) return view(r);
      if (!["SUBMITTING", "UNKNOWN", "SETTLING"].includes(r.status))
        return view(r);
      const saved = (
        await tx.query(
          `UPDATE ${s}.investment_actions SET status='UNKNOWN',failure_reason=$2,updated_at=$3 WHERE id=$1 RETURNING *`,
          [id, reason, clock()],
        )
      ).rows[0];
      await enqueue(tx, id, "reconcile", delay);
      await audit(tx, r, "REDEMPTION_UNKNOWN", { reason });
      return view(saved);
    });
  };
  const service: InvestmentService = {
    async migrate() {
      await pool.query(`
      CREATE TABLE IF NOT EXISTS ${s}.investment_positions(id text PRIMARY KEY,user_id text NOT NULL,account_id text NOT NULL REFERENCES ${s}.accounts(id),product_id text NOT NULL,principal_minor bigint NOT NULL CHECK(principal_minor>=0),reserved_minor bigint NOT NULL DEFAULT 0 CHECK(reserved_minor>=0 AND reserved_minor<=principal_minor),version integer NOT NULL DEFAULT 1);
      CREATE TABLE IF NOT EXISTS ${s}.provider_positions(id text PRIMARY KEY,user_id text NOT NULL,principal_minor bigint NOT NULL CHECK(principal_minor>=0));
      CREATE TABLE IF NOT EXISTS ${s}.investment_actions(id text PRIMARY KEY,user_id text NOT NULL,command_id text NOT NULL,input_hash text NOT NULL,provider_key text NOT NULL UNIQUE,task_id text NOT NULL,position_id text NOT NULL REFERENCES ${s}.investment_positions(id),account_id text NOT NULL,product_id text NOT NULL,product_name text NOT NULL,business_days integer NOT NULL,amount_minor bigint NOT NULL CHECK(amount_minor>0),expected_version integer NOT NULL,action_hash text NOT NULL,status text NOT NULL,reserved boolean NOT NULL DEFAULT false,expires_at timestamptz NOT NULL,expected_settlement_at timestamptz NOT NULL,accepted_at timestamptz,receipt jsonb,failure_reason text,created_at timestamptz NOT NULL,updated_at timestamptz NOT NULL,UNIQUE(user_id,command_id));
      CREATE TABLE IF NOT EXISTS ${s}.investment_proofs(proof_id text PRIMARY KEY,user_id text NOT NULL,action_id text NOT NULL REFERENCES ${s}.investment_actions(id),action_hash text NOT NULL,level text NOT NULL,consumed_at timestamptz NOT NULL);
      CREATE TABLE IF NOT EXISTS ${s}.investment_outbox(id bigserial PRIMARY KEY,action_id text NOT NULL REFERENCES ${s}.investment_actions(id),kind text NOT NULL CHECK(kind IN ('execute','reconcile')),available_at timestamptz NOT NULL,sent_at timestamptz,UNIQUE(action_id,kind));
      CREATE TABLE IF NOT EXISTS ${s}.provider_redemptions(provider_key text PRIMARY KEY,request_hash text NOT NULL,user_id text NOT NULL,position_id text NOT NULL,account_id text NOT NULL,product_id text NOT NULL,amount_minor bigint NOT NULL CHECK(amount_minor>0),status text NOT NULL CHECK(status IN ('ACCEPTED','SETTLED','REJECTED')),accepted_at timestamptz NOT NULL,due_at timestamptz NOT NULL,receipt jsonb,fault_mode text NOT NULL);
      CREATE TABLE IF NOT EXISTS ${s}.redemption_entries(id bigserial PRIMARY KEY,provider_key text NOT NULL REFERENCES ${s}.provider_redemptions(provider_key),account_id text NOT NULL REFERENCES ${s}.provider_accounts(id),side text NOT NULL CHECK(side IN ('DEBIT','CREDIT')),amount_minor bigint NOT NULL CHECK(amount_minor>0),UNIQUE(provider_key,side));
      CREATE TABLE IF NOT EXISTS ${s}.investment_faults(user_id text PRIMARY KEY,mode text NOT NULL);
    `);
    },
    async seedDemo(actor) {
      const userId = owner(actor);
      await transaction(async (tx) => {
        await lock(tx, userId);
        const account = (
          await tx.query(
            `SELECT id FROM ${s}.accounts WHERE user_id=$1 ORDER BY id LIMIT 1`,
            [userId],
          )
        ).rows[0];
        if (!account) throw new CoreError("NOT_FOUND", "账户不存在", 404);
        for (const p of products) {
          const id = `position:${userId}:${p.id}`,
            amount = p.redemptionBusinessDays === 0 ? "500000" : "1000000";
          await tx.query(
            `INSERT INTO ${s}.investment_positions(id,user_id,account_id,product_id,principal_minor) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
            [id, userId, account.id, p.id, amount],
          );
          await tx.query(
            `INSERT INTO ${s}.provider_positions(id,user_id,principal_minor) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,
            [id, userId, amount],
          );
          await tx.query(
            `INSERT INTO ${s}.provider_accounts(id,balance_minor) VALUES($1,$2) ON CONFLICT DO NOTHING`,
            [`investment-fund:${id}`, amount],
          );
        }
      });
    },
    async dashboard(actor) {
      const userId = owner(actor);
      return transaction(async (tx) => {
        await lock(tx, userId);
        await expire(tx, userId);
        const positions = await tx.query(
          `SELECT * FROM ${s}.investment_positions WHERE user_id=$1 ORDER BY id`,
          [userId],
        );
        const actions = await tx.query(
          `SELECT * FROM ${s}.investment_actions WHERE user_id=$1 ORDER BY created_at DESC,id LIMIT 100`,
          [userId],
        );
        return {
          businessDate: day(clock()),
          calendar,
          products: structuredClone(products),
          positions: positions.rows.map((r) => {
            const p = products.find((p) => p.id === r.product_id)!;
            return {
              id: r.id,
              accountId: r.account_id,
              productId: p.id,
              productName: p.name,
              principalMinor: String(r.principal_minor),
              reservedMinor: String(r.reserved_minor),
              availableMinor: (
                BigInt(r.principal_minor) - BigInt(r.reserved_minor)
              ).toString(),
              version: r.version,
              redemptionBusinessDays: p.redemptionBusinessDays,
              calendar,
            };
          }),
          actions: actions.rows.map(view),
        };
      });
    },
    async prepare(actor, input) {
      const userId = owner(actor),
        parsed = redemptionInputSchema.safeParse(input);
      if (!parsed.success)
        throw new CoreError(
          "INVALID_INPUT",
          "赎回参数无效，金额必须为正整数分",
          400,
        );
      const data = parsed.data,
        inputHash = hash(data);
      return transaction(async (tx) => {
        await lock(tx, userId);
        await lockPreparationRequest(tx, schema, userId, 'investment', 'redemption', data, clock());
        const prior = (
          await tx.query(
            `SELECT * FROM ${s}.investment_actions WHERE user_id=$1 AND command_id=$2`,
            [userId, data.commandId],
          )
        ).rows[0];
        if (prior) {
          if (prior.input_hash !== inputHash)
            throw new CoreError("IDEMPOTENCY_CONFLICT", "同指令不能更改参数");
          await markPreparationPrepared(tx, schema, userId, 'investment', data.commandId, prior.id, clock());
          return view(prior);
        }
        const pos = (
          await tx.query(
            `SELECT * FROM ${s}.investment_positions WHERE id=$1 AND user_id=$2`,
            [data.positionId, userId],
          )
        ).rows[0];
        if (!pos) throw new CoreError("NOT_FOUND", "持仓不存在", 404);
        if (pos.version !== data.expectedVersion)
          throw new CoreError("STALE_POSITION", "持仓版本已变化");
        if (
          BigInt(data.amountMinor) >
          BigInt(pos.principal_minor) - BigInt(pos.reserved_minor)
        )
          throw new CoreError("INSUFFICIENT_POSITION", "可赎持仓不足");
        const p = products.find((p) => p.id === pos.product_id)!;
        const id = `investment-${randomUUID()}`,
          expires = new Date(clock().getTime() + 600000),
          due = estimateSettlementAt(clock(), p.redemptionBusinessDays);
        const taskId = data.taskId ?? `task-${data.commandId}`;
        const actionHash = hash({
          id,
          userId,
          taskId,
          ...data,
          accountId: pos.account_id,
          product: p,
          expiresAt: iso(expires),
          expectedSettlementAt: due,
        });
        const r = (
          await tx.query(
            `INSERT INTO ${s}.investment_actions(id,user_id,command_id,input_hash,provider_key,task_id,position_id,account_id,product_id,product_name,business_days,amount_minor,expected_version,action_hash,status,expires_at,expected_settlement_at,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'AWAITING_VERIFICATION',$15,$16,$17,$17) RETURNING *`,
            [
              id,
              userId,
              data.commandId,
              inputHash,
              `redeem:${id}`,
              taskId,
              pos.id,
              pos.account_id,
              p.id,
              p.name,
              p.redemptionBusinessDays,
              data.amountMinor,
              data.expectedVersion,
              actionHash,
              expires,
              due,
              clock(),
            ],
          )
        ).rows[0];
        await audit(tx, r, "REDEMPTION_PREPARED", {
          actionHash,
          amountMinor: data.amountMinor,
        });
        await markPreparationPrepared(tx, schema, userId, 'investment', data.commandId, id, clock());
        return view(r);
      });
    },
    async getAction(actor, id, options) {
      const userId = owner(actor);
      if (options?.readOnly) {
        const result = await pool.query(`SELECT * FROM ${s}.investment_actions WHERE id=$1 AND user_id=$2`, [id, userId]);
        if (!result.rows[0]) throw new CoreError("NOT_FOUND", "赎回动作不存在", 404);
        return view(result.rows[0]);
      }
      return transaction(async (tx) => {
        await lock(tx, userId);
        await expire(tx, userId);
        return view(await owned(tx, userId, id));
      });
    },
    async getByCommand(actor, commandId) {
      const userId = owner(actor);
      const result = await pool.query(
        `SELECT * FROM ${s}.investment_actions WHERE user_id=$1 AND command_id=$2`,
        [userId, commandId],
      );
      if (!result.rows[0]) throw new CoreError("COMMAND_NOT_FOUND", "赎回指令记录不存在", 404);
      // Lookup must not expire reservations, enqueue work, or contact the provider.
      return view(result.rows[0]);
    },
    async authorize(actor, id, proof) {
      const userId = owner(actor);
      if (
        !proof ||
        !["CONFIRMATION", "STRONG"].includes(proof.level) ||
        typeof proof.proofId !== "string" ||
        !proof.proofId ||
        proof.proofId.length > 256
      )
        throw new CoreError("INVALID_PROOF", "无效授权凭据", 400);
      return transaction(async (tx) => {
        await lock(tx, userId);
        await expire(tx, userId);
        const r = await owned(tx, userId, id);
        if (proof.actionHash !== r.action_hash)
          throw new CoreError("STALE_ACTION", "动作摘要不一致");
        if (
          [
            "AUTHORIZED",
            "SUBMITTING",
            "UNKNOWN",
            "SETTLING",
            "SUCCEEDED",
          ].includes(r.status)
        )
          return view(r);
        if (
          r.status !== "AWAITING_VERIFICATION" ||
          new Date(r.expires_at) <= clock()
        )
          throw new CoreError(
            "ACTION_EXPIRED_OR_NOT_PENDING",
            "动作过期或不再等待授权",
          );
        if (proof.level !== "STRONG") return view(r);
        const p = (
          await tx.query(
            `SELECT * FROM ${s}.investment_positions WHERE id=$1 AND user_id=$2 FOR UPDATE`,
            [r.position_id, userId],
          )
        ).rows[0];
        if (p.version !== r.expected_version)
          throw new CoreError("STALE_POSITION", "持仓版本已变化");
        if (
          BigInt(p.principal_minor) - BigInt(p.reserved_minor) <
          BigInt(r.amount_minor)
        )
          throw new CoreError("INSUFFICIENT_POSITION", "可赎持仓不足");
        const inserted = await tx.query(
          `INSERT INTO ${s}.investment_proofs(proof_id,user_id,action_id,action_hash,level,consumed_at) VALUES($1,$2,$3,$4,'STRONG',$5) ON CONFLICT DO NOTHING RETURNING proof_id`,
          [proof.proofId, userId, id, r.action_hash, clock()],
        );
        if (!inserted.rows[0])
          throw new CoreError("PROOF_REPLAY", "凭据已使用");
        await tx.query(
          `UPDATE ${s}.investment_positions SET reserved_minor=reserved_minor+$2 WHERE id=$1`,
          [r.position_id, r.amount_minor],
        );
        const saved = (
          await tx.query(
            `UPDATE ${s}.investment_actions SET status='AUTHORIZED',reserved=true,updated_at=$2 WHERE id=$1 RETURNING *`,
            [id, clock()],
          )
        ).rows[0];
        await enqueue(tx, id, "execute");
        await audit(tx, r, "REDEMPTION_AUTHORIZED", {
          proofId: proof.proofId,
          actionHash: r.action_hash,
        });
        return view(saved);
      });
    },
    async cancel(actor, id) {
      const userId = owner(actor);
      return transaction(async (tx) => {
        await lock(tx, userId);
        const r = await owned(tx, userId, id);
        if (!["AWAITING_VERIFICATION", "AUTHORIZED"].includes(r.status))
          throw new CoreError("INVALID_STATE", "已派发赎回不得撤销");
        if (new Date(r.expires_at) <= clock())
          throw new CoreError("ACTION_EXPIRED", "动作已过期");
        await release(tx, r);
        const saved = (
          await tx.query(
            `UPDATE ${s}.investment_actions SET status='CANCELLED',updated_at=$2 WHERE id=$1 RETURNING *`,
            [id, clock()],
          )
        ).rows[0];
        await audit(tx, r, "REDEMPTION_CANCELLED", {});
        return view(saved);
      });
    },
    async execute(id) {
      const userId = await internal(id);
      const prepared = await transaction(async (tx) => {
        await lock(tx, userId);
        await expire(tx, userId);
        const r = await owned(tx, userId, id);
        if (r.status !== "AUTHORIZED") return { row: r, submit: false };
        const saved = (
          await tx.query(
            `UPDATE ${s}.investment_actions SET status='SUBMITTING',updated_at=$2 WHERE id=$1 RETURNING *`,
            [id, clock()],
          )
        ).rows[0];
        await audit(tx, r, "REDEMPTION_DISPATCHED", {
          providerKey: r.provider_key,
        });
        return { row: saved, submit: true };
      });
      if (!prepared.submit) {
        if (["SUBMITTING", "UNKNOWN", "SETTLING"].includes(prepared.row.status))
          return service.reconcile(id);
        return view(prepared.row);
      }
      try {
        const provider = await submit(prepared.row);
        await service.processDue();
        if (provider.fault_mode === "TIMEOUT_AFTER_COMMIT")
          return unknown(id, "提供方已提交但响应丢失；仅查原单");
        return await service.reconcile(id);
      } catch (e) {
        return unknown(id, e instanceof Error ? e.message : "提供方结果未知");
      }
    },
    async reconcile(id) {
      const userId = await internal(id);
      return transaction(async (tx) => {
        await lock(tx, userId);
        const r = await owned(tx, userId, id);
        if (terminal.has(r.status)) return view(r);
        if (!["SUBMITTING", "UNKNOWN", "SETTLING"].includes(r.status))
          throw new CoreError("INVALID_STATE", "赎回尚未派发");
        const p = (
          await tx.query(
            `SELECT * FROM ${s}.provider_redemptions WHERE provider_key=$1`,
            [r.provider_key],
          )
        ).rows[0];
        if (!p) {
          const saved = (
            await tx.query(
              `UPDATE ${s}.investment_actions SET status='UNKNOWN',failure_reason='查原单尚无终态；禁止重发',updated_at=$2 WHERE id=$1 RETURNING *`,
              [id, clock()],
            )
          ).rows[0];
          await enqueue(tx, id, "reconcile", delay);
          return view(saved);
        }
        if (
          p.request_hash !== r.input_hash ||
          p.user_id !== userId ||
          p.account_id !== r.account_id ||
          p.position_id !== r.position_id ||
          p.product_id !== r.product_id ||
          String(p.amount_minor) !== String(r.amount_minor) ||
          !Number.isFinite(new Date(p.accepted_at).getTime()) ||
          new Date(p.accepted_at) > clock() ||
          !Number.isFinite(new Date(p.due_at).getTime()) ||
          iso(p.due_at) !==
            estimateSettlementAt(new Date(p.accepted_at), r.business_days)
        )
          throw new CoreError("INVALID_RECEIPT", "提供方原单与请求不一致");
        if (p.status === "REJECTED") {
          await release(tx, r);
          const saved = (
            await tx.query(
              `UPDATE ${s}.investment_actions SET status='FAILED',failure_reason='提供方明确拒绝',updated_at=$2 WHERE id=$1 RETURNING *`,
              [id, clock()],
            )
          ).rows[0];
          await audit(tx, r, "REDEMPTION_REJECTED", {});
          return view(saved);
        }
        if (p.status === "ACCEPTED") {
          const saved = (
            await tx.query(
              `UPDATE ${s}.investment_actions SET status='SETTLING',accepted_at=$2,expected_settlement_at=$3,failure_reason=NULL,updated_at=$4 WHERE id=$1 RETURNING *`,
              [id, p.accepted_at, p.due_at, clock()],
            )
          ).rows[0];
          await enqueue(tx, id, "reconcile", delay);
          return view(saved);
        }
        const receipt = p.receipt as InvestmentReceipt;
        const entries = await tx.query(
          `SELECT side,account_id,amount_minor FROM ${s}.redemption_entries WHERE provider_key=$1`,
          [r.provider_key],
        );
        if (
          !receipt ||
          receipt.providerRequestId !== r.provider_key ||
          receipt.positionId !== r.position_id ||
          receipt.accountId !== r.account_id ||
          receipt.amountMinor !== String(r.amount_minor) ||
          receipt.currency !== "CNY" ||
          !receipt.providerTransactionId ||
          !Number.isFinite(Date.parse(receipt.settledAt)) ||
          new Date(receipt.settledAt) > clock() ||
          new Date(receipt.settledAt) < new Date(p.due_at) ||
          entries.rows.length !== 2 ||
          !entries.rows.some(
            (e) =>
              e.side === "CREDIT" &&
              e.account_id === r.account_id &&
              String(e.amount_minor) === String(r.amount_minor),
          ) ||
          !entries.rows.some(
            (e) =>
              e.side === "DEBIT" &&
              e.account_id === `investment-fund:${r.position_id}` &&
              String(e.amount_minor) === String(r.amount_minor),
          )
        )
          throw new CoreError("INVALID_RECEIPT", "到账回执或双边分录无效");
        await tx.query(
          `UPDATE ${s}.accounts SET balance_minor=balance_minor+$2 WHERE id=$1 AND user_id=$3`,
          [r.account_id, r.amount_minor, userId],
        );
        await tx.query(
          `UPDATE ${s}.investment_positions SET principal_minor=principal_minor-$2,reserved_minor=reserved_minor-$2,version=version+1 WHERE id=$1 AND user_id=$3`,
          [r.position_id, r.amount_minor, userId],
        );
        const saved = (
          await tx.query(
            `UPDATE ${s}.investment_actions SET status='SUCCEEDED',reserved=false,receipt=$2,accepted_at=$3,expected_settlement_at=$4,failure_reason=NULL,updated_at=$5 WHERE id=$1 RETURNING *`,
            [id, JSON.stringify(receipt), p.accepted_at, p.due_at, clock()],
          )
        ).rows[0];
        await audit(tx, r, "REDEMPTION_SUCCEEDED", {
          receiptHash: hash(receipt),
          providerKey: r.provider_key,
        });
        return view(saved);
      });
    },
    async processDue() {
      const due = await pool.query(
        `SELECT provider_key,account_id FROM ${s}.provider_redemptions WHERE status='ACCEPTED' AND due_at<=$1 ORDER BY due_at LIMIT 100`,
        [clock()],
      );
      for (const item of due.rows)
        await transaction(async (tx) => {
          await providerLock(tx, item.account_id);
          const p = (
            await tx.query(
              `SELECT * FROM ${s}.provider_redemptions WHERE provider_key=$1 FOR UPDATE`,
              [item.provider_key],
            )
          ).rows[0];
          if (p.status !== "ACCEPTED" || new Date(p.due_at) > clock()) return;
          const receipt: InvestmentReceipt = {
            providerRequestId: p.provider_key,
            providerTransactionId: `sim-redemption-${randomUUID()}`,
            positionId: p.position_id,
            accountId: p.account_id,
            amountMinor: String(p.amount_minor),
            currency: "CNY",
            settledAt: clock().toISOString(),
          };
          await tx.query(
            `UPDATE ${s}.provider_accounts SET balance_minor=balance_minor-$2 WHERE id=$1`,
            [`investment-fund:${p.position_id}`, p.amount_minor],
          );
          await tx.query(
            `UPDATE ${s}.provider_accounts SET balance_minor=balance_minor+$2 WHERE id=$1`,
            [p.account_id, p.amount_minor],
          );
          await tx.query(
            `UPDATE ${s}.provider_positions SET principal_minor=principal_minor-$2 WHERE id=$1`,
            [p.position_id, p.amount_minor],
          );
          await tx.query(
            `INSERT INTO ${s}.redemption_entries(provider_key,account_id,side,amount_minor) VALUES($1,$2,'DEBIT',$4),($1,$3,'CREDIT',$4)`,
            [
              p.provider_key,
              `investment-fund:${p.position_id}`,
              p.account_id,
              p.amount_minor,
            ],
          );
          await tx.query(
            `UPDATE ${s}.provider_redemptions SET status='SETTLED',receipt=$2 WHERE provider_key=$1`,
            [p.provider_key, JSON.stringify(receipt)],
          );
        });
    },
    async timeline(actor, input = {}) {
      const userId = owner(actor),
        days = input.days ?? 30;
      if (!Number.isSafeInteger(days) || days < 1 || days > 90)
        throw new CoreError("INVALID_INPUT", "时间线天数须为1至90", 400);
      return transaction(async (tx) => {
        await lock(tx, userId);
        const funds = await readFunds(
          tx,
          schema,
          userId,
          input.accountId,
          "0",
          clock(),
        );
        const p = funds.preview,
          rows = (
            await tx.query(
              `SELECT * FROM ${s}.investment_actions WHERE user_id=$1 AND account_id=$2 AND status IN ('SETTLING','UNKNOWN','SUBMITTING')`,
              [userId, p.accountId],
            )
          ).rows;
        const today = day(clock());
        let projected = BigInt(p.balanceMinor) - BigInt(p.reservedMinor),
          conservative = projected;
        const items: FundsTimeline["days"] = [];
        for (let n = 0; n < days; n++) {
          const date = new Date(
            new Date(`${today}T00:00:00Z`).getTime() + n * 86400000,
          )
            .toISOString()
            .slice(0, 10);
          const events: FundsTimeline["days"][number]["events"] = [];
          let income = 0n,
            out = 0n;
          for (const o of funds.policy.obligations) {
            if (o.dueDate === date || (n === 0 && o.dueDate < today)) {
              out += BigInt(o.amountMinor);
              events.push({
                id: `obligation:${o.id}`,
                kind: "OBLIGATION",
                amountMinor: o.amountMinor,
                sourceId: o.id,
                title: o.title,
                certainty: "EXPECTED",
              });
            }
          }
          for (const r of rows) {
            const expected = day(new Date(r.expected_settlement_at));
            if (
              (r.status === "SETTLING" &&
                (expected === date || (n === 0 && expected < today))) ||
              (r.status !== "SETTLING" && n === 0)
            ) {
              const uncertain = r.status !== "SETTLING";
              if (!uncertain) income += BigInt(r.amount_minor);
              events.push({
                id: `redemption:${r.id}`,
                kind: uncertain
                  ? "UNCERTAIN_REDEMPTION"
                  : "REDEMPTION_EXPECTED",
                amountMinor: String(r.amount_minor),
                sourceId: r.id,
                title: r.product_name,
                certainty: uncertain ? "UNCERTAIN" : "EXPECTED",
              });
            }
          }
          projected += income - out;
          conservative -= out;
          items.push({
            date,
            expectedInMinor: income.toString(),
            obligationsDueMinor: out.toString(),
            projectedCashMinor: projected.toString(),
            conservativeCashMinor: conservative.toString(),
            protectedHeadroomMinor: (
              projected - BigInt(funds.policy.minimumBalanceMinor)
            ).toString(),
            events,
          });
        }
        return {
          asOf: clock().toISOString(),
          timezone: "Asia/Shanghai",
          calendar,
          accountId: p.accountId,
          balanceMinor: p.balanceMinor,
          reservedTransferMinor: p.reservedMinor,
          minimumBalanceMinor: funds.policy.minimumBalanceMinor,
          spendableNowMinor: p.spendableMinor,
          days: items,
          warnings: [
            "仅合成工作日日历，未纳入中国法定节假日。",
            "预计赎回不是当前可用余额；未知结果不计预计流入。",
            "时间线为不落账预演，未自动支付义务；保守线不计未来收入。",
          ],
        };
      });
    },
    async setNextFault(actor, mode) {
      const userId = owner(actor);
      if (!["NORMAL", "REJECT", "TIMEOUT_AFTER_COMMIT"].includes(mode))
        throw new CoreError("INVALID_INPUT", "无效故障模式", 400);
      await transaction(async (tx) => {
        await lock(tx, userId);
        await tx.query(
          `INSERT INTO ${s}.investment_faults(user_id,mode) VALUES($1,$2) ON CONFLICT(user_id) DO UPDATE SET mode=EXCLUDED.mode`,
          [userId, mode],
        );
      });
    },
  };
  investmentRuntime.set(service, { schema });
  return service;
}
