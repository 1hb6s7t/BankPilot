import { describe,expect,it } from 'vitest';
import { createPlanner,resolveInvestmentQuery } from '../packages/agents/src/index';
import type { InvestmentDashboard,PlannerInput,SemanticTask } from '../packages/contracts/src/index';
import { evaluationAccounts,evaluationPayees } from '../evals/fixtures';

const positions:InvestmentDashboard['positions']=[
  {id:'camellia',accountId:evaluationAccounts[0]!.id,productId:'synthetic-t0',productName:'山茶组合 A',principalMinor:'64000',reservedMinor:'5000',availableMinor:'59000',version:4,redemptionBusinessDays:0,calendar:'DEMO_WEEKDAYS_V1'},
  {id:'unused',accountId:evaluationAccounts[0]!.id,productId:'synthetic-t2',productName:'UNREQUESTED_POSITION_CANARY',principalMinor:'987654',reservedMinor:'7654',availableMinor:'980000',version:7,redemptionBusinessDays:2,calendar:'DEMO_WEEKDAYS_V1'},
];
const dashboard:InvestmentDashboard={businessDate:'2026-10-24',calendar:'DEMO_WEEKDAYS_V1',products:[],positions,actions:[]};
function input(message:string,task:SemanticTask):PlannerInput {return {taskId:'g9e-query-scope',message,accounts:structuredClone(evaluationAccounts),payees:structuredClone(evaluationPayees),investmentContext:structuredClone(dashboard),referenceDate:'2026-10-24',semanticIntent:{status:'ready',tasks:[task],findings:[],modelRuns:[]}};}
describe('deterministic investment query scope from grounded tasks',()=>{
  it('answers only the requested position and keeps the input snapshot unchanged',()=>{
    const before=structuredClone(dashboard),result=resolveInvestmentQuery(dashboard,'camellia');
    expect(result.evidence.map(e=>e.source)).toEqual(['investment-position:camellia:v4']);
    expect(result.summary).toContain('本金64000分，预留5000分，可赎回59000分');
    expect(JSON.stringify(result)).not.toContain('UNREQUESTED_POSITION_CANARY');expect(JSON.stringify(result)).not.toContain('987654');
    expect(result.investmentSuggestions).toEqual([]);expect(dashboard).toEqual(before);
  });
  it('keeps the complete collection when no singular object is requested',()=>{
    expect(resolveInvestmentQuery(dashboard).evidence).toHaveLength(2);
  });
  it('distinguishes an actual empty collection from an unavailable snapshot',()=>{
    const empty=resolveInvestmentQuery({...dashboard,positions:[]});expect(empty.summary).toContain('暂无');expect(empty.clarification).toBeUndefined();
    const unavailable=resolveInvestmentQuery();expect(unavailable.clarification).toBeTruthy();expect(unavailable.evidence).toEqual([]);
  });
  it.each(['missing','duplicate'])('does not fall back to other positions for %s selected identity',kind=>{
    const data=kind==='missing'?dashboard:{...dashboard,positions:[positions[0]!,{...positions[0]!,productName:'OTHER_DUPLICATE'}]};
    const result=resolveInvestmentQuery(data,kind==='missing'?'absent':'camellia');
    expect(result.clarification).toBeTruthy();expect(result.evidence).toEqual([]);expect(result.investmentSuggestions).toEqual([]);
    expect(JSON.stringify(result)).not.toContain('UNREQUESTED_POSITION_CANARY');
  });
  it('passes a server-grounded query identity through the real planner local context',async()=>{
    const message='查看山茶组合 A的可赎回余额';
    const result=await createPlanner({provider:false}).plan(input(message,{operation:'investment_query',role:'investment',source:{text:message,start:0,end:message.length},canonicalMessage:'查询理财持仓 camellia',slots:{entityId:'camellia'}}));
    expect(result.evidence.map(e=>e.source)).toEqual(['investment-position:camellia:v4']);
    expect(JSON.stringify(result)).not.toContain('UNREQUESTED_POSITION_CANARY');expect(result.investmentSuggestions).toEqual([]);
  });
  it('passes a funded goal dependency identity without exposing unrelated positions',async()=>{
    const message='为林晓建立生活目标，2027-01-12前准备300元，从山茶组合 A赎回400元筹资';
    const result=await createPlanner({provider:false}).plan(input(message,{operation:'goal_create',role:'goal',source:{text:message,start:0,end:message.length},canonicalMessage:'建立林晓生活目标，2027-01-12前准备300.00元，从camellia赎回400.00元',slots:{entityId:'payee-lin',amountMinor:'30000',targetDate:'2027-01-12',funding:{positionId:'camellia',amountMinor:'40000'}}}));
    const evidence=result.evidence.filter(e=>e.source.startsWith('investment-position:'));
    expect(evidence.length).toBeGreaterThan(0);expect(evidence.every(e=>e.source==='investment-position:camellia:v4')).toBe(true);
    expect(JSON.stringify(result)).not.toContain('UNREQUESTED_POSITION_CANARY');expect(result.investmentSuggestions).toEqual([]);
  });
  it.each(['different','same','collection'])('preserves explicit query and goal funding read scopes: %s',async kind=>{
    const message='查看山茶组合 A；为林晓建立生活目标，2027-01-12前准备300元，从另一指定产品赎回400元筹资';
    const queryId=kind==='collection'?undefined:'camellia',fundingId=kind==='same'?'camellia':'unused';
    const data=input(message,{operation:'investment_query',role:'investment',source:{text:message.split('；')[0]!},canonicalMessage:`查询理财持仓 ${queryId??''}`,slots:queryId?{entityId:queryId}:{}});
    data.investmentContext!.positions.push({...positions[0]!,id:'not-requested',productName:'THIRD_POSITION_CANARY'});
    data.semanticIntent!.tasks.push({operation:'goal_create',role:'goal',source:{text:message.split('；')[1]!},canonicalMessage:`建立林晓生活目标，2027-01-12前准备300.00元，从${fundingId}赎回400.00元`,slots:{entityId:'payee-lin',amountMinor:'30000',targetDate:'2027-01-12',funding:{positionId:fundingId,amountMinor:'40000'}}});
    const result=await createPlanner({provider:false}).plan(data);
    const sources=new Set(result.evidence.filter(e=>e.source.startsWith('investment-position:')).map(e=>e.source));
    expect(sources.has('investment-position:camellia:v4')).toBe(true);
    expect(sources.has(`investment-position:${fundingId}:v${fundingId==='camellia'?4:7}`)).toBe(true);
    if(kind==='collection')expect(sources.has('investment-position:not-requested:v4')).toBe(true);
    else expect(JSON.stringify(result)).not.toContain('THIRD_POSITION_CANARY');
    expect(result.investmentSuggestions).toEqual([]);expect(result.suggestions).toEqual([]);
    expect(result.events.filter(e=>e.role==='investment'&&e.status==='started')).toHaveLength(1);
  });
});
