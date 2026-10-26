import { defineConfig } from '@playwright/test';
import { resolve } from 'node:path';
// Controlled transport, real browser/API/worker; test:isolated --browser supplies an owned database.
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const evidence = resolve(process.env.BANKPILOT_G9H_EVIDENCE_DIR ?? `docs/evidence/g9h-controlled-browser-${runId}`);
export default defineConfig({
  testDir: './tests/e2e',
  testMatch: ['g8h-*.spec.ts', 'g9c-bill-review.spec.ts', 'g9h-bill-domain.spec.ts'],
  fullyParallel: false, workers: 1, retries: 0, timeout: 120_000,
  outputDir: resolve(evidence, 'artifacts'),
  use: { browserName: 'chromium', viewport: { width: 1440, height: 1000 }, actionTimeout: 15_000,
    trace: 'on', screenshot: 'only-on-failure' },
  reporter: [['list'], ['json', { outputFile: resolve(evidence, 'report.json') }],
    ['html', { outputFolder: resolve(evidence, 'html'), open: 'never' }]],
});
