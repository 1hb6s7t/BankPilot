import { defineConfig } from '@playwright/test';
import { resolve } from 'node:path';

// Using this separate config is the explicit opt-in to the configured cloud provider.
// The synthetic bank, authentication, API, database schema and worker stay isolated.
process.loadEnvFile('.env');
process.env.BANKPILOT_G9F_LIVE = '1';
const evidence = resolve(process.env.BANKPILOT_G9F_LIVE_EVIDENCE_DIR ?? 'test-results/g9f-live');
export default defineConfig({
  testDir: './tests/e2e',
  testMatch: 'g9f-subscription-continuation.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 360_000,
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
