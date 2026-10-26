import { billDomainResponse } from './bill-domain-response.js';
import { semanticIntentSchema, type SemanticIntentDraft } from '../../packages/agents/src/semantic-intent.js';
import type { LocalContext, ReviewContext } from '../../packages/agents/src/index.js';
import { reviewResponse } from './review-response.js';
import { syntheticInvestmentProducts } from '../../packages/contracts/src/investment.js';

export const G8H_MODEL_ORIGIN = 'https://g8h-model.invalid';
export type G8hModelRole = 'semantic_intent'|'transfer'|'bills'|'investment'|'card'|'subscription'|'goal'|'reviewer';
export type G8hModelCall = { sequence: number; role: G8hModelRole; taskId?: string; status: number; requestMaxOutputTokens: number; responseKind: 'valid'|'unavailable' };
type CatalogEntry = { kind: 'payee'|'position'|'card'|'subscription'; id: string; names: string[]; suffix: string };
export type G8hSemanticRequest = { role:'semantic_intent'; taskId:string; message:string; catalog:CatalogEntry[]; referenceDate:string|null };
export type G8hScenario = { message: string; semanticDraft: SemanticIntentDraft | ((task:G8hSemanticRequest)=>SemanticIntentDraft) };
export function g8hScenarios(now = new Date()) {
  const targetDate = new Date(now.valueOf()+30*86400_000+8*3600_000).toISOString().slice(0,10);
  const t0=syntheticInvestmentProducts.find(p=>p.redemptionBusinessDays===0)!.name, t2=syntheticInvestmentProducts.find(p=>p.redemptionBusinessDays===2)!.name;
  return Object.freeze({ targetDate, transferExact:'给林晓转账307.50元', transferUnknown:'给林晓转账600.00元', billsCurrent:'查询本月账单收入和支出', billsMissing:'查询2020年1月账单',
    billsProtectedTransfer:'查本月账单，给林晓转账4000元，不影响房租和生活费',
    redeemT0:`从${t0}赎回427.35元`, redeemT2:`从${t2}赎回100.50元`, redeemUnknown:'从未知理财持仓赎回80.00元',
    cardQuery:'查询银行卡状态', cardLost:'挂失尾号2026银行卡', cardRestore:'解挂尾号2026银行卡', cardAmbiguous:'挂失银行卡',
    subscriptionQuery:'查询订阅', subscriptionCancel:'取消云音乐订阅', subscriptionBlock:'阻止城市健身合约的银行扣款',
    tuitionGoal:`给林晓准备600.75元学费，${targetDate}前到账；先从${t0}赎回1000元`,
  });
}
export type G8hScenarios = ReturnType<typeof g8hScenarios>;
const clone=<T>(value:T):T=>structuredClone(value);
const envelope=(value:unknown)=>new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(value)}}],usage:{prompt_tokens:120,completion_tokens:80}}),{status:200,headers:{'Content-Type':'application/json'}});
const span=(text:string)=>({text});
function entity(task:G8hSemanticRequest,kind:CatalogEntry['kind'],text:string) {
  const matches=task.catalog.filter(item=>item.kind===kind && (item.names.includes(text) || kind==='card' && text===`尾号${item.suffix}`));
  if(matches.length!==1) return undefined;
  return {kind,id:matches[0]!.id,mention:span(text)};
}
/** Deliberately finite test vocabulary; all answers still traverse the production grounding checks. */
export function defaultG8hSemantic(task:G8hSemanticRequest, scenarios:G8hScenarios):SemanticIntentDraft {
  const message=task.message, scope={source:'whole_message' as const};
  const one=(operation:SemanticIntentDraft['tasks'][number]['operation'],fields:Record<string,unknown>={},query=false):SemanticIntentDraft=>({tasks:[{operation,disposition:query?'query':'request',scope,...fields}] as SemanticIntentDraft['tasks']});
  if(message===scenarios.billsCurrent) return one('bills_query',{period:span('本月')},true);
  if(message===scenarios.billsMissing) return one('bills_query',{period:span('2020年1月')},true);
  if(message===scenarios.billsProtectedTransfer) return {tasks:[{operation:'bills_query',disposition:'query',scope:span('查本月账单'),period:span('本月')},{operation:'transfer',disposition:'request',scope:span('给林晓转账4000元'),entity:entity(task,'payee','林晓'),amount:span('4000元')},{operation:'funds_query',disposition:'query',scope:span('不影响房租和生活费')}]};
  if(message===scenarios.tuitionGoal) return one('goal_create',{entity:entity(task,'payee','林晓'),amount:span('600.75元'),date:span(scenarios.targetDate),funding:{entity:entity(task,'position',syntheticInvestmentProducts.find(p=>p.redemptionBusinessDays===0)!.name),amount:span('1000元')}});
  if(message===scenarios.redeemT0 || message===scenarios.redeemT2) {
    const product=syntheticInvestmentProducts.find(p=>message.includes(p.name))!;
    return one('investment_redeem',{entity:entity(task,'position',product.name),amount:span(message.endsWith('427.35元')?'427.35元':'100.50元')});
  }
  if(message===scenarios.redeemUnknown) return one('investment_redeem',{amount:span('80.00元')});
  if(message===scenarios.cardQuery) return one('card_query',{},true);
  if(message===scenarios.cardLost || message===scenarios.cardRestore) return one(message===scenarios.cardLost?'card_report_lost':'card_restore',{entity:entity(task,'card','尾号2026')});
  if(message===scenarios.cardAmbiguous) return one('card_report_lost');
  if(message===scenarios.subscriptionQuery) return one('subscription_query',{},true);
  if(message===scenarios.subscriptionCancel) return one('subscription_cancel',{entity:entity(task,'subscription','云音乐')});
  if(message===scenarios.subscriptionBlock) return one('subscription_block',{entity:entity(task,'subscription','城市健身合约')});
  const transfer=/^给林晓转账([0-9]+(?:\.[0-9]{2})?元)$/.exec(message);
  if(transfer) return one('transfer',{entity:entity(task,'payee','林晓'),amount:span(transfer[1]!)});
  throw new Error('G8H_SCENARIO_NOT_CONFIGURED');
}
/** Repeats only server-resolved DTOs; no fixed PlanResult or authorization is fabricated. */
export function g8hDomainResponse(task:LocalContext) {
  const base={role:task.role,planVersion:task.planVersion,summary:'受控合成提案，尚未授权执行',findings:[] as string[],evidence:[] as {source:string;detail:string}[]};
  if(task.role==='transfer') {
    const resolved=task.data.resolved as any;
    return {...base,summary:resolved.noActionReason??base.summary,...(resolved.suggestion?{suggestion:clone(resolved.suggestion)}:{}),...(resolved.clarification?{clarification:resolved.clarification}:{})};
  }
  if(task.role==='bills') return billDomainResponse(task);
  if(task.role==='investment') return {...base,...clone(task.data.investment as object)};
  if(task.role==='card'||task.role==='subscription') return {...base,...clone(task.data.management as object)};
  if(task.role==='goal' && task.data.lifeGoal) return {...base,...clone(task.data.lifeGoal as object)};
  if(task.role==='goal') { const funds=task.data.funds as any; return {...base,summary:funds ? `服务端资金保护核对：可安排${funds.spendableMinor}分；本次${funds.allowed?'符合':'不符合'}保护规则。`:'缺少服务端资金预演',findings:clone(funds?.reasons??[]),evidence:funds?[{source:`funds-preview:policy-${funds.policyVersion}`,detail:`allowed=${funds.allowed};protectedMinor=${funds.protectedMinor};shortfallMinor=${funds.shortfallMinor}`}]:[]}; }
  throw new Error('G8H_DOMAIN_NOT_SUPPORTED');
}
export function g8hReviewResponse(task:ReviewContext) { return reviewResponse(task, { approved: !task.rejected.length && !task.proposals.some(p=>p.clarification) && task.deterministic?.funds?.allowed!==false, summary: '仅核对结构和确定性事实；所有资金及管理动作仍须本人独立授权' }); }
export function createG8hControlledModel(scenarios=g8hScenarios(), reviewerOverride?: (context: ReviewContext) => unknown, billDomainOverride?: (context: LocalContext) => unknown) {
  const calls:G8hModelCall[]=[], configured=new Map<string,G8hScenario['semanticDraft']>();
  let failRole:G8hModelRole|undefined, failuresRemaining=0;
  return {calls,scenarios,
    configureScenario(value:G8hScenario) { if(!value.message.trim()) throw new Error('G8H_EMPTY_SCENARIO'); if(typeof value.semanticDraft!=='function') semanticIntentSchema.parse(value.semanticDraft); configured.set(value.message,typeof value.semanticDraft==='function'?value.semanticDraft:clone(value.semanticDraft)); },
    failNextRolePair(role:G8hModelRole) { failRole=role; failuresRemaining=2; },
    async respond(body:unknown):Promise<Response> {
      const request=body as any, user=request?.messages?.find((value:any)=>value.role==='user');
      if(typeof user?.content!=='string' || !Number.isSafeInteger(request.max_tokens) || request.max_tokens<1 || request.max_tokens>32768) throw new Error('G8H_MODEL_REQUEST_INVALID');
      const task=JSON.parse(user.content);
      if(!['semantic_intent','transfer','bills','investment','card','subscription','goal','reviewer'].includes(task.role)) throw new Error('G8H_MODEL_ROLE_UNEXPECTED');
      const failed=task.role===failRole && failuresRemaining>0; if(failed) failuresRemaining--;
      calls.push({sequence:calls.length+1,role:task.role,...(typeof task.taskId==='string'?{taskId:task.taskId}:{}),status:failed?502:200,requestMaxOutputTokens:request.max_tokens,responseKind:failed?'unavailable':'valid'});
      if(failed) return new Response('Controlled temporary model outage',{status:502});
      if(task.role==='semantic_intent') {const candidate=configured.get(task.message); return envelope(candidate ? typeof candidate==='function'?candidate(task):clone(candidate) : defaultG8hSemantic(task,scenarios));}
      if(task.role==='reviewer') return envelope(reviewerOverride ? reviewerOverride(task) : g8hReviewResponse(task));
      return envelope(task.role==='bills' && billDomainOverride ? billDomainOverride(task) : g8hDomainResponse(task));
    },
  };
}
