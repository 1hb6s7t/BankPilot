import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { digest } from '../evals/ablation-score.ts';
import { g9eExpected, scoreG9E } from '../evals/g9e-score.ts';
import { scoreG9 } from '../evals/g9-score.ts';

// Reuses the G9 post-run audit against the new candidate; original labels stay fixed.
const [reportPath, outputPath] = process.argv.slice(2);
if (!reportPath || !outputPath) throw new Error('Usage: node --import tsx scripts/audit-g9-run.mjs REPORT OUTPUT');
const report = JSON.parse(await readFile(reportPath, 'utf8'));
if (!report.executionComplete || ![36,12].includes(report.records?.length)) throw new Error('G9E_RUN_NOT_COMPLETE');
const hash = value => createHash('sha256').update(value).digest('hex');
const fileHash = async path => hash(await readFile(path));
const manifestPath = 'evals/g9e-manifest.json';
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const original = JSON.parse(await readFile('evals/g9-manifest.json', 'utf8'));
if (!['known-regression','development-supplemental'].includes(report.cohort)) throw new Error('G9E_AUDIT_COHORT_INVALID');
const binding = manifest.cohorts[report.cohort === 'known-regression' ? 'knownRegression' : 'developmentSupplemental'];
Object.assign(manifest,binding); manifest.authorReview = original.authorReview; manifest.authorNotes = original.authorNotes;
const source = JSON.parse(await readFile(manifest.sourceManifestPath, 'utf8'));
const datasetModule = await import(pathToFileURL(resolve(manifest.fixturePath)).href); const g9Dataset = datasetModule.g9Dataset ?? datasetModule.g9cQualityDataset;
const fixtureById = new Map(g9Dataset.cases.map(item => [item.id, item]));
const sourceDrift = [];
for (const file of source.files) if (await fileHash(file.path).catch(() => null) !== file.sha256) sourceDrift.push(file.path);
const evaluatorDrift = [];
for (const [path, expected] of Object.entries(manifest.evaluatorHashes)) if (await fileHash(path).catch(() => null) !== expected) evaluatorDrift.push(path);
const bindingChecks = report.records.map(record => {
  const fixture = fixtureById.get(record.id), input = structuredClone(fixture.input), binding = record.snapshotClockBinding;
  let clockValid = !fixture.snapshotClock && !binding;
  if (fixture.snapshotClock && binding) {
    const snapshot = input.managementContext.subscriptions;
    const delta = Date.parse(record.startedAt) - Date.parse(fixture.snapshotClock.anchorIso);
    const queried = new Date(Date.parse(snapshot.queriedAt) + delta).toISOString();
    const expires = new Date(Date.parse(snapshot.accessExpiresAt) + delta).toISOString();
    clockValid = binding.anchorIso === fixture.snapshotClock.anchorIso && binding.caseWallStartIso === record.startedAt && binding.deltaMs === delta && binding.queriedAt.template === snapshot.queriedAt && binding.accessExpiresAt.template === snapshot.accessExpiresAt && binding.queriedAt.resolved === queried && binding.accessExpiresAt.resolved === expires;
    snapshot.queriedAt = queried; snapshot.accessExpiresAt = expires;
  }
  return { id: record.id, originalScoreMatches:record.failure ? !record.score : digest(scoreG9({...fixture,input},record.result))===digest(record.score), currentLabelHashMatches:digest(g9eExpected(fixture))===record.currentExpectedHash, currentScoreMatches:record.failure ? !record.currentContractScore : digest(scoreG9E({...fixture,input},record.result))===digest(record.currentContractScore), templateHashMatches: digest(fixture.input) === record.templateInputHash, actualHashMatches: digest(input) === record.inputHash, expectedHashMatches: digest(fixture.expected) === record.expectedHash, clockValid };
});
const events = (await readFile(report.attemptsPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
const starts = events.filter(event => event.type === 'attempt_start'), ends = events.filter(event => event.type === 'attempt_end');
const startIds = starts.map(event => event.attemptId), endIds = ends.map(event => event.attemptId);
const openIds = startIds.filter(id => !endIds.includes(id)), unmatchedEndIds = endIds.filter(id => !startIds.includes(id));
const countBy = (rows, key) => Object.fromEntries([...new Set(rows.map(item => String(item[key] ?? 'unknown')))].sort().map(value => [value, rows.filter(item => String(item[key] ?? 'unknown') === value).length]));
const distribution = values => {
  const sorted = [...values].sort((a,b) => a-b), n = sorted.length;
  return { n, medianMs: n ? (n % 2 ? sorted[(n-1)/2] : (sorted[n/2-1] + sorted[n/2])/2) : null, p95Ms: n ? sorted[Math.ceil(n*0.95)-1] : null, maxMs: n ? sorted[n-1] : null };
};
const usage = field => {
  const reported = ends.filter(end => Number.isSafeInteger(end[field]) && end[field] >= 0);
  const sum = reported.reduce((total,end) => total + end[field],0), missing = ends.length - reported.length;
  return { reportedSum: sum, missingUsage: missing, total: missing || openIds.length ? null : sum };
};
const budgets = report.records.map(record => {
  const rows = starts.filter(start => start.caseSequence === record.sequence);
  const invalidCaps = rows.filter(start => !Number.isSafeInteger(start.requestMaxOutputTokens) || start.requestMaxOutputTokens <= 0 || start.requestMaxOutputTokens > report.limits.totalOutputTokenCeilingPerCase).length;
  const total = rows.reduce((sum,start) => sum + (Number.isSafeInteger(start.requestMaxOutputTokens) ? start.requestMaxOutputTokens : 0),0);
  return { id: record.id, requests: rows.length, requestedOutputTokenCeilingSum: total, invalidCaps, withinBudget: !invalidCaps && total <= report.limits.totalOutputTokenCeilingPerCase };
});
const stats = rows => ({ cases: rows.length, passed: rows.filter(row => row.passed).length, assessed: rows.filter(row => row.score?.assessed).length, unavailable: rows.filter(row => row.failure).length, semanticPassed: rows.filter(row => row.score?.intentRecognition).length, safetyAssessed: rows.filter(row => row.score?.planningSafety !== undefined && row.score.planningSafety !== null).length, safetyFailed: rows.filter(row => row.score?.planningSafety === false).length, unexpectedProposals: rows.filter(row => row.score?.unexpectedActionProposal).length, missingProposals: rows.filter(row => (row.score?.missingProposalCount ?? 0) > 0).length, latency: distribution(rows.map(row => row.durationMs)) });
// Recompute the full recorded summaries from individual cases. This audit is
// independent of the runner's summary function and keeps both score versions.
const summarize = (rows, plannedCases) => {
  const assessed=rows.flatMap(row=>row.score?.assessed?[row.score]:[]);
  const safety=assessed.filter(score=>score.planningSafety!==null);
  const failureCodes=Object.fromEntries([...new Set(rows.flatMap(row=>[...(row.score?.failures??[]),...(row.errorCode?[row.errorCode]:[])]))].sort().map(code=>[code,rows.filter(row=>row.errorCode===code||row.score?.failures.includes(code)).length]));
  return { plannedCases,attemptedCases:rows.length,unattemptedCases:plannedCases-rows.length,
    businessAssessedCases:assessed.length,businessUnavailableCases:rows.filter(row=>!!row.failure).length,businessUnscoredCases:rows.length-assessed.length,
    passedCases:rows.filter(row=>row.passed).length,businessPassCases:assessed.filter(score=>score.businessSemanticsPass).length,
    semanticPassCases:assessed.filter(score=>score.intentRecognition).length,exactSuccessfulCallSetCases:assessed.filter(score=>score.modelComplete).length,
    safetyAssessedCases:safety.length,safetyUnscoredCases:rows.length-safety.length,safetyPassCases:safety.filter(score=>score.planningSafety===true).length,
    safetyFailureCases:safety.filter(score=>score.planningSafety===false).length,
    missingProposalCases:assessed.filter(score=>(score.missingProposalCount??0)>0).length,
    unexpectedProposalCases:assessed.filter(score=>score.unexpectedActionProposal).length,
    evaluationInvalidCases:rows.filter(row=>!row.evaluationValid).length,failureCodes };
};
const currentRows=report.records.map(row=>({...row,score:row.currentContractScore,passed:row.currentContractPassed}));
const summaryMatches=digest(summarize(report.records,binding.caseCount))===digest(report.scoreSummary);
const currentSummaryMatches=digest(summarize(currentRows,binding.caseCount))===digest(report.currentScoreSummary);
const orderMatches=report.stage===(report.cohort==='known-regression'?'default-known':'default-quality')
  && digest(report.caseIds)===digest(binding.caseIds)
  && digest(report.records.map(row=>row.id))===digest(binding.caseIds)
  && report.records.every((row,index)=>row.sequence===index+1);
const artifactHashes = {};
for (const path of [reportPath, report.jsonlPath, report.attemptsPath, report.semanticPath, manifestPath, manifest.fixturePath, manifest.sourceManifestPath, manifest.authorReview.reviewPath, manifest.authorNotes.path]) artifactHashes[path] = await fileHash(path);
const traces = (await readFile(report.semanticPath,'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
const semanticEnds = ends.filter(e=>e.role==='semantic_intent');
const traceChecks = semanticEnds.map(end=>{const rows=traces.filter(t=>t.attemptId===end.attemptId);const t=rows[0];return {attemptId:end.attemptId,unique:rows.length===1,caseMatches:t?.caseSequence===end.caseSequence,statusMatches:t?.status===end.status,hashMatches:t?.outputText===undefined || hash(t.outputText)===t.outputDigest,lengthMatches:t?.outputText===undefined || t.outputText.length===t.outputLength};});
const result = {
  semanticTrace: {status:report.semanticTraceStatus,records:traces.length,expected:semanticEnds.length,checks:traceChecks,unexpectedIds:traces.filter(t=>!semanticEnds.some(e=>e.attemptId===t.attemptId)).map(t=>t.attemptId)},
  auditedAt: new Date().toISOString(), reportPath, reportValidRun: report.validRun, executionComplete: report.executionComplete, cohort: report.cohort,
  assertionCoverage: { privacyCanaryCases: g9Dataset.cases.filter(item => item.expected.forbiddenOutputFragments?.length).length, forbiddenResponseGroupCount: g9Dataset.cases.reduce((sum,item) => sum + (item.expected.response?.forbidden?.length ?? 0),0), requiredResponseGroupCount: g9Dataset.cases.reduce((sum,item) => sum + (item.expected.response?.required?.length ?? 0),0), fieldAssertionCount: g9Dataset.cases.reduce((sum,item) => sum + (item.expected.fields?.length ?? 0),0), limitations: 'Zero configured privacy or contradiction assertions provide no coverage of that property; raw boolean score fields must not be interpreted as acceptance.' },
  identity: { orderMatches,summaryMatches,currentSummaryMatches,originalLabelsAggregateMatches:digest(g9Dataset.cases.map(f=>f.expected))===manifest.originalExpectedLabelsSha256 && report.originalExpectedLabelsSha256===manifest.originalExpectedLabelsSha256, currentLabelsAggregateMatches:digest(g9Dataset.cases.map(g9eExpected))===manifest.currentExpectedLabelsSha256 && report.currentExpectedLabelsSha256===manifest.currentExpectedLabelsSha256, inputAggregateMatches:digest(g9Dataset.cases.map(f=>f.input))===manifest.templateInputsSha256 && report.templateInputsSha256===manifest.templateInputsSha256, manifestMatchesRun: artifactHashes[manifestPath] === report.manifestSha256, fixtureMatches: artifactHashes[manifest.fixturePath] === manifest.fixtureSha256, reviewMatches: artifactHashes[manifest.authorReview.reviewPath] === manifest.authorReview.reviewSha256, notesMatches: artifactHashes[manifest.authorNotes.path] === manifest.authorNotes.sha256, sourceFileCount: source.files.length, sourceDrift, evaluatorFileCount: Object.keys(manifest.evaluatorHashes).length, evaluatorDrift, inputAndLabelChecks: bindingChecks },
  allCases: stats(report.records), currentByDomain:Object.fromEntries([...new Set(report.records.map(r=>r.domain))].map(domain=>[domain,stats(report.records.filter(r=>r.domain===domain).map(r=>({...r,score:r.currentContractScore,passed:r.currentContractPassed})))])), currentAllCases:stats(report.records.map(r=>({...r,score:r.currentContractScore,passed:r.currentContractPassed}))), currentPassedCasesLatency:distribution(report.records.filter(r=>r.currentContractPassed).map(r=>r.durationMs)), passedCasesLatency: distribution(report.records.filter(record => record.passed).map(record => record.durationMs)), casesWithDispatchLatency: distribution(report.records.filter(record => starts.some(start => start.caseSequence === record.sequence)).map(record => record.durationMs)), byDomain: Object.fromEntries([...new Set(report.records.map(record => record.domain))].map(domain => [domain,stats(report.records.filter(record => record.domain === domain))])), byKind: Object.fromEntries([...new Set(report.records.map(record => record.kind))].map(kind => [kind,stats(report.records.filter(record => record.kind === kind))])),
  attempts: { starts: starts.length, ends: ends.length, duplicateStarts: starts.length-new Set(startIds).size, duplicateEnds: ends.length-new Set(endIds).size, openIds, unmatchedEndIds, statusCounts: countBy(ends,'status'), httpCounts: countBy(ends,'httpStatus'), errorCodes: countBy(ends.filter(end => end.errorCode),'errorCode'), roles: countBy(starts,'role'), inputUsage: usage('inputTokens'), outputUsage: usage('outputTokens'), reasoningUsage:usage('reasoningTokens'), budgets },
  currentFailures:report.records.filter(r=>!r.currentContractPassed).map(r=>({id:r.id,errorCode:r.errorCode??null,failures:r.currentContractScore?.failures??[],assessed:r.currentContractScore?.assessed??false})), failures: report.records.filter(record => !record.passed).map(record => ({ id: record.id, domain: record.domain, kind: record.kind, errorCode: record.errorCode ?? null, failures: record.score?.failures ?? [], assessed: record.score?.assessed ?? false, evaluationValid: record.evaluationValid })), artifactHashes,
};
await writeFile(outputPath, JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({ outputPath, allCases: result.allCases, currentAllCases:result.currentAllCases, starts: starts.length, ends: ends.length, sourceDrift, evaluatorDrift }));
