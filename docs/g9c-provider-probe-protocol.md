# G9C `reasoning_effort: "none"` provider probe protocol

Prepared 2026-10-24 (Asia/Shanghai). **Preparation only: this document and script do not show that G9C cloud requests have run.** The root task must review this fixed protocol before invoking `scripts/probe-g9c-reasoning.ts --live --protocol-reviewed` with the existing local environment file. The script requires both flags and does not perform banking operations.

## Evidence basis and claim boundary

The [official DeepSeek Chat Completions API](https://api-docs.deepseek.com/api/create-chat-completion/) lists `reasoning_effort` values `none`, `low`, `high`, `max` and says `none` disables thinking mode. The [Thinking Mode guide](https://api-docs.deepseek.com/guides/thinking_mode/) describes the separate `thinking` switch. These docs concern official `deepseek-flash` / `deepseek-v4-pro`, **not** the configured proxy's `deepseek-v4.1-flash` alias. The proxy's forwarding and actual upstream behavior are unknown. HTTP 2xx only proves proxy acceptance, and a schema-valid answer alone does not establish that reasoning was disabled.

The immutable G9B experiment is `evals/results/g9b-thinking-probe-2026-10-24T05-02-49-989Z`. Its seven synthetic tasks had equal common request-body hashes within pairs. Its `thinking: {"type":"disabled"}` responses still reported positive `reasoning_tokens` in all seven calls. Its files are read as frozen inputs; none are edited.

## One factor, fixed requests

- Inputs: the **same seven task IDs, task JSON and schema** in the G9B `tasks.json`. Verify each task hash against its G9B `protocol.json` before any dispatch.
- Endpoint and alias: same normalized `https://apiw.pro/v1` and `deepseek-v4.1-flash`, checked against G9B endpoint hash and model. No other proxy/model is substituted.
- A: provider default, without `thinking` or `reasoning_effort`.
- B: the identical request body plus only top-level `"reasoning_effort":"none"`; no `thinking` field. The script removes any inherited `thinkingMode` and sets the effort explicitly per condition. It does not change `.env` or the application's default.
- Both: `json_object`, `max_tokens=4096`, `temperature=0`, 60-second attempt timeout, one attempt, zero structural repairs. There are 14 planned HTTP dispatches: one A and one B for each of seven tasks, interleaved A/B for odd indices and B/A for even indices. No retry, changed budget, alternate output mode or replacement task. A failed/timeout/unknown request remains in the denominator.
- Every intercepted request is checked immediately before dispatch; the verified request digest and digest after removing only `reasoning_effort` are written and fsynced. The exact common-body hash must match the corresponding frozen G9B pair, and A/B hashes must match each other. Any mismatch prevents dispatch and makes the experiment incomplete.

## Sealed evidence and interruption behavior

Before the first HTTP call the script creates a unique result directory, copies the script, provider, attempt journal, this protocol, and the original G9B tasks/protocol/records into `source/`, verifies copy hashes, and fsyncs `protocol.json`. The protocol records the source hashes, frozen task file hash, schema hash, endpoint hash, **each frozen exact common-body hash**, fixed settings, conditions and order. It checks those source hashes again before every request.

The attempt journal writes and fsyncs an `attempt_start` before HTTP dispatch and an `attempt_end` afterward. `records.jsonl` receives a pre-dispatch `request_body_verified` entry and then a result entry, each fsynced. An interrupted process can leave an open attempt; it must be reported as unknown and must **not** be rerun within that sealed experiment. Start a new experiment for any repeat. The final `report.json` contains all 14 results, pair comparisons, journal summary, source drift and completion state. A stopped run writes an incomplete report when the process is still able to do so.

Saved results contain status/error codes, finish reason, reported token usage including reasoning tokens when present, content length/digest, schema result, duration and safe provider-reported model string. Missing usage is unknown. The script never persists raw reasoning content, raw response text, task text in the results (the frozen task text exists only in the private source copy), API key or authorization header. Probe output is synthetic; it is not business, privacy or bank-execution acceptance.

## Interpretation and decision rule

Report per condition: request count, HTTP success count, JSON/schema success count, `finish_reason=length` count, reported `reasoning_tokens` with missing values, and same-common-body validity. Compare paired tasks rather than treating 14 independent samples as a product score. If B has zero reported reasoning tokens and valid output where A consumes reasoning budget, that supports endpoint-specific parameter effect. Positive tokens in B, absent usage or mixed outcomes leave actual upstream behavior unconfirmed. A 4xx means that request was rejected; a 2xx with apparent improvement does not prove that the proxy honored the field. Do not automatically change production defaults, budgets, G9/G9B manifests or scores based on this probe.
