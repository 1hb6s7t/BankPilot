import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { invokeStructured, providerFromEnv, type OpenAICompatibleConfig } from '../packages/agents/src/provider';

afterEach(() => vi.unstubAllGlobals());
const config: OpenAICompatibleConfig = {
  baseURL: 'https://synthetic.invalid/v1', model: 'synthetic-model', outputMode: 'json_object',
  maxOutputTokens: 4096, maxAttempts: 1, maxStructureRepairs: 0, temperature: 0,
};
const schema = z.object({ ready: z.boolean() }).strict();

describe('optional DeepSeek reasoning effort', () => {
  it.each([undefined, 'none', 'low', 'high', 'max'] as const)('uses only explicit reasoning effort %s', async reasoningEffort => {
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      bodies.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '{"ready":true}' } }] }), { status: 200 });
    }));
    const result = await invokeStructured({ ...config, reasoningEffort }, { role: 'semantic_intent', request: 'synthetic' }, schema, 'submit_intent');
    expect(result).toEqual({ ready: true });
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({ model: config.model, max_tokens: 4096, temperature: 0, response_format: { type: 'json_object' } });
    expect(bodies[0]).not.toHaveProperty('thinking');
    if (reasoningEffort === undefined) expect(bodies[0]).not.toHaveProperty('reasoning_effort');
    else expect(bodies[0]).toHaveProperty('reasoning_effort', reasoningEffort);
  });

  it('keeps the default and explicit request bodies equal after removing only the experiment field', async () => {
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      bodies.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '{"ready":true}' } }] }), { status: 200 });
    }));
    const task = { role: 'semantic_intent', request: 'same synthetic task' };
    await invokeStructured(config, task, schema, 'submit_intent');
    await invokeStructured({ ...config, reasoningEffort: 'none' }, task, schema, 'submit_intent');
    const { reasoning_effort: effort, ...experimentCommon } = bodies[1];
    expect(effort).toBe('none');
    expect(experimentCommon).toEqual(bodies[0]);
  });

  it.each(['', 'minimal', 'medium', 'xhigh', 'disabled;extra'])( 'rejects unsupported runtime value %s before dispatch', async value => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    await expect(invokeStructured({ ...config, reasoningEffort: value as any }, {}, schema, 'submit_intent')).rejects.toThrow('reasoningEffort');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('reads only the explicit BankPilot environment variable and leaves default absent', () => {
    const env = { BANKPILOT_MODEL_BASE_URL: config.baseURL, BANKPILOT_MODEL_NAME: config.model };
    expect(providerFromEnv(env)).not.toHaveProperty('reasoningEffort');
    expect(providerFromEnv({ ...env, BANKPILOT_MODEL_REASONING_EFFORT: 'none' })?.reasoningEffort).toBe('none');
    expect(providerFromEnv({ ...env, REASONING_EFFORT: 'none' })).not.toHaveProperty('reasoningEffort');
    expect(() => providerFromEnv({ ...env, BANKPILOT_MODEL_REASONING_EFFORT: '' })).toThrow('BANKPILOT_MODEL_REASONING_EFFORT');
    expect(() => providerFromEnv({ ...env, BANKPILOT_MODEL_REASONING_EFFORT: 'disabled' })).toThrow('BANKPILOT_MODEL_REASONING_EFFORT');
  });
});
