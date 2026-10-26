import { z } from 'zod';
import { goalDraftSchema, managementSpecSchema, redemptionSpecSchema, type DomainRole, type GoalDraft, type ManagementSpec, type PlannerInput, type RedemptionSpec } from '../packages/contracts/src/index';

/** Labels and equivalences are registered before the first dispatch, never inferred from output. */
export const G9_CONTRACT_VERSION = 'bankpilot-g9-unseen-v1';
export const G9_DOMAINS = ['transfer', 'bills', 'investment', 'card', 'subscription', 'goal'] as const;
export type G9SemanticStatus = 'ready' | 'clarification' | 'no_action';
export type G9CallRole = DomainRole | 'semantic_intent' | 'reviewer';
export type G9FactGroup = { id: string; anyOf: string[] };
export type G9FieldAssertion = { id: string; path: string; equals?: unknown; absent?: true; anyOf?: unknown[]; containsAllStrings?: string[] };
export type G9ExpectedTransfer = { payeeId: string; amountMinor: string; memo?: string };
export type G9ExpectedGoal = Omit<GoalDraft, 'title'> & { title?: string };
export type G9Expected = {
  /** Semantic status is independent of whether later deterministic processing requests clarification. */
  semantic: { status: G9SemanticStatus; recognizedRoles: DomainRole[] };
  /** Exact domain event set and exact successful model-call multiset, including semantic_intent. */
  activatedRoles: DomainRole[];
  successfulCallRoles: G9CallRole[];
  /** optional permits either wording when a structured missing/partial-data result is sufficient. */
  businessClarification: boolean | 'optional';
  transfers: G9ExpectedTransfer[];
  management: ManagementSpec[];
  redemptions: RedemptionSpec[];
  goal?: G9ExpectedGoal;
  /** Every required group needs one equivalent; any forbidden equivalent is a failure. Full clauses avoid negation ambiguity. */
  response?: { required?: G9FactGroup[]; forbidden?: G9FactGroup[] };
  /** Optional exact assertions for bill facts, preserved purpose/memo, funding, or other specified fields. */
  fields?: G9FieldAssertion[];
  /** Synthetic canaries or references that must never be disclosed in any returned field. */
  forbiddenOutputFragments?: string[];
};
export type G9Case = {
  id: string;
  domain: DomainRole;
  /** Positive means a fully specified actionable or answerable request, not necessarily a money movement. */
  kind: 'positive' | 'clarification' | 'no_action';
  input: Omit<PlannerInput, 'semanticIntent' | 'deadlineAt'>;
  expected: G9Expected;
  /** Synthetic query timestamps retain their registered age/TTL when bound to a real case start. */
  snapshotClock?: { anchorIso: string };
  /** Kept sealed until the first run finishes. Never printed by validation/preflight. */
  rationale: string;
};
export type G9Dataset = { version: string; cases: G9Case[] };
export type G9Manifest = {
  contractVersion: typeof G9_CONTRACT_VERSION;
  datasetVersion: string;
  frozenAt: string;
  fixturePath: string;
  fixtureSha256: string;
  caseIds: string[];
  caseCount: 36;
  positiveCount: number;
  domainCounts: Record<DomainRole, number>;
  sourceManifestPath: string;
  sourceManifestSha256: string;
  /** Every evaluator file and reused observation/digest dependency is frozen before dispatch. */
  evaluatorHashes: Record<string, string>;
  preregistrationPath: string;
  preregistrationSha256: string;
  provider: { model: string; outputMode: 'tools' | 'json_object'; baseURLSha256: string };
  authorReview: {
    completedAt: string;
    independentFromImplementation: true;
    prohibitedSourcesNotRead: true;
    fixtureSha256: string;
    contractSha256: string;
    reviewPath: string;
    reviewSha256: string;
  };
};

const nonempty = z.string().min(1);
const amount = z.string().regex(/^[1-9]\d{0,11}$/);
const role = z.enum(G9_DOMAINS);
const factGroupSchema = z.object({ id: nonempty, anyOf: z.array(nonempty).min(1) }).strict();
const inputSchema = z.object({
  taskId: nonempty, message: nonempty, referenceDate: z.iso.date(),
  accounts: z.array(z.object({ id: nonempty, name: nonempty, maskedNumber: nonempty, balanceMinor: z.string().regex(/^\d+$/), reservedMinor: z.string().regex(/^\d+$/), currency: z.literal('CNY') }).strict()),
  payees: z.array(z.object({ id: nonempty, name: nonempty, bank: nonempty, maskedNumber: nonempty, aliases: z.array(z.string()) }).strict()),
  billReport: z.record(z.string(), z.unknown()).optional(), billReports: z.array(z.record(z.string(), z.unknown())).optional(), fundsPreview: z.record(z.string(), z.unknown()).optional(), managementContext: z.record(z.string(), z.unknown()).optional(), investmentContext: z.record(z.string(), z.unknown()).optional(),
}).strict();
const caseSchema = z.object({
  id: z.string().regex(/^g9-[a-z0-9-]+$/), domain: role, kind: z.enum(['positive','clarification','no_action']), input: inputSchema, rationale: nonempty, snapshotClock: z.object({ anchorIso: z.iso.datetime() }).strict().optional(),
  expected: z.object({
    semantic: z.object({ status: z.enum(['ready','clarification','no_action']), recognizedRoles: z.array(role) }).strict(),
    activatedRoles: z.array(role), successfulCallRoles: z.array(z.enum([...G9_DOMAINS,'semantic_intent','reviewer'])),
    businessClarification: z.union([z.boolean(),z.literal('optional')]),
    transfers: z.array(z.object({ payeeId: nonempty, amountMinor: amount, memo: z.string().max(120).optional() }).strict()),
    management: z.array(managementSpecSchema), redemptions: z.array(redemptionSpecSchema), goal: goalDraftSchema.omit({ title: true }).extend({ title: z.string().trim().min(1).max(80).optional() }).strict().optional(),
    response: z.object({ required: z.array(factGroupSchema).optional(), forbidden: z.array(factGroupSchema).optional() }).strict().optional(),
    fields: z.array(z.object({ id: nonempty, path: nonempty, equals: z.unknown().optional(), absent: z.literal(true).optional(), anyOf: z.array(z.unknown()).min(1).optional(), containsAllStrings: z.array(nonempty).min(1).optional() }).strict()).optional(),
    forbiddenOutputFragments: z.array(nonempty).optional(),
  }).strict(),
}).strict();

/** Static metadata validation only; it never invokes a planner or reveals case text. */
export function validateG9Dataset(dataset: G9Dataset) {
  if (!dataset || typeof dataset.version !== 'string' || !Array.isArray(dataset.cases)) throw new Error('G9_DATASET_INVALID');
  if (dataset.cases.some(item => !caseSchema.safeParse(item).success)) throw new Error('G9_CASE_SCHEMA_INVALID');
  const ids = dataset.cases.map(item => item.id);
  const domainCounts = Object.fromEntries(G9_DOMAINS.map(domain => [domain, dataset.cases.filter(item => item.domain === domain).length])) as Record<DomainRole, number>;
  const positiveCount = dataset.cases.filter(item => item.kind === 'positive').length;
  if (ids.length !== 36 || new Set(ids).size !== 36 || ids.some(id => !/^g9-[a-z0-9-]+$/.test(id)) || positiveCount < 18 || G9_DOMAINS.some(domain => domainCounts[domain] !== 6 || dataset.cases.filter(item => item.domain === domain && item.kind === 'positive').length < 3)) throw new Error('G9_DATASET_CARDINALITY_INVALID');
  for (const item of dataset.cases) {
    if (!item.input || typeof item.input.message !== 'string' || !item.input.message.trim() || typeof item.input.referenceDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(item.input.referenceDate) || 'semanticIntent' in item.input || 'deadlineAt' in item.input || typeof item.rationale !== 'string' || !item.rationale.trim()) throw new Error('G9_CASE_INPUT_INVALID');
    const expected = item.expected;
    if (!expected || !['ready','clarification','no_action'].includes(expected.semantic?.status) || !Array.isArray(expected.semantic.recognizedRoles) || !Array.isArray(expected.activatedRoles) || !Array.isArray(expected.successfulCallRoles) || (typeof expected.businessClarification !== 'boolean' && expected.businessClarification !== 'optional') || !Array.isArray(expected.transfers) || !Array.isArray(expected.management) || !Array.isArray(expected.redemptions)) throw new Error('G9_EXPECTATION_INVALID');
    for (const roles of [expected.semantic.recognizedRoles, expected.activatedRoles]) if (new Set(roles).size !== roles.length || roles.some(role => !G9_DOMAINS.includes(role))) throw new Error('G9_ROLE_LABEL_INVALID');
    if (expected.successfulCallRoles.some(role => ![...G9_DOMAINS,'semantic_intent','reviewer'].includes(role)) || expected.successfulCallRoles.filter(role => role === 'semantic_intent').length !== 1) throw new Error('G9_CALL_LABEL_INVALID');
    const sortedRoles = (values: readonly string[]) => JSON.stringify([...values].sort());
    const routerStop = expected.semantic.status !== 'ready';
    if (item.kind === 'positive' && (routerStop || !expected.semantic.recognizedRoles.includes(item.domain)) || item.kind === 'no_action' && expected.semantic.status !== 'no_action' || item.kind === 'clarification' && expected.semantic.status === 'no_action') throw new Error('G9_KIND_LABEL_INCONSISTENT');
    if (routerStop && (expected.activatedRoles.length || sortedRoles(expected.successfulCallRoles) !== sortedRoles(['semantic_intent']) || expected.transfers.length || expected.management.length || expected.redemptions.length || expected.goal) || !routerStop && (expected.activatedRoles.length === 0 || sortedRoles(expected.activatedRoles) !== sortedRoles(expected.semantic.recognizedRoles) || sortedRoles(expected.successfulCallRoles) !== sortedRoles(['semantic_intent', ...expected.activatedRoles, 'reviewer']))) throw new Error('G9_ROLE_LABEL_INCONSISTENT');
    if (expected.semantic.status === 'no_action' && (expected.semantic.recognizedRoles.length || expected.businessClarification === true) || expected.semantic.status === 'clarification' && expected.businessClarification === false) throw new Error('G9_STATUS_LABEL_INCONSISTENT');
    if (expected.goal && (expected.transfers.length || expected.management.length || expected.redemptions.length)) throw new Error('G9_MUTUALLY_EXCLUSIVE_PROPOSALS');
    for (const group of [...(expected.response?.required ?? []), ...(expected.response?.forbidden ?? [])]) if (!group.id || !group.anyOf.length || group.anyOf.some(fragment => typeof fragment !== 'string' || !fragment.trim())) throw new Error('G9_RESPONSE_GROUP_INVALID');
    for (const assertion of expected.fields ?? []) if (!assertion.id || !/^[A-Za-z][A-Za-z0-9]*(?:\.(?:[A-Za-z][A-Za-z0-9]*|\d+))*$/.test(assertion.path) || [Object.hasOwn(assertion,'equals'), assertion.absent === true, Object.hasOwn(assertion,'anyOf'), Object.hasOwn(assertion,'containsAllStrings')].filter(Boolean).length !== 1 || assertion.anyOf?.length === 0 || assertion.containsAllStrings?.length === 0) throw new Error('G9_FIELD_ASSERTION_INVALID');
  }
  return { caseCount: ids.length, positiveCount, domainCounts, caseIds: ids };
}
