import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run = promisify(execFile);
const invoke = (args: string[]) => run(process.execPath, ['--import', 'tsx', 'scripts/test-isolated.ts', ...args], { timeout: 10_000 });
describe('isolated browser fixed command boundary', () => {
  it('selects only the fixed G9H controlled suite without connecting on dry run', async () => {
    const { stdout } = await invoke(['--browser', '--dry-run']);
    expect(JSON.parse(stdout)).toMatchObject({ dryRun: true, databaseCreated: false, databaseConnected: false,
      childCommand: 'pnpm exec playwright test --config playwright.g9h.config.ts' });
  });
  it.each([['--browser', '--browser', '--dry-run'], ['--browser', '--config', 'other.ts'], ['--browser', '--live']])('rejects unregistered command overrides %j', async (...args) => {
    await expect(invoke(args)).rejects.toThrow();
  });
});
