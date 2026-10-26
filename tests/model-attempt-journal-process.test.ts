import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';

const providerModule = new URL('../packages/agents/src/provider.ts', import.meta.url).href;
const journalModule = new URL('../packages/agents/src/attempt-journal.ts', import.meta.url).href;
const children = new Set<ChildProcess>();
const servers = new Set<Server>();
const directories: string[] = [];
type Exit = { code: number | null; signal: NodeJS.Signals | null };
async function waitForExit(child: ChildProcess): Promise<Exit> {
  if (child.exitCode !== null || child.signalCode !== null) return { code: child.exitCode, signal: child.signalCode };
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.removeListener('exit', finish); reject(new Error('Attempt-journal child did not exit')); }, 15_000);
    const finish = (code: number | null, signal: NodeJS.Signals | null) => { clearTimeout(timer); resolve({ code, signal }); };
    child.once('exit', finish); child.once('error', reject);
  });
}
async function start(mode: 'hang' | 'http-failure' | 'throw-after-success') {
  const directory = await mkdtemp(join(tmpdir(), 'bp-attempt-process-')); directories.push(directory);
  const path = join(directory, 'attempts.jsonl');
  let received!: () => void;
  const receipt = new Promise<void>(resolve => { received = resolve; });
  const server = createServer((request, response) => {
    request.resume();
    received();
    if (mode === 'hang') return;
    response.writeHead(mode === 'http-failure' ? 503 : 200, { 'content-type': 'application/json' });
    response.end(mode === 'http-failure' ? 'private-http-error-body' : JSON.stringify({ usage: { prompt_tokens: 9, completion_tokens: 4 }, choices: [{ finish_reason: 'stop', message: { content: '{"ok":true}' } }] }));
  });
  servers.add(server);
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Mock HTTP server did not bind');
  // No test-only provider implementation: the actual provider and durable writer run in a real Node process.
  const source = `
    import { z } from 'zod';
    import { invokeStructured } from ${JSON.stringify(providerModule)};
    import { createModelAttemptJournal } from ${JSON.stringify(journalModule)};
    const config = JSON.parse(process.argv[1]);
    const journal = await createModelAttemptJournal(config.path);
    await invokeStructured({ baseURL: config.baseURL, model: 'synthetic-local-only', outputMode: 'json_object',
      maxAttempts: 1, maxOutputTokens: 2048, timeoutMs: 120000, attemptObserver: journal.observerForCase(1) },
      { role: 'semantic_intent', text: 'private-process-user-content' }, z.object({ ok: z.literal(true) }), 'submit');
    throw new Error('TOP_LEVEL_FAILURE_AFTER_COMPLETED_ATTEMPT');
  `;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', source,
    JSON.stringify({ path, baseURL: `http://127.0.0.1:${address.port}/v1` })], { cwd: process.cwd(), stdio: ['ignore', 'ignore', 'pipe'] });
  child.stderr?.resume(); children.add(child);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([receipt, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Child did not send its actual HTTP request')), 15_000); })]);
  } finally { clearTimeout(timer); }
  return { child, path, lines: async () => (await readFile(path, 'utf8')).trim().split('\n').map(line => JSON.parse(line)) };
}
afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) { const exit = waitForExit(child); child.kill('SIGKILL'); await exit; }
  }
  children.clear();
  for (const server of servers) { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  servers.clear();
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

it('preserves the fsynced start across real SIGKILL while HTTP is in flight, without fabricating an end', async () => {
  const { child, lines, path } = await start('hang');
  const before = await lines();
  expect(before.map(row => row.type)).toEqual(['journal_start', 'attempt_start']);
  expect(before[1]).toMatchObject({ dispatch: 'pending', role: 'semantic_intent', attempt: 1, requestMaxOutputTokens: 2048 });
  const exited = waitForExit(child);
  expect(child.kill('SIGKILL')).toBe(true);
  expect(await exited).toEqual({ code: null, signal: 'SIGKILL' });
  expect(await lines()).toEqual(before);
  const raw = await readFile(path, 'utf8');
  expect(raw).not.toContain('attempt_end'); expect(raw).not.toContain('private-process-user-content'); expect(raw).not.toContain('http://');
}, 30_000);

it.each(['http-failure', 'throw-after-success'] as const)('retains completed attempt records when the process has a top-level %s and no aggregate case result', async mode => {
  const { child, lines, path } = await start(mode);
  expect(await waitForExit(child)).toEqual({ code: 1, signal: null });
  const rows = await lines();
  expect(rows.map(row => row.type)).toEqual(['journal_start', 'attempt_start', 'attempt_end']);
  expect(rows[2]).toMatchObject({ attemptId: rows[1].attemptId, invocationId: rows[1].invocationId, requestStarted: true,
    status: mode === 'http-failure' ? 'failed' : 'success', httpStatus: mode === 'http-failure' ? 503 : 200,
    ...(mode === 'http-failure' ? { errorCode: 'MODEL_HTTP_503' } : { inputTokens: 9, outputTokens: 4 }) });
  expect(await readFile(path, 'utf8')).not.toContain('private-process-user-content');
  expect(await readFile(path, 'utf8')).not.toContain('private-http-error-body');
}, 30_000);
