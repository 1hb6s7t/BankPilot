# G7 refinement and reserved first-execution protocol

Status: evaluation protocol for the next G7 quality iteration. This document does not certify a product fix or authorize a new model run. The first live pilot remains an immutable baseline; new reports must use new filenames and record the new protocol version.

## Cohorts and what may be claimed

The first live pilot selected 12 cases from the frozen 24-case G7 set. Those 12 are now known regression cases. The other 12 were frozen before the first model execution and remain the reserved first-execution cohort. Their IDs remain in the frozen manifest and are intentionally not repeated in this protocol. During implementation collaboration, an agent saw the manifest's per-case rationale metadata, although it did not inspect the reserved prompt contents. Therefore the reserved cohort is not represented as fully blind; it is evidence from the first model execution on those reserved inputs.

The runner accepts three cohort selections:

- `pilot`: the original live pilot, reported as a known regression cohort. It is useful for checking whether known failures recur after a change; it is not unseen evidence.
- `reserved`: the remaining cases in original manifest order. Before first execution, report it as `reserved-first-execution`; after any live run starts on those IDs, report it as `reserved-known`. Its prompts were not inspected by this evaluator, but rationale metadata was visible to an implementation collaborator. The phrase “first execution” describes exposure state, not a claim of a fully blind cohort.
- `all`: both cohorts. Every aggregate must be accompanied by separate `pilot-known` and `reserved-first-execution` or `reserved-known` rows, according to prior exposure. A combined result alone is not an acceptable quality claim because it mixes the known pilot with the reserved cohort.

If the runner is interrupted or any case errors before a scored result is recorded, the run is incomplete/invalid. Do not selectively rerun only failed or inconvenient cases and replace the first report. Preserve the partial JSONL and issue a distinct run that identifies its relationship to the first attempt.

## Frozen baseline and labels

Do not edit, regenerate, or reorder `evals/g7-holdout-fixtures.ts` or `evals/g7-manifest.json` to make a model result pass. The original baseline is [`2026-10-23T01-14-01-994Z-g7-semantic-live-pilot-production.json`](../evals/results/2026-10-23T01-14-01-994Z-g7-semantic-live-pilot-production.json) and its incremental journal. Its 2/12 result, failures, input/output usage fields, and source hashes remain the first-run record even after a product repair.

Expected entities, financial facts, action proposals, clarification requirements, explicit quote/negation outcomes, and manually selected live cases remain labels derived from their synthetic context and this contract. Scoring may be corrected only for a demonstrated scorer defect that applies consistently to all cohorts; such a change requires a versioned scorer/protocol, tests, and a preserved old report. It must not delete or weaken an expected action, change a fixture label, add model-judge scoring, or tune thresholds against the reserved cohort.

Financial correctness remains exact and deterministic: integer minor units, exact resource IDs/versions, no unexpected mutations, safe unsupported-action handling, and context-backed evidence. Frozen `requiredSummaryFragments` and `forbiddenSummaryFragments` are literal phrase anchors, not a general natural-language-equivalence judge. Keep their failures distinct (for example, `RESPONSE_FACT_MISSING`) from exact structured money/action/evidence failures; report financial failure codes by cohort. A missing phrase anchor alone does not prove an incorrect amount, while a correct route alone does not prove the user received the requested amount or evidence. Do not remove anchors to increase pass rates. Review semantically equivalent wording against the source evidence when diagnosing, and record remaining phrase-matching limitations.

## Output budget and execution protocol

The first live report used fixed 2,048-token output caps on every provider request. That is its historical protocol and cannot be rewritten. The next run uses a new protocol version and an observed-route stage budget:

- Maximum per-case output request ceiling is 32,768 tokens across the semantic router, routed domain calls, reviewer (when scheduled), and every retry.
- The semantic stage has a 4,096-token cap. Remaining budget is distributed across the domain and reviewer stages actually scheduled from the validated semantic interpretation, with retry count included in the allocation. The allocation must be independent of frozen expected labels.
- Case wall-clock deadline remains 180 seconds. Provider timeout, max attempts, per-stage allocation, actual role set, per-attempt requested token cap, finish reason and reported usage are recorded with each case.
- Every provider-call cap must be a safe integer from 1 through 32,768; missing and invalid caps are separately reported, and invalid values cannot cancel each other in the summed ceiling. Do not silently fall back to fixed 2,048-token calls or increase the total ceiling. A further budget change requires another `protocolVersion`, a separate report artifact, updated budget tests, and an explicit explanation. Never edit the initial pilot artifact.

The implementation uses the shared `createStageOutputPlan({domainStageCount, reviewerStageCount, maxAttempts, totalOutputTokens})` contract. The runner must verify its arithmetic before any provider request: the semantic cap plus all downstream per-attempt allocations must not exceed the declared per-case ceiling; zero downstream stages allocate no downstream budget; actual role count comes from observed scheduling, not expected roles. The result of the budget plan and actual attempts must be included in the JSON/JSONL so a reviewer can recalculate the maximum.

### Protocol v3 scorer-integrity correction

The frozen first-run artifact and all earlier reports remain unchanged under their recorded protocol versions. A scorer audit found two general defects, corrected for new runs under `g7-semantic-eval-v3-success-cardinality-budget-caps`: each expected logical model stage must have exactly one successful call (failed retries before the success remain valid); duplicate successes no longer count as complete. In addition, each recorded request cap must be a safe integer from 1 through 32,768 inclusive. Missing caps and invalid caps are distinct audit failures, and invalid caps cannot cancel one another in the total. These rules apply equally to all cohorts and do not change fixture labels, expected outcomes, or financial assertions.

Run exactly the requested selection once after independent review. Keep model name, endpoint identity (without credentials), output mode, temperature, runtime limits, start/end source hashes, fixture/expected hashes, per-case diagnostics, all attempts, and every error code. Do not store secrets. A planner exception, deadline abort, source drift, missing result score, or malformed manifest makes the run invalid even if a subset passes.

## Scoring and report requirements

Keep these separate for every case and cohort:

1. Interpretation: semantic status and roles compared with frozen labels; quote/no-action and clarification paths are explicit outcomes, not inferred from free-text category labels.
2. Scheduling: semantic stop must not fabricate domain/reviewer model calls; a ready interpretation must schedule the frozen domain roles and reviewer. Clarification fixtures may validly stop at the semantic stage or reach ready routing and then clarify in a domain when source data/business state is missing.
3. Model execution: schema/structure success, exact call-role set, retries, first-attempt completion, error/finish codes, and provider-reported usage.
4. Business result: exact action/resource/amount/date/funding/evidence/safety checks and final clarification state. An expected action that stops before the domain cannot pass, even when the stop status is schema-valid.
5. User-facing facts: required phrase-anchor presence and any absent requested fact, kept distinct from whether the structured action itself is financially correct.

Summary output must include, for each stratum and overall: case count; execution completeness and source drift; valid-run status; intent correctness; expected model-call completeness; first-attempt completeness; business pass; planning-safety failures; unexpected action proposals; financial failure-code counts; scheduled role events; call successes/failures and finish/error categories; missing, invalid and reported token usage; median/P95 across all cases and cases with actual model calls. `all` mode must never conceal an underperforming reserved cohort behind a known pilot aggregate.

Scripted mode is a deterministic nonsemantic baseline and must not be called a semantic evaluation. A successful schema-valid response, safe refusal, or reviewer completion is not by itself a business pass. These tests measure proposed plans only; authorization, execution, idempotency, ledger posting, receipt retrieval and conversation recovery remain separate acceptance layers.

## Local preflight before any model run

The non-model preflight must verify all of the following before creating the first case request:

- Manifest version, full frozen timestamp, fixture-file SHA-256, fixture count, ordered case ID list, unique IDs, live count and membership.
- `pilot`, `reserved`, and `all` counts and order: 12, 12 and 24; the two subsets are disjoint and their union exactly equals original manifest order.
- The per-case output plan fits the total cap for the worst allowed route/retry combination, and no budget is computed from fixture expectations.
- Source hashes are captured before and after execution, including the integration paths that can change what the planner does.
- Tests cover malformed/tampered manifests, count/order/hash drift, cohort stratification, zero-call and routed call sets, legitimate semantic/domain clarification, expected-action early stop, safety failures and preservation of fixture labels.

Run only typecheck, preflight tests, scorer tests with synthetic `PlanResult` values, and manifest/count/hash tests during implementation review. These local tests must not invoke a planner/provider or make a network call. Do not call the model until root has reviewed the runner, budget arithmetic, cohort report and changed-source hashes.

## Quality repair and full-project boundary

The first live findings show a quality problem rather than a passing G7 gate: exact supplied aliases/card identifiers and supported subscription cancellation can be rejected before domain planning; one unresolved redemption was classified as no-action; clarifications can be too generic; bill and cross-domain goal requests can exhaust model output; and a funds query can be routed correctly but omit the spendable amount. Fix the implementation against these frozen cases while preserving the underlying financial and safety contract. Then run known pilot regression and separately examine the reserved first-execution set; any live run on those IDs permanently changes their status to `reserved-known`.

Passing the repaired G7 cohort is not full-project acceptance. Full project work also includes persisted conversation/task identity and resume after refresh/process restart, independently accepted six-domain and cross-domain browser workflows, explicit authorization-to-execution/recovery evidence in the synthetic environment, observability and measured performance/cost targets, and a reproducible demo with documented constraints. These broader items are tracked in [`ideal-state-acceptance.md`](ideal-state-acceptance.md). G8 design notes are planning artifacts, not implementation evidence.
