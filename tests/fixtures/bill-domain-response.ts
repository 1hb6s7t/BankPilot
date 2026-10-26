import type { LocalContext } from '../../packages/agents/src/index.js';
import type { BillReviewFacts } from '../../packages/agents/src/bill-review-facts.js';
import { scriptBillDomainAssessment } from '../../packages/agents/src/bill-domain-assessment.js';

/** Explicit controlled response; production still invokes and validates the bill agent. */
export function billDomainResponse(context: LocalContext) {
  if (context.role !== 'bills' || !context.data.billFacts) throw new Error('TEST_BILL_CONTEXT_REQUIRED');
  return scriptBillDomainAssessment(context.data.billFacts as BillReviewFacts, context.planVersion);
}
