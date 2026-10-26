/** G9C single-factor compatibility probe. No imports or calls to bank execution paths. */
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, open, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { createModelAttemptJournal } from '../packages/agents/src/attempt-journal';
import { invokeStructured, normalizeBaseURL, providerFromEnv } from '../packages/agents/src/provider';
import type { ModelRun } from '../packages/contracts/src/index';

if (!process.argv.includes('--live') || !process.argv.includes('--protocol-reviewed')) {
  throw new Error('G9C needs explicit --live --protocol-reviewed after protocol review');
}

const sha = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
const fileHash = async (path: string) => sha(await readFile(path));
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item) ?? 'undefined';
const digest = (value: unknown) => sha(canonical(value));
const frozenRoot = 'evals/results/g9b-thinking-probe-2026-10-24T05-02-49-989Z';
const frozenTasksPath = `${frozenRoot}/tasks.json`;
const frozenProtocolPath = `${frozenRoot}/protocol.json`;
const frozenRecordsPath = `${frozenRoot}/records.jsonl`;
const frozenTasks = JSON.parse(await readFile(frozenTasksPath, 'utf8')) as {
  schema: unknown; tasks: { id: string; task: unknown; inputHash: string; taskHash: string }[];
};
const frozenProtocol = JSON.parse(await readFile(frozenProtocolPath, 'utf8')) as {
  model: string; baseURLSha256: string; schemaHash: string;
  tasks: { id: string; inputHash: string; taskHash: string }[];
};
if (frozenTasks.tasks.length !== 7 || digest(frozenTasks.schema) !== frozenProtocol.schemaHash) throw new Error('Frozen G9B schema/count differs');
for (const [index, item] of frozenTasks.tasks.entries()) {
  const expected = frozenProtocol.tasks[index];
  if (!expected || item.id !== expected.id || item.inputHash !== expected.inputHash || item.taskHash !== expected.taskHash || digest(item.task) !== item.taskHash) {
    throw new Error('Frozen G9B task differs');
  }
}
const schema = z.fromJSONSchema(frozenTasks.schema as z.core.JSONSchema.JSONSchema) as z.ZodType;
if (digest(z.toJSONSchema(schema)) !== frozenProtocol.schemaHash) throw new Error('G9B schema round trip differs');
const oldResults = (await readFile(frozenRecordsPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as {
  type: string; id?: string; condition?: string; commonBodyHash?: string; bodyVerified?: boolean;
}).filter(row => row.type === 'result');
const expectedCommonBodyHashes: Record<string, string> = {};
for (const item of frozenTasks.tasks) {
  const pair = oldResults.filter(row => row.id === item.id);
  if (pair.length !== 2 || pair.some(row => !row.bodyVerified || !row.commonBodyHash || row.commonBodyHash !== pair[0].commonBodyHash) ||
    !pair.some(row => row.condition === 'provider_default') || !pair.some(row => row.condition === 'thinking_disabled')) {
    throw new Error('G9B common request hash pair differs');
  }
  expectedCommonBodyHashes[item.id] = pair[0].commonBodyHash!;
}
const provider = providerFromEnv();
if (!provider?.apiKey) throw new Error('Explicit model configuration and key required');
const endpoint = normalizeBaseURL(provider.baseURL);
if (provider.model !== frozenProtocol.model || sha(endpoint) !== frozenProtocol.baseURLSha256 || endpoint !== 'https://apiw.pro/v1') {
  throw new Error('G9C endpoint/model differs from G9B');
}

const startedAt = new Date().toISOString();
const directory = `evals/results/g9c-reasoning-probe-${startedAt.replace(/[:.]/g, '-')}-${randomUUID()}`;
await mkdir(directory, { recursive: false });
const sourcePaths = [
  'scripts/probe-g9c-reasoning.ts', 'packages/agents/src/provider.ts', 'packages/agents/src/attempt-journal.ts',
  'docs/g9c-provider-probe-protocol.md', frozenTasksPath, frozenProtocolPath, frozenRecordsPath,
];
const sourceHashes: Record<string, string> = {};
for (const path of sourcePaths) {
  const destination = join(directory, 'source', path);
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(path, destination);
  const originalHash = await fileHash(path), copyHash = await fileHash(destination);
  if (originalHash !== copyHash) throw new Error('Source copy verification failed');
  sourceHashes[path] = originalHash;
}
const writeSealed = async (name: string, value: unknown) => {
  const handle = await open(join(directory, name), 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(value, null, 2)); await handle.sync(); }
  finally { await handle.close(); }
};
const protocol = {
  version: 'g9c-reasoning-single-factor-v1', startedAt, model: provider.model,
  baseURLSha256: sha(endpoint), frozenRoot, frozenTaskFileSha256: sourceHashes[frozenTasksPath],
  schemaHash: digest(frozenTasks.schema), sourceHashes, outputMode: 'json_object', maxTokens: 4096,
  temperature: 0, timeoutMs: 60000, maxAttempts: 1, maxStructureRepairs: 0,
  caseCount: 7, plannedDispatches: 14, conditions: ['provider_default', 'reasoning_effort_none'],
  order: 'Interleaved per case; A/B for odd case indices, B/A for even. No retries or extra conditions.',
  tasks: frozenProtocol.tasks.map(item => ({ ...item, expectedCommonBodyHash: expectedCommonBodyHashes[item.id] })),
  scope: 'Synthetic semantic structure only; response metadata does not prove upstream parameter execution.',
};
await writeSealed('protocol.json', protocol);

const journal = await createModelAttemptJournal(join(directory, 'attempts.jsonl'));
const recordsFile = await open(join(directory, 'records.jsonl'), 'wx', 0o600);
const records: Record<string, unknown>[] = [];
const nativeFetch = globalThis.fetch;
let active: {
  sequence: number; id: string; condition: 'provider_default' | 'reasoning_effort_none';
  taskHash: string; requestHash?: string; commonBodyHash?: string; bodyVerified?: boolean;
  providerModel?: string;
} | undefined;
const appendRecord = async (value: unknown) => { await recordsFile.appendFile(JSON.stringify(value) + '\n'); await recordsFile.sync(); };
globalThis.fetch = async (input, init) => {
  if (!active || String(input) !== `${endpoint}/chat/completions` || typeof init?.body !== 'string') throw new Error('Unexpected G9C request');
  const body = JSON.parse(init.body);
  const { reasoning_effort: effort, ...common } = body;
  if (body.model !== provider.model || body.max_tokens !== 4096 || body.temperature !== 0 ||
    body.response_format?.type !== 'json_object' || body.thinking !== undefined || body.messages?.length !== 2 ||
    digest(JSON.parse(body.messages[1].content)) !== active.taskHash ||
    (active.condition === 'provider_default' ? effort !== undefined : effort !== 'none')) throw new Error('G9C request drift');
  active.requestHash = digest(body);
  active.commonBodyHash = digest(common);
  if (active.commonBodyHash !== expectedCommonBodyHashes[active.id]) throw new Error('G9C request differs from frozen G9B common body');
  active.bodyVerified = true;
  // This fsync precedes the actual HTTP dispatch. No raw body or authorization header is written.
  await appendRecord({ type: 'request_body_verified', sequence: active.sequence, id: active.id,
    condition: active.condition, requestHash: active.requestHash, commonBodyHash: active.commonBodyHash });
  const response = await nativeFetch(input, { ...init, redirect: 'error' });
  try {
    const payload = await response.clone().json() as { model?: unknown };
    if (typeof payload.model === 'string' && /^[a-zA-Z0-9._-]{1,100}$/.test(payload.model)) active.providerModel = payload.model;
  } catch { /* Response parsing and validation remain inside invokeStructured. */ }
  return response;
};

let stoppedError: string | undefined;
try {
  for (const [index, item] of frozenTasks.tasks.entries()) {
    const conditions = index % 2 === 0 ? ['provider_default', 'reasoning_effort_none'] as const : ['reasoning_effort_none', 'provider_default'] as const;
    for (const condition of conditions) {
      for (const [path, expected] of Object.entries(sourceHashes)) if (await fileHash(path) !== expected) throw new Error('G9C source drift before dispatch');
      active = { sequence: records.length + 1, id: item.id, condition, taskHash: item.taskHash };
      const modelRuns: ModelRun[] = [];
      const tick = performance.now();
      let output: unknown, errorCode: string | undefined;
      try {
        output = await invokeStructured({ ...provider, thinkingMode: undefined,
          reasoningEffort: condition === 'reasoning_effort_none' ? 'none' : undefined,
          outputMode: 'json_object', maxOutputTokens: 4096, temperature: 0,
          maxAttempts: 1, maxStructureRepairs: 0, timeoutMs: 60000,
          attemptObserver: journal.observerForCase(active.sequence),
        }, item.task, schema, 'submit_semantic_intent', run => modelRuns.push(run));
      } catch (error) {
        errorCode = error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message) ? error.message : 'PROBE_CALL_FAILED';
      }
      const record = { type: 'result', sequence: active.sequence, id: item.id, condition,
        requestHash: active.requestHash ?? null, commonBodyHash: active.commonBodyHash ?? null,
        bodyVerified: active.bodyVerified === true, providerModel: active.providerModel ?? null,
        schemaSuccess: output !== undefined, outputHash: output === undefined ? null : digest(output),
        errorCode: errorCode ?? null, durationMs: Math.round(performance.now() - tick), modelRuns };
      records.push(record);
      await appendRecord(record);
      console.log(JSON.stringify({ sequence: record.sequence, id: record.id, condition, schemaSuccess: record.schemaSuccess,
        errorCode: record.errorCode, durationMs: record.durationMs }));
      if (!active.bodyVerified) throw new Error('G9C request was not verified; stop further dispatch');
    }
  }
} catch (error) {
  stoppedError = error instanceof Error ? error.message.replace(/[^A-Z0-9_ -]/gi, '').slice(0, 100) : 'G9C_STOPPED';
} finally {
  globalThis.fetch = nativeFetch;
  try { await journal.close(); } catch { stoppedError = stoppedError ?? 'G9C_ATTEMPT_JOURNAL_CLOSE_FAILED'; }
  await recordsFile.close();
}
const pairs = frozenTasks.tasks.map(item => {
  const pair = records.filter(row => row.id === item.id);
  return { id: item.id, sameCommonBody: pair.length === 2 && pair[0].commonBodyHash === pair[1].commonBodyHash };
});
const sourceDrift = (await Promise.all(sourcePaths.map(async path => await fileHash(path) === sourceHashes[path] ? null : path))).filter(Boolean);
const complete = records.length === 14 && pairs.every(pair => pair.sameCommonBody) && sourceDrift.length === 0 &&
  journal.summary().complete && !stoppedError;
await writeSealed('report.json', { protocol, finishedAt: new Date().toISOString(), complete,
  stoppedError: stoppedError ?? null, sourceDrift, pairs, attemptObservation: journal.summary(), records });
console.log(JSON.stringify({ status: complete ? 'finished' : 'incomplete', directory, records: records.length,
  pairsEqual: pairs.every(pair => pair.sameCommonBody), stoppedError: stoppedError ?? null }));
if (!complete) process.exitCode = 1;
