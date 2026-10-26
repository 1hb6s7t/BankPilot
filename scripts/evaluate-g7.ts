import { appendFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { EVALUATION_OBSERVATION_VERSION, classifyEvaluationFailure, summarizeEvaluationObservation, summarizeEvaluationCases } from './evaluation-observation';
import { PlanningStageFailure } from '../packages/agents/src/planning-failures';
import { createPlanner, normalizeBaseURL, providerFromEnv } from '../packages/agents/src/index';
import { MODEL_ATTEMPT_PROTOCOL_VERSION, MODEL_ATTEMPT_PERSIST_TIMEOUT_MS } from '../packages/agents/src/provider';
import { createModelAttemptJournal, type ModelAttemptJournalSummary } from '../packages/agents/src/attempt-journal';
import type { ModelRun, PlanResult } from '../packages/contracts/src/index';
import { createStageOutputPlan, PLANNING_OUTPUT_TOKEN_LIMIT, SEMANTIC_OUTPUT_TOKEN_LIMIT } from '../packages/agents/src/budget';
import { g7HoldoutFixtures, g7HoldoutVersion } from '../evals/g7-holdout-fixtures';
import { scoreSemantic, type SemanticScore } from '../evals/semantic-score';
import { digest } from '../evals/ablation-score';

const trackedFiles=[
 'evals/g7-holdout-fixtures.ts','evals/g7-manifest.json','evals/semantic-score.ts','scripts/evaluate-g7.ts', 'scripts/evaluation-observation.ts', 'packages/agents/src/stage-recovery.ts', 'packages/agents/src/planning-failures.ts', 'packages/agents/src/card-locator.ts',
 'evals/ablation-score.ts','packages/agents/src/index.ts','packages/agents/src/budget.ts','packages/agents/src/semantic-intent.ts','packages/agents/src/intent.ts',
 'packages/agents/src/management.ts','packages/agents/src/financial.ts','packages/agents/src/provider.ts','packages/agents/src/attempt-journal.ts','packages/agents/src/bills.ts',
 'packages/contracts/src/index.ts','packages/contracts/src/management.ts','packages/contracts/src/investment.ts','packages/contracts/src/goals.ts',
 'apps/api/src/app.ts','apps/api/src/planning.ts','apps/api/src/plan-runner.ts','packages/core/src/finance.ts','apps/web/src/App.tsx','package.json','pnpm-lock.yaml',
];
const hashes=async()=>Object.fromEntries(await Promise.all(trackedFiles.map(async file=>[file,createHash('sha256').update(await readFile(file)).digest('hex')])));
export type G7Selection='pilot'|'reserved'|'all';
export type G7Cohort='pilot-known'|'reserved-first-execution'|'reserved-known';
export type G7Manifest={version:string;frozenAt:string;fixtureSha256:string;caseIds:string[];liveCaseIds:string[];fixtureCount:number;liveCaseCount:number};
export type OutputBudgetAudit={requestCount:number;requestedTokenCeilingSum:number;missingRequestCaps:number;invalidRequestCaps:number;ceilingExceeded:boolean;withinBudget:boolean;requests:{role:string;attempt:number;maxOutputTokens?:number}[]};
export type CaseIntegrityError='CASE_DEADLINE_EXCEEDED'|'INPUT_MUTATED';
export function caseIntegrityError(signalAborted:boolean,inputMutated:boolean):CaseIntegrityError|undefined {
 if(signalAborted)return 'CASE_DEADLINE_EXCEEDED';
 if(inputMutated)return 'INPUT_MUTATED';
 return undefined;
}
export function applyCaseIntegrity<T extends {passed:boolean;failures:string[]},R extends {score?:T;errorCode?:string}>(record:R,errorCode?:CaseIntegrityError):R {
 if(!errorCode)return record;
 if(record.score){record.score.passed=false;if(!record.score.failures.includes(errorCode))record.score.failures.push(errorCode);}
 record.errorCode=errorCode;
 return record;
}
export function isValidCaseRecord(record:{score?:unknown;errorCode?:string;budgetValid?:boolean}) {
 return Boolean(record.score)&&!record.errorCode&&record.budgetValid!==false;
}
export function isValidOutputRequestCap(value:number|undefined):value is number {
 return value!==undefined&&Number.isSafeInteger(value)&&value>=1&&value<=PLANNING_OUTPUT_TOKEN_LIMIT;
}
export function auditRequestedOutputBudget(runs:readonly ModelRun[],totalOutputTokens=PLANNING_OUTPUT_TOKEN_LIMIT):OutputBudgetAudit {
 const requests=runs.map(run=>({role:run.role,attempt:run.attempt??1,...(run.requestMaxOutputTokens!==undefined?{maxOutputTokens:run.requestMaxOutputTokens}:{})}));
 const requestedTokenCeilingSum=requests.reduce((total,request)=>total+(isValidOutputRequestCap(request.maxOutputTokens)?request.maxOutputTokens:0),0);
 const missingRequestCaps=requests.filter(request=>request.maxOutputTokens===undefined).length;
 const invalidRequestCaps=requests.filter(request=>request.maxOutputTokens!==undefined&&!isValidOutputRequestCap(request.maxOutputTokens)).length;
 const ceilingExceeded=requestedTokenCeilingSum>totalOutputTokens;
 return {requestCount:requests.length,requestedTokenCeilingSum,missingRequestCaps,invalidRequestCaps,ceilingExceeded,withinBudget:missingRequestCaps===0&&invalidRequestCaps===0&&!ceilingExceeded,requests};
}
export function preflightG7Manifest(manifest:G7Manifest,fixtures:typeof g7HoldoutFixtures,fixtureSha256:string,nowIso:string,version:string) {
 const ids=fixtures.map(f=>f.id),idSet=new Set(ids),liveSet=new Set(manifest.liveCaseIds),frozenMs=Date.parse(manifest.frozenAt),nowMs=Date.parse(nowIso);
 const fullTimestamp=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(manifest.frozenAt);
 if(manifest.version!==version||manifest.fixtureSha256!==fixtureSha256||!fullTimestamp||!Number.isFinite(frozenMs)||!Number.isFinite(nowMs)||frozenMs>nowMs||digest(manifest.caseIds)!==digest(ids)||idSet.size!==ids.length||liveSet.size!==manifest.liveCaseIds.length||manifest.fixtureCount!==24||manifest.liveCaseCount!==12||ids.length!==24||manifest.liveCaseIds.length!==12||manifest.liveCaseIds.some(id=>!idSet.has(id)))throw new Error('Frozen G7 manifest mismatch');
 return true;
}
export function selectG7Cases(selection:G7Selection,fixtures:typeof g7HoldoutFixtures,manifest:G7Manifest,reservedPreviouslyExposed=false) {
 const indexed=new Map(fixtures.map(f=>[f.id,f]));
 if(indexed.size!==fixtures.length||manifest.caseIds.length!==fixtures.length)throw new Error('Fixture ids/count do not match manifest');
 const pilotSet=new Set(manifest.liveCaseIds);
 if(pilotSet.size!==manifest.liveCaseIds.length||manifest.caseIds.some(id=>!indexed.has(id))||manifest.liveCaseIds.some(id=>!indexed.has(id)))throw new Error('Invalid G7 manifest case ids');
 const ids=selection==='pilot'?manifest.liveCaseIds:selection==='reserved'?manifest.caseIds.filter(id=>!pilotSet.has(id)):manifest.caseIds;
 return ids.map(id=>({fixture:indexed.get(id)!,cohort:(pilotSet.has(id)?'pilot-known':reservedPreviouslyExposed?'reserved-known':'reserved-first-execution') as G7Cohort}));
}
export function g7CohortSummary(records:CaseRecord[]) {
 return Object.fromEntries((['pilot-known','reserved-first-execution','reserved-known'] as const).map(cohort=>{
  const rows=records.filter(r=>r.cohort===cohort),scores=rows.flatMap(r=>r.score?.semanticApplicable?[r.score]:[]);
  const financialFailureCodes=Object.fromEntries([...new Set(scores.flatMap(s=>s.financialFailures))].map(code=>[code,scores.filter(s=>s.financialFailures.includes(code)).length]));
  return [cohort,{cases:rows.length,passed:rows.filter(r=>r.passed).length,correctIntent:scores.filter(s=>s.intentRecognition).length,modelComplete:scores.filter(s=>s.modelComplete).length,businessSemanticsPass:scores.filter(s=>s.businessSemanticsPass).length,planningSafetyFailures:rows.filter(r=>r.score&&!r.score.planningSafety).length,unexpectedActionProposals:rows.filter(r=>r.score?.unexpectedActionProposal).length,financialFailureCodes}];
 }));
}
export async function hasPriorLiveExposure(resultsDir:string,reservedIds:readonly string[],fixtureVersion:string) {
 const files=(await readdir(resultsDir).catch(()=>[])).filter(file=>file.endsWith('.jsonl'));
 for(const file of files) {
  const firstLine=(await readFile(resolve(resultsDir,file),'utf8')).split('\n',1)[0];
  if(!firstLine)continue;
  try {
   const event=JSON.parse(firstLine),protocol=event.protocol;
   if(event.type==='start'&&event.mode==='live'&&protocol?.fixtureVersion===fixtureVersion&&Array.isArray(protocol.caseIds)&&protocol.caseIds.some((id:string)=>reservedIds.includes(id)))return true;
  } catch { /* Ignore unrelated or malformed journals; their contents cannot prove exposure. */ }
 }
 return false;
}
/** An alternate artifact directory cannot erase exposure recorded in the canonical history. */
export async function hasPriorLiveExposureAcross(resultsDirs:readonly string[],reservedIds:readonly string[],fixtureVersion:string) {
 const directories=[...new Set(resultsDirs.map(directory=>resolve(directory)))];
 return (await Promise.all(directories.map(directory=>hasPriorLiveExposure(directory,reservedIds,fixtureVersion)))).some(Boolean);
}
type CaseRecord={sequence:number;id:string;category:string;mode:'live'|'scripted';cohort:G7Cohort;startedAt:string;inputHash:string;expectedHash:string;scheduledRoles:string[];durationMs:number;passed:boolean;budgetValid?:boolean;outputBudget?:OutputBudgetAudit;attemptObservation?:ModelAttemptJournalSummary;observation?:ReturnType<typeof summarizeEvaluationObservation>;failure?:ReturnType<typeof classifyEvaluationFailure>;failureSource?:'returned-plan'|'thrown';score?:SemanticScore;result?:PlanResult;errorCode?:string};
const latency=(values:number[])=>{if(!values.length)return{medianMs:null,p95Ms:null};const sorted=[...values].sort((a,b)=>a-b),mid=Math.floor(sorted.length/2);return{medianMs:sorted.length%2?sorted[mid]:(sorted[mid-1]!+sorted[mid]!)/2,p95Ms:sorted[Math.ceil(sorted.length*.95)-1]};};
export async function runG7(args=process.argv.slice(2), options: { resultsDir?: string } = {}) {
 const option=(name:string)=>{const i=args.indexOf(name);return i<0?undefined:args[i+1];};
 const mode=option('--mode'); if(mode!=='live'&&mode!=='scripted')throw new Error('Explicit --mode live|scripted required');
 const selection=(option('--selection')??(mode==='live'?'pilot':'all')) as G7Selection;if(!['pilot','reserved','all'].includes(selection))throw new Error('Invalid selection');
 const config=mode==='live'?providerFromEnv():undefined;if(mode==='live'&&!config)throw new Error('Explicit BANKPILOT model configuration required');
 const startedAt=new Date().toISOString(),startHashes=await hashes();
 const manifest=JSON.parse(await readFile('evals/g7-manifest.json','utf8')) as G7Manifest;
 preflightG7Manifest(manifest,g7HoldoutFixtures,startHashes['evals/g7-holdout-fixtures.ts']!,startedAt,g7HoldoutVersion);
 const dir=resolve(options.resultsDir ?? 'evals/results');await mkdir(dir,{recursive:true});
 const reservedIds=manifest.caseIds.filter(id=>!manifest.liveCaseIds.includes(id));
 const reservedPreviouslyExposed=await hasPriorLiveExposureAcross([resolve('evals/results'),dir],reservedIds,g7HoldoutVersion);
 const selected=selectG7Cases(selection,g7HoldoutFixtures,manifest,reservedPreviouslyExposed);
 const runId=startedAt.replace(/[:.]/g,'-'),prefix=`${runId}-g7-semantic-${mode}-${selection}-production`;
 const jsonPath=resolve(dir,`${prefix}.json`),mdPath=resolve(dir,`${prefix}.md`),jsonlPath=resolve(dir,`${prefix}.jsonl`),attemptsPath=resolve(dir,`${prefix}.attempts.jsonl`);
 const provider=config?{baseURL:normalizeBaseURL(config.baseURL),model:config.model,outputMode:config.outputMode??'tools'}:null;
 const reservedStatus=reservedPreviouslyExposed?'reserved-known-regression':'reserved-first-execution';
 const datasetStatus=selection==='pilot'?'pilot-known-regression':selection==='reserved'?reservedStatus:`mixed-cohorts; pilot-known + ${reservedStatus}`;
 const worstCaseOutputPlan=createStageOutputPlan({domainStageCount:6,reviewerStageCount:1,maxAttempts:2,totalOutputTokens:PLANNING_OUTPUT_TOKEN_LIMIT});
 if(worstCaseOutputPlan.allocatedCeiling>PLANNING_OUTPUT_TOKEN_LIMIT||worstCaseOutputPlan.semanticMaxOutputTokens!==SEMANTIC_OUTPUT_TOKEN_LIMIT)throw new Error('G7 staged output budget preflight failed');
 const protocol={evaluationObservationVersion:EVALUATION_OBSERVATION_VERSION,protocolVersion:'g7-semantic-eval-v3-success-cardinality-budget-caps',attemptObservationProtocolVersion:MODEL_ATTEMPT_PROTOCOL_VERSION,attemptPersistenceTimeoutMs:MODEL_ATTEMPT_PERSIST_TIMEOUT_MS,attemptObservationBoundary:'Each dispatch intent is fsynced before fetch. A start is not proof of remote receipt; unclosed attempts have outcome unknown. An end describes HTTP/output-validation outcome, not business acceptance. No prompt, completion, key, provider URL, headers or user identifiers enter the attempt journal. Returned-plan ModelRun totals can omit attempts when the planner throws; use the independent attempt journal for observation coverage.',fixtureVersion:g7HoldoutVersion,sourceHashes:startHashes,selection,datasetStatus,cohortCaveat:'Reserved per-case rationales were visible to implementation collaborators, although reserved prompt content was not inspected; this is a reserved first model execution, not a fully blind evaluation.',topology:'production-parallel-review',semanticEnabled:mode==='live',referenceDate:'2026-10-23',caseIds:selected.map(s=>s.fixture.id),caseDeadlineMs:180000,providerTimeoutMs:60000,maxAttempts:2,maxStructureRepairs:1 as const,temperature:0,semanticMaxOutputTokens:SEMANTIC_OUTPUT_TOKEN_LIMIT,totalOutputTokenCeilingPerCase:PLANNING_OUTPUT_TOKEN_LIMIT,worstCaseOutputPlan,budgetRule:'Semantic stage cap 4096 tokens per attempt; remaining 32768-token per-case request ceiling is allocated across the observed routed domain/reviewer stages and retries using the shared stage-output planner. Allocation is independent of fixture labels and usage. Every request cap is recorded; future budget changes require a new protocolVersion and separate report.',executionMeaning:'Only produces planning proposals. It does not authorize or execute banking actions.',modeMeaning:mode==='scripted'?'Deterministic nonsemantic baseline only; do not report as semantic evaluation.':'Real model semantic evaluation; successful model calls are not equivalent to business correctness.'};
 const attemptJournal=await createModelAttemptJournal(attemptsPath);
 try {
 await appendFile(jsonlPath,JSON.stringify({type:'start',startedAt,mode,provider,protocol,attemptJournalPath:attemptsPath,attemptJournalId:attemptJournal.journalId})+'\n');
 const records:CaseRecord[]=[];let stopped=false,active:AbortController|undefined;const stop=()=>{stopped=true;active?.abort();};process.once('SIGINT',stop);process.once('SIGTERM',stop);
 try {
  for(const {fixture,cohort} of selected){if(stopped)break;const input={...structuredClone(fixture.input),referenceDate:'2026-10-23'};const inputHash=digest(input),expectedHash=digest(fixture.expected),caseStarted=new Date().toISOString(),tick=performance.now();let record:CaseRecord={sequence:records.length+1,id:fixture.id,category:fixture.category,mode,cohort,startedAt:caseStarted,inputHash,expectedHash,scheduledRoles:[],durationMs:0,passed:false};
   const controller=new AbortController();active=controller;const timer=setTimeout(()=>controller.abort(),protocol.caseDeadlineMs);
   try {
    const planner=createPlanner(mode==='live'?{semantic:true,provider:{...config!,timeoutMs:protocol.providerTimeoutMs,maxAttempts:protocol.maxAttempts,maxStructureRepairs:protocol.maxStructureRepairs,temperature:protocol.temperature,signal:controller.signal,attemptObserver:attemptJournal.observerForCase(record.sequence)}}:{semantic:false,provider:false});
    const result=await planner.plan(input);const score=scoreSemantic(fixture,result,mode,'parallel-review');
    const integrityFailure=caseIntegrityError(controller.signal.aborted,digest(input)!==inputHash);
    const outputBudget=auditRequestedOutputBudget(result.modelRuns??[],protocol.totalOutputTokenCeilingPerCase);
    const budgetValid=outputBudget.withinBudget;
    if(!budgetValid){score.passed=false;score.failures.push(outputBudget.ceilingExceeded?'OUTPUT_BUDGET_CEILING_EXCEEDED':outputBudget.invalidRequestCaps?'OUTPUT_BUDGET_CAP_INVALID':'OUTPUT_BUDGET_CAP_MISSING');}
    if(result.failure){record.failure=classifyEvaluationFailure(new PlanningStageFailure(result.failure));record.failureSource='returned-plan';}
    record={...record,scheduledRoles:result.events.filter(e=>e.status==='started').map(e=>e.role),durationMs:Math.round(performance.now()-tick),passed:score.passed,budgetValid,outputBudget,score,result};
    record=applyCaseIntegrity(record,integrityFailure);
    record.passed=score.passed&&!result.failure;
   }catch(error){const failure=classifyEvaluationFailure(error,{deadlineExceeded:controller.signal.aborted});record={...record,durationMs:Math.round(performance.now()-tick),errorCode:failure.code,failure,failureSource:'thrown'};}
   finally{clearTimeout(timer);controller.abort();active=undefined;}
   if(digest(input)!==inputHash){record=applyCaseIntegrity(record,'INPUT_MUTATED');record.passed=false;}
   await attemptJournal.flush().catch(()=>{});
   record.attemptObservation=attemptJournal.summary(record.sequence);
   if(!record.attemptObservation.complete&&!record.errorCode)record.errorCode=record.failure?.code??(record.attemptObservation.persistenceFailed?'MODEL_ATTEMPT_JOURNAL_FAILED':'MODEL_ATTEMPT_OUTCOME_UNKNOWN');
   record.observation=summarizeEvaluationObservation(record.attemptObservation,{mode,caseSequence:record.sequence,maxOutputTokens:protocol.totalOutputTokenCeilingPerCase});
   if(!record.observation.complete||mode==='live'&&record.observation.budget.withinBudget!==true){record.passed=false;record.errorCode??=record.failure?.code??'EVAL_OBSERVATION_INCOMPLETE';}
   records.push(record);await appendFile(jsonlPath,JSON.stringify({type:'case',...record})+'\n');console.log(JSON.stringify({sequence:record.sequence,id:record.id,mode,passed:record.passed,durationMs:record.durationMs,failures:record.score?.failures??[record.errorCode]}));
  }
 }finally{process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);}
 await attemptJournal.close().catch(()=>{});
 const attemptObservation=attemptJournal.summary();
 const observedAttempts=summarizeEvaluationObservation(attemptObservation,{mode,maxOutputTokens:protocol.totalOutputTokenCeilingPerCase});
 const observedCases=summarizeEvaluationCases(records);
 const endHashes=await hashes(),sourceDrift=trackedFiles.filter(f=>startHashes[f]!==endHashes[f]);
 const evaluated=records.filter(r=>r.score?.semanticApplicable);const scores=evaluated.map(r=>r.score!);const allScores=records.flatMap(r=>r.score?[r.score]:[]);const modelRuns=records.flatMap(r=>r.result?.modelRuns??[]);const executionComplete=records.length===selected.length;const financialFailureCodes=Object.fromEntries([...new Set(scores.flatMap(s=>s.financialFailures))].map(code=>[code,scores.filter(s=>s.financialFailures.includes(code)).length]));const requestedOutputTokens=modelRuns.reduce((n,r)=>n+(r.requestMaxOutputTokens??0),0);const missingOutputRequestCap=modelRuns.filter(r=>r.requestMaxOutputTokens===undefined).length;const invalidOutputRequestCap=modelRuns.filter(r=>r.requestMaxOutputTokens!==undefined&&!isValidOutputRequestCap(r.requestMaxOutputTokens)).length;const report={startedAt,finishedAt:new Date().toISOString(),mode,provider,...protocol,attemptJournalPath:attemptsPath,attemptObservation,modelCallsSource:'returned-plan-model-runs',observedAttempts,observedCases,complete:executionComplete,executionComplete,stopped,sourceDrift,validRun:sourceDrift.length===0&&executionComplete&&records.every(isValidCaseRecord)&&attemptObservation.complete&&observedCases.complete&&observedAttempts.budget.withinBudget!==false,semanticEvaluation:mode==='live',structureSuccess:scores.filter(s=>s.structureSuccess).length,correctIntent:scores.filter(s=>s.intentRecognition).length,modelComplete:scores.filter(s=>s.modelComplete).length,firstAttemptComplete:scores.filter(s=>s.firstAttemptComplete).length,businessSemanticsPass:scores.filter(s=>s.businessSemanticsPass).length,planningSafetyFailures:allScores.filter(s=>!s.planningSafety).length,unexpectedActionProposals:allScores.filter(s=>s.unexpectedActionProposal).length,financialFailureCodes,passed:records.filter(r=>r.passed).length,cohortSummary:g7CohortSummary(records),actualScheduledRoleCalls:records.reduce((n,r)=>n+(r.score?.scheduledRoles.length??0),0),routerOnlyStops:scores.filter(s=>s.expectedStatus!=='ready'&&s.scheduledRoles.length===0).length,modelCalls:{total:modelRuns.length,successful:modelRuns.filter(r=>r.status==='success').length,failed:modelRuns.filter(r=>r.status==='failed').length,zeroInputUsage:modelRuns.filter(r=>r.inputTokens===0).length,missingInputUsage:modelRuns.filter(r=>r.inputTokens===undefined).length,inputReportedSum:modelRuns.reduce((n,r)=>n+(typeof r.inputTokens==='number'?r.inputTokens:0),0),missingOutputUsage:modelRuns.filter(r=>r.outputTokens===undefined).length,outputTokensReported:modelRuns.reduce((n,r)=>n+(r.outputTokens??0),0),requestedOutputTokens,missingOutputRequestCap,invalidOutputRequestCap,errorCodes:Object.fromEntries([...new Set(modelRuns.flatMap(r=>r.errorCode?[r.errorCode]:[]))].map(code=>[code,modelRuns.filter(r=>r.errorCode===code).length]))},latency:{allCases:latency(records.map(r=>r.durationMs)),casesWithCalls:latency(records.filter(r=>(r.result?.modelRuns?.length??0)>0).map(r=>r.durationMs))},endSourceHashes:endHashes,records,interpretation:mode==='live'?'Production-topology evaluation; report pilot-known, reserved-first-execution or reserved-known strata separately. The reserved prompts were not inspected by this evaluator, but per-case rationale metadata was exposed to an implementation collaborator; this is not a fully blind evaluation.':'Scripted deterministic baseline only; not evidence of semantic model quality.'};
 const strata=Object.entries(report.cohortSummary).map(([name,value]:[string,any])=>`${name}: n=${value.cases}, passed=${value.passed}, intent=${value.correctIntent}, calls=${value.modelComplete}, business=${value.businessSemanticsPass}, safetyFailures=${value.planningSafetyFailures}, unexpectedActions=${value.unexpectedActionProposals}, financialFailures=${JSON.stringify(value.financialFailureCodes)}`).join('\n');
 const observationNote=`Independent evaluation observation ${EVALUATION_OBSERVATION_VERSION}: ${JSON.stringify(observedCases)}. Returned-plan statistics retain their original source and exclude thrown plans. Partial failure ModelRuns are never added to them. A start proves dispatch intent, not remote receipt; unknown outcomes and missing usage stay unknown.`;
 const md=['# G7 semantic evaluation: '+mode+' / '+selection,'',observationNote,'',`Protocol ${protocol.protocolVersion}; ${protocol.datasetStatus}. Production topology: parallel domains plus independent reviewer. Valid run: ${report.validRun}; execution complete: ${report.executionComplete}; semantic evaluation: ${report.semanticEvaluation}; cases: ${records.length}/${selected.length}; passed: ${report.passed}/${records.length}.`,strata,'',`Attempt observation protocol ${protocol.attemptObservationProtocolVersion}; starts ${attemptObservation.confirmedStarts}, ends ${attemptObservation.confirmedEnds}, outcomes unknown ${attemptObservation.openAttempts.length}, persistence failed ${attemptObservation.persistenceFailed}. Separate journal: ${attemptsPath}. Attempt observation is required for validRun; v3 scoring and passed labels are unchanged.`,protocol.attemptObservationBoundary,'',mode==='live'?`Provider ${provider?.baseURL}; model ${provider?.model}; output ${provider?.outputMode}; temperature 0.`:'Scripted nonsemantic baseline; no model calls and no semantic-quality claim.','',`Correct intent ${report.correctIntent}/${scores.length}; model call set complete ${report.modelComplete}/${scores.length}; business semantics passed ${report.businessSemanticsPass}/${scores.length}; returned-plan model calls ${report.modelCalls.total} (${report.modelCalls.successful} successful, ${report.modelCalls.failed} failed). Planning safety failures ${report.planningSafetyFailures}; unexpected action proposals ${report.unexpectedActionProposals}.`,`Financial failure codes: ${JSON.stringify(report.financialFailureCodes)}.`,`Latency median/P95 all cases: ${report.latency.allCases.medianMs}/${report.latency.allCases.p95Ms} ms; casesWithCalls (returned plans with ModelRuns only; excludes thrown plans): ${report.latency.casesWithCalls.medianMs}/${report.latency.casesWithCalls.p95Ms} ms.`,'',`Semantic request cap: ${protocol.semanticMaxOutputTokens} × ${protocol.maxAttempts}; maximum per-case output request ceiling: ${protocol.totalOutputTokenCeilingPerCase}; returned-plan ModelRun requested cap sum (excludes thrown plans): ${report.modelCalls.requestedOutputTokens}; returned-plan calls missing request cap: ${report.modelCalls.missingOutputRequestCap}; returned-plan calls with invalid request cap: ${report.modelCalls.invalidOutputRequestCap}. Input tokens reported: ${report.modelCalls.inputReportedSum}; calls missing input usage: ${report.modelCalls.missingInputUsage}; calls missing output usage: ${report.modelCalls.missingOutputUsage}. Usage values are supplier reports, not proof of zero cost.`,'', '| # | case | cohort | mode | intent | calls complete | business pass | passed | duration ms | failures |','|---:|---|---|---|---|---|---|---|---:|---|',...records.map(r=>`| ${r.sequence} | ${r.id} | ${r.cohort} | ${r.mode} | ${r.score?.observedStatus??'—'} | ${r.score?.modelComplete??'未评分'} | ${r.score?.businessSemanticsPass??'未评分'} | ${r.passed} | ${r.durationMs} | ${(r.score?.failures.join(', ')??r.errorCode??'').replaceAll('|','/')} |`),'','Returned plans are incrementally journaled after each case. Independent attempts JSONL is fsynced before HTTP dispatch and after each attempt outcome, including failures without a returned plan. A SIGKILL may leave a durable start without an end; its outcome is unknown, never inferred success or zero cost. Missing usage stays unknown. Attempt observability has its own version; the v3 scorer and passed labels retain their existing meanings. No planner, resolver, provider output, or scorer changes the frozen fixture labels. This matrix measures proposals, not user authorization or bank execution.'].join('\n');
 await writeFile(jsonPath,JSON.stringify(report,null,2));await writeFile(mdPath,md);console.log(JSON.stringify({jsonPath,mdPath,jsonlPath,attemptsPath,validRun:report.validRun,passed:report.passed,semanticEvaluation:report.semanticEvaluation}));return report;
 }finally{await attemptJournal.close().catch(()=>{});}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){runG7().then(report=>{if(!report.validRun||report.records.some(r=>!r.passed))process.exitCode=1;}).catch(()=>{console.error('G7 evaluation configuration or execution failed; no credentials logged.');process.exitCode=1;});}
