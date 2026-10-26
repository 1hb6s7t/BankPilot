import { defineConfig } from '@playwright/test';
import { resolve } from 'node:path';
const evidence = resolve(process.env.BANKPILOT_G8M_EVIDENCE_DIR ?? 'test-results/g8m');
export default defineConfig({
  testDir: './tests/e2e', testMatch: ['g8m-*.spec.ts'],
  fullyParallel: false, workers: 1, retries: 0, timeout: 120_000,
  outputDir: resolve(evidence, 'artifacts'),
  use: { browserName: 'chromium', viewport: { width: 1440, height: 1000 }, actionTimeout: 15_000, trace: 'on', screenshot: 'only-on-failure' },
  reporter: [['list'], ['json', { outputFile: resolve(evidence, 'report.json') }], ['html', { outputFolder: resolve(evidence, 'html'), open: 'never' }]],
});
