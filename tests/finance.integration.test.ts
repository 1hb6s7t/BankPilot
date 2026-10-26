import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { beforeEach,afterEach,afterAll,describe,it,expect } from 'vitest';
import { createCore,createFinance } from '../packages/core/src/index.js';
import type { ActionView,CoreService,FinanceService,FundObligation } from '../packages/contracts/src/index.js';

const pool=new Pool({ connectionString:process.env.TEST_DATABASE_URL??'postgres://bankpilot:bankpilot-local@127.0.0.1:55432/bankpilot',max:15 });
const actor={ userId:'finance-test-user' },other={ userId:'other-finance-user' };
let schema:string,now:Date,core:CoreService,finance:FinanceService;
const accountId=`acc-main-${actor.userId}`;
const make=(amountMinor:string)=>core.createTransfer(actor,{ commandId:randomUUID(),accountId,payeeId:'payee-lin',amountMinor,memo:'资金保护测试',taskId:randomUUID() });
const authorize=(action:ActionView)=>core.authorize(actor,action.id,{ level:'STRONG',proofId:randomUUID(),actionHash:action.actionHash });
beforeEach(async()=>{
  schema=`financetest_${randomUUID().replaceAll('-','').slice(0,12)}`;now=new Date('2026-10-22T07:00:00Z');
  core=createCore(pool,{ schema,clock:()=>now });finance=createFinance(pool,{ schema,clock:()=>now });
  await core.migrate();await core.seedDemo(actor);await core.seedDemo(other);
});
afterEach(async()=>{await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);});
afterAll(async()=>{await pool.end();});

describe('funds protection, statements and execution share trusted database facts',()=>{
  it('defaults unseeded users to zero protection and previews do not write or occupy funds',async()=>{
    const before=await core.dashboard(actor);
    const first=await finance.funds(actor,undefined,'800000');
    expect(first.policy.version).toBe(0);expect(first.policy.minimumBalanceMinor).toBe('0');
    expect(first.preview.allowed).toBe(true);expect(first.preview.availableAfterMinor).toBe('0');
    await finance.funds(actor,accountId,'800000');
    expect((await core.dashboard(actor)).dailyUsedMinor).toBe(before.dailyUsedMinor);
    expect((await core.dashboard(actor)).accounts[0].reservedMinor).toBe('0');
    expect((await pool.query(`SELECT count(*)::int AS n FROM "${schema}".funds_policies`)).rows[0].n).toBe(0);
  });

  it('explicit demo seed adds protection without debiting current balances and is idempotent',async()=>{
    await finance.seedDemo(actor);await finance.seedDemo(actor);
    const funds=await finance.funds(actor,accountId,'300000');
    expect(funds.policy).toMatchObject({ version:1,minimumBalanceMinor:'200000' });
    expect(funds.preview).toMatchObject({ balanceMinor:'800000',protectedMinor:'500000',spendableMinor:'300000',availableAfterMinor:'500000',allowed:true });
    expect((await finance.funds(actor,accountId,'300001')).preview).toMatchObject({ allowed:false,shortfallMinor:'1' });
    expect((await core.dashboard(actor)).accounts[0].balanceMinor).toBe('800000');
    expect((await finance.funds(other)).policy.version).toBe(0);
    await finance.updatePolicy(actor,{ expectedVersion:1,minimumBalanceMinor:'100',obligations:[] });
    await finance.seedDemo(actor);
    expect((await finance.funds(actor)).policy.minimumBalanceMinor).toBe('100');
  });

  it('two concurrent transfers cannot jointly spend protected money; execute excludes its own reservation',async()=>{
    await finance.seedDemo(actor);
    const [a,b]=await Promise.all([make('200000'),make('200000')]);
    const results=await Promise.allSettled([authorize(a),authorize(b)]);
    expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
    const rejected=results.find(r=>r.status==='rejected') as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ code:'FUNDS_PROTECTED' });
    const accepted=(results.find(r=>r.status==='fulfilled') as PromiseFulfilledResult<ActionView>).value;
    expect((await finance.funds(actor)).preview.spendableMinor).toBe('100000');
    expect((await core.execute(accepted.id)).status).toBe('SUCCEEDED');
    expect((await finance.funds(actor)).preview).toMatchObject({ balanceMinor:'600000',reservedMinor:'0',spendableMinor:'100000' });
  });

  it('policy changes between preview and authorization cannot be bypassed',async()=>{
    expect((await finance.funds(actor,accountId,'500000')).preview.allowed).toBe(true);
    const action=await make('500000');
    await finance.updatePolicy(actor,{ expectedVersion:0,minimumBalanceMinor:'400000',obligations:[] });
    await expect(authorize(action)).rejects.toMatchObject({ code:'FUNDS_PROTECTED' });
    expect((await core.getAction(actor,action.id)).status).toBe('AWAITING_VERIFICATION');
    expect((await core.dashboard(actor)).dailyUsedMinor).toBe('0');
  });

  it('a newly blocking policy makes an authorized but undispatched action FAILED and releases quota',async()=>{
    await finance.seedDemo(actor);
    const action=await make('200000');await authorize(action);
    await finance.updatePolicy(actor,{ expectedVersion:1,minimumBalanceMinor:'650000',obligations:[] });
    const failed=await core.execute(action.id);
    expect(failed.status).toBe('FAILED');expect(failed.failureReason).toContain('资金保护');
    const dashboard=await core.dashboard(actor);
    expect(dashboard.accounts[0]).toMatchObject({ balanceMinor:'800000',reservedMinor:'0' });
    expect(dashboard.dailyUsedMinor).toBe('0');
    expect(dashboard.audit.some(e=>e.type==='TRANSFER_BLOCKED_BY_FUNDS_POLICY')).toBe(true);
    expect((await pool.query(`SELECT count(*)::int AS n FROM "${schema}".provider_transfers`)).rows[0].n).toBe(0);
  });

  it('policy changes cannot cancel or release an already submitted UNKNOWN payment',async()=>{
    await finance.seedDemo(actor);
    const action=await make('250000');await authorize(action);
    await core.setNextFault(actor,'TIMEOUT_AFTER_COMMIT');
    expect((await core.execute(action.id)).status).toBe('UNKNOWN');
    await finance.updatePolicy(actor,{ expectedVersion:1,minimumBalanceMinor:'800000',obligations:[] });
    expect((await finance.funds(actor)).preview.reservedMinor).toBe('250000');
    expect((await core.execute(action.id)).status).toBe('SUCCEEDED');
    expect((await core.dashboard(actor)).accounts[0].balanceMinor).toBe('550000');
    expect((await pool.query(`SELECT count(*)::int AS n FROM "${schema}".provider_transfers`)).rows[0].n).toBe(1);
  });

  it('includes overdue and day-30 obligations, excludes day-31 and never anticipates future income',async()=>{
    const obligations:FundObligation[]=[
      { id:'overdue',title:'逾期未清',amountMinor:'100000',dueDate:'2026-10-01' },
      { id:'boundary',title:'第30天',amountMinor:'200000',dueDate:'2026-11-21' },
      { id:'later',title:'第31天',amountMinor:'300000',dueDate:'2026-11-22' },
    ];
    await finance.updatePolicy(actor,{ expectedVersion:0,minimumBalanceMinor:'100000',obligations });
    const before=await finance.funds(actor,accountId,'400001');
    expect(before.preview).toMatchObject({ horizonEnd:'2026-11-21',protectedMinor:'400000',shortfallMinor:'1',allowed:false });
    expect(before.preview.obligations.map(o=>o.id)).toEqual(['overdue','boundary']);
    await pool.query(`INSERT INTO "${schema}".bill_transactions(id,user_id,account_id,booked_at,merchant,amount_minor,direction,category) VALUES('future-income',$1,$2,'2026-11-01T00:00:00+08:00','预期工资',1200000,'IN','收入')`,[actor.userId,accountId]);
    expect((await finance.funds(actor,accountId,'400001')).preview).toEqual(before.preview);
    expect((await finance.billReport(actor,'2026-11')).incomeMinor).toBe('0');
  });

  it('validates integer policy amounts, real calendar dates, unique ids and version conflicts',async()=>{
    const good={ expectedVersion:0,minimumBalanceMinor:'0',obligations:[] as FundObligation[] };
    for (const dueDate of ['2026-02-30','2026-13-01','2026-2-01','0000-01-01','not-a-date']) {
      await expect(finance.updatePolicy(actor,{ ...good,obligations:[{ id:'x',title:'租金',amountMinor:'1',dueDate }] })).rejects.toMatchObject({ code:'INVALID_INPUT' });
    }
    for (const value of ['-1','1.5','1e3','00','1000000000000']) {
      await expect(finance.updatePolicy(actor,{ ...good,minimumBalanceMinor:value })).rejects.toMatchObject({ code:'INVALID_INPUT' });
      await expect(finance.funds(actor,accountId,value)).rejects.toMatchObject({ code:'INVALID_INPUT' });
    }
    const obligation={ id:'same',title:'租金',amountMinor:'1',dueDate:'2028-02-29' };
    await expect(finance.updatePolicy(actor,{ ...good,obligations:[obligation,obligation] })).rejects.toMatchObject({ code:'INVALID_INPUT' });
    await expect(finance.updatePolicy(actor,{ ...good,userId:other.userId } as typeof good)).rejects.toMatchObject({ code:'INVALID_INPUT' });
    const versions=await Promise.allSettled([finance.updatePolicy(actor,good),finance.updatePolicy(actor,good)]);
    expect(versions.filter(r=>r.status==='fulfilled')).toHaveLength(1);
    expect((versions.find(r=>r.status==='rejected') as PromiseRejectedResult).reason).toMatchObject({ code:'POLICY_VERSION_CONFLICT' });
    expect((await finance.funds(other)).policy.version).toBe(0);
    await expect(finance.funds(other,accountId)).rejects.toMatchObject({ code:'NOT_FOUND' });
  });

  it('statement totals reconcile to provenance, recurring evidence and one successful transfer',async()=>{
    await finance.seedDemo(actor);
    const first=await finance.billReport(actor);
    expect(first).toMatchObject({ period:'2026-10',incomeMinor:'1200000',expenseMinor:'443400',netMinor:'756600',previousExpenseMinor:'348200' });
    expect(first.categories.reduce((sum,c)=>sum+BigInt(c.amountMinor),0n)).toBe(443400n);
    const ids=new Set([...first.transactions,...(first.evidenceTransactions??[])].map(t=>t.id));
    for (const finding of first.findings) for (const id of finding.transactionIds) expect(ids.has(id)).toBe(true);
    expect(new Set(first.findings.map(f=>f.kind))).toEqual(new Set(['LARGE_EXPENSE','POSSIBLE_DUPLICATE','RECURRING']));
    const action=await make('10000');await authorize(action);
    expect((await finance.billReport(actor)).transactions.filter(t=>t.source==='SANDBOX_TRANSFER')).toHaveLength(0);
    expect((await core.execute(action.id)).status).toBe('SUCCEEDED');
    const after=await finance.billReport(actor);await finance.billReport(actor);await core.reconcile(action.id);
    expect(after.transactions.filter(t=>t.source==='SANDBOX_TRANSFER')).toHaveLength(1);
    expect(after.expenseMinor).toBe('453400');expect(after.previousExpenseMinor).toBe('348200');
    expect((await finance.billReport(actor)).expenseMinor).toBe(after.expenseMinor);
    expect((await core.dashboard(actor)).accounts[0].balanceMinor).toBe('790000');
    expect((await finance.billReport(other)).transactions).toHaveLength(0);
    expect((await finance.billReport(other)).evidenceTransactions).toHaveLength(0);
    for (const period of ['2026-13','2026-2','2026-10-01']) await expect(finance.billReport(actor,period)).rejects.toMatchObject({ code:'INVALID_INPUT' });
  });

  it('seeds no future statement and repeat seeds do not rewrite or expand the captured month',async()=>{
    now=new Date('2026-10-05T07:00:00Z');
    await finance.seedDemo(actor);
    const captured=await finance.billReport(actor);
    expect(captured.transactions).toHaveLength(2);
    expect(captured.transactions.every(t=>new Date(t.bookedAt)<=now)).toBe(true);
    now=new Date('2026-10-22T07:00:00Z');await finance.seedDemo(actor);
    expect((await finance.billReport(actor)).transactions).toEqual(captured.transactions);
    expect((await core.dashboard(actor)).accounts[0].balanceMinor).toBe('800000');
  });

  it('failed policy audit rolls back policy content and version',async()=>{
    await pool.query(`ALTER TABLE "${schema}".audit_events ADD CONSTRAINT fail_policy_audit CHECK(type <> 'FUNDS_POLICY_UPDATED')`);
    await expect(finance.updatePolicy(actor,{ expectedVersion:0,minimumBalanceMinor:'700000',obligations:[] })).rejects.toThrow();
    expect((await finance.funds(actor)).policy).toMatchObject({ version:0,minimumBalanceMinor:'0' });
  });
});
