import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { betterAuth } from 'better-auth';
import { serve } from '@hono/node-server';
import { createServer, type ViteDevServer } from 'vite';
import react from '@vitejs/plugin-react';
import { createApp, migrateApi } from '../../apps/api/src/app.js';
import { createCore, createFinance, createManagement, createInvestment, startWorker } from '../../packages/core/src/index.js';
import { createGoals } from '../../packages/core/src/goals.js';
import { createPlanner } from '../../packages/agents/src/index.js';
import type { LocalContext, ReviewContext } from '../../packages/agents/src/index.js';
import { normalizeBaseURL, type OpenAICompatibleConfig } from '../../packages/agents/src/provider.js';
import { createG8hControlledModel, G8H_MODEL_ORIGIN } from './g8h-controlled-model.js';

export type G8hCleanupEvidence = {
  success:boolean; clean:boolean; planningDrained:boolean; workerStopped:boolean;
  schemaDropped:boolean; jobsSchemaDropped:boolean; authUserDeleted:boolean;
  portsClosed:boolean; ownedConnectionsClosed:boolean; temporaryDirectoryRemoved:boolean;
  errors:{stage:string;code:string}[];
};
let fixtureActive=false;
const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
const localHost=(host:string)=>['localhost','127.0.0.1','[::1]','::1'].includes(host);
async function portClosed(port:number) {
  return new Promise<boolean>(resolve=>{const socket=createConnection({host:'127.0.0.1',port});
    const finish=(closed:boolean)=>{socket.destroy();resolve(closed);};
    socket.setTimeout(1000,()=>finish(false));socket.once('connect',()=>finish(false));socket.once('error',error=>finish((error as NodeJS.ErrnoException).code==='ECONNREFUSED'));
  });
}
/** Real auth, isolated PostgreSQL, planner and worker. Defaults to a controlled model;
 * an explicit cloudProvider allows only its exact HTTPS completion endpoint. */
export async function startG8hBrowserApp(options: { cloudProvider?: OpenAICompatibleConfig; businessTime?: 'previous-business-day'; controlledReviewerOverride?: (context: ReviewContext) => unknown; controlledBillDomainOverride?: (context: LocalContext) => unknown } = {}) {
  if(fixtureActive) throw new Error('G8H_FIXTURE_ALREADY_ACTIVE');
  if(options.cloudProvider && options.controlledBillDomainOverride) throw new Error('G9H_CONTROLLED_BILL_DOMAIN_FORBIDS_CLOUD');
  if(options.cloudProvider && options.controlledReviewerOverride) throw new Error('G8H_CONTROLLED_REVIEWER_FORBIDS_CLOUD');
  // Only the explicitly opted-in controlled suite simulates a business date.
  // Auth, management, SQL scheduling and browser timers remain on wall time.
  if (options.businessTime && options.cloudProvider) throw new Error('G8H_BUSINESS_TIME_FORBIDS_CLOUD');
  if (options.businessTime && options.businessTime !== 'previous-business-day') throw new Error('G8H_BUSINESS_TIME_REJECTED');
  const wallStart = new Date(), elapsedStart = performance.now();
  const businessStart = new Date(wallStart);
  if (options.businessTime) {
    const shanghai = new Date(wallStart.valueOf() + 8 * 3600_000);
    shanghai.setUTCDate(shanghai.getUTCDate() - 1);
    while (shanghai.getUTCDay() === 0 || shanghai.getUTCDay() === 6) shanghai.setUTCDate(shanghai.getUTCDate() - 1);
    businessStart.setTime(shanghai.valueOf() - 8 * 3600_000);
    // Recognition still resolves 本月 using wall time. Refuse a mixed month.
    if (shanghai.toISOString().slice(0, 7) !== new Date(wallStart.valueOf() + 8 * 3600_000).toISOString().slice(0, 7)) throw new Error('G8H_BUSINESS_TIME_CROSSES_MONTH');
  }
  const businessClock = options.businessTime ? () => new Date(Math.min(Date.now(), businessStart.valueOf() + Math.max(0, performance.now() - elapsedStart))) : undefined;
  const businessClockOptions = businessClock ? { clock: businessClock } : {};
  const timeDomains = {
    mode: options.businessTime ?? 'wall-clock', wallStart: wallStart.toISOString(), businessStart: businessStart.toISOString(), offsetMs: businessStart.valueOf() - wallStart.valueOf(),
    businessServices: options.businessTime ? ['core', 'finance', 'investment', 'goals'] : [],
    wallServices: [...(options.businessTime ? [] : ['core', 'finance', 'investment', 'goals']), 'management', 'auth', 'webauthn-challenges', 'database', 'worker-scheduler', 'browser', 'recognition-referenceDate'],
    acceptanceExclusions: options.businessTime ? ['wall-clock action TTL', 'wall-clock reconciliation backoff'] : [],
  };
  const connectionString=process.env.TEST_DATABASE_URL??process.env.DATABASE_URL??'postgres://bankpilot:bankpilot-local@127.0.0.1:55432/bankpilot';
  if(!localHost(new URL(connectionString).hostname)) throw new Error('G8H_DATABASE_MUST_BE_LOCAL');
  const cloudEndpoint = options.cloudProvider ? new URL(`${normalizeBaseURL(options.cloudProvider.baseURL)}/chat/completions`) : undefined;
  if (cloudEndpoint && (cloudEndpoint.protocol !== 'https:' || cloudEndpoint.username || cloudEndpoint.password)) throw new Error('G8H_CLOUD_ENDPOINT_REJECTED');
  fixtureActive=true;
  const suffix=randomUUID().replaceAll('-','').slice(0,18),schema=`g8h_browser_${suffix}`,jobsSchema=`${schema}_jobs`,applicationName=`g8h_${suffix}`;
  const admin=new Pool({connectionString,max:2,application_name:`${applicationName}_admin`});
  const authPool=new Pool({connectionString,options:'-c search_path=public',max:4,application_name:`${applicationName}_auth`});
  const pool=new Pool({connectionString,options:`-c search_path=${schema}`,max:12,application_name:applicationName});
  const model=createG8hControlledModel(undefined, options.controlledReviewerOverride, options.controlledBillDomainOverride),originalFetch=globalThis.fetch;
  const cloudCalls: { sequence:number; startedAt:string; durationMs:number; httpStatus?:number; outcome:'pending'|'response'|'transport_error' }[] = [];
  const email=`g8h-browser-${randomUUID()}@example.test`,password=`G8h-${randomBytes(20).toString('hex')}!`;
  let userId:string|undefined,app:ReturnType<typeof createApp>|undefined,worker:Awaited<ReturnType<typeof startWorker>>|undefined;
  let apiServer:ReturnType<typeof serve>|undefined,vite:ViteDevServer|undefined,temporaryEnvDirectory:string|undefined;
  let workerStarting=false,signupStarted=false;
  let schemaCreated=false,accepting=true,controlledFetch:typeof fetch|undefined,apiPort:number|undefined,webPort:number|undefined;
  let closePromise:Promise<G8hCleanupEvidence>|undefined;
  function close():Promise<G8hCleanupEvidence> {
    return closePromise??=(async()=>{
      const evidence:G8hCleanupEvidence={success:false,clean:false,planningDrained:false,workerStopped:false,schemaDropped:false,jobsSchemaDropped:false,authUserDeleted:false,portsClosed:false,ownedConnectionsClosed:false,temporaryDirectoryRemoved:false,errors:[]};
      const step=async(stage:string,action:()=>Promise<void>)=>{try{await action();}catch(error){const code=(error as {code?:unknown})?.code;evidence.errors.push({stage,code:typeof code==='string'&&/^[0-9A-Z]{5}$/.test(code)?code:'CLEANUP_STEP_FAILED'});}};
      // Fence new ingress before waiting for every already accepted request and plan.
      accepting=false;
      await step('planning',async()=>{await app?.waitForPlanning();evidence.planningDrained=true;});
      await step('worker',async()=>{if(worker)await worker.stop();else if(workerStarting)throw new Error('WORKER_STARTUP_NOT_CONFIRMED');evidence.workerStopped=true;});
      for(const _error of worker?.errors??[]) evidence.errors.push({stage:'worker_runtime',code:'WORKER_ERROR'});
      await step('web',async()=>{await vite?.close();});
      await step('api',async()=>{if(apiServer) await new Promise<void>((resolve,reject)=>apiServer!.close(error=>error?reject(error):resolve()));});
      if(controlledFetch&&globalThis.fetch===controlledFetch) globalThis.fetch=originalFetch;
      else if(controlledFetch) evidence.errors.push({stage:'fetch_owner',code:'FETCH_OWNER_CHANGED'});
      await step('business_pool',()=>pool.end());
      // Goal mutex pools inherit this unique application_name and expire their idle clients after 1s.
      await step('owned_connections',async()=>{for(let n=0;n<20;n++){const rows=await admin.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name=$1',[applicationName]);if(rows.rows[0].n===0){evidence.ownedConnectionsClosed=true;return;}await sleep(150);}throw new Error('OWNED_CONNECTIONS_REMAIN');});
      await step('auth_user',async()=>{if(signupStarted&&!userId){const candidates=await authPool.query('SELECT id FROM public."user" WHERE email=$1',[email]);if(candidates.rows.length>1)throw new Error('AUTH_OWNER_AMBIGUOUS');userId=candidates.rows[0]?.id;}if(userId){await authPool.query('DELETE FROM public.session WHERE "userId"=$1',[userId]);await authPool.query('DELETE FROM public.account WHERE "userId"=$1',[userId]);await authPool.query('DELETE FROM public."user" WHERE id=$1',[userId]);const row=await authPool.query('SELECT count(*)::int AS n FROM public."user" WHERE id=$1',[userId]);if(row.rows[0].n!==0)throw new Error('USER_REMAINS');}evidence.authUserDeleted=true;});
      await step('jobs_schema',async()=>{await admin.query(`DROP SCHEMA IF EXISTS "${jobsSchema}" CASCADE`);evidence.jobsSchemaDropped=(await admin.query('SELECT to_regnamespace($1) IS NULL AS gone',[jobsSchema])).rows[0].gone;});
      await step('business_schema',async()=>{if(schemaCreated)await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);evidence.schemaDropped=(await admin.query('SELECT to_regnamespace($1) IS NULL AS gone',[schema])).rows[0].gone;});
      await step('ports',async()=>{evidence.portsClosed=(await Promise.all([apiPort,webPort].filter((p):p is number=>p!==undefined).map(portClosed))).every(Boolean);if(!evidence.portsClosed)throw new Error('PORT_REMAINS');});
      await step('auth_pool',()=>authPool.end());await step('admin_pool',()=>admin.end());
      await step('temporary_directory',async()=>{if(temporaryEnvDirectory)await rm(temporaryEnvDirectory,{recursive:true,force:true});evidence.temporaryDirectoryRemoved=true;});
      evidence.success=evidence.clean=evidence.errors.length===0&&evidence.planningDrained&&evidence.workerStopped&&evidence.schemaDropped&&evidence.jobsSchemaDropped&&evidence.authUserDeleted&&evidence.portsClosed&&evidence.ownedConnectionsClosed&&evidence.temporaryDirectoryRemoved;
      fixtureActive=false;return evidence;
    })();
  }
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);schemaCreated=true;await migrateApi(pool);
    const core=createCore(pool,{schema,reconcileDelayMs:30_000,...businessClockOptions});await core.migrate();
    const finance=createFinance(pool,{schema,...businessClockOptions});const management=createManagement(pool,{schema});await management.migrate();
    const investment=createInvestment(pool,{schema,...businessClockOptions});await investment.migrate();
    const goals=createGoals(pool,core,investment,finance,{schema,...businessClockOptions});await goals.migrate();
    apiPort=await new Promise<number>(resolve=>{apiServer=serve({port:0,hostname:'127.0.0.1',fetch:request=>accepting&&app?app.fetch(request):new Response('Isolated fixture unavailable',{status:503})},info=>resolve(info.port));});
    const apiOrigin=`http://127.0.0.1:${apiPort}`;
    temporaryEnvDirectory=await mkdtemp(resolve(tmpdir(),'bankpilot-g8h-web-'));
    vite=await createServer({configFile:false,root:resolve('apps/web'),envDir:temporaryEnvDirectory,plugins:[react()],server:{host:'127.0.0.1',port:0,strictPort:true,proxy:{'/api':{target:apiOrigin,changeOrigin:false}}},logLevel:'error'});
    await vite.listen();const address=vite.httpServer?.address();if(!address||typeof address==='string')throw new Error('G8H_WEB_ADDRESS_UNAVAILABLE');webPort=address.port;
    if([apiPort,webPort].some(port=>port===8787||port===5178))throw new Error('G8H_PRODUCTION_PORT_REJECTED');
    const origin=`http://localhost:${webPort}`;
    const auth=betterAuth({appName:'BankPilot G8H isolated experience',database:authPool,secret:randomBytes(48).toString('hex'),baseURL:origin,trustedOrigins:[origin],emailAndPassword:{enabled:true},session:{expiresIn:8*60*60,cookieCache:{enabled:false}},advanced:{cookiePrefix:`g8h-${randomUUID()}`}});
    signupStarted=true;
    userId=(await auth.api.signUpEmail({body:{email,password,name:'G8H独立合成体验验收'}})).user.id;
    const actor={userId};await core.seedDemo(actor);await finance.seedDemo(actor);await management.seedDemo(actor);await investment.seedDemo(actor);
    controlledFetch=async(input,init)=>{const url=new URL(typeof input==='string'||input instanceof URL?input.toString():input.url);
      if(cloudEndpoint && url.href === cloudEndpoint.href) {
        const tick = performance.now(), observed: (typeof cloudCalls)[number] = { sequence: cloudCalls.length+1, startedAt: new Date().toISOString(), durationMs: 0, outcome: 'pending' };
        cloudCalls.push(observed);
        try {
          const response = await originalFetch(input, { ...init, redirect: 'error' });
          Object.assign(observed, { durationMs: Math.round(performance.now()-tick), httpStatus: response.status, outcome: 'response' });
          return response;
        } catch (error) { Object.assign(observed, { durationMs: Math.round(performance.now()-tick), outcome: 'transport_error' }); throw error; }
      }
      if(!cloudEndpoint && url.origin===G8H_MODEL_ORIGIN&&['/chat/completions','/v1/chat/completions'].includes(url.pathname))return model.respond(JSON.parse(String(init?.body)));
      if(!localHost(url.hostname))throw new Error('G8H_EXTERNAL_NETWORK_BLOCKED');
      return originalFetch(input,init);
    };globalThis.fetch=controlledFetch;
    const planner=createPlanner({provider:options.cloudProvider ?? {baseURL:G8H_MODEL_ORIGIN,model:'g8h-controlled-browser',outputMode:'json_object',maxAttempts:2,retryDelayMs:1}});
    app=createApp({pool,core,finance,management,investment,goals,auth,planner,origin,rpID:'localhost',sandbox:true,plannerMode:'model'});
    workerStarting=true;
    worker=await startWorker(pool,core,investment);
    workerStarting=false;
    return {origin,apiOrigin,schema,jobsSchema,userId,email,password,calls:model.calls,cloudCalls,timeDomains,modelMode:cloudEndpoint?'configured-cloud':'controlled',scenarios:model.scenarios,
      configureScenario:model.configureScenario,failNextRolePair:model.failNextRolePair,
      timeoutNextTransfer:()=>core.setNextFault(actor,'TIMEOUT_AFTER_COMMIT'),
      async savedCommand(commandId:string){return(await pool.query('SELECT * FROM bp_plan_commands WHERE user_id=$1 AND command_id=$2',[userId,commandId])).rows[0];},
      async saved(conversationId:string){const [conversation,messages,commands]=await Promise.all([pool.query('SELECT * FROM bp_conversations WHERE user_id=$1 AND id=$2',[userId,conversationId]),pool.query('SELECT * FROM bp_chat_messages WHERE user_id=$1 AND conversation_id=$2 ORDER BY sequence',[userId,conversationId]),pool.query('SELECT * FROM bp_plan_commands WHERE user_id=$1 AND conversation_id=$2 ORDER BY updated_at,command_id',[userId,conversationId])]);return{conversation:conversation.rows[0],messages:messages.rows,commands:commands.rows};},
      async snapshot(){
        const [dashboard,managementView,investmentView,goalViews]=await Promise.all([core.dashboard(actor),management.dashboard(actor),investment.dashboard(actor),goals.list(actor)]);
        const tx=await pool.connect();const tables:Record<string,Record<string,any>[]>= {};
        try{await tx.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
          const owned:Record<string,string>={preparationRequests:'preparation_requests',authorizationProofs:'authorization_proofs',managementAuthorizationProofs:'management_authorization_proofs',investmentAuthorizationProofs:'investment_proofs',actions:'actions',investmentActions:'investment_actions',managementActions:'management_actions',auditEvents:'audit_events',providerRedemptions:'provider_redemptions',positions:'investment_positions',providerPositions:'provider_positions',managementCards:'management_cards',managementSubscriptions:'management_subscriptions',managementQueryGrants:'management_query_grants',goals:'goals',goalNodeIntents:'goal_node_intents'};
          for(const [key,table]of Object.entries(owned))tables[key]=(await tx.query(`SELECT * FROM "${schema}".${table} WHERE user_id=$1`,[userId])).rows;
          tables.providerTransfers=(await tx.query(`SELECT p.* FROM "${schema}".provider_transfers p JOIN "${schema}".accounts a ON a.id=p.account_id WHERE a.user_id=$1`,[userId])).rows;
          tables.ledgerEntries=(await tx.query(`SELECT e.* FROM "${schema}".provider_entries e JOIN "${schema}".provider_transfers p USING(provider_key) JOIN "${schema}".accounts a ON a.id=p.account_id WHERE a.user_id=$1 ORDER BY e.id`,[userId])).rows;
          tables.redemptionEntries=(await tx.query(`SELECT e.* FROM "${schema}".redemption_entries e JOIN "${schema}".provider_redemptions p USING(provider_key) WHERE p.user_id=$1 ORDER BY e.id`,[userId])).rows;
          for(const [key,table,parent]of [['outbox','outbox','actions'],['investmentOutbox','investment_outbox','investment_actions']])tables[key!]=(await tx.query(`SELECT o.* FROM "${schema}".${table} o JOIN "${schema}".${parent} a ON a.id=o.action_id WHERE a.user_id=$1 ORDER BY o.id`,[userId])).rows;
          await tx.query('COMMIT');
        }catch(error){await tx.query('ROLLBACK');throw error;}finally{tx.release();}
        tables.investmentAudit=tables.auditEvents!.filter(row=>String(row.type).startsWith('REDEMPTION_'));
        tables.managementAudit=tables.auditEvents!.filter(row=>String(row.type).startsWith('MANAGEMENT_'));
        tables.goalAudit=tables.auditEvents!.filter(row=>String(row.type).startsWith('GOAL_'));
        return{capturedAt:new Date().toISOString(),schema,userId,dashboard,management:managementView,investment:investmentView,goals:goalViews,tables,providerTransfers:tables.providerTransfers!,ledgerEntries:tables.ledgerEntries!,audit:tables.auditEvents!};
      },close,
    };
  }catch(error){const cleanup=await close();const failure=new Error('G8H_FIXTURE_START_FAILED');Object.assign(failure,{cleanup,startupCode:error instanceof Error&&/^G8H_[A-Z_]+$/.test(error.message)?error.message:'STARTUP_FAILED'});throw failure;}
}
