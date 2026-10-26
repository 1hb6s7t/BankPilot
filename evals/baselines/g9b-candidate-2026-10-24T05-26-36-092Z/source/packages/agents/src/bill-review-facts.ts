import type { BillAnalysis, BillReport, BillTransaction } from '../../contracts/src/index.js';
import { z } from 'zod';

/** Bills review has no free-text monetary or merchant claims. Approval remains
 * the independent reviewer's separate decision in the enclosing review. */
export const billReviewAssessmentSchema = z.object({
  assessment: z.enum(['consistent', 'partial_data', 'missing_data', 'unsupported']),
  evidenceSources: z.array(z.string().min(1)).max(64),
}).strict();
export type BillReviewAssessment = z.infer<typeof billReviewAssessmentSchema>;

export type BillReviewFacts = {
  /** Deterministic answer, including scope, coverage status, and provenance. */
  analysis: BillAnalysis;
  reports: {
    period: string;
    source: BillReport['source'] | null;
    coverage: NonNullable<BillReport['coverage']> | { status: 'supplied-report' | 'unavailable' };
    amountsStatus: 'known' | 'partial' | 'unknown';
    incomeMinor: string | null;
    expenseMinor: string | null;
    netMinor: string | null;
    provenance: string | null;
  }[];
  transactions: (Pick<BillTransaction, 'id' | 'bookedAt' | 'merchant' | 'amountMinor' | 'direction' | 'category' | 'source'> & {
    /** Finding support can belong to the previous month without becoming spend. */
    usage: 'query-answer' | 'finding-support-only';
    provenance: string;
  })[];
};

/**
 * Expose only reports/rows accepted by analyzeBills, never a raw report's zero
 * placeholders. Call with the same frozen inputs used for the analysis. Model
 * review may assess consistency but must not replace these facts with prose.
 */
export function buildBillReviewFacts(input: { analysis: BillAnalysis; report?: BillReport; reports?: BillReport[] }): BillReviewFacts {
  const analysis = structuredClone(input.analysis);
  const supplied = input.reports ?? (input.report ? [input.report] : []);
  const evidence = new Map(analysis.evidence.map(item => [item.source, item.detail]));
  const reports: BillReviewFacts['reports'] = analysis.periods.map(period => {
    const matches = supplied.filter(report => report.period === period);
    const report = matches.length === 1 ? matches[0] : undefined;
    const provenance = report ? `bill-report:${period}:${report.source}` : undefined;
    const expected = report ? `incomeMinor=${report.incomeMinor};expenseMinor=${report.expenseMinor};netMinor=${report.netMinor};coverage=${report.coverage?.status ?? 'supplied-report'}` : undefined;
    const accepted = analysis.status !== 'unsupported' && !!report && report.coverage?.status !== 'missing'
      && evidence.get(provenance!) === expected;
    return {
      period, source: report?.source ?? null,
      coverage: report?.coverage ? { ...report.coverage } : { status: report ? 'supplied-report' : 'unavailable' },
      amountsStatus: accepted ? (report.coverage?.status === 'partial' ? 'partial' : 'known') : 'unknown',
      incomeMinor: accepted ? report.incomeMinor : null,
      expenseMinor: accepted ? report.expenseMinor : null,
      netMinor: accepted ? report.netMinor : null,
      provenance: accepted ? provenance! : null,
    };
  });
  const transactions = new Map<string, BillReviewFacts['transactions'][number]>();
  for (const report of supplied.filter(report => analysis.periods.includes(report.period))) {
    for (const row of [...report.transactions, ...(report.evidenceTransactions ?? [])]) {
      const provenance = `bill-transaction:${row.id}`;
      const detail = evidence.get(provenance);
      // This prefix is an exact serialization of all displayed row facts, so a
      // changed merchant, amount, or timestamp cannot acquire old provenance.
      const expected = `${row.bookedAt};${row.merchant};${row.direction};${row.category};amountMinor=${row.amountMinor};coverage=`;
      if (analysis.status === 'unsupported' || !detail?.startsWith(expected)) continue;
      const { id, bookedAt, merchant, amountMinor, direction, category, source } = row;
      transactions.set(id, { id, bookedAt, merchant, amountMinor, direction, category, source,
        usage: analysis.transactionIds.includes(id) ? 'query-answer' : 'finding-support-only', provenance });
    }
  }
  return { analysis, reports, transactions: [...transactions.values()] };
}

/** A model cannot declare missing data complete or acquire invented citations. */
export function validateBillReviewAssessment(facts: BillReviewFacts, value: unknown): string[] {
  const parsed = billReviewAssessmentSchema.safeParse(value);
  if (!parsed.success) return ['BILL_REVIEW_ASSESSMENT_INVALID'];
  const { assessment, evidenceSources } = parsed.data;
  const expected: Record<BillAnalysis['status'], BillReviewAssessment['assessment']> = {
    complete: 'consistent', partial: 'partial_data', missing_data: 'missing_data', unsupported: 'unsupported',
  };
  const errors: string[] = [];
  if (assessment !== expected[facts.analysis.status]) errors.push('BILL_REVIEW_ASSESSMENT_MISMATCH');
  const sources = new Set(facts.analysis.evidence.map(item => item.source));
  if ((sources.size > 0 && evidenceSources.length === 0) || new Set(evidenceSources).size !== evidenceSources.length
    || evidenceSources.some(source => !sources.has(source))) errors.push('BILL_REVIEW_EVIDENCE_REFERENCE_INVALID');
  return errors;
}

/** Render only server facts; arbitrary model summary/findings never enter here.
 * Validation errors must also gate effective approval at the caller. This does
 * not grant approval or alter the reviewer's approved boolean. */
export function renderBillReviewAssessment(facts: BillReviewFacts, value: unknown): { summary: string; findings: string[] } {
  const errors = validateBillReviewAssessment(facts, value);
  return {
    summary: `${errors.length ? '账单复核结构与事实不一致，需重新复核。' : ''}账单事实：${facts.analysis.summary}`,
    findings: [...errors, `BILL_REVIEW_STATUS_${facts.analysis.status.toUpperCase()}`, ...facts.analysis.findings],
  };
}
