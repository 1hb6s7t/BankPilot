import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp, migrateApi } from '../apps/api/src/app';
import { createCore, createManagement } from '../packages/core/src/index';
import { createSubscriptionContinuationStore } from '../apps/api/src/subscription-continuations';
import { recognizeSubscriptionPrerequisite } from '../packages/agents/src/subscription-prerequisite';
import type { Planner, PlannerInput, SemanticPlan } from '../packages/contracts/src/index';

const url=process.env.TEST_DATABASE_URL??'postgres://bankpilot:bankpilot-local@127.0.0.1:55432/bankpilot';
const admin=new Pool({connectionString:url,max:2}),origin='http://localhost:5178',actor={userId:'g9f-api-owner'};
const message='取消云音乐的订阅；在银行侧阻止城市健身合约的扣款';
let pool:Pool,schema:string,app:ReturnType<typeof createApp>,core:ReturnType<typeof createCore>,management:ReturnType<typeof createManagement>;
let now:Date,interpretCalls:number,planCalls:number,omitTask:boolean,failPlan:boolean,expireDuringInterpret:boolean;
let planGate: Promise<void> | undefined;
let failGatedPlan = false;
const planner:Planner={
  async interpret(input){
    interpretCalls++;
    const prerequisite=recognizeSubscriptionPrerequisite(input.message)!;
    const tasks=prerequisite.tasks.map((task,index)=>({operation:task.operation,role:'subscription' as const,source:task.source,canonicalMessage:task.source.text,
      slots:{entityId:input.managementContext!.subscriptions!.items.find(item=>index===0?item.cancellationSupported:!item.cancellationSupported)!.id}}));
    if(expireDuringInterpret){now=new Date(now.getTime()+6*60_000);expireDuringInterpret=false;}
    return {status:'ready',tasks:omitTask?tasks.slice(0,1):tasks,findings:[],modelRuns:[]} as SemanticPlan;
  },
  async plan(input:PlannerInput){
    planCalls++; const gate = planGate; planGate = undefined; if (gate) { await gate; if (failGatedPlan) throw new Error("CONTROLLED_GATED_INTERRUPTION"); } if(failPlan)throw new Error('CONTROLLED_INTERRUPTION');
    const snap=input.managementContext!.subscriptions!;
    return {taskId:input.taskId,planVersion:1,mode:'scripted',summary:'PRIVATE_AMOUNT_CANARY_777777',events:[],suggestions:[],evidence:[{source:'private',detail:'PRIVATE_AMOUNT_CANARY_777777'}],findings:[],
      managementSuggestions:input.semanticIntent!.tasks.map(task=>({kind:task.operation==='subscription_cancel'?'SUBSCRIPTION_CANCEL':'SUBSCRIPTION_BLOCK',subscriptionId:task.slots.entityId!,expectedVersion:snap.items.find(item=>item.id===task.slots.entityId)!.version,queryActionId:snap.queryActionId}))};
  },
};
function rebuild(){
 const auth={api:{getSession:async({headers}:{headers:Headers})=>headers.get('cookie')==='owner=yes'?{user:{id:actor.userId,email:'test@example.test'},session:{id:'test',userId:actor.userId}}:null}};
 app=createApp({pool,auth:auth as never,core,management,planner,origin,rpID:'localhost',sandbox:false,plannerMode:'scripted'});
}
async function request(path:string,body?:unknown){return app.request(origin+path,{method:body===undefined?'GET':'POST',headers:{origin,cookie:'owner=yes','content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});}
async function json(path:string,body?:unknown){const r=await request(path,body);const value=await r.json();expect(r.status,JSON.stringify(value)).toBeLessThan(400);return value as any;}
async function begin(){const chat=await json('/api/conversations',{title:'原请求续办'});const accepted=await json(`/api/conversations/${chat.id}/messages`,{clientMessageId:randomUUID(),text:message});await app.waitForPlanning();const command=await json(`/api/conversations/${chat.id}/commands/${accepted.command.commandId}`);return {chat,command,query:command.result.managementActions[0]};}
async function confirm(action:any){return json(`/api/management/actions/${action.id}/confirm`,{actionHash:action.actionHash});}
async function current(source:string){return createSubscriptionContinuationStore(pool).get(actor,source);}
async function child(source:string){const state=await current(source);return json(`/api/conversations/${state!.conversationId}/commands/${state!.successorCommandId}`);}
beforeEach(async()=>{
 schema=`g9fapi_${randomUUID().replaceAll('-','').slice(0,12)}`;await admin.query(`CREATE SCHEMA "${schema}"`);
 pool=new Pool({connectionString:url,options:`-c search_path=${schema},public`,max:12});
 await migrateApi(pool);now=new Date();core=createCore(pool,{schema,clock:()=>now});management=createManagement(pool,{schema,clock:()=>now});
 await core.migrate();await core.seedDemo(actor);await management.migrate();await management.seedDemo(actor);
 interpretCalls=0;planCalls=0;omitTask=false;failPlan=false;expireDuringInterpret=false;planGate=undefined;failGatedPlan=false;rebuild();
});
afterEach(async()=>{app?.stopContinuations();await app?.waitForPlanning();await pool?.end();await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);});
afterAll(async()=>{await admin.end();});

describe('G9F query confirmation continues the exact original request',()=>{
 it('requires query confirmation, creates one child and independently confirmed writes without another user message',async()=>{
  const {chat,command,query}=await begin();expect(command.status).toBe('complete');expect(interpretCalls).toBe(0);expect(planCalls).toBe(0);
  expect((await current(command.commandId))?.state).toBe('WAITING_QUERY');
  expect((await management.dashboard(actor)).actions.map(a=>a.spec.kind)).toEqual(['SUBSCRIPTION_QUERY']);
  await confirm(query);await app.waitForPlanning();const result=await child(command.commandId);
  expect(result.status).toBe('complete');expect(result.originalMessage).toBe(message);expect(result.planningInput.message).toBe(message);
  expect(result.result.managementActions).toHaveLength(2);expect(result.result.managementActions.every((a:any)=>a.status==='AWAITING_CONFIRMATION')).toBe(true);
  expect((await current(command.commandId))?.state).toBe('WRITE_PREPARED');expect(interpretCalls).toBe(1);expect(planCalls).toBe(1);
  const history=await json(`/api/conversations/${chat.id}/messages`);expect(history.messages.filter((m:any)=>m.role==='user')).toHaveLength(1);expect(history.latestCommandId).toBe(result.commandId);
  expect(JSON.stringify(history)).not.toContain('PRIVATE_AMOUNT_CANARY');
  expect(history.commands.find((c:any)=>c.commandId===result.commandId).result.managementActions.every((a:any)=>a.detailsRedacted===false)).toBe(true);
  await confirm(query);await app.waitForPlanning();expect((await child(command.commandId)).commandId).toBe(result.commandId);expect(planCalls).toBe(1);
  await confirm(result.result.managementActions[0]);const snap=await management.subscriptions(actor,query.id);
  expect(snap.items.find(i=>i.cancellationSupported)?.merchantStatus).toBe('CANCELLED');expect(snap.items.find(i=>!i.cancellationSupported)?.bankStatus).toBe('ALLOWED');
 });
 it('discloses continuation history cards only while their exact query grant remains valid',async()=>{
  const {chat,command,query}=await begin();await confirm(query);await app.waitForPlanning();
  const result=await child(command.commandId);
  const active=await json(`/api/conversations/${chat.id}/messages`);
  expect(active.commands.find((c:any)=>c.commandId===result.commandId).result.managementActions.every((a:any)=>a.detailsRedacted===false)).toBe(true);
  now=new Date(now.getTime()+6*60_000);
  const expired=await json(`/api/conversations/${chat.id}/messages`);
  expect(expired.commands.find((c:any)=>c.commandId===result.commandId).result.managementActions.every((a:any)=>a.detailsRedacted===true)).toBe(true);
  const stored=(await pool.query('SELECT result FROM bp_plan_commands WHERE command_id=$1',[result.commandId])).rows[0].result;
  expect(stored.managementActions.every((a:any)=>a.detailsRedacted===true && a.details.length===0)).toBe(true);
 });
 it('refuses omitted original tasks and publishes no partial write cards',async()=>{
  const {command,query}=await begin();omitTask=true;await confirm(query);await app.waitForPlanning();
  expect((await current(command.commandId))?.state).toBe('NEEDS_CLARIFICATION');expect(planCalls).toBe(0);
  expect((await management.dashboard(actor)).actions.filter(a=>a.spec.kind!=='SUBSCRIPTION_QUERY')).toHaveLength(0);
 });
 it('retains a failed child for explicit retry with the same source message and original input',async()=>{
  const {chat,command,query}=await begin();failPlan=true;await confirm(query);await app.waitForPlanning();
  const first=await child(command.commandId);expect(first.status).toBe('failed');expect((await current(command.commandId))?.state).toBe('FAILED_RECOVERABLE');
  const recovery=await json(`/api/conversations/${chat.id}/recovery`);expect(recovery.items.some((r:any)=>r.commandId===first.commandId)).toBe(true);
  failPlan=false;await json(`/api/conversations/${chat.id}/commands/${first.commandId}/retry`,{});await app.waitForPlanning();
  const retried=await child(command.commandId);expect(retried.commandId).toBe(first.commandId);expect(retried.status).toBe('complete');expect(interpretCalls).toBe(1);
 });
 it('queues explicit failed-child retry while the same owner has another continuation running',async()=>{
  const first=await begin(),second=await begin();failPlan=true;await confirm(first.query);await app.waitForPlanning();
  const failed=await child(first.command.commandId);expect(failed.status).toBe('failed');
  failPlan=false;let release!:()=>void;
  planGate=new Promise<void>(resolve=>{release=resolve;}); failGatedPlan=true;
  try {
   await confirm(second.query);
   await expect.poll(()=>planCalls).toBe(2);
   await json(`/api/conversations/${first.chat.id}/commands/${failed.commandId}/retry`,{});
  } finally { release(); }
  await app.waitForPlanning();
  expect((await child(first.command.commandId)).commandId).toBe(failed.commandId);
  expect((await child(first.command.commandId)).status).toBe('complete');
  expect((await current(second.command.commandId))?.state).toBe('FAILED_RECOVERABLE');
  expect(planCalls).toBe(3);
 });
 it('expires the exact grant during planning and requires a new confirmed query cycle',async()=>{
  const {chat,command,query}=await begin();expireDuringInterpret=true;await confirm(query);await app.waitForPlanning();
  expect((await current(command.commandId))?.state).toBe('NEEDS_QUERY_REAUTH');expect(planCalls).toBe(0);
  const oldChild=(await current(command.commandId))!.successorCommandId;
  const renewed=await json(`/api/conversations/${chat.id}/subscription-continuations/${command.commandId}/requery`,{});
  const next=renewed.result.managementActions[0];expect(next.id).not.toBe(query.id);expect((await current(command.commandId))?.state).toBe('WAITING_QUERY');
  await confirm(next);await app.waitForPlanning();expect((await current(command.commandId))?.state).toBe('WRITE_PREPARED');expect((await current(command.commandId))?.successorCommandId).not.toBe(oldChild);
  const result=await child(command.commandId);expect(result.result.managementActions.every((a:any)=>a.spec.queryActionId===next.id)).toBe(true);
 });
 it('recovers an already-confirmed waiting query on server restart without reauthorizing it',async()=>{
  const {command,query}=await begin();await management.authorize(actor,query.id,{level:'CONFIRMATION',proofId:randomUUID(),actionHash:query.actionHash});
  await app.waitForPlanning();rebuild();app.startContinuations();
  await expect.poll(async()=> (await current(command.commandId))?.state,{timeout:10000}).toBe('WRITE_PREPARED');
  app.stopContinuations();await app.waitForPlanning();expect((await child(command.commandId)).originalMessage).toBe(message);expect(planCalls).toBe(1);
 });
 it('stops a waiting continuation without treating later query confirmation as write authorization',async()=>{
  const {chat,command,query}=await begin();await json(`/api/conversations/${chat.id}/subscription-continuations/${command.commandId}/stop`,{});
  await confirm(query);await app.waitForPlanning();expect((await current(command.commandId))?.state).toBe('STOPPED');expect(planCalls).toBe(0);
  expect((await management.dashboard(actor)).actions.filter(a=>a.spec.kind!=='SUBSCRIPTION_QUERY')).toHaveLength(0);
 });
});
