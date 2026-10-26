import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createCore, createInvestment, estimateSettlementAt } from '../packages/core/src/index.js';
import type { InvestmentService, CoreService } from '../packages/contracts/src/index.js';

const connectionString=process.env.TEST_DATABASE_URL??'postgres://bankpilot:bankpilot-local@127.0.0.1:55432/bankpilot';
if(!['localhost','127.0.0.1','[::1]'].includes(new URL(connectionString).hostname))throw new Error('G8H_INVESTMENT_DATABASE_MUST_BE_LOCAL');
const id=randomUUID().replaceAll('-','').slice(0,16);
const pool=new Pool({connectionString,max:6,application_name:`g8h_acceptance_${id}`});
const actor={userId:`g8h-acceptance-${id}`};
let schema:string,core:CoreService,investment:InvestmentService,now:number,tick:number;
beforeEach(async()=>{
 schema=`g8h_accept_${randomUUID().replaceAll('-','').slice(0,16)}`;now=Date.parse('2026-10-23T08:00:00.000Z');tick=0;
 const clock=()=>{const value=new Date(now);now+=tick;return value;};
 core=createCore(pool,{schema,clock});await core.migrate();await core.seedDemo(actor);
 investment=createInvestment(pool,{schema,clock});await investment.migrate();await investment.seedDemo(actor);
});
afterEach(async()=>{vi.restoreAllMocks();await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);expect((await pool.query('SELECT to_regnamespace($1) IS NULL AS gone',[schema])).rows[0].gone).toBe(true);});
afterAll(async()=>{await pool.end();});
async function authorized(days:number){
 const position=(await investment.dashboard(actor)).positions.find(p=>p.redemptionBusinessDays===days)!;
 const action=await investment.prepare(actor,{commandId:randomUUID(),positionId:position.id,amountMinor:'100000',expectedVersion:position.version});
 await investment.authorize(actor,action.id,{level:'STRONG',proofId:randomUUID(),actionHash:action.actionHash});return action;
}
it.each([0,2])('uses one acceptance instant for T+%i with a clock advancing on every read',async days=>{
 tick=1;const action=await authorized(days);
 const result=await investment.execute(action.id);
 expect(result.status).toBe(days===0?'SUCCEEDED':'SETTLING');
 const provider=(await pool.query(`SELECT * FROM "${schema}".provider_redemptions WHERE provider_key=$1`,[`redeem:${action.id}`])).rows[0];
 expect(provider.due_at.toISOString()).toBe(estimateSettlementAt(provider.accepted_at,days));
 if(days===2){
  expect((await core.dashboard(actor)).accounts[0]!.balanceMinor).toBe('800000');
  expect((await investment.dashboard(actor)).positions.find(p=>p.id===action.positionId)!.reservedMinor).toBe('100000');
  now=provider.due_at.getTime()+1000;await investment.processDue();expect((await investment.reconcile(action.id)).status).toBe('SUCCEEDED');
 }
 expect((await core.dashboard(actor)).accounts[0]!.balanceMinor).toBe('900000');
 expect((await investment.reconcile(action.id)).status).toBe('SUCCEEDED');
 expect((await pool.query(`SELECT count(*)::int AS n FROM "${schema}".provider_redemptions`)).rows[0].n).toBe(1);
 expect((await pool.query(`SELECT count(*)::int AS n FROM "${schema}".redemption_entries`)).rows[0].n).toBe(2);
});
it('records an asynchronous first reconciliation failure as UNKNOWN and recovers only the original settled request',async()=>{
 const action=await authorized(0),failure=new Error('CONTROLLED_ASYNC_RECONCILIATION_FAILURE');
 const reconcile=vi.spyOn(investment,'reconcile').mockRejectedValueOnce(failure);
 const uncertain=await investment.execute(action.id);
 expect(reconcile).toHaveBeenCalledExactlyOnceWith(action.id);reconcile.mockRestore();
 expect(uncertain.status).toBe('UNKNOWN');expect(uncertain.failureReason).toBe(failure.message);
 const before=await investment.dashboard(actor);
 expect(before.positions.find(p=>p.id===action.positionId)!.reservedMinor).toBe('100000');
 expect((await core.dashboard(actor)).accounts[0]!.balanceMinor).toBe('800000');
 const provider=(await pool.query(`SELECT * FROM "${schema}".provider_redemptions`)).rows;
 expect(provider).toHaveLength(1);expect(provider[0].status).toBe('SETTLED');
 expect((await pool.query(`SELECT * FROM "${schema}".investment_outbox WHERE action_id=$1 AND kind='reconcile'`,[action.id])).rows).toHaveLength(1);
 expect((await pool.query(`SELECT * FROM "${schema}".audit_events WHERE action_id=$1 AND type='REDEMPTION_UNKNOWN'`,[action.id])).rows).toHaveLength(1);
 const receipt=provider[0].receipt;
 expect((await investment.reconcile(action.id)).receipt).toEqual(receipt);
 expect((await investment.execute(action.id)).receipt).toEqual(receipt);
 expect((await core.dashboard(actor)).accounts[0]!.balanceMinor).toBe('900000');
 expect((await investment.dashboard(actor)).positions.find(p=>p.id===action.positionId)!.reservedMinor).toBe('0');
 expect((await pool.query(`SELECT count(*)::int AS n FROM "${schema}".provider_redemptions`)).rows[0].n).toBe(1);
 expect((await pool.query(`SELECT count(*)::int AS n FROM "${schema}".redemption_entries`)).rows[0].n).toBe(2);
});
it('still rejects a tampered provider due date without releasing reservations or crediting cash',async()=>{
 const action=await authorized(2);expect((await investment.execute(action.id)).status).toBe('SETTLING');
 await pool.query(`UPDATE "${schema}".provider_redemptions SET due_at=due_at+interval '1 millisecond' WHERE provider_key=$1`,[`redeem:${action.id}`]);
 await expect(investment.reconcile(action.id)).rejects.toMatchObject({code:'INVALID_RECEIPT'});
 expect((await investment.getAction(actor,action.id)).status).toBe('SETTLING');
 expect((await investment.dashboard(actor)).positions.find(p=>p.id===action.positionId)!.reservedMinor).toBe('100000');
 expect((await core.dashboard(actor)).accounts[0]!.balanceMinor).toBe('800000');
 expect((await pool.query(`SELECT count(*)::int AS n FROM "${schema}".redemption_entries`)).rows[0].n).toBe(0);
});
