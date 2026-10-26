import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { beforeEach, afterEach, afterAll, describe, it, expect } from "vitest";
import {
  createCore,
  createFinance,
  createInvestment,
  estimateSettlementAt,
  startWorker,
} from "../packages/core/src/index.js";
import type {
  CoreService,
  FinanceService,
  InvestmentService,
  InvestmentAction,
} from "../packages/contracts/src/index.js";

const pool = new Pool({
  connectionString:
    process.env.TEST_DATABASE_URL ??
    "postgres://bankpilot:bankpilot-local@127.0.0.1:55432/bankpilot",
  max: 15,
});
const actor = { userId: "investment-owner" },
  other = { userId: "investment-other" };
let schema: string,
  now: Date,
  core: CoreService,
  finance: FinanceService,
  investment: InvestmentService;
const prepare = async (
  amountMinor = "100000",
  productId = "synthetic-t0",
  commandId = randomUUID(),
) => {
  const position = (await investment.dashboard(actor)).positions.find(
    (p) => p.productId === productId,
  )!;
  return investment.prepare(actor, {
    commandId,
    positionId: position.id,
    amountMinor,
    expectedVersion: position.version,
  });
};
const approve = (
  action: InvestmentAction,
  level: "STRONG" | "CONFIRMATION" = "STRONG",
  proofId = randomUUID(),
) =>
  investment.authorize(actor, action.id, {
    level,
    proofId,
    actionHash: action.actionHash,
  });
const cash = async () => {
  const r = await pool.query(
    `SELECT a.balance_minor::text AS local,p.balance_minor::text AS provider FROM "${schema}".accounts a JOIN "${schema}".provider_accounts p ON a.id=p.id WHERE a.user_id=$1`,
    [actor.userId],
  );
  return r.rows[0];
};
const count = async (table: string) =>
  (await pool.query(`SELECT count(*)::int AS n FROM "${schema}".${table}`))
    .rows[0].n;
beforeEach(async () => {
  schema = `investtest_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  now = new Date("2026-10-23T08:00:00Z");
  core = createCore(pool, { schema, clock: () => now });
  finance = createFinance(pool, { schema, clock: () => now });
  investment = createInvestment(pool, {
    schema,
    clock: () => now,
    reconcileDelayMs: 10,
  });
  await core.migrate();
  await core.seedDemo(actor);
  await core.seedDemo(other);
  await investment.migrate();
  await investment.seedDemo(actor);
  await investment.seedDemo(other);
});
afterEach(async () => {
  await pool.query(`DROP SCHEMA IF EXISTS "${schema}_jobs" CASCADE`);
  await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
});
afterAll(async () => {
  await pool.end();
});

describe("synthetic investment redemption with independent provider settlement", () => {
  it("estimates explicit weekday calendar across weekends, years and Shanghai midnight", () => {
    expect(estimateSettlementAt(new Date("2026-10-23T08:00:00Z"), 1)).toBe(
      "2026-10-26T08:00:00.000Z",
    );
    expect(estimateSettlementAt(new Date("2026-10-24T08:00:00Z"), 0)).toBe(
      "2026-10-26T08:00:00.000Z",
    );
    expect(estimateSettlementAt(new Date("2026-12-31T08:00:00Z"), 2)).toBe(
      "2027-01-04T08:00:00.000Z",
    );
    expect(estimateSettlementAt(new Date("2026-10-23T16:00:00Z"), 0)).toBe(
      "2026-10-25T16:00:00.000Z",
    );
    expect(() => estimateSettlementAt(new Date(), -1)).toThrow();
  });
  it("seeds principal independently of cash, validates integer inputs and binds owner/idempotency/hash", async () => {
    await investment.seedDemo(actor);
    expect(await cash()).toEqual({ local: "800000", provider: "800000" });
    expect(
      (await investment.dashboard(actor)).positions.map(
        (p) => p.principalMinor,
      ),
    ).toEqual(["500000", "1000000"]);
    const commandId = randomUUID(),
      action = await prepare("12345", "synthetic-t0", commandId);
    expect(action).toMatchObject({
      status: "AWAITING_VERIFICATION",
      tier: "RED",
      feeMinor: "0",
      netAmountMinor: "12345",
    });
    expect((await prepare("12345", "synthetic-t0", commandId)).id).toBe(
      action.id,
    );
    await expect(
      prepare("12346", "synthetic-t0", commandId),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    for (const amount of ["0", "-1", "1.2", "01", "1000000000000"])
      await expect(prepare(amount)).rejects.toMatchObject({
        code: "INVALID_INPUT",
      });
    await expect(investment.getAction(other, action.id)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(
      investment.authorize(other, action.id, {
        level: "STRONG",
        proofId: randomUUID(),
        actionHash: action.actionHash,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await approve(action, "CONFIRMATION")).status).toBe(
      "AWAITING_VERIFICATION",
    );
    expect(await count("investment_proofs")).toBe(0);
    await expect(
      investment.authorize(actor, action.id, {
        level: "STRONG",
        proofId: randomUUID(),
        actionHash: "0".repeat(64),
      }),
    ).rejects.toMatchObject({ code: "STALE_ACTION" });
  });
  it("atomically reserves positions across concurrent approvals; proofs and retries do not double reserve", async () => {
    const a = await prepare("400000"),
      b = await prepare("400000");
    const results = await Promise.allSettled([approve(a), approve(b)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(
      (results.find((r) => r.status === "rejected") as PromiseRejectedResult)
        .reason.code,
    ).toBe("INSUFFICIENT_POSITION");
    const winner = (
      results.find(
        (r) => r.status === "fulfilled",
      ) as PromiseFulfilledResult<InvestmentAction>
    ).value;
    await approve(winner);
    expect((await investment.dashboard(actor)).positions[0].reservedMinor).toBe(
      "400000",
    );
    expect(await count("investment_proofs")).toBe(1);
    await investment.cancel(actor, winner.id);
    expect((await investment.dashboard(actor)).positions[0].reservedMinor).toBe(
      "0",
    );
    const fresh = await prepare("100000"),
      another = await prepare("100000"),
      proof = randomUUID();
    await approve(fresh, "STRONG", proof);
    await expect(approve(another, "STRONG", proof)).rejects.toMatchObject({
      code: "PROOF_REPLAY",
    });
  });
  it("T+0 uses actual provider double entry, credits both cash mirrors once and enables subsequent transfer", async () => {
    const action = await prepare();
    await approve(action);
    expect(await cash()).toEqual({ local: "800000", provider: "800000" });
    const result = await investment.execute(action.id);
    expect(result.status).toBe("SUCCEEDED");
    expect(result.receipt).toMatchObject({
      amountMinor: "100000",
      accountId: `acc-main-${actor.userId}`,
    });
    await Promise.all([
      investment.execute(action.id),
      investment.reconcile(action.id),
      investment.processDue(),
    ]);
    expect(await cash()).toEqual({ local: "900000", provider: "900000" });
    expect(await count("redemption_entries")).toBe(2);
    expect((await investment.dashboard(actor)).positions[0]).toMatchObject({
      principalMinor: "400000",
      reservedMinor: "0",
      version: 2,
    });
    const transfer = await core.createTransfer(actor, {
      commandId: randomUUID(),
      accountId: `acc-main-${actor.userId}`,
      payeeId: "payee-lin",
      amountMinor: "850000",
      memo: "",
    });
    await core.authorize(actor, transfer.id, {
      level: "STRONG",
      proofId: randomUUID(),
      actionHash: transfer.actionHash,
    });
    expect((await core.execute(transfer.id)).status).toBe("SUCCEEDED");
    expect(await cash()).toEqual({ local: "50000", provider: "50000" });
  });
  it("T+2 stays unavailable until maturity and timeline projections do not authorize spending", async () => {
    const action = await prepare("300000", "synthetic-t2");
    await approve(action);
    const result = await investment.execute(action.id);
    expect(result.status).toBe("SETTLING");
    expect(result.expectedSettlementAt).toBe("2026-10-27T08:00:00.000Z");
    const timeline = await investment.timeline(actor, { days: 6 });
    expect(
      timeline.days.find((d) => d.date === "2026-10-27")!.expectedInMinor,
    ).toBe("300000");
    expect(timeline.spendableNowMinor).toBe("800000");
    expect(
      (await finance.funds(actor, undefined, "900000")).preview.allowed,
    ).toBe(false);
    expect(await cash()).toEqual({ local: "800000", provider: "800000" });
    now = new Date("2026-10-27T07:59:59Z");
    await investment.processDue();
    expect((await investment.reconcile(action.id)).status).toBe("SETTLING");
    now = new Date("2026-10-27T08:00:00Z");
    await Promise.all([investment.processDue(), investment.processDue()]);
    expect(await cash()).toEqual({ local: "800000", provider: "1100000" });
    expect((await investment.reconcile(action.id)).status).toBe("SUCCEEDED");
    expect(await cash()).toEqual({ local: "1100000", provider: "1100000" });
    expect(
      (await investment.timeline(actor)).days.every(
        (d) => d.expectedInMinor === "0",
      ),
    ).toBe(true);
  });
  it("post-commit response loss is UNKNOWN; original-query recovery never double credits or cancels reservations", async () => {
    const action = await prepare();
    await approve(action);
    await investment.setNextFault(actor, "TIMEOUT_AFTER_COMMIT");
    expect((await investment.execute(action.id)).status).toBe("UNKNOWN");
    expect(await cash()).toEqual({ local: "800000", provider: "900000" });
    expect((await investment.timeline(actor)).days[0]).toMatchObject({
      expectedInMinor: "0",
    });
    expect((await investment.timeline(actor)).days[0].events[0].kind).toBe(
      "UNCERTAIN_REDEMPTION",
    );
    await expect(investment.cancel(actor, action.id)).rejects.toMatchObject({
      code: "INVALID_STATE",
    });
    expect((await investment.dashboard(actor)).positions[0].reservedMinor).toBe(
      "100000",
    );
    await Promise.all([
      investment.execute(action.id),
      investment.reconcile(action.id),
      investment.reconcile(action.id),
    ]);
    expect(await cash()).toEqual({ local: "900000", provider: "900000" });
    expect(await count("provider_redemptions")).toBe(1);
    expect(await count("redemption_entries")).toBe(2);
  });
  it("recovered SUBMITTING with no provider record stays UNKNOWN and never resubmits", async () => {
    const action = await prepare();
    await approve(action);
    await pool.query(
      `UPDATE "${schema}".investment_actions SET status='SUBMITTING' WHERE id=$1`,
      [action.id],
    );
    for (let n = 0; n < 3; n++)
      expect((await investment.execute(action.id)).status).toBe("UNKNOWN");
    expect(await count("provider_redemptions")).toBe(0);
    expect(await count("redemption_entries")).toBe(0);
    expect((await investment.dashboard(actor)).positions[0].reservedMinor).toBe(
      "100000",
    );
  });
  it("serializes simultaneous transfer debits and redemption credits without losing either mirror update", async () => {
    const redemption = await prepare("300000");
    await approve(redemption);
    const transfer = await core.createTransfer(actor, {
      commandId: randomUUID(),
      accountId: `acc-main-${actor.userId}`,
      payeeId: "payee-lin",
      amountMinor: "100000",
      memo: "",
    });
    await core.authorize(actor, transfer.id, {
      level: "STRONG",
      proofId: randomUUID(),
      actionHash: transfer.actionHash,
    });
    const results = await Promise.all([
      core.execute(transfer.id),
      investment.execute(redemption.id),
    ]);
    expect(results.every((r) => r.status === "SUCCEEDED")).toBe(true);
    expect(await cash()).toEqual({ local: "1000000", provider: "1000000" });
    expect(await count("redemption_entries")).toBe(2);
    expect(await count("provider_entries")).toBe(2);
  });
  it("unknown acceptance of T+2 is excluded from income until original-order query confirms acceptance", async () => {
    const redemption = await prepare("200000", "synthetic-t2");
    await approve(redemption);
    await investment.setNextFault(actor, "TIMEOUT_AFTER_COMMIT");
    expect((await investment.execute(redemption.id)).status).toBe("UNKNOWN");
    expect(
      (await investment.timeline(actor, { days: 6 })).days.every(
        (d) => d.expectedInMinor === "0",
      ),
    ).toBe(true);
    expect((await investment.reconcile(redemption.id)).status).toBe("SETTLING");
    expect(
      (await investment.timeline(actor, { days: 6 })).days.find(
        (d) => d.date === "2026-10-27",
      )!.expectedInMinor,
    ).toBe("200000");
    expect(await cash()).toEqual({ local: "800000", provider: "800000" });
    expect(await count("redemption_entries")).toBe(0);
  });
  it("provider rejection releases reservation without credit; expiry prevents dispatch", async () => {
    const action = await prepare();
    await approve(action);
    await investment.setNextFault(actor, "REJECT");
    expect((await investment.execute(action.id)).status).toBe("FAILED");
    expect((await investment.dashboard(actor)).positions[0].reservedMinor).toBe(
      "0",
    );
    expect(await count("redemption_entries")).toBe(0);
    const expired = await prepare();
    await approve(expired);
    now = new Date(expired.expiresAt);
    expect((await investment.execute(expired.id)).status).toBe("EXPIRED");
    expect((await investment.dashboard(actor)).positions[0].reservedMinor).toBe(
      "0",
    );
    expect(await cash()).toEqual({ local: "800000", provider: "800000" });
  });
  it("stale position version cannot authorize after another redemption settles", async () => {
    const stale = await prepare(),
      completed = await prepare();
    await approve(completed);
    await investment.execute(completed.id);
    await expect(approve(stale)).rejects.toMatchObject({
      code: "STALE_POSITION",
    });
    expect(await count("investment_proofs")).toBe(1);
  });
  it("cash projection subtracts transfer holds and overdue obligations once; reads are isolated and side effect free", async () => {
    await finance.updatePolicy(actor, {
      expectedVersion: 0,
      minimumBalanceMinor: "200000",
      obligations: [
        {
          id: "past",
          title: "逾期待付",
          amountMinor: "10000",
          dueDate: "2026-10-20",
        },
        {
          id: "future",
          title: "未来义务",
          amountMinor: "20000",
          dueDate: "2026-10-25",
        },
      ],
    });
    const transfer = await core.createTransfer(actor, {
      commandId: randomUUID(),
      accountId: `acc-main-${actor.userId}`,
      payeeId: "payee-lin",
      amountMinor: "50000",
      memo: "",
    });
    await core.authorize(actor, transfer.id, {
      level: "CONFIRMATION",
      proofId: randomUUID(),
      actionHash: transfer.actionHash,
    });
    const before = await count("audit_events"),
      timeline = await investment.timeline(actor, { days: 4 });
    expect(timeline).toMatchObject({
      balanceMinor: "800000",
      reservedTransferMinor: "50000",
      minimumBalanceMinor: "200000",
      spendableNowMinor: "520000",
    });
    expect(timeline.days[0]).toMatchObject({
      obligationsDueMinor: "10000",
      projectedCashMinor: "740000",
      protectedHeadroomMinor: "540000",
    });
    expect(timeline.days[2]).toMatchObject({
      obligationsDueMinor: "20000",
      conservativeCashMinor: "720000",
    });
    await expect(
      investment.timeline(other, { accountId: `acc-main-${actor.userId}` }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await count("audit_events")).toBe(before);
    expect(await cash()).toEqual({ local: "800000", provider: "800000" });
  });
  it("local audit failure rolls back mirror credit and holding consumption, then query recovery settles once", async () => {
    const action = await prepare();
    await approve(action);
    await pool.query(
      `ALTER TABLE "${schema}".audit_events ADD CONSTRAINT reject_redemption_audit CHECK(type<>'REDEMPTION_SUCCEEDED') NOT VALID`,
    );
    // First reconciliation is awaited inside execute: a local commit failure is
    // recoverable UNKNOWN, while the provider receipt and reservation stay intact.
    const unknown = await investment.execute(action.id);
    expect(unknown.status).toBe("UNKNOWN");
    expect(unknown.failureReason).toContain("reject_redemption_audit");
    expect((await pool.query(`SELECT kind FROM "${schema}".investment_outbox WHERE action_id=$1 AND kind='reconcile'`, [action.id])).rows).toEqual([{ kind: "reconcile" }]);
    expect((await pool.query(`SELECT type FROM "${schema}".audit_events WHERE action_id=$1 AND type='REDEMPTION_UNKNOWN'`, [action.id])).rows).toEqual([{ type: "REDEMPTION_UNKNOWN" }]);
    expect(await count("provider_redemptions")).toBe(1);
    expect(await cash()).toEqual({ local: "800000", provider: "900000" });
    expect((await investment.dashboard(actor)).positions[0]).toMatchObject({
      principalMinor: "500000",
      reservedMinor: "100000",
    });
    await pool.query(
      `ALTER TABLE "${schema}".audit_events DROP CONSTRAINT reject_redemption_audit`,
    );
    expect((await investment.reconcile(action.id)).status).toBe("SUCCEEDED");
    expect(await cash()).toEqual({ local: "900000", provider: "900000" });
    expect(await count("redemption_entries")).toBe(2);
  });
  it("rejects corrupted receipt without crediting local cash", async () => {
    const action = await prepare();
    await approve(action);
    await investment.setNextFault(actor, "TIMEOUT_AFTER_COMMIT");
    await investment.execute(action.id);
    await pool.query(
      `UPDATE "${schema}".provider_redemptions SET receipt=jsonb_set(receipt,'{amountMinor}','"999999"')`,
    );
    await expect(investment.reconcile(action.id)).rejects.toMatchObject({
      code: "INVALID_RECEIPT",
    });
    expect(await cash()).toEqual({ local: "800000", provider: "900000" });
  });
  it.each([
    "future",
    "before-due",
    "future-acceptance",
    "wrong-product",
    "early-due",
  ] as const)(
    "rejects %s provider timing or identity evidence without local credit",
    async (mode) => {
      const action = await prepare("100000", "synthetic-t2");
      await approve(action);
      await investment.execute(action.id);
      now = new Date("2026-10-27T08:00:00Z");
      await investment.processDue();
      if (mode === "future" || mode === "before-due") {
        const settledAt = new Date(
          now.getTime() + (mode === "future" ? 60000 : -60000),
        ).toISOString();
        await pool.query(
          `UPDATE "${schema}".provider_redemptions SET receipt=jsonb_set(receipt,'{settledAt}',to_jsonb($1::text))`,
          [settledAt],
        );
      } else if (mode === "future-acceptance")
        await pool.query(
          `UPDATE "${schema}".provider_redemptions SET accepted_at=$1`,
          [new Date(now.getTime() + 60000)],
        );
      else if (mode === "wrong-product")
        await pool.query(
          `UPDATE "${schema}".provider_redemptions SET product_id='synthetic-t0'`,
        );
      else
        await pool.query(
          `UPDATE "${schema}".provider_redemptions SET due_at=accepted_at`,
        );
      await expect(investment.reconcile(action.id)).rejects.toMatchObject({
        code: "INVALID_RECEIPT",
      });
      expect(await cash()).toEqual({ local: "800000", provider: "900000" });
      expect(
        (await investment.dashboard(actor)).positions.find(
          (p) => p.productId === "synthetic-t2",
        )!,
      ).toMatchObject({ principalMinor: "1000000", reservedMinor: "100000" });
    },
  );
  it("uses real pg-boss/outbox worker for T+0 without a special cash mutation path", async () => {
    const action = await prepare();
    await approve(action);
    // Queue delivery uses wall time; the provider clock remains a deterministic business Friday.
    await pool.query(
      `UPDATE "${schema}".investment_outbox SET available_at=now()`,
    );
    const worker = await startWorker(pool, core, investment);
    try {
      const deadline = Date.now() + 10000;
      let result = await investment.getAction(actor, action.id);
      while (result.status !== "SUCCEEDED" && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
        result = await investment.getAction(actor, action.id);
      }
      expect(result.status).toBe("SUCCEEDED");
      expect(worker.errors).toEqual([]);
      expect(await count("redemption_entries")).toBe(2);
    } finally {
      await worker.stop();
    }
  }, 15000);
});
