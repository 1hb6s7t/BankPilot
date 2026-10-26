import { createHash } from 'node:crypto';
import { mkdir, open, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { invokeStructured, normalizeBaseURL, providerFromEnv } from '../packages/agents/src/provider';
import { createModelAttemptJournal } from '../packages/agents/src/attempt-journal';
import { digest } from '../evals/ablation-score';
import { g9Dataset } from '../evals/g9-holdout-fixtures';
import type { ModelRun } from '../packages/contracts/src/index';

const sha = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
const fileHash = async (path: string) => sha(await readFile(path));
if (!process.argv.includes('--live')) throw new Error('Explicit --live required');
const config = providerFromEnv(); if (!config) throw new Error('Explicit model configuration required');
const frozenRoot = 'evals/baselines/g8n-final-2026-10-24T03-56-37-821Z';
const frozenManifest = JSON.parse(await readFile(`${frozenRoot}/source-manifest.json`, 'utf8')) as { files: { path: string; sha256: string }[] };
for (const file of frozenManifest.files.filter(file => file.path.startsWith('packages/'))) {
  if (await fileHash(`${frozenRoot}/source/${file.path}`) !== file.sha256) throw new Error('Frozen semantic dependency differs');
}
const original = await import(pathToFileURL(resolve(`${frozenRoot}/source/packages/agents/src/semantic-intent.ts`)).href);
const ids = ['g9-investment-05','g9-investment-06','g9-subscription-05','g9-goal-05','g9-goal-06','g9-transfer-04','g9-card-05'];
const schema = original.semanticIntentSchema as z.ZodType;
const tasks: { id: string; task: unknown; inputHash: string; taskHash: string }[] = [];
for (const id of ids) {
  const fixture = g9Dataset.cases.find(item => item.id === id)!;
  let task: unknown;
  await original.interpretSemanticIntent(structuredClone(fixture.input), { provider: { baseURL: 'https://synthetic.invalid/v1', model: 'capture-only' }, referenceDate: fixture.input.referenceDate,
    adapter: async (value: unknown) => { task = structuredClone(value); return { tasks: [] }; } });
  if (!task) throw new Error('Task capture failed');
  tasks.push({ id, task, inputHash: digest(fixture.input), taskHash: digest(task) });
}
const startedAt = new Date().toISOString(), runId = startedAt.replace(/[:.]/g,'-');
const directory = `evals/results/g9b-thinking-probe-${runId}`;
await mkdir(directory, { recursive: false });
const sources = ['scripts/probe-g9b-thinking.ts','packages/agents/src/provider.ts','packages/agents/src/attempt-journal.ts','evals/g9-holdout-fixtures.ts'];
const sourceHashes = Object.fromEntries(await Promise.all(sources.map(async path => [path,await fileHash(path)])));
const protocol = { version: 'g9b-thinking-single-factor-v1', startedAt, model: config.model, baseURLSha256: sha(normalizeBaseURL(config.baseURL)), outputMode: 'json_object', maxTokens: 4096, temperature: 0, maxAttempts: 1, maxStructureRepairs: 0, timeoutMs: 60000, caseCount: 7, plannedDispatches: 14,
  conditions: ['provider_default','thinking_disabled'], order: 'Interleaved per case; A/B for odd case indices, B/A for even. No retries or additional conditions.', sourceHashes, frozenSemanticRoot: frozenRoot, schemaHash: digest(z.toJSONSchema(schema)), tasks: tasks.map(({ task: _task, ...metadata }) => metadata), scope: 'Known synthetic semantic-output compatibility probe only; not business, bank execution, or privacy acceptance. Provider reports are observations, not proof of internal implementation.' };
await writeFile(`${directory}/protocol.json`,JSON.stringify(protocol,null,2));
await writeFile(`${directory}/tasks.json`,JSON.stringify({ schema: z.toJSONSchema(schema), tasks },null,2),{ mode:0o600 });
const journal = await createModelAttemptJournal(`${directory}/attempts.jsonl`);
const records: Record<string,unknown>[] = [], file = await open(`${directory}/records.jsonl`,'wx',0o600);
const nativeFetch = globalThis.fetch;
let activeRecord: { condition: string; taskHash: string; requestHash?: string; commonBodyHash?: string; bodyVerified?: boolean } | undefined;
globalThis.fetch = async (input, init) => {
  if (!activeRecord || String(input) !== `${normalizeBaseURL(config.baseURL)}/chat/completions` || typeof init?.body !== 'string') throw new Error('Unexpected probe request');
  const body = JSON.parse(init.body), { thinking, ...common } = body;
  if (body.max_tokens !== 4096 || body.model !== config.model || digest(JSON.parse(body.messages[1].content)) !== activeRecord.taskHash || (activeRecord.condition === 'provider_default' ? thinking !== undefined : JSON.stringify(thinking) !== '{"type":"disabled"}')) throw new Error('Probe request drift');
  activeRecord.requestHash = digest(body); activeRecord.commonBodyHash = digest(common); activeRecord.bodyVerified = true;
  await file.appendFile(JSON.stringify({ type:'request_body_verified', sequence:records.length+1, condition:activeRecord.condition, requestHash:activeRecord.requestHash, commonBodyHash:activeRecord.commonBodyHash })+'\n'); await file.sync();
  return nativeFetch(input, { ...init, redirect: 'error' });
};
try {
  for (const [index,item] of tasks.entries()) {
    for (const condition of (index % 2 === 0 ? ['provider_default','thinking_disabled'] : ['thinking_disabled','provider_default'])) {
      for (const [path,expected] of Object.entries(sourceHashes)) if (await fileHash(path) !== expected) throw new Error('Probe source drift');
      const runs: ModelRun[] = [], tick = performance.now(); let output: unknown, errorCode: string | undefined;
      activeRecord = { condition, taskHash:item.taskHash };
      try {
        output = await invokeStructured({ ...config, thinkingMode: condition === 'thinking_disabled' ? 'disabled' : undefined, outputMode:'json_object', maxOutputTokens:4096, temperature:0, maxAttempts:1,maxStructureRepairs:0,timeoutMs:60000,attemptObserver:journal.observerForCase(records.length+1) }, item.task, schema,'submit_semantic_intent', run => runs.push(run));
      } catch (error) { errorCode = error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message) ? error.message : 'PROBE_CALL_FAILED'; }
      const record = { sequence:records.length+1, id:item.id, ...activeRecord, schemaSuccess:output !== undefined, ...(output !== undefined ? { outputHash:digest(output), semantic:original.validateSemanticIntent(g9Dataset.cases.find(fixture => fixture.id === item.id)!.input,output) } : {}), errorCode, durationMs:Math.round(performance.now()-tick), modelRuns:runs };
      records.push(record); await file.appendFile(JSON.stringify({ type:'result',...record })+'\n'); await file.sync();
      console.log(JSON.stringify({ sequence:record.sequence,id:record.id,condition,schemaSuccess:record.schemaSuccess,errorCode,durationMs:record.durationMs }));
    }
  }
} finally { globalThis.fetch = nativeFetch; await journal.close(); await file.close(); }
const pairs = tasks.map(item => { const rows=records.filter(record=>record.id===item.id); return { id:item.id, sameCommonBody:rows.length===2 && rows[0].commonBodyHash===rows[1].commonBodyHash }; });
const sourceDrift = (await Promise.all(sources.map(async path => await fileHash(path)===sourceHashes[path] ? null : path))).filter(Boolean);
await writeFile(`${directory}/report.json`,JSON.stringify({ protocol, finishedAt:new Date().toISOString(), complete:records.length===14, sourceDrift, pairs, attemptObservation:journal.summary(), records },null,2),{mode:0o600});
console.log(JSON.stringify({ status:'finished',directory,records:records.length,sourceDrift,pairsEqual:pairs.every(pair=>pair.sameCommonBody) }));
