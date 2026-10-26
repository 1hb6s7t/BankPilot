import { defineConfig } from '@playwright/test';
import { resolve } from 'node:path';

// Each test creates a loopback UI/API, real local Postgres schema, auth user and worker.
// Only the model completion HTTP response is controlled; no cloud provider is configured.
process.env.BANKPILOT_G9F_LIVE = '0';
const evidence = resolve(process.env.BANKPILOT_G9F_EVIDENCE_DIR ?? 'test-results/g9f');
export default defineConfig({
  testDir: './tests/e2e',
  testMatch: 'g9f-subscription-continuation.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 150_000,
  outputDir: resolve(evidence, 'artifacts'),
  use: {
    browserName: 'chromium',
    viewport: { width: 1440, height: 1000 },
    actionTimeout: 15_000,
    trace: 'on',
    screenshot: 'only-on-failure',
  },
  reporter: [
    ['list'],
    ['json', { outputFile: resolve(evidence, 'report.json') }],
    ['html', { outputFolder: resolve(evidence, 'html'), open: 'never' }],
  ],
});
