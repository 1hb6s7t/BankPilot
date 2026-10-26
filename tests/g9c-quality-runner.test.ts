import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { PlanResult } from '../packages/contracts/src/index';
import { MODEL_ATTEMPT_PROTOCOL_VERSION, ModelProviderError, type ModelAttemptObserver, type ModelAttemptStart } from '../packages/agents/src/provider';
import { G9_DOMAINS, type G9Case, type G9Dataset } from '../evals/g9-contract';
import { G9_LIMITS } from '../scripts/evaluate-g9';
import { G9C_EVALUATOR_FILES, G9C_PROTOCOL_PATH, G9C_RUNNER_VERSION, g9cProviderFingerprint, type G9CManifest } from '../scripts/evaluate-g9c';
import { buildG9CQualityManifest, executeG9CQuality, G9C_QUALITY_CONTRACT_PATH, G9C_QUALITY_DATASET_VERSION, G9C_QUALITY_EVALUATOR_FILES, G9C_QUALITY_FIXTURE_PATH, G9C_QUALITY_MANIFEST_PATH, G9C_QUALITY_PARENT_MANIFEST_PATH, hashG9CQualityEvaluatorFiles, runG9CQuality, validateG9CQualityDataset, validateG9CQualityManifestMetadata, verifyG9CQualityFrozenFiles } from '../scripts/evaluate-g9c-quality';

// Independent authored calibration inputs only. No import/read of the quality
// fixture or historical G9 inputs, and no cloud/database access.
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const config = { model:'supplemental-calibration',baseURL:'https://quality-calibration.invalid/v1',outputMode:'json_object' as const,reasoningEffort:'none' as const };
const directories: string[] = [];
async function temporary() { const path=await mkdtemp(join(tmpdir(),'g9c-quality-calibration-'));directories.push(path);return path; }
afterEach(async()=>{ vi.restoreAllMocks();vi.unstubAllGlobals();await Promise.all(directories.splice(0).map(path=>rm(path,{recursive:true,force:true}))); });
function dataset(): G9Dataset {
  return { version:G9C_QUALITY_DATASET_VERSION,cases:G9_DOMAINS.flatMap(domain=>[0,1].map((index):G9Case=>{
    const kind=index===1&&(domain==='transfer'||domain==='investment')?'no_action':index===1&&domain==='goal'?'clarification':'positive';
    const status=kind==='positive'?'ready':kind;
    return {id:`g9-quality-${domain}-0${index+1}`,domain,kind,rationale:'Independent offline runner calibration.',input:{taskId:`cal-${domain}-${index}`,message:'补充运行器独立合成输入。',referenceDate:'2026-10-24',accounts:[],payees:[]},
      expected:{semantic:{status,recognizedRoles:kind==='no_action'?[]:[domain]},activatedRoles:kind==='positive'?[domain]:[],successfulCallRoles:kind==='positive'?['semantic_intent',domain,'reviewer']:['semantic_intent'],businessClarification:kind==='clarification',transfers:[],management:[],redemptions:[]}};
  })) };
}
function metadata() {
  const data=dataset(),evaluatorHashes=Object.fromEntries(G9C_QUALITY_EVALUATOR_FILES.map(path=>[path,hash(path)]));
  const parent:G9CManifest={protocolVersion:G9C_RUNNER_VERSION,cohort:'known-regression',frozenAt:'2026-10-24T01:00:00.000Z',originalManifestPath:'evals/g9-manifest.json',originalManifestSha256:hash('original manifest'),
    datasetVersion:'original-static-calibration',fixturePath:'evals/parent-calibration-fixture.ts',fixtureSha256:hash('parent fixture'),caseIds:Array.from({length:36},(_,i)=>`parent-case-${i}`),caseCount:36,positiveCount:24,domainCounts:Object.fromEntries(G9_DOMAINS.map(domain=>[domain,6])) as G9CManifest['domainCounts'],
    sourceManifestPath:'evals/baselines/g9c-quality-calibration/source-manifest.json',sourceManifestSha256:hash('parent source'),evaluatorHashes:Object.fromEntries(G9C_EVALUATOR_FILES.map(path=>[path,evaluatorHashes[path]!])),protocolPath:G9C_PROTOCOL_PATH,protocolSha256:evaluatorHashes[G9C_PROTOCOL_PATH]!,provider:g9cProviderFingerprint(config),limits:G9_LIMITS};
  const parentHash=hash('parent manifest'),fixtureHash=evaluatorHashes[G9C_QUALITY_FIXTURE_PATH]!;
  const manifest=buildG9CQualityManifest({parent,parentManifestSha256:parentHash,dataset:data,fixtureSha256:fixtureHash,evaluatorHashes,frozenAt:'2026-10-24T02:00:00.000Z'});
  return {data,parent,parentHash,fixtureHash,evaluatorHashes,manifest};
}
async function staticFiles() {
  const root=await temporary(),value=metadata();
  const put=async(path:string,contents:string)=>{await mkdir(dirname(join(root,path)),{recursive:true});await writeFile(join(root,path),contents);return hash(contents);};
  for(const path of G9C_QUALITY_EVALUATOR_FILES) value.evaluatorHashes[path]=await put(path,path==='package.json'?JSON.stringify({type:'module'}):`Independent static bytes for ${path}`);
  value.fixtureHash=await put(G9C_QUALITY_FIXTURE_PATH,`export const g9cQualityDataset=${JSON.stringify(value.data)};`);
  value.evaluatorHashes[G9C_QUALITY_FIXTURE_PATH]=value.fixtureHash;
  const original={sourceManifestPath:'evals/parent-original-source.json',sourceManifestSha256:await put('evals/parent-original-source.json','Original source bytes.'),authorReview:{reviewPath:'docs/parent-original-review.json',reviewSha256:await put('docs/parent-original-review.json','Original review bytes.')}};
  value.parent.originalManifestSha256=await put(value.parent.originalManifestPath,JSON.stringify(original));
  value.parent.fixtureSha256=await put(value.parent.fixturePath,'Frozen parent fixture bytes.');
  value.parent.evaluatorHashes=Object.fromEntries(G9C_EVALUATOR_FILES.map(path=>[path,value.evaluatorHashes[path]!]));
  value.parent.protocolSha256=value.evaluatorHashes[G9C_PROTOCOL_PATH]!;
  await mkdir(join(root,'apps'),{recursive:true});
  const source={files:G9C_EVALUATOR_FILES.filter(path=>/^(apps|packages)\//.test(path)).map(path=>({path,sha256:value.evaluatorHashes[path]!}))};
  value.parent.sourceManifestSha256=await put(value.parent.sourceManifestPath,JSON.stringify(source));
  value.parentHash=await put(G9C_QUALITY_PARENT_MANIFEST_PATH,JSON.stringify(value.parent));
  value.manifest=buildG9CQualityManifest({parent:value.parent,parentManifestSha256:value.parentHash,dataset:value.data,fixtureSha256:value.fixtureHash,evaluatorHashes:value.evaluatorHashes,frozenAt:'2026-10-24T02:00:00.000Z'});
  const path=join(root,G9C_QUALITY_MANIFEST_PATH),manifestHash=await put(G9C_QUALITY_MANIFEST_PATH,JSON.stringify(value.manifest));
  return {...value,root,path,manifestHash};
}
function resultFor(item:G9Case):PlanResult {
  return {taskId:item.input.taskId,planVersion:1,mode:'model',summary:'Independent supplemental calibration.',findings:[],evidence:[],suggestions:[],managementSuggestions:[],investmentSuggestions:[],
    ...(item.kind==='clarification'?{clarification:'请补充年份。'}:{}),events:item.expected.activatedRoles.map(role=>({role,status:'started',at:'2026-10-24T00:00:00.000Z',summary:''})),
    modelRuns:item.expected.successfulCallRoles.map(role=>({role,model:config.model,status:'success',durationMs:1,attempt:1,requestMaxOutputTokens:role==='semantic_intent'?4096:2048})),diagnostics:{intent:{status:item.expected.semantic.status,roles:item.expected.semantic.recognizedRoles,findings:[]},domains:[]}};
}
async function emit(observer:ModelAttemptObserver,role:ModelAttemptStart['role'],success=true) {
  const start:ModelAttemptStart={type:'attempt_start',protocolVersion:MODEL_ATTEMPT_PROTOCOL_VERSION,invocationId:randomUUID(),attemptId:randomUUID(),role,attempt:1,requestMaxOutputTokens:role==='semantic_intent'?4096:2048,startedAtUtc:new Date().toISOString(),dispatch:'pending'};
  await observer(start);const {dispatch:_dispatch,...identity}=start;
  await observer({...identity,type:'attempt_end',endedAtUtc:new Date().toISOString(),durationMs:1,requestStarted:true,status:success?'success':'failed',...(success?{}:{errorCode:'MODEL_HTTP_503',httpStatus:503,failureStage:'request'})});
}
function quiet(){vi.spyOn(console,'log').mockImplementation(()=>{});vi.stubGlobal('fetch',vi.fn(()=>{throw new Error('CLOUD_FORBIDDEN_IN_QUALITY_CALIBRATION');}));}

describe('G9C supplemental entrypoint has a separate, explicitly non-blind contract',()=>{
  it('requires live and development-supplemental before reading any manifest',async()=>{
    await expect(runG9CQuality([])).rejects.toThrow('G9C_QUALITY_EXPLICIT_MODE_LIVE_REQUIRED');
    await expect(runG9CQuality(['--mode','scripted','--development-supplemental'])).rejects.toThrow('G9C_QUALITY_EXPLICIT_MODE_LIVE_REQUIRED');
    await expect(runG9CQuality(['--mode','live'])).rejects.toThrow('G9C_QUALITY_EXPLICIT_DEVELOPMENT_SUPPLEMENTAL_REQUIRED');
    await expect(runG9CQuality(['--preflight','--mode','live'])).rejects.toThrow('G9C_QUALITY_PREFLIGHT_HAS_NO_EXECUTION_MODE');
  });
  it.each(['--known-regression','--first-run','--unseen','--limit','--selection','--concurrency'])('rejects changing the cohort or case selection via %s',async option=>{await expect(runG9CQuality(['--mode','live','--development-supplemental',option])).rejects.toThrow('G9C_QUALITY_UNSUPPORTED_OR_DUPLICATE_OPTION');});
  it('rejects duplicate or missing option values',async()=>{
    await expect(runG9CQuality(['--mode'])).rejects.toThrow('G9C_QUALITY_OPTION_VALUE_REQUIRED');
    await expect(runG9CQuality(['--preflight','--preflight'])).rejects.toThrow('G9C_QUALITY_UNSUPPORTED_OR_DUPLICATE_OPTION');
  });
  it('freezes exactly twelve cases, two per domain and separate positive/no-action/clarification denominators',()=>{
    const {data,manifest}=metadata();expect(validateG9CQualityDataset(data)).toMatchObject({caseCount:12,positiveCount:9,kindCounts:{positive:9,no_action:2,clarification:1}});
    expect(manifest).toMatchObject({cohort:'development-supplemental',implementationInformed:true,blind:false,provider:{thinkingMode:'omitted',reasoningEffort:'none'}});
    expect(Object.values(manifest.domainCounts)).toEqual([2,2,2,2,2,2]);
  });
  it.each(['version','subset','order','domain','kind','source-slot','label-call-set'])('rejects %s dataset drift without invoking a scorer',issue=>{
    const {data}=metadata();
    if(issue==='version')data.version='unseen';if(issue==='subset')data.cases.pop();if(issue==='order')data.cases.reverse();if(issue==='domain')data.cases[0]!.domain='card';if(issue==='kind')data.cases[0]!.kind='no_action';
    if(issue==='source-slot')(data.cases[0]!.input as any).semanticIntent={status:'ready'};if(issue==='label-call-set')data.cases[0]!.expected.successfulCallRoles.push('subscription');
    expect(()=>validateG9CQualityDataset(data)).toThrow(/^G9C_QUALITY/);
  });
  it.each(['cohort','blind','implementation-informed','parent','fixture','labels','inputs','docs','evaluator','provider','budget','future-freeze'])('rejects %s manifest drift statically',issue=>{
    const v=metadata(),m=v.manifest;
    if(issue==='cohort')(m as any).cohort='known-regression';if(issue==='blind')(m as any).blind=true;if(issue==='implementation-informed')(m as any).implementationInformed=false;if(issue==='parent')m.parentManifestSha256=hash('wrong parent');
    if(issue==='fixture')m.fixtureSha256=hash('wrong fixture');if(issue==='labels')v.data.cases[0]!.expected.forbiddenOutputFragments=['new synthetic label'];if(issue==='inputs')v.data.cases[0]!.input.message+='changed';
    if(issue==='docs')m.contractSha256=hash('changed docs');if(issue==='evaluator')m.evaluatorHashes={...m.evaluatorHashes,'scripts/evaluate-g9c-quality.ts':hash('changed runner')};if(issue==='provider')m.provider={...m.provider,reasoningEffort:'omitted'};
    if(issue==='budget')m.limits={...G9_LIMITS,maxAttempts:3} as any;if(issue==='future-freeze')m.frozenAt='2027-01-01T00:00:00Z';
    expect(()=>validateG9CQualityManifestMetadata(m,v.parent,v.data,v.parentHash,v.fixtureHash,v.evaluatorHashes,'2026-10-24T03:00:00Z')).toThrow('G9C_QUALITY_FROZEN_MANIFEST_MISMATCH');
  });
  it('preflights static temporary files without reading provider config or creating cloud/DB clients',async()=>{
    const v=await staticFiles();expect(await hashG9CQualityEvaluatorFiles(v.root)).toEqual(v.evaluatorHashes);
    const {stdout,stderr}=await promisify(execFile)(process.execPath,[resolve('node_modules/tsx/dist/cli.mjs'),resolve('scripts/evaluate-g9c-quality.ts'),'--preflight','--manifest',v.path],{cwd:v.root,env:{...process.env,BANKPILOT_MODEL_BASE_URL:'',BANKPILOT_MODEL_NAME:'',BANKPILOT_MODEL_THINKING:'invalid-no-provider-read',BANKPILOT_MODEL_REASONING_EFFORT:'invalid-no-provider-read',DATABASE_URL:'invalid-no-db-read'},timeout:15000});
    expect(stderr).toBe('');expect(JSON.parse(stdout)).toMatchObject({status:'preflight-passed',cohort:'development-supplemental',implementationInformed:true,blind:false,caseCount:12,caseIds:v.manifest.caseIds});
  });
  it.each(['fixture','docs','quality-test','main-manifest','new-product-file'])('checks %s before dispatch using the shared main source inventory',async issue=>{
    const v=await staticFiles();await expect(verifyG9CQualityFrozenFiles(v.manifest,v.manifestHash,v.path,v.parent,v.root)).resolves.toBeUndefined();
    const path=issue==='fixture'?G9C_QUALITY_FIXTURE_PATH:issue==='docs'?G9C_QUALITY_CONTRACT_PATH:issue==='quality-test'?'tests/g9c-quality-runner.test.ts':issue==='main-manifest'?G9C_QUALITY_PARENT_MANIFEST_PATH:'apps/new-product.ts';
    await writeFile(join(v.root,path),'changed static bytes');
    await expect(verifyG9CQualityFrozenFiles(v.manifest,v.manifestHash,v.path,v.parent,v.root)).rejects.toThrow(/^G9/);
  });
});

describe('G9C supplemental durable execution reuses G9 scoring, attempts and observation',()=>{
  it('runs all twelve sequentially in frozen order with every before/after check and independent artifact denominator',async()=>{
    quiet();const v=metadata(),resultsDir=await temporary(),verifyFrozenFiles=vi.fn(async()=>true),order:string[]=[];let active=0,peak=0;
    const report=await executeG9CQuality({dataset:v.data,manifest:v.manifest,manifestHash:hash('quality manifest'),config,resultsDir,verifyFrozenFiles,plan:async(input,observer)=>{
      active++;peak=Math.max(peak,active);order.push(input.taskId);const item=v.data.cases.find(item=>item.input.taskId===input.taskId)!;for(const role of item.expected.successfulCallRoles)await emit(observer,role);active--;return resultFor(item);
    }});
    expect(report).toMatchObject({validRun:true,executionComplete:true,cohort:'development-supplemental',implementationInformed:true,blind:false,knownRegression:false,caseCount:12});
    expect(report.scoreSummary).toMatchObject({plannedCases:12,passedCases:12,unattemptedCases:0});expect(report.observedAttempts.usage.outputTokensTotal).toBeNull();expect(peak).toBe(1);
    expect(order).toEqual(v.data.cases.map(item=>item.input.taskId));expect(verifyFrozenFiles).toHaveBeenCalledTimes(26);
    const lines=(await readFile(report.jsonlPath,'utf8')).trim().split('\n').map(line=>JSON.parse(line));expect(lines).toHaveLength(14);expect(lines[0].protocol.cohort).toBe('development-supplemental');expect(lines.at(-1).type).toBe('finish');
    expect(lines.filter(line=>line.type==='case').map(line=>line.id)).toEqual(v.manifest.caseIds);expect(fetch).not.toHaveBeenCalled();
  });
  it('checks the provider effort and exact frozen labels before opening a run or planning',async()=>{
    quiet();const v=metadata(),plan=vi.fn(),resultsDir=await temporary();
    await expect(executeG9CQuality({dataset:v.data,manifest:v.manifest,manifestHash:hash('manifest'),config:{...config,reasoningEffort:undefined},resultsDir,verifyFrozenFiles:async()=>true,plan})).rejects.toThrow('G9C_QUALITY_EXECUTION_CONTRACT_MISMATCH');
    v.data.cases[0]!.expected.forbiddenOutputFragments=['changed-after-freeze'];
    await expect(executeG9CQuality({dataset:v.data,manifest:v.manifest,manifestHash:hash('manifest'),config,resultsDir,verifyFrozenFiles:async()=>true,plan})).rejects.toThrow('G9C_QUALITY_EXECUTION_CONTRACT_MISMATCH');expect(plan).not.toHaveBeenCalled();
  });
  it('stops before the first model attempt on source drift',async()=>{
    quiet();const v=metadata(),plan=vi.fn(),verifyFrozenFiles=vi.fn().mockResolvedValueOnce(true).mockRejectedValue(new Error('drift'));
    const report=await executeG9CQuality({dataset:v.data,manifest:v.manifest,manifestHash:hash('manifest'),config,resultsDir:await temporary(),verifyFrozenFiles,plan});
    expect(plan).not.toHaveBeenCalled();expect(report).toMatchObject({validRun:false,sourceDrift:true});expect(report.scoreSummary.unattemptedCases).toBe(12);
  });
  it('invalidates a completed case and retains its durable record on post-case drift',async()=>{
    quiet();const v=metadata(),verifyFrozenFiles=vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(true).mockRejectedValue(new Error('drift'));
    const report=await executeG9CQuality({dataset:v.data,manifest:v.manifest,manifestHash:hash('manifest'),config,resultsDir:await temporary(),verifyFrozenFiles,plan:async(_input,observer)=>{for(const role of v.data.cases[0]!.expected.successfulCallRoles)await emit(observer,role);return resultFor(v.data.cases[0]!);}});
    expect(report.records).toHaveLength(1);expect(report.records[0]).toMatchObject({passed:false,evaluationValid:false,errorCode:'G9C_QUALITY_FROZEN_FILE_DRIFT'});expect(report.scoreSummary.unattemptedCases).toBe(11);
  });
  it('persists an interrupted attempt and does not start subsequent cases',async()=>{
    quiet();const v=metadata(),controller=new AbortController();
    const report=await executeG9CQuality({dataset:v.data,manifest:v.manifest,manifestHash:hash('manifest'),config,resultsDir:await temporary(),verifyFrozenFiles:async()=>true,signal:controller.signal,plan:async(_input,observer)=>{await emit(observer,'semantic_intent',false);controller.abort();throw new ModelProviderError('MODEL_DEADLINE_EXCEEDED');}});
    expect(report).toMatchObject({stopped:true,validRun:false});expect(report.records).toHaveLength(1);expect(report.records[0]!.errorCode).toBe('CASE_DEADLINE_EXCEEDED');expect(report.scoreSummary).toMatchObject({businessUnavailableCases:1,safetyUnscoredCases:1,unattemptedCases:11});
  });
  it('retains unavailable and unscored safety counts rather than recording failures as successful no-action',async()=>{
    quiet();const v=metadata();
    const report=await executeG9CQuality({dataset:v.data,manifest:v.manifest,manifestHash:hash('manifest'),config,resultsDir:await temporary(),verifyFrozenFiles:async()=>true,plan:async(_input,observer)=>{await emit(observer,'semantic_intent',false);throw new ModelProviderError('MODEL_HTTP_503',true);}});
    expect(report.validRun).toBe(true);expect(report.scoreSummary).toMatchObject({plannedCases:12,passedCases:0,businessUnavailableCases:12,businessAssessedCases:0,safetyPassCases:0,safetyUnscoredCases:12});
  });
});
