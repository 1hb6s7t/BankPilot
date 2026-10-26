import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { G9I_DIAGNOSTIC_VERSION, G9I_MARKER, runG9IDiagnosticCli, runG9IProviderDiagnostic } from '../scripts/diagnose-provider-contract';

const directories: string[] = [];
const temp = async () => { const path = await mkdtemp(join(tmpdir(), 'g9i-diagnostic-')); directories.push(path); return path; };
const provider = { baseURL: 'https://diagnostic.invalid/v1', model: 'synthetic-provider', outputMode: 'json_object' as const };
const completion = (content: string, status = 200) => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: {
  content, reasoning_content: 'HIDDEN_REASONING_CANARY_MUST_NOT_APPEAR' } }], usage: {
  prompt_tokens: 25, completion_tokens: 13, completion_tokens_details: { reasoning_tokens: 7 },
} }), { status, headers: { 'Content-Type': 'application/json' } });
const events = async (directory: string) => (await readFile(join(directory, 'events.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

describe('G9I provider contract diagnostic', () => {
  it('defaults to offline fixed synthetic production invokeStructured requests with durable repair feedback', async () => {
    const originalFetch = globalThis.fetch;
    const root = await temp();
    const final = await runG9IProviderDiagnostic({ mode: 'offline', outputRoot: root });
    expect(globalThis.fetch).toBe(originalFetch);
    expect(final).toMatchObject({ version: G9I_DIAGNOSTIC_VERSION, mode: 'offline', httpCalls: 4,
      systemContractPassed: true, userControlPassed: true, systemRepairFeedback: 'changed_after_failure', validEvidence: true });
    expect(final.firstAttemptPassed).toEqual({ system_only: false, user_control: false });
    const lines = await events(final.directory), requests = lines.filter(line => line.type === 'request');
    expect(requests).toHaveLength(4);
    expect(requests.map(line => line.sequence)).toEqual([1, 2, 3, 4]);
    expect(requests.every(line => line.components.system.hasRequiredJsonSchema && line.components.system.hasMarker)).toBe(true);
    expect(requests.slice(0, 2).every(line => line.components.user.hasMarker === false)).toBe(true);
    expect(requests.slice(2).every(line => line.components.user.hasMarker === true)).toBe(true);
    expect(requests[0].components.system.hasRepairFeedback).toBe(false);
    expect(requests[1].components.system.hasRepairFeedback).toBe(true);
    expect(requests[0].bodySha256).not.toBe(requests[1].bodySha256);
    expect(lines.filter(line => line.type === 'attempt_start')).toHaveLength(4);
    expect(lines.filter(line => line.type === 'attempt_end')).toHaveLength(4);
    expect((await readFile(join(final.directory, 'manifest.json'), 'utf8'))).toContain(G9I_DIAGNOSTIC_VERSION);
    expect((await readFile(join(final.directory, 'final.json'), 'utf8'))).toContain('"systemContractPassed":true');
  });
  it('reports system failure separately from a successful user control and restores fetch', async () => {
    const originalFetch = globalThis.fetch;
    const root = await temp();
    const transport = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const task = JSON.parse(JSON.parse(String(init?.body)).messages[1].content);
      return completion(task.scenario === 'system_only' ? 'I cannot provide that diagnostic.' : JSON.stringify({ probe: G9I_MARKER }));
    }) as typeof fetch;
    const final = await runG9IProviderDiagnostic({ mode: 'live', outputRoot: root, provider, transport });
    expect(globalThis.fetch).toBe(originalFetch);
    expect(final).toMatchObject({ httpCalls: 3, systemContractPassed: false, userControlPassed: true,
      systemRepairFeedback: 'changed_after_failure', validEvidence: true });
    expect(final.outcomes.system_only.errorCode).toBe('MODEL_OUTPUT_JSON_INVALID');
    const text = await readFile(join(final.directory, 'events.jsonl'), 'utf8');
    expect(text).not.toContain('HIDDEN_REASONING_CANARY_MUST_NOT_APPEAR');
    expect(text).not.toContain('Authorization');
    expect(text).toContain('I cannot provide that diagnostic.');
    expect(transport).toHaveBeenCalledTimes(3);
  });
  it('bounds failed HTTP transports at four calls and never records raw thrown errors', async () => {
    const root = await temp(), secret = 'SECRET_TRANSPORT_EXPLANATION';
    const transport = vi.fn(async () => { throw new Error(secret); }) as typeof fetch;
    const final = await runG9IProviderDiagnostic({ mode: 'live', outputRoot: root, provider, transport });
    expect(final).toMatchObject({ httpCalls: 4, systemContractPassed: false, userControlPassed: false, validEvidence: true });
    expect(transport).toHaveBeenCalledTimes(4);
    const text = await readFile(join(final.directory, 'events.jsonl'), 'utf8');
    expect(text).not.toContain(secret);
    expect(text).toContain('G9I_TRANSPORT_ERROR');
  });
  it('omits oversized visible output wholesale and never records hidden reasoning', async () => {
    const root = await temp(), giant = 'x'.repeat(66_000);
    const transport = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const task = JSON.parse(JSON.parse(String(init?.body)).messages[1].content);
      return completion(task.scenario === 'system_only' ? giant : JSON.stringify({ probe: G9I_MARKER }));
    }) as typeof fetch;
    const final = await runG9IProviderDiagnostic({ mode: 'live', outputRoot: root, provider, transport });
    const lines = await events(final.directory), oversized = lines.find(line => line.type === 'response' && line.scenario === 'system_only');
    expect(oversized).toMatchObject({ outputOmitted: 'size_limit', outputLength: giant.length });
    expect(oversized.outputText).toBeUndefined();
    const text = await readFile(join(final.directory, 'events.jsonl'), 'utf8');
    expect(text).not.toContain(giant); expect(text).not.toContain('HIDDEN_REASONING_CANARY_MUST_NOT_APPEAR');
  });
  it('does not persist a credential echoed in the visible provider content', async () => {
    const root = await temp(), apiKey = 'G9I_TEST_PRIVATE_KEY_9426';
    const transport = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const task = JSON.parse(JSON.parse(String(init?.body)).messages[1].content);
      return completion(task.scenario === 'system_only' ? `{"error":"${apiKey}"}` : JSON.stringify({ probe: G9I_MARKER }));
    }) as typeof fetch;
    const final = await runG9IProviderDiagnostic({ mode: 'live', outputRoot: root, provider: { ...provider, apiKey }, transport });
    const lines = await events(final.directory), redacted = lines.find(line => line.type === 'response' && line.scenario === 'system_only');
    expect(redacted).toMatchObject({ outputOmitted: 'credential_echo' });
    expect(redacted.outputText).toBeUndefined();
    const all = (await Promise.all(['events.jsonl', 'manifest.json', 'final.json'].map(name => readFile(join(final.directory, name), 'utf8')))).join('\n');
    expect(all).not.toContain(apiKey); expect(all).not.toContain('Authorization');
  });
  it('rejects provider model or URL that would expose the configured credential in evidence', async () => {
    const root = await temp(), apiKey = 'G9I_TEST_PRIVATE_KEY_9426';
    await expect(runG9IProviderDiagnostic({ mode: 'live', outputRoot: root,
      provider: { ...provider, model: `synthetic-${apiKey}`, apiKey }, transport: vi.fn() })).rejects.toThrow('G9I_PROVIDER_CONFIG_CREDENTIAL_ECHO');
    await expect(runG9IProviderDiagnostic({ mode: 'live', outputRoot: root,
      provider: { ...provider, baseURL: `https://diagnostic.invalid/${apiKey}/v1`, apiKey }, transport: vi.fn() })).rejects.toThrow('G9I_PROVIDER_CONFIG_CREDENTIAL_ECHO');
  });
  it('rejects extra CLI switches before any dispatch and uses a unique directory per run', async () => {
    await expect(runG9IDiagnosticCli(['--live', '--dry-run'])).rejects.toThrow('G9I_OPTION_INVALID');
    await expect(runG9IDiagnosticCli(['--out', '/tmp/alternate'])).rejects.toThrow('G9I_OPTION_INVALID');
    await expect(runG9IProviderDiagnostic({ mode: 'offline', outputRoot: await temp(), transport: vi.fn() })).rejects.toThrow('G9I_OFFLINE_TRANSPORT_FORBIDDEN');
    const root = await temp();
    const first = await runG9IProviderDiagnostic({ mode: 'offline', outputRoot: root });
    const second = await runG9IProviderDiagnostic({ mode: 'offline', outputRoot: root });
    expect(first.directory).not.toBe(second.directory);
    expect(first.httpCalls).toBe(4); expect(second.httpCalls).toBe(4);
  });
});
