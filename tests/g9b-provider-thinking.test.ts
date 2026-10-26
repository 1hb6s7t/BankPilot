import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { invokeStructured, providerFromEnv, type OpenAICompatibleConfig } from '../packages/agents/src/provider';

afterEach(() => vi.unstubAllGlobals());
const config: OpenAICompatibleConfig = { baseURL: 'https://synthetic.invalid/v1', model: 'synthetic-model', outputMode: 'json_object', maxOutputTokens: 4096, maxAttempts: 1, maxStructureRepairs: 0, temperature: 0 };
describe('explicit provider thinking extension', () => {
  it.each([undefined, 'enabled', 'disabled'] as const)('sends only the explicit thinking control %s', async thinkingMode => {
    const bodies: Record<string,unknown>[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      bodies.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '{"ready":true}' } }] }), { status: 200 });
    }));
    expect(await invokeStructured({ ...config, thinkingMode }, { role: 'semantic_intent', request: 'synthetic request' }, z.object({ ready: z.boolean() }).strict(), 'submit_intent')).toEqual({ ready: true });
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({ model: config.model, max_tokens: 4096, temperature: 0, response_format: { type: 'json_object' } });
    if (thinkingMode === undefined) expect(bodies[0]).not.toHaveProperty('thinking');
    else expect(bodies[0]).toHaveProperty('thinking', { type: thinkingMode });
    expect(bodies[0]).not.toHaveProperty('reasoning_effort');
  });
  it('rejects arbitrary injected thinking fields before dispatch', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    await expect(invokeStructured({ ...config, thinkingMode: 'disabled;extra' as any }, {}, z.object({}), 'submit_intent')).rejects.toThrow('thinkingMode');
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(['enabled','disabled'] as const)('reads only explicit BankPilot %s config', value => {
    expect(providerFromEnv({ BANKPILOT_MODEL_BASE_URL: config.baseURL, BANKPILOT_MODEL_NAME: config.model, BANKPILOT_MODEL_THINKING: value })?.thinkingMode).toBe(value);
  });
  it('omits extension when unset and rejects unknown values', () => {
    const env = { BANKPILOT_MODEL_BASE_URL: config.baseURL, BANKPILOT_MODEL_NAME: config.model };
    expect(providerFromEnv(env)).not.toHaveProperty('thinkingMode');
    expect(() => providerFromEnv({ ...env, BANKPILOT_MODEL_THINKING: 'none' })).toThrow('BANKPILOT_MODEL_THINKING');
  });
});
