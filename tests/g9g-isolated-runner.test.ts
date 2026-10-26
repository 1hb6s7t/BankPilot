import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const script = 'scripts/test-isolated.ts';

describe('G9G isolated test runner pure safety probes', () => {
  it('passes only the minimal child environment and the three isolated database variables', async () => {
    const { stdout } = await run(process.execPath, ['--import', 'tsx', script, '--probe-child-environment'], {
      env: { ...process.env, AWS_SECRET_ACCESS_KEY: 'synthetic-canary', PGPASSWORD: 'synthetic-canary',
        GITHUB_PAT: 'synthetic-canary', BANKPILOT_MODEL_API_KEY: 'synthetic-canary',
        BANKPILOT_G9F_LIVE: '1', LC_API_KEY: 'synthetic-canary' }, timeout: 10_000 });
    expect(JSON.parse(stdout)).toMatchObject({ probe: 'child-environment', forbiddenKeys: [], leakedCanaries: [], databaseVariables: true });
    expect(stdout).not.toContain('synthetic-canary');
  });

  it('kills an owned grandchild that ignores TERM after its process-group leader exits', async () => {
    const { stdout } = await run(process.execPath, ['--import', 'tsx', script, '--probe-owned-group'], {
      env: { ...process.env }, timeout: 15_000 });
    expect(JSON.parse(stdout)).toMatchObject({ probe: 'owned-process-group', leaderExited: true,
      descendantWasRunning: true, termSent: true, killSent: true, groupGone: true });
  }, 20_000);
});
