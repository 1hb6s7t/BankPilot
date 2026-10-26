import { z } from 'zod';
import { billReviewAssessmentSchema, validateBillReviewAssessment, type BillReviewFacts } from './bill-review-facts';

export const BILL_DOMAIN_PROTOCOL = 'g9h-bill-domain-v1';
export const BILL_JOINT_PROTOCOL = 'g9h-bill-joint-v1';
export const BILL_REVIEW_PROTOCOL = 'g9h-bill-review-v1';
export const billDomainConcernCodes = ['period_mismatch', 'filter_mismatch', 'statistic_mismatch', 'evidence_mismatch', 'unresolved_query', 'additional_review_required'] as const;
export type BillDomainConcernCode = typeof billDomainConcernCodes[number];

/** The bills agent judges query alignment and evidence; it never rewrites facts. */
export const billDomainAssessmentSchema = z.object({
  role: z.literal('bills'),
  planVersion: z.number().int().positive(),
  queryAligned: z.boolean().describe('Independently compare the complete original bill request with analysis: preserve every requested period, literal merchant/category predicate, statistic and display requirement. Accurate partial/missing/unsupported diagnostics may be aligned. Return false if any requested constraint disappeared.'),
  assessment: billReviewAssessmentSchema.shape.assessment,
  evidenceSources: billReviewAssessmentSchema.shape.evidenceSources.describe('Select existing analysis.evidence sources only; no amounts, merchant prose or evidence details. These references do not replace or shorten the server answer evidence.'),
  concerns: z.array(z.enum(billDomainConcernCodes)).max(8).describe('Independent, evidence-based concerns. An empty array is not required; any concern withholds the bill answer. Never authorize or execute.'),
}).strict();
export type BillDomainAssessment = z.infer<typeof billDomainAssessmentSchema>;

export function schemaForBillDomainAssessment(facts: BillReviewFacts, planVersion: number) {
  if (!Number.isSafeInteger(planVersion) || planVersion < 1) throw new Error('BILL_DOMAIN_PLAN_VERSION_INVALID');
  return billDomainAssessmentSchema.extend({ planVersion: z.literal(planVersion) }).superRefine((value, context) => {
    for (const code of validateBillReviewAssessment(facts, { assessment: value.assessment, evidenceSources: value.evidenceSources })) {
      context.addIssue({ code: 'custom', path: [code === 'BILL_REVIEW_ASSESSMENT_MISMATCH' ? 'assessment' : 'evidenceSources'], message: code });
    }
    if (new Set(value.concerns).size !== value.concerns.length) context.addIssue({ code: 'custom', path: ['concerns'], message: 'BILL_DOMAIN_CONCERNS_DUPLICATED' });
  });
}

/** Explicit scripted fixture only; production still invokes the bills agent. */
export function scriptBillDomainAssessment(facts: BillReviewFacts, planVersion: number): BillDomainAssessment {
  const assessment = { complete: 'consistent', partial: 'partial_data', missing_data: 'missing_data', unsupported: 'unsupported' } as const;
  return schemaForBillDomainAssessment(facts, planVersion).parse({ role: 'bills', planVersion, queryAligned: true,
    assessment: assessment[facts.analysis.status], evidenceSources: [...new Set(facts.analysis.evidence.map(item => item.source))].slice(0, 64), concerns: [] });
}

export function billDomainApproved(value: BillDomainAssessment): boolean {
  return value.queryAligned && value.concerns.length === 0;
}

/** Public wording and complete citations come only from the server analysis.
 * The caller must retain the independent decision and gate every output surface. */
export function renderBillDomainAssessment(facts: BillReviewFacts, value: BillDomainAssessment) {
  const checked = schemaForBillDomainAssessment(facts, value.planVersion).parse(value);
  const analysis = structuredClone(facts.analysis);
  return { role: 'bills' as const, planVersion: checked.planVersion, summary: analysis.summary,
    findings: [...analysis.findings, ...(!checked.queryAligned ? ['BILL_DOMAIN_QUERY_SCOPE_MISMATCH'] : []), ...checked.concerns.map(code => `BILL_DOMAIN_CONCERN:${code}`)],
    evidence: analysis.evidence, ...(analysis.clarification ? { clarification: analysis.clarification } : {}) };
}
