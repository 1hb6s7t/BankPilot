import { defineConfig } from '@playwright/test';
import { resolve } from 'node:path';

// Isolated controlled model, real loopback API, PostgreSQL and browser. Never loads .env.
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const evidence = resolve(process.env.BANKPILOT_G9C_EVIDENCE_DIR ?? `docs/evidence/g9c-bill-review-browser-${runId}`);
export default defineConfig({
  testDir: './tests/e2e', testMatch: 'g9c-bill-review.spec.ts',
  fullyParallel: false, workers: 1, retries: 0, timeout: 120_000,
  outputDir: resolve(evidence, 'artifacts'),
  use: { browserName: 'chromium', viewport: { width: 1440, height: 1000 }, actionTimeout: 15_000,
    trace: 'on', screenshot: 'only-on-failure' },
  reporter: [['list'], ['json', { outputFile: resolve(evidence, 'report.json') }],
    ['html', { outputFolder: resolve(evidence, 'html'), open: 'never' }]],
});
