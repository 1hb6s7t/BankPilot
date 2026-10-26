import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { MODEL_REQUEST_OBSERVATION_VERSION } from '../packages/agents/src/provider';

const INVALID='G9I_PRIOR_REQUEST_EVIDENCE_INVALID';
const sha=(value:unknown)=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
function requireEvidence(value:unknown):asserts value {if(!value)throw new Error(INVALID);}

/** Recheck the adjacent, predispatch request journal before a quality stage. */
export async function verifyG9IRequestPriorEvidence(report:any,reportPath:string):Promise<void>{
  try {
    const directory=dirname(resolve(reportPath));
    const path=resolve(directory,'request-metadata.jsonl');
    requireEvidence(report.requestPath===path&&report.requestTraceStatus==='complete'&&report.requestTraceFailed===false&&report.requestContractFailed===false
      && report.requestObservationVersion===MODEL_REQUEST_OBSERVATION_VERSION);
    const caseText=await readFile(resolve(directory,'cases.jsonl'),'utf8');
    requireEvidence(caseText.endsWith('\n'));
    const caseLines=caseText.trimEnd().split('\n');
    const start=JSON.parse(caseLines[0]!),finish=JSON.parse(caseLines.at(-1)!);
    requireEvidence(start.requestPath===path&&start.protocol.requestObservationVersion===MODEL_REQUEST_OBSERVATION_VERSION
      && finish.requestTraceFailed===false&&finish.requestTraceStatus==='complete'&&finish.requestContractFailed===false);
    const content=await readFile(path,'utf8');
    requireEvidence(report.requestMetadataSha256===createHash('sha256').update(content).digest('hex'));
    requireEvidence(content===''||content.endsWith('\n'));
    const rows=content===''?[]:content.slice(0,-1).split('\n').map(line=>JSON.parse(line));
    const attempts=report.attemptObservation?.confirmedAttempts;
    requireEvidence(Array.isArray(attempts));
    const sent=attempts.filter((item:any)=>item.end?.requestStarted===true);
    const preparedNotSent=attempts.filter((item:any)=>item.end?.requestStarted===false
      &&['MODEL_TIMEOUT','MODEL_DEADLINE_EXCEEDED'].includes(item.end.errorCode));
    requireEvidence(rows.length>=sent.length&&rows.length<=sent.length+preparedNotSent.length);
    requireEvidence(report.requestObservationSummary?.capturedAttempts===rows.length
      &&report.requestObservationSummary?.sentAttempts===sent.length
      &&report.requestObservationSummary?.preparedNotSent===rows.length-sent.length
      &&report.requestObservationSummary?.schemaMissing===rows.filter((row:any)=>row.schemaIncluded===false).length
      &&report.requestObservationSummary?.repairFeedbackIncluded===rows.filter((row:any)=>row.repairFeedbackIncluded===true).length);
    const byId=new Map<string,any>([...sent,...preparedNotSent].map((item:any)=>[item.start?.attemptId,item]));
    const seen=new Set<string>();
    const firstByInvocation=new Map<string,any>();
    const allowed=new Set(['type','stage','caseId','caseSequence','fixtureSha256','sourceManifestSha256','version','invocationId','attemptId','role','attempt','requestMaxOutputTokens','outputMode','body','system','user','schema','schemaLocation','schemaIncluded','repairFeedbackIncluded']);
    for(const row of rows){
      const attempt=byId.get(row?.attemptId);
      requireEvidence(attempt&&!seen.has(row.attemptId)&&Object.keys(row).every(key=>allowed.has(key)));
      seen.add(row.attemptId);
      requireEvidence(row.type==='request_metadata'&&row.version===MODEL_REQUEST_OBSERVATION_VERSION
        &&row.stage===report.stage&&row.caseSequence===attempt.caseSequence
        &&row.caseId===report.caseIds[attempt.caseSequence-1]
        &&row.fixtureSha256===report.fixtureSha256&&row.sourceManifestSha256===report.sourceManifestSha256
        &&row.invocationId===attempt.start.invocationId&&row.attemptId===attempt.start.attemptId
        &&row.role===attempt.start.role&&row.attempt===attempt.start.attempt
        &&row.requestMaxOutputTokens===attempt.start.requestMaxOutputTokens
        &&row.outputMode===report.provider.outputMode
        &&row.schemaLocation===(row.outputMode==='tools'?'tool':'system')
        &&row.schemaIncluded===true&&typeof row.repairFeedbackIncluded==='boolean');
      for(const component of [row.body,row.system,row.user,row.schema]){
        requireEvidence(component&&typeof component==='object'&&Object.keys(component).sort().join(',')==='bytes,sha256'
          &&sha(component.sha256)&&Number.isSafeInteger(component.bytes)&&component.bytes>=0);
      }
      const first=firstByInvocation.get(row.invocationId);
      requireEvidence(!(row.attempt===1&&row.repairFeedbackIncluded)
        &&(!first||(first.schema.sha256===row.schema.sha256&&first.user.sha256===row.user.sha256
          &&(!row.repairFeedbackIncluded||(first.system.sha256!==row.system.sha256&&first.body.sha256!==row.body.sha256)))));
      if(!first)firstByInvocation.set(row.invocationId,row);
    }
    requireEvidence(sent.every((item:any)=>seen.has(item.start.attemptId)));
  }catch{throw new Error(INVALID);}
}
