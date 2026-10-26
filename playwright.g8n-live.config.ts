import { defineConfig } from '@playwright/test';
import { resolve } from 'node:path';
// This explicit command opts into the user's configured cloud model. The fixture
// still owns an isolated local bank, account, API, database schema and worker.
process.loadEnvFile('.env');
const evidence = resolve(process.env.BANKPILOT_G8N_LIVE_EVIDENCE_DIR ?? 'test-results/g8n-live');
export default defineConfig({
  testDir: './tests/e2e', testMatch: 'g8n-live-*.spec.ts', fullyParallel: false, workers: 1, retries: 0, timeout: 240_000,
  outputDir: resolve(evidence, 'artifacts'),
  use: { browserName: 'chromium', viewport: { width: 1440, height: 1000 }, actionTimeout: 15_000, trace: 'on', screenshot: 'only-on-failure' },
  reporter: [['list'], ['json', { outputFile: resolve(evidence, 'report.json') }], ['html', { outputFolder: resolve(evidence, 'html'), open: 'never' }]],
});
