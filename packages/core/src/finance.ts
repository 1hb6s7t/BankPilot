import { withTransaction } from './database.js';
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type {
  Actor, BillCategory, BillFinding, BillReport, BillTransaction, FinanceService,
  FundObligation, FundsOverview, FundsPolicy,
} from '../../contracts/src/index.js';
import { CoreError } from './errors.js';

export type FinanceOptions = { schema?: string; clock?: () => Date };
const day = (date: Date) => new Date(date.getTime()+8*3600_000).toISOString().slice(0,10);
const addDays = (date: string, days: number) => new Date(new Date(`${date}T00:00:00Z`).getTime()+days*86400_000).toISOString().slice(0,10);
const positive = /^[1-9]\d{0,11}$/;
const nonnegative = /^(0|[1-9]\d{0,11})$/;
const max = (a: bigint,b: bigint) => a>b?a:b;
const quote = (schema: string) => {
  if (!/^[a-z_][a-z0-9_]{0,47}$/.test(schema)) throw new Error('Invalid finance schema');
  return `"${schema}"`;
};
const actorId = (actor: Actor) => {
  if (!actor?.userId || typeof actor.userId!=='string') throw new CoreError('UNAUTHENTICATED','请先登录',401);
  return actor.userId;
};
function validDate(value: unknown): value is string {
  if (typeof value!=='string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000')) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0,10)===value;
}
function validatePolicy(input: unknown): { expectedVersion:number; minimumBalanceMinor:string; obligations:FundObligation[] } {
  if (!input || typeof input!=='object' || Array.isArray(input)) throw new CoreError('INVALID_INPUT','无效资金保护规则',400);
  const data=input as Record<string,unknown>;
  if (Object.keys(data).some(k=>!['expectedVersion','minimumBalanceMinor','obligations'].includes(k))
      || !Number.isSafeInteger(data.expectedVersion) || (data.expectedVersion as number)<0
      || typeof data.minimumBalanceMinor!=='string' || !nonnegative.test(data.minimumBalanceMinor)
      || !Array.isArray(data.obligations) || data.obligations.length>100) throw new CoreError('INVALID_INPUT','资金保护规则格式不正确',400);
  const ids=new Set<string>();
  const obligations:FundObligation[]=data.obligations.map(value=>{
    if (!value || typeof value!=='object' || Array.isArray(value)) throw new CoreError('INVALID_INPUT','无效待付义务',400);
    const o=value as Record<string,unknown>;
    if (Object.keys(o).some(k=>!['id','title','amountMinor','dueDate'].includes(k))
        || typeof o.id!=='string' || !/^[A-Za-z0-9_-]{1,128}$/.test(o.id) || ids.has(o.id)
        || typeof o.title!=='string' || !o.title.trim() || o.title.length>120
        || typeof o.amountMinor!=='string' || !positive.test(o.amountMinor) || !validDate(o.dueDate)) {
      throw new CoreError('INVALID_INPUT','待付义务需唯一编号、正整数分和真实日期',400);
    }
    ids.add(o.id);
    return { id:o.id,title:o.title.trim(),amountMinor:o.amountMinor,dueDate:o.dueDate };
  });
  return { expectedVersion:data.expectedVersion as number,minimumBalanceMinor:data.minimumBalanceMinor,obligations };
}

/** Called only by core.migrate; uses the same schema and database lifecycle. */
export function financeMigration(schema:string):string {
  const s=quote(schema);
  return `
    CREATE TABLE IF NOT EXISTS ${s}.funds_policies(user_id text PRIMARY KEY,version integer NOT NULL CHECK(version>0),minimum_balance_minor bigint NOT NULL CHECK(minimum_balance_minor>=0),obligations jsonb NOT NULL,updated_at timestamptz NOT NULL);
    CREATE TABLE IF NOT EXISTS ${s}.bill_transactions(id text PRIMARY KEY,user_id text NOT NULL,account_id text NOT NULL REFERENCES ${s}.accounts(id),booked_at timestamptz NOT NULL,merchant text NOT NULL,amount_minor bigint NOT NULL CHECK(amount_minor>0),direction text NOT NULL CHECK(direction IN ('IN','OUT')),category text NOT NULL);
    CREATE INDEX IF NOT EXISTS bill_transactions_user_time_idx ON ${s}.bill_transactions(user_id,booked_at);
    CREATE TABLE IF NOT EXISTS ${s}.finance_fixture_months(user_id text NOT NULL,period text NOT NULL,seeded_at timestamptz NOT NULL,PRIMARY KEY(user_id,period));
  `;
}

async function readPolicy(db:PoolClient,userId:string,s:string):Promise<FundsPolicy> {
  const result=await db.query(`SELECT * FROM ${s}.funds_policies WHERE user_id=$1`,[userId]);
  const row=result.rows[0];
  return row ? { version:row.version,minimumBalanceMinor:String(row.minimum_balance_minor),obligations:row.obligations,updatedAt:new Date(row.updated_at).toISOString() }
    : { version:0,minimumBalanceMinor:'0',obligations:[],updatedAt:new Date(0).toISOString() };
}

/** Caller holds the identical core user advisory lock. No writes or external calls. */
export async function readFunds(db:PoolClient,schema:string,userId:string,accountId:string|undefined,amountMinor:string,now:Date,excludeActionId?:string):Promise<FundsOverview> {
  const s=quote(schema);
  if (typeof amountMinor!=='string' || !nonnegative.test(amountMinor)) throw new CoreError('INVALID_INPUT','预演金额必须为非负整数分',400);
  const account=await db.query(`SELECT * FROM ${s}.accounts WHERE user_id=$1 AND ($2::text IS NULL OR id=$2) ORDER BY id LIMIT 1`,[userId,accountId??null]);
  if (!account.rows[0]) throw new CoreError('NOT_FOUND','账户不存在',404);
  const row=account.rows[0];
  const reservation=await db.query(`SELECT COALESCE(sum(amount_minor),0)::text AS amount FROM ${s}.actions
    WHERE user_id=$1 AND account_id=$2 AND reserved AND ($3::text IS NULL OR id<>$3)
    AND (status IN ('SUBMITTING','UNKNOWN') OR (status='AUTHORIZED' AND expires_at>$4))`,[userId,row.id,excludeActionId??null,now]);
  const policy=await readPolicy(db,userId,s);
  const horizonEnd=addDays(day(now),30);
  // Every listed obligation is outstanding. Future incomes are not part of this calculation.
  const obligations=policy.obligations.filter(o=>o.dueDate<=horizonEnd);
  const balance=BigInt(row.balance_minor),reserved=BigInt(reservation.rows[0].amount),amount=BigInt(amountMinor);
  const protectedMinor=BigInt(policy.minimumBalanceMinor)+obligations.reduce((sum,o)=>sum+BigInt(o.amountMinor),0n);
  const before=balance-reserved,after=before-amount,shortfall=max(0n,protectedMinor-after);
  const reasons:string[]=[];
  if (reserved>0n) reasons.push('已授权及结果未知的转账占额已扣除');
  if (BigInt(policy.minimumBalanceMinor)>0n) reasons.push('保留生活费底线');
  if (obligations.length) reasons.push('保护未来30天及逾期未清的待付义务');
  reasons.push('预期收入及历史账单收入不会计入当前可用余额；预演不占额');
  if (shortfall>0n) reasons.push('本次支出将突破资金保护底线');
  return { policy,preview:{
    accountId:row.id,amountMinor,balanceMinor:balance.toString(),reservedMinor:reserved.toString(),
    availableBeforeMinor:before.toString(),availableAfterMinor:after.toString(),protectedMinor:protectedMinor.toString(),
    spendableMinor:max(0n,before-protectedMinor).toString(),shortfallMinor:shortfall.toString(),allowed:shortfall===0n,
    policyVersion:policy.version,horizonEnd,obligations,reasons,
  } };
}

export function createFinance(pool:Pool,options:FinanceOptions={}):FinanceService {
  const schema=options.schema??'bankpilot_core',s=quote(schema),clock=options.clock??(()=>new Date());
  const transaction=<T>(userId:string,fn:(tx:PoolClient)=>Promise<T>):Promise<T>=>withTransaction(pool,async tx=>{
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`${schema}:${userId}`]);
    return fn(tx);
  });
  const audit=async(tx:PoolClient,userId:string,type:string,detail:unknown)=>{
    await tx.query(`INSERT INTO ${s}.audit_events(id,user_id,action_id,type,detail,created_at) VALUES($1,$2,NULL,$3,$4,$5)`,[randomUUID(),userId,type,JSON.stringify(detail),clock()]);
  };
  const requireAccount=async(tx:PoolClient,userId:string)=>{
    const r=await tx.query(`SELECT id FROM ${s}.accounts WHERE user_id=$1 ORDER BY id LIMIT 1`,[userId]);
    if (!r.rows[0]) throw new CoreError('NOT_FOUND','账户不存在',404);
    return r.rows[0].id as string;
  };
  const previousPeriod=(period:string)=>{
    const first=new Date(`${period}-01T00:00:00Z`);first.setUTCMonth(first.getUTCMonth()-1);
    return first.toISOString().slice(0,7);
  };
  return {
    async seedDemo(actor) {
      const userId=actorId(actor);
      await transaction(userId,async tx=>{
        const accountId=await requireAccount(tx,userId),today=day(clock()),current=today.slice(0,7);
        const obligations:FundObligation[]=[{ id:'demo-rent',title:'未来房租（合成义务）',amountMinor:'300000',dueDate:addDays(today,10) }];
        const policy=await tx.query(`INSERT INTO ${s}.funds_policies(user_id,version,minimum_balance_minor,obligations,updated_at) VALUES($1,1,200000,$2,$3) ON CONFLICT DO NOTHING RETURNING user_id`,[userId,JSON.stringify(obligations),clock()]);
        if (policy.rows[0]) await audit(tx,userId,'FUNDS_POLICY_SEEDED',{ version:1,minimumBalanceMinor:'200000',obligations });
        type Fixture=[number,string,string,'IN'|'OUT',BillCategory];
        const older:Fixture[]=[
          [2,'合成工资','1200000','IN','收入'],[3,'城市公寓','300000','OUT','住房'],[6,'社区食堂','5800','OUT','餐饮'],
          [8,'城市地铁','600','OUT','交通'],[12,'云音乐','1800','OUT','订阅'],[15,'生活百货','28000','OUT','购物'],[20,'周末餐厅','12000','OUT','餐饮'],
        ];
        const recent:Fixture[]=[
          [2,'合成工资','1200000','IN','收入'],[3,'城市公寓','300000','OUT','住房'],[6,'社区食堂','6800','OUT','餐饮'],
          [8,'城市地铁','800','OUT','交通'],[12,'云音乐','1800','OUT','订阅'],[15,'数码商店','128000','OUT','购物'],
          [18,'午间咖啡','2800','OUT','餐饮'],[18,'午间咖啡','2800','OUT','餐饮'],[20,'公交出行','400','OUT','交通'],
        ];
        for (const [period,fixtures] of [[previousPeriod(current),older],[current,recent]] as [string,Fixture[]][]) {
          const inserted=await tx.query(`INSERT INTO ${s}.finance_fixture_months(user_id,period,seeded_at) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING period`,[userId,period,clock()]);
          if (!inserted.rows[0]) continue;
          for (const [index,f] of fixtures.entries()) {
            if (period===current && f[0]>Number(today.slice(-2))) continue;
            const d=f[0];
            const bookedAt=`${period}-${String(d).padStart(2,'0')}T00:${String(index).padStart(2,'0')}:00+08:00`;
            if (new Date(bookedAt)>clock()) continue;
            await tx.query(`INSERT INTO ${s}.bill_transactions(id,user_id,account_id,booked_at,merchant,amount_minor,direction,category)
              VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,[`fixture:${userId}:${period}:${index}`,userId,accountId,bookedAt,f[1],f[2],f[3],f[4]]);
          }
        }
      });
    },
    async funds(actor,accountId,amountMinor='0') {
      const userId=actorId(actor);
      return transaction(userId,tx=>readFunds(tx,schema,userId,accountId,amountMinor,clock()));
    },
    async updatePolicy(actor,input) {
      const userId=actorId(actor),data=validatePolicy(input);
      return transaction(userId,async tx=>{
        await requireAccount(tx,userId);
        const current=await readPolicy(tx,userId,s);
        if (current.version!==data.expectedVersion) throw new CoreError('POLICY_VERSION_CONFLICT','资金保护规则已更新，请刷新后重试');
        const version=current.version+1;
        const updatedAt=clock().toISOString();
        await tx.query(`INSERT INTO ${s}.funds_policies(user_id,version,minimum_balance_minor,obligations,updated_at) VALUES($1,$2,$3,$4,$5)
          ON CONFLICT(user_id) DO UPDATE SET version=EXCLUDED.version,minimum_balance_minor=EXCLUDED.minimum_balance_minor,obligations=EXCLUDED.obligations,updated_at=EXCLUDED.updated_at`,
        [userId,version,data.minimumBalanceMinor,JSON.stringify(data.obligations),updatedAt]);
        await audit(tx,userId,'FUNDS_POLICY_UPDATED',{ previousVersion:current.version,version,minimumBalanceMinor:data.minimumBalanceMinor,obligations:data.obligations });
        return { version,minimumBalanceMinor:data.minimumBalanceMinor,obligations:data.obligations,updatedAt };
      });
    },
    async billReport(actor,period) {
      const userId=actorId(actor),selected=period??day(clock()).slice(0,7);
      if (!validDate(`${selected}-01`)) throw new CoreError('INVALID_INPUT','账单月份必须为有效的 YYYY-MM',400);
      return transaction(userId,async tx=>{
        await requireAccount(tx,userId);
        const previous=previousPeriod(selected);
        // Transfers are derived from unique succeeded actions rather than copied on every report request.
        const result=await tx.query(`SELECT id,account_id,booked_at,merchant,amount_minor,direction,category,'SYNTHETIC_STATEMENT' AS source FROM ${s}.bill_transactions
          WHERE user_id=$1 AND booked_at<=$4 AND to_char(booked_at AT TIME ZONE 'Asia/Shanghai','YYYY-MM') IN ($2,$3)
          UNION ALL
          SELECT 'transfer:'||id,account_id,(receipt->>'settledAt')::timestamptz,payee_name,amount_minor,'OUT','转账','SANDBOX_TRANSFER' FROM ${s}.actions
          WHERE user_id=$1 AND status='SUCCEEDED' AND (receipt->>'settledAt')::timestamptz<=$4 AND to_char((receipt->>'settledAt')::timestamptz AT TIME ZONE 'Asia/Shanghai','YYYY-MM') IN ($2,$3)
          ORDER BY booked_at,id`,[userId,selected,previous,clock()]);
        const all:BillTransaction[]=result.rows.map(r=>({ id:r.id,accountId:r.account_id,bookedAt:new Date(r.booked_at).toISOString(),merchant:r.merchant,amountMinor:String(r.amount_minor),direction:r.direction,category:r.category,source:r.source }));
        const transactions=all.filter(t=>day(new Date(t.bookedAt)).startsWith(selected));
        const before=all.filter(t=>day(new Date(t.bookedAt)).startsWith(previous));
        // A missing statement month must not become evidence for zero spending.
        // Current-month fixtures were captured only through seeded_at. They do
        // not become a complete month merely because the clock later advances.
        const coverageRow=await tx.query(`SELECT seeded_at FROM ${s}.finance_fixture_months WHERE user_id=$1 AND period=$2`,[userId,selected]);
        const seededAt=coverageRow.rows[0]?.seeded_at;
        const coverage:BillReport['coverage']=seededAt
          ? { status:selected<day(new Date(seededAt)).slice(0,7)?'complete':'partial',through:new Date(seededAt).toISOString() }
          : { status:transactions.length?'partial':'missing' };
        const sum=(rows:BillTransaction[],direction:'IN'|'OUT')=>rows.filter(t=>t.direction===direction).reduce((total,t)=>total+BigInt(t.amountMinor),0n);
        const income=sum(transactions,'IN'),expense=sum(transactions,'OUT');
        const categories:BillReport['categories']=[];
        const findings:BillFinding[]=[];
        const evidenceTransactions=new Map<string,BillTransaction>();
        for (const t of transactions.filter(t=>t.direction==='OUT')) {
          let category=categories.find(c=>c.category===t.category);
          if (!category) { category={ category:t.category,amountMinor:'0',count:0,transactionIds:[] };categories.push(category); }
          category.amountMinor=(BigInt(category.amountMinor)+BigInt(t.amountMinor)).toString();category.count++;category.transactionIds.push(t.id);
          if (BigInt(t.amountMinor)>=100000n) findings.push({ id:`large:${t.id}`,kind:'LARGE_EXPENSE',summary:'单笔支出达到1000元，建议核对用途；仅为金额规则提示，不代表欺诈。',transactionIds:[t.id] });
          const priorMatches=before.filter(p=>p.source==='SYNTHETIC_STATEMENT' && p.accountId===t.accountId && p.direction==='OUT' && p.merchant===t.merchant && p.amountMinor===t.amountMinor);
          if (t.source==='SYNTHETIC_STATEMENT' && priorMatches.length) {
            for (const p of priorMatches) evidenceTransactions.set(p.id,p);
            findings.push({ id:`recurring:${t.id}`,kind:'RECURRING',summary:`上月存在同商户同金额支出，可能为周期费用；尚未确认订阅关系。`,transactionIds:[t.id,...priorMatches.map(p=>p.id)] });
          }
        }
        const duplicateGroups=new Map<string,BillTransaction[]>();
        for (const t of transactions.filter(t=>t.direction==='OUT')) {
          const key=JSON.stringify([t.accountId,t.merchant,t.amountMinor,day(new Date(t.bookedAt))]);
          duplicateGroups.set(key,[...(duplicateGroups.get(key)??[]),t]);
        }
        for (const group of duplicateGroups.values()) if (group.length>1) findings.push({ id:`duplicate:${group[0].id}`,kind:'POSSIBLE_DUPLICATE',summary:'同日同商户存在相同金额支出，可能重复，也可能是多次正常消费；请核对原始流水。',transactionIds:group.map(t=>t.id) });
        return { period:selected,source:'SYNTHETIC',coverage,incomeMinor:income.toString(),expenseMinor:expense.toString(),netMinor:(income-expense).toString(),previousExpenseMinor:sum(before,'OUT').toString(),categories,transactions,evidenceTransactions:[...evidenceTransactions.values()],findings,generatedAt:clock().toISOString() };
      });
    },
  };
}
