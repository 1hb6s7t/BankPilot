import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCore, createFinance } from '../packages/core/src/index';
import type { FinanceService } from '../packages/contracts/src/index';

const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL ?? 'postgres://bankpilot:bankpilot-local@127.0.0.1:55432/bankpilot' });
const actor = { userId: 'coverage-user' }, other = { userId: 'coverage-other' };
let schema: string, now: Date, finance: FinanceService;
beforeEach(async () => {
  schema = `billcoverage_${randomUUID().replaceAll('-', '').slice(0, 12)}`; now = new Date('2026-10-23T06:00:00Z');
  const core = createCore(pool, { schema, clock: () => now });
  finance = createFinance(pool, { schema, clock: () => now });
  await core.migrate(); await core.seedDemo(actor); await core.seedDemo(other); await finance.seedDemo(actor);
});
afterEach(async () => { await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); });
afterAll(async () => { await pool.end(); });

describe('statement availability comes from actor-scoped provenance, not zero aggregates', () => {
  it('distinguishes a complete previous fixture, an as-of fixture, and an unprovided month', async () => {
    expect((await finance.billReport(actor, '2026-09')).coverage?.status).toBe('complete');
    expect((await finance.billReport(actor, '2026-10')).coverage).toEqual({ status: 'partial', through: now.toISOString() });
    expect(await finance.billReport(actor, '2026-08')).toMatchObject({ expenseMinor: '0', coverage: { status: 'missing' } });
  });
  it('does not promote an old partial snapshot to a complete statement when the clock advances', async () => {
    now = new Date('2026-11-02T06:00:00Z');
    expect((await finance.billReport(actor, '2026-10')).coverage?.status).toBe('partial');
  });
  it('does not borrow another user coverage and does not count future transactions as data', async () => {
    expect((await finance.billReport(other, '2026-09')).coverage?.status).toBe('missing');
    await pool.query(`INSERT INTO "${schema}".bill_transactions(id,user_id,account_id,booked_at,merchant,amount_minor,direction,category) VALUES('future',$1,$2,'2026-11-03T00:00:00Z','未到收入',10000,'IN','收入')`, [actor.userId, `acc-main-${actor.userId}`]);
    expect(await finance.billReport(actor, '2026-11')).toMatchObject({ incomeMinor: '0', coverage: { status: 'missing' } });
  });
  it('marks isolated known transactions without a complete statement as partial', async () => {
    await pool.query(`INSERT INTO "${schema}".bill_transactions(id,user_id,account_id,booked_at,merchant,amount_minor,direction,category) VALUES('known',$1,$2,'2026-08-03T00:00:00Z','已提供流水',1234,'OUT','购物')`, [actor.userId, `acc-main-${actor.userId}`]);
    expect(await finance.billReport(actor, '2026-08')).toMatchObject({ expenseMinor: '1234', coverage: { status: 'partial' } });
  });
});
