import type { ReviewContext } from '../../packages/agents/src/index.js';

type Concern = {
  role: 'all' | ReviewContext['proposals'][number]['role'];
  code: 'proposal_incomplete' | 'unresolved_ambiguity' | 'evidence_mismatch' | 'funds_refused' | 'additional_review_required';
};

/** A controlled reviewer decision that quotes only deterministic bill evidence. */
export function reviewResponse(context: ReviewContext, options: {
  approved?: boolean;
  billQueryAligned?: boolean;
  concerns?: Concern[];
  summary?: string;
  findings?: string[];
} = {}) {
  const approved = options.approved ?? true;
  const facts = context.deterministic?.bills;
  if (facts) {
    const assessment = { complete: 'consistent', partial: 'partial_data', missing_data: 'missing_data', unsupported: 'unsupported' } as const;
    return {
      approved,
      billQueryAligned: options.billQueryAligned ?? true,
      bill: { assessment: assessment[facts.analysis.status], evidenceSources: [...new Set(facts.analysis.evidence.map(item => item.source))].slice(0, 64) },
      concerns: options.concerns ?? [],
    };
  }
  return { approved, findings: options.findings ?? [], summary: options.summary ?? '仅核对提案结构和证据；仍须本人授权。' };
}
