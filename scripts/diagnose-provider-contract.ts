import { createHash, randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, writeSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadEnvFile } from 'node:process';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { invokeStructured, normalizeBaseURL, providerFromEnv, type OpenAICompatibleConfig } from '../packages/agents/src/provider';

export const G9I_DIAGNOSTIC_VERSION = 'bankpilot-g9i-provider-contract-diagnostic-v1';
export const G9I_MARKER = 'BANKPILOT_G9I_CANARY_7429';
export const G9I_MAX_HTTP_CALLS = 4;
export const G9I_MAX_OUTPUT_TOKENS = 1024;
export const G9I_TIMEOUT_MS = 20_000;
const MAX_VISIBLE_BYTES = 65_536;
const sha256 = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const count = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
const schema = z.object({ probe: z.literal(G9I_MARKER) }).strict();
const scenarios = ['system_only', 'user_control'] as const;
type Scenario = typeof scenarios[number];
type Mode = 'offline' | 'live';
type Event = Record<string, unknown>;

function durableLine(fd: number, event: Event): void {
  const bytes = Buffer.from(`${JSON.stringify(event)}\n`, 'utf8');
  for (let offset = 0; offset < bytes.length;) {
    const written = writeSync(fd, bytes, offset, bytes.length - offset);
    if (written <= 0) throw new Error('G9I_EVIDENCE_SHORT_WRITE');
    offset += written;
  }
  fsyncSync(fd);
}
function durableNew(path: string, value: unknown): void {
  const fd = openSync(path, 'wx', 0o600);
  try { durableLine(fd, value as Event); } finally { closeSync(fd); }
}
function safeCode(error: unknown): string {
  const code = error && typeof error === 'object' && 'code' in error ? (error as { code?: unknown }).code : undefined;
  return typeof code === 'string' && (/^MODEL_HTTP_[1-5]\d{2}$/.test(code)
    || ['MODEL_SCHEMA_INVALID', 'MODEL_OUTPUT_JSON_INVALID', 'MODEL_OUTPUT_EMPTY', 'MODEL_OUTPUT_TRUNCATED',
      'MODEL_RESPONSE_JSON_INVALID', 'MODEL_NETWORK_ERROR', 'MODEL_TIMEOUT', 'MODEL_DEADLINE_EXCEEDED',
      'MODEL_ATTEMPT_START_PERSIST_FAILED', 'MODEL_ATTEMPT_END_PERSIST_FAILED'].includes(code)) ? code : 'G9I_DIAGNOSTIC_FAILED';
}
function offlineTransport(): typeof fetch {
  const calls: Partial<Record<Scenario, number>> = {};
  return (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const task = JSON.parse(JSON.parse(String(init?.body)).messages[1].content) as { scenario: Scenario };
    calls[task.scenario] = (calls[task.scenario] ?? 0) + 1;
    const content = JSON.stringify({ probe: calls[task.scenario] === 1 ? 'INTENTIONALLY_WRONG_OFFLINE' : G9I_MARKER });
    return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content } }],
      usage: { prompt_tokens: 64, completion_tokens: 32, completion_tokens_details: { reasoning_tokens: 8 } } }),
    { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
}

export type G9IDiagnosticOptions = {
  mode: Mode;
  /** The CLI uses a unique directory under docs/evidence. Tests may supply a temporary root. */
  outputRoot?: string;
  /** Fixed production wire construction with an injected synthetic transport for pure tests. */
  provider?: OpenAICompatibleConfig;
  transport?: typeof fetch;
};

/** No business fixtures, payment facts or user text enter either request. */
export async function runG9IProviderDiagnostic(options: G9IDiagnosticOptions) {
  if (options.mode !== 'offline' && options.mode !== 'live') throw new Error('G9I_MODE_INVALID');
  if (options.mode === 'offline' && options.transport) throw new Error('G9I_OFFLINE_TRANSPORT_FORBIDDEN');
  const configured = options.mode === 'offline' ? { baseURL: 'https://offline.invalid/v1', model: 'offline-synthetic', outputMode: 'json_object' as const }
    : options.provider ?? providerFromEnv();
  if (!configured) throw new Error('G9I_PROVIDER_REQUIRED');
  if (configured.outputMode !== 'json_object' || configured.reasoningEffort !== undefined || configured.thinkingMode !== undefined)
    throw new Error('G9I_PROVIDER_CONTRACT_MISMATCH');
  const baseURL = normalizeBaseURL(configured.baseURL);
  if (configured.apiKey && (configured.model.includes(configured.apiKey) || baseURL.includes(configured.apiKey)))
    throw new Error('G9I_PROVIDER_CONFIG_CREDENTIAL_ECHO');
  const provider: OpenAICompatibleConfig = { ...configured, outputMode: 'json_object',
    maxAttempts: 2, maxStructureRepairs: 1, retryDelayMs: 0, timeoutMs: G9I_TIMEOUT_MS,
    maxOutputTokens: G9I_MAX_OUTPUT_TOKENS, temperature: 0 };
  // Never allow a caller-supplied observer to export unbounded provider data.
  delete provider.structuredOutputObserver;
  delete provider.attemptObserver;
  const outputRoot = resolve(options.outputRoot ?? 'docs/evidence');
  mkdirSync(outputRoot, { recursive: true });
  const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`;
  const directory = resolve(outputRoot, `g9i-provider-contract-${options.mode}-${runId}`);
  mkdirSync(directory, { mode: 0o700 });
  const eventsPath = resolve(directory, 'events.jsonl'), manifestPath = resolve(directory, 'manifest.json'), finalPath = resolve(directory, 'final.json');
  durableNew(manifestPath, { version: G9I_DIAGNOSTIC_VERSION, runId, mode: options.mode,
    provider: { model: provider.model, baseURLSha256: sha256(baseURL), outputMode: provider.outputMode,
      thinkingMode: 'omitted', reasoningEffort: 'omitted' },
    fixedSyntheticOnly: true, scenarios, maxHttpCalls: G9I_MAX_HTTP_CALLS, maxAttemptsPerScenario: 2,
    maxStructureRepairs: 1, maxOutputTokens: G9I_MAX_OUTPUT_TOKENS, timeoutMs: G9I_TIMEOUT_MS, temperature: 0,
    markerSha256: sha256(G9I_MARKER), note: 'Independent endpoint diagnostic; never a G9H cohort retry or business score.' });
  const fd = openSync(eventsPath, 'wx', 0o600);
  const nativeFetch = globalThis.fetch;
  const transport = options.transport ?? (options.mode === 'offline' ? offlineTransport() : nativeFetch);
  const events: Event[] = [], outcomes: Record<Scenario, { passed: boolean; errorCode?: string; httpCalls: number }> = {
    system_only: { passed: false, httpCalls: 0 }, user_control: { passed: false, httpCalls: 0 },
  };
  let currentScenario: Scenario = 'system_only', dispatched = 0;
  const record = (event: Event) => { durableLine(fd, event); events.push(event); };
  const wrapper: typeof fetch = async (input, init) => {
    if (dispatched >= G9I_MAX_HTTP_CALLS) {
      record({ type: 'budget_refused', scenario: currentScenario, errorCode: 'G9I_HTTP_CALL_LIMIT' });
      throw new Error('G9I_HTTP_CALL_LIMIT');
    }
    const bodyText = typeof init?.body === 'string' ? init.body : '';
    let body: any;
    try { body = JSON.parse(bodyText); } catch { throw new Error('G9I_REQUEST_BODY_INVALID'); }
    const system = body.messages?.[0]?.content, user = body.messages?.[1]?.content;
    if (typeof system !== 'string' || typeof user !== 'string' || body.model !== provider.model
      || body.max_tokens !== G9I_MAX_OUTPUT_TOKENS || body.response_format?.type !== 'json_object')
      throw new Error('G9I_REQUEST_BODY_INVALID');
    const sequence = ++dispatched;
    outcomes[currentScenario].httpCalls++;
    record({ type: 'request', sequence, scenario: currentScenario, bodySha256: sha256(bodyText), bodyBytes: Buffer.byteLength(bodyText, 'utf8'),
      model: body.model, maxOutputTokens: body.max_tokens, temperature: body.temperature, responseFormat: body.response_format.type,
      components: { system: { sha256: sha256(system), bytes: Buffer.byteLength(system, 'utf8'),
        hasRequiredJsonSchema: system.includes('Required JSON schema:'), hasMarker: system.includes(G9I_MARKER),
        hasRepairFeedback: system.includes('Safe validation feedback:') },
      user: { sha256: sha256(user), bytes: Buffer.byteLength(user, 'utf8'), hasMarker: user.includes(G9I_MARKER) } } });
    let response: Response;
    try { response = await transport(input, init); }
    catch { record({ type: 'transport_error', sequence, scenario: currentScenario, errorCode: 'G9I_TRANSPORT_ERROR' }); throw new Error('G9I_TRANSPORT_ERROR'); }
    let visible: Record<string, unknown> = { outputOmitted: 'not_text' };
    let finishReason: string | undefined, usage: Record<string, number> = {};
    if (response.ok) {
      try {
        const completion = await response.clone().json() as any;
        const candidate = completion?.choices?.[0]?.message?.content;
        finishReason = typeof completion?.choices?.[0]?.finish_reason === 'string'
          ? ['stop', 'length', 'tool_calls', 'function_call', 'content_filter'].includes(completion.choices[0].finish_reason)
            ? completion.choices[0].finish_reason : 'other' : undefined;
        if (typeof candidate === 'string') visible = configured.apiKey && candidate.includes(configured.apiKey)
          ? { outputOmitted: 'credential_echo', outputLength: candidate.length, outputDigest: sha256(candidate) }
          : Buffer.byteLength(candidate, 'utf8') <= MAX_VISIBLE_BYTES
            ? { outputText: candidate, outputLength: candidate.length, outputDigest: sha256(candidate) }
            : { outputOmitted: 'size_limit', outputLength: candidate.length, outputDigest: sha256(candidate) };
        const promptTokens = count(completion?.usage?.prompt_tokens), completionTokens = count(completion?.usage?.completion_tokens);
        const reasoningTokens = count(completion?.usage?.completion_tokens_details?.reasoning_tokens);
        usage = { ...(promptTokens !== undefined ? { promptTokens } : {}),
          ...(completionTokens !== undefined ? { completionTokens } : {}),
          ...(reasoningTokens !== undefined ? { reasoningTokens } : {}) };
      } catch { visible = { outputOmitted: 'not_text' }; }
    }
    record({ type: 'response', sequence, scenario: currentScenario, httpStatus: response.status,
      ...(finishReason ? { finishReason } : {}), usage, ...visible });
    return response;
  };
  try {
    globalThis.fetch = wrapper;
    for (const scenario of scenarios) {
      currentScenario = scenario;
      const task = scenario === 'system_only'
        ? { role: 'single', scenario, instruction: 'Return the one synthetic diagnostic object required by the structured output contract.' }
        : { role: 'single', scenario, instruction: `Return exactly {"probe":"${G9I_MARKER}"}; do not add keys.` };
      record({ type: 'scenario_start', scenario });
      try {
        const value = await invokeStructured({ ...provider,
          attemptObserver: async event => record({ type: event.type, scenario,
            attemptId: event.attemptId, attempt: event.attempt, role: event.role,
            requestMaxOutputTokens: event.requestMaxOutputTokens,
            ...(event.type === 'attempt_end' ? { status: event.status, requestStarted: event.requestStarted,
              ...(event.httpStatus !== undefined ? { httpStatus: event.httpStatus } : {}),
              ...(event.errorCode ? { errorCode: event.errorCode } : {}),
              ...(event.inputTokens !== undefined ? { inputTokens: event.inputTokens } : {}),
              ...(event.outputTokens !== undefined ? { outputTokens: event.outputTokens } : {}),
              ...(event.reasoningTokens !== undefined ? { reasoningTokens: event.reasoningTokens } : {}) } : {}) }),
        }, task, schema, 'submit_g9i_diagnostic', run => record({ type: 'model_run', scenario, attempt: run.attempt,
          status: run.status, ...(run.errorCode ? { errorCode: run.errorCode } : {}),
          ...(run.finishReason ? { finishReason: run.finishReason } : {}),
          ...(run.outputLength !== undefined ? { outputLength: run.outputLength } : {}),
          ...(run.outputDigest ? { outputDigest: run.outputDigest } : {}),
          ...(run.inputTokens !== undefined ? { inputTokens: run.inputTokens } : {}),
          ...(run.outputTokens !== undefined ? { outputTokens: run.outputTokens } : {}),
          ...(run.reasoningTokens !== undefined ? { reasoningTokens: run.reasoningTokens } : {}) }));
        outcomes[scenario].passed = value.probe === G9I_MARKER;
      } catch (error) { outcomes[scenario].errorCode = safeCode(error); }
      record({ type: 'scenario_end', scenario, ...outcomes[scenario] });
    }
    const requests = events.filter(event => event.type === 'request');
    const terminals = events.filter(event => event.type === 'response' || event.type === 'transport_error');
    const attemptStarts = events.filter(event => event.type === 'attempt_start');
    const attemptEnds = events.filter(event => event.type === 'attempt_end');
    const modelRuns = events.filter(event => event.type === 'model_run');
    const systemRequests = requests.filter(event => event.scenario === 'system_only');
    const repairObserved = systemRequests.length >= 2
      ? systemRequests[0]?.components && systemRequests[1]?.components
        ? (systemRequests[0].components as any).system.hasRepairFeedback === false
          && (systemRequests[1].components as any).system.hasRepairFeedback === true
          && systemRequests[0].bodySha256 !== systemRequests[1].bodySha256 : false : null;
    const requestConstructionValid = requests.every(event => {
      const components = event.components as any;
      return components?.system?.hasRequiredJsonSchema === true && components.system.hasMarker === true
        && components.user.hasMarker === (event.scenario === 'user_control');
    });
    const journalClosed = requests.length === dispatched && terminals.length === dispatched
      && attemptStarts.length === dispatched && attemptEnds.length === dispatched
      && requests.every(request => terminals.filter(terminal => terminal.sequence === request.sequence).length === 1)
      && attemptStarts.every(start => attemptEnds.filter(end => end.attemptId === start.attemptId).length === 1);
    const final = { version: G9I_DIAGNOSTIC_VERSION, mode: options.mode, runId, directory,
      httpCalls: dispatched, maxHttpCalls: G9I_MAX_HTTP_CALLS, outcomes,
      systemContractPassed: outcomes.system_only.passed,
      userControlPassed: outcomes.user_control.passed,
      firstAttemptPassed: Object.fromEntries(scenarios.map(scenario => [scenario,
        modelRuns.find(event => event.scenario === scenario && event.attempt === 1)?.status === 'success'])),
      systemRepairFeedback: repairObserved === null ? 'not_observed' : repairObserved ? 'changed_after_failure' : 'missing_or_unchanged',
      requestConstructionValid, journalClosed,
      validEvidence: dispatched <= G9I_MAX_HTTP_CALLS && journalClosed && requestConstructionValid,
      interpretation: 'Synthetic provider-contract diagnostic only. User-control success does not establish system/schema compliance. No business score, cohort retry, key, headers or hidden reasoning content is recorded.' };
    durableNew(finalPath, final);
    return final;
  } finally { globalThis.fetch = nativeFetch; closeSync(fd); }
}

export async function runG9IDiagnosticCli(args = process.argv.slice(2)) {
  if (args.length > 1 || args.some(arg => !['--live', '--dry-run'].includes(arg))) throw new Error('G9I_OPTION_INVALID');
  const mode: Mode = args[0] === '--live' ? 'live' : 'offline';
  if (mode === 'live') {
    try { loadEnvFile('.env'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('G9I_ENV_LOAD_FAILED'); }
  }
  const final = await runG9IProviderDiagnostic({ mode });
  console.log(JSON.stringify({ directory: final.directory, httpCalls: final.httpCalls,
    systemContractPassed: final.systemContractPassed, userControlPassed: final.userControlPassed,
    systemRepairFeedback: final.systemRepairFeedback, validEvidence: final.validEvidence }));
  if (!final.validEvidence || !final.systemContractPassed || !final.userControlPassed) process.exitCode = 1;
  return final;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  runG9IDiagnosticCli().catch(() => { console.error('G9I diagnostic setup failed; credentials and provider details remain sealed.'); process.exitCode = 1; });
