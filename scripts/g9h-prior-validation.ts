import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { G9Dataset } from '../evals/g9-contract';
import { MODEL_STRUCTURED_OUTPUT_MAX_BYTES, MODEL_STRUCTURED_OUTPUT_OBSERVATION_VERSION } from '../packages/agents/src/provider';
import { verifyG9GPriorEvidence } from './g9g-prior-validation';

const INVALID = 'G9H_PRIOR_EVIDENCE_INVALID';
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const hex = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function requireEvidence(ok: unknown): asserts ok { if (!ok) throw new Error(INVALID); }

/** The G9G verifier rechecks scores, case and attempt journals, semantic output,
 * clock binding and summaries. G9H adds a mandatory bill output sidecar. */
export async function verifyG9HPriorEvidence(report: any, dataset: G9Dataset, reportPath: string): Promise<void> {
  try {
    await verifyG9GPriorEvidence(report, dataset, reportPath);
    const expectedPath = resolve(dirname(resolve(reportPath)), 'bill-domain-output.jsonl');
    requireEvidence(report.billTraceStatus === 'complete' && report.billTraceFailed === false
      && typeof report.billPath === 'string' && resolve(report.billPath) === expectedPath);
    const caseContents = await readFile(resolve(dirname(expectedPath), 'cases.jsonl'), 'utf8');
    const caseLines = caseContents.trimEnd().split('\n');
    const start = JSON.parse(caseLines[0]!), finish = JSON.parse(caseLines.at(-1)!);
    requireEvidence(start.billPath === report.billPath && finish.billTraceFailed === report.billTraceFailed
      && finish.billTraceStatus === report.billTraceStatus);
    const contents = await readFile(expectedPath, 'utf8');
    requireEvidence(contents === '' || contents.endsWith('\n'));
    const rows = contents === '' ? [] : contents.slice(0, -1).split('\n').map(line => JSON.parse(line));
    const attempts = report.attemptObservation.confirmedAttempts.filter((item: any) => item.start?.role === 'bills');
    requireEvidence(rows.length === attempts.length);
    const byId = new Map(attempts.map((item: any) => [item.start.attemptId, item]));
    const seen = new Set<string>();
    for (const row of rows) {
      const attempt = byId.get(row?.attemptId) as any;
      requireEvidence(attempt && !seen.has(row.attemptId) && attempt.end);
      seen.add(row.attemptId);
      requireEvidence(row.type === 'bill_domain_output' && row.version === MODEL_STRUCTURED_OUTPUT_OBSERVATION_VERSION
        && row.stage === report.stage && row.role === 'bills' && row.toolName === 'submit_domain_proposal'
        && row.caseSequence === attempt.caseSequence && row.caseId === dataset.cases[attempt.caseSequence - 1]?.id
        && row.fixtureSha256 === report.fixtureSha256 && row.sourceManifestSha256 === report.sourceManifestSha256
        && row.attempt === attempt.start.attempt && row.status === attempt.end.status && row.errorCode === attempt.end.errorCode);
      if (typeof row.outputText === 'string' || row.outputOmitted === 'size_limit') {
        requireEvidence(Number.isSafeInteger(attempt.end.httpStatus) && attempt.end.httpStatus >= 200 && attempt.end.httpStatus < 300);
      }
      const allowed = new Set(['type', 'version', 'stage', 'caseId', 'caseSequence', 'fixtureSha256', 'sourceManifestSha256',
        'role', 'toolName', 'attempt', 'attemptId', 'status', 'errorCode', 'outputLength', 'outputDigest', 'outputText', 'outputOmitted']);
      requireEvidence(Object.keys(row).every(key => allowed.has(key)));
      if (typeof row.outputText === 'string') {
        requireEvidence(row.outputOmitted === undefined && Buffer.byteLength(row.outputText, 'utf8') <= MODEL_STRUCTURED_OUTPUT_MAX_BYTES
          && row.outputLength === row.outputText.length && row.outputDigest === digest(row.outputText));
      } else if (row.outputOmitted === 'not_text') {
        requireEvidence(row.outputText === undefined && row.outputLength === undefined && row.outputDigest === undefined);
      } else {
        requireEvidence(row.outputText === undefined && row.outputOmitted === 'size_limit' && Number.isSafeInteger(row.outputLength)
          && row.outputLength >= 0 && hex(row.outputDigest));
      }
    }
  } catch { throw new Error(INVALID); }
}
