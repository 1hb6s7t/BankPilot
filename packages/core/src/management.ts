import { withTransaction } from './database.js';
import { createHash,randomUUID } from 'node:crypto';
import type { Pool,PoolClient } from 'pg';
import type { Actor,AuthorizationProof,PayeeView } from '../../contracts/src/index.js';
import {
  managementInputSchema,type ManagementAction,type ManagementInput,type ManagementReceipt,
  type ManagementService,type ManagementSpec,type CardView,type SubscriptionSnapshot,type SubscriptionView,
} from '../../contracts/src/management.js';
import { CoreError } from './errors.js';
import { lockPreparationRequest, markPreparationPrepared } from './preparations.js';

export type ManagementOptions={ schema?:string; clock?:()=>Date; actionTtlMs?:number; queryGrantTtlMs?:number };
type Row=Record<string,any>;
const iso=(value:Date|string)=>new Date(value).toISOString();
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value,(_key,item)=>
  item && typeof item==='object' && !Array.isArray(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b))):item)).digest('hex');
const normalize=(value:string)=>value.normalize('NFKC').trim();
const aliasKey=(value:string)=>normalize(value).toLocaleLowerCase('en-US');
const pending=new Set(['AWAITING_CONFIRMATION','AWAITING_VERIFICATION']);

/** Local synthetic provider: operation, receipt, authorization and audit commit together. */
export function createManagement(pool:Pool,options:ManagementOptions={}):ManagementService {
  const schema=options.schema??'bankpilot_core';
  if (!/^[a-z_][a-z0-9_]{0,47}$/.test(schema)) throw new Error('Invalid management schema');
  const s=`"${schema}"`,clock=options.clock??(()=>new Date());
  const actionTtl=options.actionTtlMs??10*60_000,grantTtl=options.queryGrantTtlMs??5*60_000;
  if (![actionTtl,grantTtl].every(n=>Number.isSafeInteger(n)&&n>0)) throw new Error('Invalid management TTL');
  const owner=(actor:Actor)=>{
    if (!actor?.userId || typeof actor.userId!=='string') throw new CoreError('UNAUTHENTICATED','请先登录',401);
    return actor.userId;
  };
  const transaction=<T>(userId:string,fn:(tx:PoolClient)=>Promise<T>):Promise<T>=>withTransaction(pool,async tx=>{
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`${schema}:${userId}`]);
    return fn(tx);
  });
  const audit=async(tx:PoolClient,userId:string,id:string,type:string,detail:unknown)=>{
    // core.audit_events.action_id intentionally has no transfer-only foreign key.
    await tx.query(`INSERT INTO ${s}.audit_events(id,user_id,action_id,type,detail,created_at) VALUES($1,$2,$3,$4,$5,$6)`,[randomUUID(),userId,id,type,JSON.stringify(detail),clock()]);
  };
  const account=async(tx:PoolClient,userId:string)=>{
    const result=await tx.query(`SELECT * FROM ${s}.accounts WHERE user_id=$1 ORDER BY id LIMIT 1`,[userId]);
    if (!result.rows[0]) throw new CoreError('NOT_FOUND','账户不存在',404);
    return result.rows[0];
  };
  const cardView=(r:Row):CardView=>({ id:r.id,accountId:r.account_id,name:r.name,maskedNumber:r.masked_number,status:r.status,version:r.version,updatedAt:iso(r.updated_at) });
  const card=async(tx:PoolClient,userId:string,id:string)=>{
    const result=await tx.query(`SELECT * FROM ${s}.management_cards WHERE id=$1 AND user_id=$2 FOR UPDATE`,[id,userId]);
    if (!result.rows[0]) throw new CoreError('NOT_FOUND','卡片不存在',404);
    return result.rows[0];
  };
  const subscriptionsList=async(tx:PoolClient,userId:string):Promise<SubscriptionView[]>=>{
    const result=await tx.query(`SELECT sub.*,card.status AS card_status FROM ${s}.management_subscriptions sub
      JOIN ${s}.management_cards card ON sub.card_id=card.id AND sub.user_id=card.user_id WHERE sub.user_id=$1 ORDER BY sub.id`,[userId]);
    return result.rows.map(r=>({
      id:r.id,merchant:r.merchant,amountMinor:String(r.amount_minor),currency:'CNY',nextChargeDate:r.next_charge_date,
      cardId:r.card_id,merchantStatus:r.merchant_status,bankStatus:r.bank_status,
      collectionStatus:r.merchant_status==='CANCELLED'?'MERCHANT_CANCELLED':r.bank_status==='BLOCKED'?'BLOCKED_BY_BANK':r.card_status==='LOST'?'BLOCKED_BY_CARD':'ENABLED',
      version:r.version,cancellationSupported:r.cancellation_supported,source:'SYNTHETIC_MERCHANT',
    }));
  };
  const grant=async(tx:PoolClient,userId:string,id:string):Promise<Row>=>{
    const result=await tx.query(`SELECT g.* FROM ${s}.management_query_grants g JOIN ${s}.management_actions a ON g.action_id=a.id
      WHERE g.action_id=$1 AND g.user_id=$2 AND a.user_id=$2 AND a.status='SUCCEEDED' AND a.spec->>'kind'='SUBSCRIPTION_QUERY'`,[id,userId]);
    if (!result.rows[0]) throw new CoreError('QUERY_AUTHORIZATION_REQUIRED','请先确认查询订阅',403);
    if (new Date(result.rows[0].expires_at)<=clock()) throw new CoreError('QUERY_ACCESS_EXPIRED','订阅查询授权已过期，请重新确认查询',403);
    return result.rows[0];
  };
  const activeGrants=async(tx:PoolClient,userId:string):Promise<Map<string,string>>=>{
    const result=await tx.query(`SELECT g.action_id,g.expires_at FROM ${s}.management_query_grants g JOIN ${s}.management_actions a ON a.id=g.action_id AND a.user_id=g.user_id
      WHERE g.user_id=$1 AND g.expires_at>$2 AND a.status='SUCCEEDED' AND a.spec->>'kind'='SUBSCRIPTION_QUERY'
      ORDER BY g.queried_at DESC,g.action_id`,[userId,clock()]);
    return new Map(result.rows.map(r=>[r.action_id,iso(r.expires_at)]));
  };
  const sensitiveMutation=(row:Row)=>row.spec.kind==='SUBSCRIPTION_CANCEL'||row.spec.kind==='SUBSCRIPTION_BLOCK';
  const mutationDeadline=(row:Row,grants:Map<string,string>)=>sensitiveMutation(row)?grants.get(row.spec.queryActionId):undefined;
  const snapshot=async(tx:PoolClient,userId:string,g:Row):Promise<SubscriptionSnapshot>=>({
    items:await subscriptionsList(tx,userId),queriedAt:iso(g.queried_at),queryActionId:g.action_id,accessExpiresAt:iso(g.expires_at),
  });
  const contacts=async(tx:PoolClient,userId:string):Promise<PayeeView[]>=>{
    await account(tx,userId);
    const payees=await tx.query(`SELECT * FROM ${s}.payees ORDER BY id`);
    const aliases=await tx.query(`SELECT payee_id,alias FROM ${s}.management_contact_aliases WHERE user_id=$1 ORDER BY alias_key`,[userId]);
    return payees.rows.map(p=>({ id:p.id,name:p.name,bank:p.bank,maskedNumber:p.masked_number,aliases:[...p.aliases,...aliases.rows.filter(a=>a.payee_id===p.id).map(a=>a.alias)] }));
  };
  const assertAliasFree=async(tx:PoolClient,userId:string,payeeId:string,alias:string)=>{
    const people=await contacts(tx,userId);
    if (!people.some(p=>p.id===payeeId)) throw new CoreError('NOT_FOUND','收款人不存在',404);
    if (people.some(p=>[p.name,...p.aliases].some(v=>aliasKey(v)===aliasKey(alias)))) throw new CoreError('ALIAS_CONFLICT','该别名与现有姓名或别名冲突，请选择其他称呼');
    return people.find(p=>p.id===payeeId)!;
  };
  const getOwned=async(tx:PoolClient,userId:string,id:string):Promise<Row>=>{
    const result=await tx.query(`SELECT * FROM ${s}.management_actions WHERE id=$1 AND user_id=$2 FOR UPDATE`,[id,userId]);
    if (!result.rows[0]) throw new CoreError('NOT_FOUND','管理动作不存在',404);
    return result.rows[0];
  };
  const actionView=(row:Row,expose=false,detailsAccessExpiresAt?:string):ManagementAction=>{
    const spec=row.spec as ManagementSpec;
    let receipt:ManagementReceipt|undefined=row.receipt?structuredClone(row.receipt):undefined;
    const isSensitive=sensitiveMutation(row);
    if(isSensitive) expose=!!detailsAccessExpiresAt && new Date(detailsAccessExpiresAt)>clock();
    if (!expose && receipt) { delete receipt.subscriptions;delete receipt.subscription; }
    return {
      id:row.id,taskId:row.task_id,spec,title:row.title,
      details:!expose&&isSensitive?['订阅明细需在有效的查询授权内查看；此为本地合成商户操作。']:row.details,
      status:pending.has(row.status)&&new Date(row.expires_at)<=clock()?'EXPIRED':row.status,tier:row.tier,
      actionVersion:row.action_version,actionHash:row.action_hash,expiresAt:iso(row.expires_at),createdAt:iso(row.created_at),updatedAt:iso(row.updated_at),
      ...(receipt?{receipt}:{}),...(row.failure_reason?{failureReason:row.failure_reason}:{}),
      ...(isSensitive?{detailsRedacted:!expose,...(expose?{detailsAccessExpiresAt}:{})}:{}),
    };
  };
  const actionWithAccess=async(tx:PoolClient,userId:string,row:Row,expose=false):Promise<ManagementAction>=>
    actionView(row,expose,sensitiveMutation(row)?mutationDeadline(row,await activeGrants(tx,userId)):undefined);
  const evaluate=async(tx:PoolClient,userId:string,spec:ManagementSpec):Promise<{title:string;details:string[];scope:Record<string,unknown>} >=>{
    if (spec.kind==='CONTACT_ALIAS_SAVE') {
      const person=await assertAliasFree(tx,userId,spec.payeeId,spec.alias);
      return {title:'保存联系人别名',details:[`将“${spec.alias}”绑定到${person.name}（${person.bank} ${person.maskedNumber}）。`,'确认前不会保存；别名仅对当前用户可见，不发起转账。'],scope:{payeeId:person.id,name:person.name,bank:person.bank,maskedNumber:person.maskedNumber}};
    }
    if (spec.kind==='CARD_REPORT_LOST'||spec.kind==='CARD_UNREPORT_LOST') {
      const current=await card(tx,userId,spec.cardId);
      if (current.version!==spec.expectedVersion) throw new CoreError('STALE_RESOURCE','卡片版本已变化，请重新查看并创建动作');
      const expected=spec.kind==='CARD_REPORT_LOST'?'ACTIVE':'LOST';
      if (current.status!==expected) throw new CoreError('INVALID_STATE',expected==='ACTIVE'?'卡片已挂失':'卡片尚未挂失');
      return {
        title:spec.kind==='CARD_REPORT_LOST'?'挂失卡片':'解除卡片挂失',
        details:[`${current.name}（${current.masked_number}）将从${current.status}变为${expected==='ACTIVE'?'LOST':'ACTIVE'}。`,
          spec.kind==='CARD_REPORT_LOST'?'挂失将阻止此卡的后续模拟扣款，但不会取消任何商户合同。':'解挂后，未被银行限制且商户合同仍有效的模拟扣款可恢复。','需逐动作强验证；仅作用于合成卡片，余额不变。'],
        scope:{cardId:current.id,accountId:current.account_id,version:current.version,status:current.status},
      };
    }
    if (spec.kind==='SUBSCRIPTION_QUERY') return {title:'查询订阅与周期扣费',details:['确认后可在有限时间内查看当前用户的本地合成商户订阅。','查询不会取消商户合同、修改银行扣款限制或改变余额。'],scope:{resource:'subscriptions',provider:'LOCAL_SYNTHETIC_MERCHANT'}};
    await grant(tx,userId,spec.queryActionId);
    const subscription=(await subscriptionsList(tx,userId)).find(x=>x.id===spec.subscriptionId);
    if (!subscription) throw new CoreError('NOT_FOUND','订阅不存在',404);
    if (subscription.version!==spec.expectedVersion) throw new CoreError('STALE_RESOURCE','订阅版本已变化，请重新查询并确认');
    if (spec.kind==='SUBSCRIPTION_CANCEL' && !subscription.cancellationSupported) throw new CoreError('CANCELLATION_UNSUPPORTED','该合成商户不支持在线取消，可单独确认银行扣款限制');
    if (spec.kind==='SUBSCRIPTION_CANCEL' && subscription.merchantStatus==='CANCELLED') throw new CoreError('INVALID_STATE','商户订阅已经取消');
    if (spec.kind==='SUBSCRIPTION_BLOCK' && subscription.bankStatus==='BLOCKED') throw new CoreError('INVALID_STATE','银行扣款已被限制');
    return {
      title:spec.kind==='SUBSCRIPTION_CANCEL'?'取消商户订阅':'限制银行扣款',
      details:[`${subscription.merchant}，周期金额${subscription.amountMinor}分；当前商户${subscription.merchantStatus}、银行${subscription.bankStatus}。`,
        spec.kind==='SUBSCRIPTION_CANCEL'?'将商户合同改为CANCELLED；银行扣款限制状态不变，不退还历史费用。':'将银行扣款限制改为BLOCKED；商户合同不取消，可能仍有合同义务。',
        '仅操作本地合成商户，余额不变；需要单独明确确认。'],
      scope:{subscriptionId:subscription.id,version:subscription.version,merchantStatus:subscription.merchantStatus,bankStatus:subscription.bankStatus,cardId:subscription.cardId,collectionStatus:subscription.collectionStatus,provider:'LOCAL_SYNTHETIC_MERCHANT'},
    };
  };
  type Evaluation=Awaited<ReturnType<typeof evaluate>>;
  const validatedInput=(input:ManagementInput):ManagementInput=>{
    const parsed=managementInputSchema.safeParse(input);
    if (!parsed.success) throw new CoreError('INVALID_INPUT','管理动作参数无效',400);
    const data=parsed.data;
    if (data.spec.kind==='CONTACT_ALIAS_SAVE') {
      data.spec.alias=normalize(data.spec.alias);
      if (!data.spec.alias || data.spec.alias.length>40 || /\p{C}/u.test(data.spec.alias)) throw new CoreError('INVALID_INPUT','别名格式无效',400);
    }
    return data;
  };
  const existingPrepared=async(tx:PoolClient,userId:string,data:ManagementInput):Promise<Row|undefined>=>{
    const prior=(await tx.query(`SELECT * FROM ${s}.management_actions WHERE user_id=$1 AND command_id=$2`,[userId,data.commandId])).rows[0] as Row|undefined;
    if (prior && prior.input_hash!==digest({spec:data.spec,taskId:data.taskId??null}))
      throw new CoreError('IDEMPOTENCY_CONFLICT','相同指令编号不能修改操作参数');
    return prior;
  };
  const insertPrepared=async(tx:PoolClient,userId:string,data:ManagementInput,evaluated:Evaluation):Promise<Row>=>{
    const now=clock(),expiresAt=new Date(now.getTime()+actionTtl),id=`mgmt-${randomUUID()}`,tier=data.spec.kind.startsWith('CARD_')?'RED':'YELLOW';
    const taskId=data.taskId??`task-${data.commandId}`;
    const actionHash=digest({id,userId,taskId,spec:data.spec,scope:evaluated.scope,actionVersion:1,expiresAt:iso(expiresAt),tier});
    const result=await tx.query(`INSERT INTO ${s}.management_actions(id,user_id,command_id,input_hash,task_id,spec,title,details,scope,status,tier,action_version,action_hash,expires_at,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,1,$12,$13,$14,$14) RETURNING *`,
    [id,userId,data.commandId,digest({spec:data.spec,taskId:data.taskId??null}),taskId,JSON.stringify(data.spec),evaluated.title,JSON.stringify(evaluated.details),JSON.stringify(evaluated.scope),tier==='RED'?'AWAITING_VERIFICATION':'AWAITING_CONFIRMATION',tier,actionHash,expiresAt,now]);
    await audit(tx,userId,id,'MANAGEMENT_PREPARED',{kind:data.spec.kind,actionHash,tier});
    await markPreparationPrepared(tx,schema,userId,'management',data.commandId,id,clock());
    return result.rows[0];
  };

  return {
    async migrate() {
      await pool.query(`CREATE SCHEMA IF NOT EXISTS ${s};
        CREATE TABLE IF NOT EXISTS ${s}.management_cards(id text PRIMARY KEY,user_id text NOT NULL,account_id text NOT NULL REFERENCES ${s}.accounts(id),name text NOT NULL,masked_number text NOT NULL,status text NOT NULL CHECK(status IN ('ACTIVE','LOST')),version integer NOT NULL CHECK(version>0),updated_at timestamptz NOT NULL,UNIQUE(id,user_id));
        CREATE TABLE IF NOT EXISTS ${s}.management_subscriptions(id text PRIMARY KEY,user_id text NOT NULL,merchant text NOT NULL,amount_minor bigint NOT NULL CHECK(amount_minor>0),next_charge_date text NOT NULL,card_id text NOT NULL,merchant_status text NOT NULL CHECK(merchant_status IN ('ACTIVE','CANCELLED')),bank_status text NOT NULL CHECK(bank_status IN ('ALLOWED','BLOCKED')),version integer NOT NULL CHECK(version>0),cancellation_supported boolean NOT NULL,FOREIGN KEY(card_id,user_id) REFERENCES ${s}.management_cards(id,user_id));
        CREATE TABLE IF NOT EXISTS ${s}.management_contact_aliases(user_id text NOT NULL,alias_key text NOT NULL,alias text NOT NULL,payee_id text NOT NULL REFERENCES ${s}.payees(id),created_at timestamptz NOT NULL,PRIMARY KEY(user_id,alias_key));
        CREATE TABLE IF NOT EXISTS ${s}.management_actions(id text PRIMARY KEY,user_id text NOT NULL,command_id text NOT NULL,input_hash text NOT NULL,task_id text NOT NULL,spec jsonb NOT NULL,title text NOT NULL,details jsonb NOT NULL,scope jsonb NOT NULL,status text NOT NULL,tier text NOT NULL,action_version integer NOT NULL,action_hash text NOT NULL,expires_at timestamptz NOT NULL,created_at timestamptz NOT NULL,updated_at timestamptz NOT NULL,receipt jsonb,failure_reason text,UNIQUE(user_id,command_id));
        CREATE INDEX IF NOT EXISTS management_actions_user_idx ON ${s}.management_actions(user_id,created_at);
        CREATE TABLE IF NOT EXISTS ${s}.management_authorization_proofs(proof_id text PRIMARY KEY,user_id text NOT NULL,action_id text NOT NULL REFERENCES ${s}.management_actions(id),action_hash text NOT NULL,level text NOT NULL,consumed_at timestamptz NOT NULL);
        CREATE TABLE IF NOT EXISTS ${s}.management_query_grants(action_id text PRIMARY KEY REFERENCES ${s}.management_actions(id),user_id text NOT NULL,queried_at timestamptz NOT NULL,expires_at timestamptz NOT NULL);
      `);
    },
    async seedDemo(actor) {
      const userId=owner(actor);
      await transaction(userId,async tx=>{
        const ownedAccount=await account(tx,userId),id=`card-main-${userId}`;
        await tx.query(`INSERT INTO ${s}.management_cards(id,user_id,account_id,name,masked_number,status,version,updated_at) VALUES($1,$2,$3,'日常借记卡','**** 2026','ACTIVE',1,$4) ON CONFLICT DO NOTHING`,[id,userId,ownedAccount.id,clock()]);
        const nextChargeDate=new Date(clock().getTime()+8*3600_000+10*86400_000).toISOString().slice(0,10);
        for(const [key,merchant,amount,supported] of [['music','云音乐','1800',true],['club','城市健身合约','19900',false]] as const) {
          await tx.query(`INSERT INTO ${s}.management_subscriptions(id,user_id,merchant,amount_minor,next_charge_date,card_id,merchant_status,bank_status,version,cancellation_supported)
            VALUES($1,$2,$3,$4,$5,$6,'ACTIVE','ALLOWED',1,$7) ON CONFLICT DO NOTHING`,[`sub-${key}-${userId}`,userId,merchant,amount,nextChargeDate,id,supported]);
        }
      });
    },
    async contacts(actor) { const userId=owner(actor);return transaction(userId,tx=>contacts(tx,userId)); },
    async dashboard(actor) {
      const userId=owner(actor);
      return transaction(userId,async tx=>{
        await account(tx,userId);
        const cards=await tx.query(`SELECT * FROM ${s}.management_cards WHERE user_id=$1 ORDER BY id`,[userId]);
        const actions=await tx.query(`SELECT * FROM ${s}.management_actions WHERE user_id=$1 ORDER BY created_at DESC,id DESC LIMIT 100`,[userId]);
        const grants=await activeGrants(tx,userId),queryIds=[...grants.keys()];
        // Preserve the frozen confirmation details only under this action's own query grant.
        // Query receipts themselves stay hidden on ordinary dashboard/getAction reads.
        return {cards:cards.rows.map(cardView),actions:actions.rows.map(a=>actionView(a,false,mutationDeadline(a,grants))),...(queryIds[0]?{subscriptionQueryActionId:queryIds[0]}:{})};
      });
    },
    async prepare(actor,input:ManagementInput) {
      const userId=owner(actor),data=validatedInput(input);
      return transaction(userId,async tx=>{
        await lockPreparationRequest(tx,schema,userId,'management','management',data,clock());
        await account(tx,userId);
        const prior=await existingPrepared(tx,userId,data);
        if(prior) {
          await markPreparationPrepared(tx,schema,userId,'management',data.commandId,prior.id,clock());
          // Retry may re-display a frozen mutation card only while its original query access is valid.
          return actionWithAccess(tx,userId,prior);
        }
        const evaluated=await evaluate(tx,userId,data.spec);
        return actionWithAccess(tx,userId,await insertPrepared(tx,userId,data,evaluated),true);
      });
    },
    async prepareBatch(actor,inputs) {
      const userId=owner(actor);
      if (!Array.isArray(inputs) || inputs.length<1 || inputs.length>8)
        throw new CoreError('INVALID_INPUT','批量订阅动作须包含 1 至 8 项',400);
      const data=inputs.map(input=>validatedInput(input));
      if (data.some(input=>input.spec.kind!=='SUBSCRIPTION_CANCEL' && input.spec.kind!=='SUBSCRIPTION_BLOCK'))
        throw new CoreError('INVALID_INPUT','批量准备仅支持取消订阅或限制银行扣款',400);
      if (new Set(data.map(input=>input.commandId)).size!==data.length)
        throw new CoreError('INVALID_INPUT','批量订阅动作的指令编号不得重复',400);
      return transaction(userId,async tx=>{
        for (const input of data) await lockPreparationRequest(tx,schema,userId,'management','management',input,clock());
        await account(tx,userId);
        const priors: (Row|undefined)[]=[];
        for (const input of data) priors.push(await existingPrepared(tx,userId,input));
        const evaluated: (Evaluation|undefined)[]=[];
        for (let i=0;i<data.length;i++)
          evaluated.push(priors[i]?undefined:await evaluate(tx,userId,data[i].spec));
        const actions:ManagementAction[]=[];
        for (let i=0;i<data.length;i++) {
          const row=priors[i]??await insertPrepared(tx,userId,data[i],evaluated[i]!);
          if (priors[i]) await markPreparationPrepared(tx,schema,userId,'management',data[i].commandId,row.id,clock());
          actions.push(await actionWithAccess(tx,userId,row,!priors[i]));
        }
        return actions;
      });
    },
    async getAction(actor,id) {
      const userId=owner(actor);
      return transaction(userId,async tx=>{
        const row=await getOwned(tx,userId,id);
        return actionWithAccess(tx,userId,row);
      });
    },
    async getByCommand(actor,commandId) {
      const userId=owner(actor);
      return transaction(userId,async tx=>{
        const result=await tx.query(`SELECT * FROM ${s}.management_actions WHERE user_id=$1 AND command_id=$2`,[userId,commandId]);
        if(!result.rows[0]) throw new CoreError('COMMAND_NOT_FOUND','管理指令记录不存在',404);
        const row=result.rows[0];
        // Resolving a lost response has the same privacy boundary as an ordinary read.
        return actionWithAccess(tx,userId,row);
      });
    },
    async authorize(actor,id,proof:AuthorizationProof) {
      const userId=owner(actor);
      if (!proof || !['CONFIRMATION','STRONG'].includes(proof.level) || typeof proof.proofId!=='string' || !proof.proofId || proof.proofId.length>256) throw new CoreError('INVALID_PROOF','无效授权凭据',400);
      return transaction(userId,async tx=>{
        const row=await getOwned(tx,userId,id);
        if(proof.actionHash!==row.action_hash) throw new CoreError('STALE_ACTION','动作摘要已变化，请重新确认');
        if(row.status==='SUCCEEDED') {
          // Retries are read-only: return the immutable receipt without consuming a new proof or renewing access.
          return actionWithAccess(tx,userId,row,true);
        }
        if(!pending.has(row.status)) throw new CoreError('INVALID_STATE','动作不是待批准状态');
        if(new Date(row.expires_at)<=clock()) throw new CoreError('ACTION_EXPIRED','动作已过期，请重新创建');
        if(row.tier==='RED' && proof.level!=='STRONG') return actionWithAccess(tx,userId,row);
        const spec=row.spec as ManagementSpec;
        const evaluated=await evaluate(tx,userId,spec); // re-check owner, resource version, alias and query-grant expiry
        if(digest(evaluated.scope)!==digest(row.scope)) throw new CoreError('STALE_RESOURCE','目标状态已变化，请重新创建动作');
        const proofRow=await tx.query(`INSERT INTO ${s}.management_authorization_proofs(proof_id,user_id,action_id,action_hash,level,consumed_at)
          VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING proof_id`,[proof.proofId,userId,id,proof.actionHash,proof.level,clock()]);
        if(!proofRow.rows[0]) throw new CoreError('PROOF_REPLAY','授权凭据已经被使用');
        const receipt:ManagementReceipt={operationId:`local:${id}`,completedAt:clock().toISOString(),summary:'本地合成操作已完成，余额不变。',balanceDeltaMinor:'0'};
        if(spec.kind==='CONTACT_ALIAS_SAVE') {
          await tx.query(`INSERT INTO ${s}.management_contact_aliases(user_id,alias_key,alias,payee_id,created_at) VALUES($1,$2,$3,$4,$5)`,[userId,aliasKey(spec.alias),spec.alias,spec.payeeId,clock()]);
          receipt.payee=(await contacts(tx,userId)).find(p=>p.id===spec.payeeId)!;
          receipt.summary='联系人别名已保存，仅当前用户可见。';
        } else if(spec.kind==='CARD_REPORT_LOST'||spec.kind==='CARD_UNREPORT_LOST') {
          const target=spec.kind==='CARD_REPORT_LOST'?'LOST':'ACTIVE';
          const changed=await tx.query(`UPDATE ${s}.management_cards SET status=$3,version=version+1,updated_at=$4 WHERE id=$1 AND user_id=$2 RETURNING *`,[spec.cardId,userId,target,clock()]);
          await tx.query(`UPDATE ${s}.management_subscriptions SET version=version+1 WHERE card_id=$1 AND user_id=$2`,[spec.cardId,userId]);
          receipt.card=cardView(changed.rows[0]);receipt.summary=target==='LOST'?'合成卡片已挂失；商户合同状态未改变。':'合成卡片已解挂；商户合同与银行扣款限制保持不变。';
        } else if(spec.kind==='SUBSCRIPTION_QUERY') {
          const g={action_id:id,queried_at:clock(),expires_at:new Date(clock().getTime()+grantTtl)};
          await tx.query(`INSERT INTO ${s}.management_query_grants(action_id,user_id,queried_at,expires_at) VALUES($1,$2,$3,$4)`,[id,userId,g.queried_at,g.expires_at]);
          receipt.subscriptions=await snapshot(tx,userId,g);receipt.summary='本地合成订阅查询已确认；查询权限有限期，未更改合同或余额。';
        } else {
          const field=spec.kind==='SUBSCRIPTION_CANCEL'?'merchant_status':'bank_status';
          const target=spec.kind==='SUBSCRIPTION_CANCEL'?'CANCELLED':'BLOCKED';
          await tx.query(`UPDATE ${s}.management_subscriptions SET ${field}=$3,version=version+1 WHERE id=$1 AND user_id=$2`,[spec.subscriptionId,userId,target]);
          receipt.subscription=(await subscriptionsList(tx,userId)).find(x=>x.id===spec.subscriptionId)!;
          receipt.summary=spec.kind==='SUBSCRIPTION_CANCEL'?'本地商户合同已取消；未退款，银行扣款限制状态不变。':'银行扣款已限制；商户合同仍独立存在，未退款。';
        }
        const result=await tx.query(`UPDATE ${s}.management_actions SET status='SUCCEEDED',receipt=$2,updated_at=$3 WHERE id=$1 RETURNING *`,[id,JSON.stringify(receipt),clock()]);
        await audit(tx,userId,id,'MANAGEMENT_SUCCEEDED',{kind:spec.kind,actionHash:row.action_hash,proofId:proof.proofId,level:proof.level,operationId:receipt.operationId,balanceDeltaMinor:'0'});
        return actionWithAccess(tx,userId,result.rows[0],true);
      });
    },
    async cancel(actor,id) {
      const userId=owner(actor);
      return transaction(userId,async tx=>{
        const row=await getOwned(tx,userId,id);
        if(!pending.has(row.status)) throw new CoreError('INVALID_STATE','只能取消待批准动作');
        if(new Date(row.expires_at)<=clock()) throw new CoreError('ACTION_EXPIRED','动作已过期');
        const result=await tx.query(`UPDATE ${s}.management_actions SET status='CANCELLED',updated_at=$2 WHERE id=$1 RETURNING *`,[id,clock()]);
        await audit(tx,userId,id,'MANAGEMENT_CANCELLED',{kind:row.spec.kind,actionHash:row.action_hash});
        return actionWithAccess(tx,userId,result.rows[0]);
      });
    },
    async subscriptions(actor,queryActionId) {
      const userId=owner(actor);
      return transaction(userId,async tx=>snapshot(tx,userId,await grant(tx,userId,queryActionId)));
    },
  };
}
