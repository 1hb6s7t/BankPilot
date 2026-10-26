import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run = promisify(execFile);
const invoke = (args: string[], env = process.env) => run(process.execPath, ['--import', 'tsx', 'scripts/test-isolated.ts', ...args], { timeout: 10_000, env });

describe('G9K explicit isolated live subscription boundary', () => {
  it('selects the fixed existing live spec only by explicit flag; dry run never connects', async () => {
    const { stdout } = await invoke(['--browser-live-subscription', '--dry-run']);
    expect(JSON.parse(stdout)).toMatchObject({ dryRun: true, databaseCreated: false, databaseConnected: false,
      cloudModelOptIn: true, childCommand: 'pnpm exec playwright test --config playwright.g9f-live.config.ts' });
  });
  it.each([[], ['--browser']])('does not select cloud from inherited flags in %j mode', async (...args) => {
    const { stdout } = await invoke([...args, '--dry-run'], { ...process.env, BANKPILOT_G9F_LIVE: '1', BANKPILOT_MODEL_API_KEY: 'synthetic-secret-only' });
    const result = JSON.parse(stdout);
    expect(result.cloudModelOptIn).toBe(false);
    expect(result.childCommand).not.toContain('g9f-live');
    expect(result.databaseConnected).toBe(false);
    expect(stdout).not.toContain('synthetic-secret-only');
  });
  it.each([
    ['--browser-live-subscription', '--browser'],
    ['--browser-live-subscription', '--browser-live-subscription'],
    ['--browser-live-subscription', '--config', 'other.ts'],
  ])('rejects mixed, duplicate and arbitrary commands %j', async (...args) => {
    await expect(invoke([...args, '--dry-run'])).rejects.toThrow();
  });
});
