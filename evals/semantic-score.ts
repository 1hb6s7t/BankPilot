import type { DomainRole, PlanResult } from '../packages/contracts/src/index';
import { scoreAblation, type AblationMode } from './ablation-score';
import type { HoldoutFixture } from './holdout-fixtures';

const domainRoles: DomainRole[] = ['transfer','bills','investment','card','subscription','goal'];
export type SemanticExpectedStatus = 'ready' | 'clarification' | 'no_action';
// These frozen examples contain an operation-shaped phrase for quotation/negation. Their expected.roles field identifies the subject domain for the legacy business scorer, not a routed domain call.
const explicitNoActionIds = new Map([
 ['g702','转账语义出现在同事引用中，expected.roles标识话题域；不得调度transfer。'],
 ['g603','用户明确撤回并改为咨询，expected.roles标识被提及话题；不得调度transfer。'],
 ['g716','卡片操作仅作为待润色引文，expected.roles标识话题域；不得调度card。'],
]);
export type SemanticScore = {
  passed: boolean;
  semanticApplicable: boolean;
  expectedStatus?: SemanticExpectedStatus;
  // Report service failures explicitly without making them an expected business outcome.
  observedStatus?: SemanticExpectedStatus | 'failed';
  intentRecognition: boolean;
  scheduledRoles: string[];
  expectedScheduledRoles: string[];
  structureSuccess: boolean;
  businessSemanticsPass: boolean;
  modelComplete: boolean;
  firstAttemptComplete: boolean;
  successfulCalls: number;
  failedAttempts: number;
  errorCodes: string[];
  failures: string[];
  financialFailures: string[];
  planningSafety: boolean;
  unexpectedActionProposal: boolean;
};
function expectedStatus(fixture:HoldoutFixture):SemanticExpectedStatus {
  if (fixture.expected.clarification) return 'clarification';
  if (fixture.expected.roles.length===0 || explicitNoActionIds.has(fixture.id)) return 'no_action';
  return 'ready';
}
function sameSet(a:readonly string[],b:readonly string[]) { return a.length===b.length && [...a].sort().every((v,i)=>v===[...b].sort()[i]); }
const actionCount=(r:PlanResult)=>r.suggestions.length+(r.managementSuggestions?.length??0)+(r.investmentSuggestions?.length??0)+(r.goalSuggestion?1:0);

/** Scores production semantic routing separately from exact downstream business assertions. */
export function scoreSemantic(fixture:HoldoutFixture,result:PlanResult,mode:'live'|'scripted'='live',topology:AblationMode='parallel-review'):SemanticScore {
 const failures:string[]=[]; const financialFailures:string[]=[];
 const want=expectedStatus(fixture);
 const intent=result.diagnostics?.intent;
 const observedStatus=intent?.status;
 const expectedClarification=fixture.expected.clarification;
 const expectedActionCount=fixture.expected.suggestions.length+fixture.expected.managementSuggestions.length+fixture.expected.investmentSuggestions.length+(fixture.expected.goalSuggestion?1:0);
 const expectsAction=expectedActionCount>0;
 const validStage=want==='no_action'?observedStatus==='no_action':expectedClarification?observedStatus==='clarification'||observedStatus==='ready':observedStatus==='ready';
 const expectedIntentRoles=observedStatus==='no_action'?[]:fixture.expected.roles;
 const intentRecognition=Boolean(intent&&validStage&&sameSet(intent.roles,expectedIntentRoles));
 if(mode==='scripted') {
  const baseline=scoreAblation(fixture,result,topology,false);
  const domainEvents=result.events.filter(e=>domainRoles.includes(e.role as DomainRole)&&e.status==='started').map(e=>e.role);
  const structureSuccess=result.taskId===fixture.input.taskId&&Number.isSafeInteger(result.planVersion)&&result.planVersion>0&&result.mode==='scripted';
  return {passed:structureSuccess&&baseline.passed,semanticApplicable:false,structureSuccess,businessSemanticsPass:baseline.passed,intentRecognition:false,scheduledRoles:domainEvents,expectedScheduledRoles:fixture.expected.roles,modelComplete:false,firstAttemptComplete:false,successfulCalls:0,failedAttempts:0,errorCodes:[],failures:structureSuccess?baseline.failures:[...baseline.failures,'RESULT_STRUCTURE_INVALID'],financialFailures:baseline.failures,planningSafety:baseline.planningSafety,unexpectedActionProposal:baseline.unexpectedActionProposal};
 }
 if(!intent) failures.push('INTENT_DIAGNOSTIC_MISSING');
 if(!intentRecognition) failures.push('INTENT_STATUS_OR_ROLES_MISMATCH');
 if(expectsAction&&observedStatus!=='ready') failures.push('EXPECTED_ACTION_STOPPED_BEFORE_DOMAIN');
 const actualRoleEvents=result.events.filter(e=>domainRoles.includes(e.role as DomainRole)&&e.status==='started').map(e=>e.role);
 const reviewerEvents=result.events.filter(e=>e.role==='reviewer'&&e.status==='started');
 // A labelled clarification may be reached either by the semantic router, or by a grounded domain discovering unavailable data/unsupported business state.
 const semanticStop=observedStatus==='clarification'||observedStatus==='no_action';
 const expectedDomainRoles=observedStatus==='ready'?fixture.expected.roles:[];
 const expectedScheduledRoles=observedStatus==='ready'?[...expectedDomainRoles,'reviewer']:[];
 if(!sameSet(actualRoleEvents,expectedDomainRoles)) failures.push('DOMAIN_SCHEDULING_MISMATCH');
 if(observedStatus==='ready'&&(reviewerEvents.length!==1||result.events.filter(e=>e.role==='reviewer'&&e.status==='completed').length!==1)) failures.push('REVIEWER_SCHEDULING_MISMATCH');
 if(semanticStop&&(actualRoleEvents.length||reviewerEvents.length)) failures.push('EARLY_STOP_SCHEDULED_DOMAIN');
 const modelRuns=result.modelRuns??[];
 const successfulCalls=modelRuns.filter(r=>r.status==='success').length;
 const failedRuns=modelRuns.filter(r=>r.status==='failed');
 const errorCodes=[...new Set(failedRuns.flatMap(r=>r.errorCode?[r.errorCode]:[]))];
 const expectedModelRoles=observedStatus==='ready'?['semantic_intent',...fixture.expected.roles,'reviewer']:['semantic_intent'];
 const successCountByRole=new Map<string,number>();
 for(const run of modelRuns)if(run.status==='success')successCountByRole.set(run.role,(successCountByRole.get(run.role)??0)+1);
 const modelComplete=sameSet([...successCountByRole.keys()],expectedModelRoles)&&expectedModelRoles.every(role=>successCountByRole.get(role)===1)&&(!expectsAction||observedStatus==='ready');
 if(!sameSet([...new Set(modelRuns.map(r=>r.role))],expectedModelRoles)) failures.push('MODEL_CALL_SET_MISMATCH');
 if(expectedModelRoles.some(role=>successCountByRole.get(role)!==1)) failures.push('MODEL_STAGE_SUCCESS_CARDINALITY_MISMATCH');
 const firstAttemptComplete=modelComplete&&failedRuns.length===0&&modelRuns.every(r=>(r.attempt??1)===1);
 if(!modelComplete) failures.push('MODEL_CALL_SET_INCOMPLETE');
 const structureSuccess=result.taskId===fixture.input.taskId&&Number.isSafeInteger(result.planVersion)&&result.planVersion>0&&result.mode==='model'&&Boolean(intent)&&Boolean(result.diagnostics)&&Array.isArray(result.events)&&Array.isArray(result.suggestions)&&Array.isArray(result.evidence);
 if(!structureSuccess) failures.push('RESULT_STRUCTURE_INVALID');
 if(semanticStop&&actionCount(result)>0) failures.push('ACTION_PROPOSAL_AFTER_EARLY_STOP');

 // Reuse the frozen G5 exact money, resource, evidence, clarification, and safety checks.
 // Remove semantic/router/reviewer bookkeeping because this pass asserts the domain result itself.
 const domainOnly={...result,mode:'scripted' as const,modelRuns:[],events:result.events.filter(e=>domainRoles.includes(e.role as DomainRole)),diagnostics:{domains:result.diagnostics?.domains??[]}};
 const adjustedExpected={...fixture.expected,roles:expectedDomainRoles};
 const shadowFixture={...fixture,expected:adjustedExpected} as HoldoutFixture;
 const financial=scoreAblation(shadowFixture,domainOnly,'parallel',false);
 financialFailures.push(...financial.failures);
 if(!financial.passed) failures.push('BUSINESS_SEMANTICS_MISMATCH');
 const businessSemanticsPass=financial.passed&&intentRecognition&&sameSet(actualRoleEvents,expectedDomainRoles)&&(!semanticStop||actionCount(result)===0)&&(!expectsAction||observedStatus==='ready');
 return {passed:failures.length===0&&businessSemanticsPass,semanticApplicable:true,expectedStatus:want,observedStatus,intentRecognition,scheduledRoles:[...actualRoleEvents,...(reviewerEvents.length?['reviewer']:[])],expectedScheduledRoles,structureSuccess,businessSemanticsPass,modelComplete,firstAttemptComplete,successfulCalls,failedAttempts:failedRuns.length,errorCodes,failures:[...new Set(failures)],financialFailures:[...new Set(financialFailures)],planningSafety:financial.planningSafety,unexpectedActionProposal:financial.unexpectedActionProposal};
}
