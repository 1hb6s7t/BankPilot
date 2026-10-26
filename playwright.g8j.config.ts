import { defineConfig } from '@playwright/test';
import { resolve } from 'node:path';

// Reuse G8H's real auth/API/worker fixture with its unique local schema.
// Tests explicitly seed archive messages; only model HTTP is controlled.
const evidence = resolve(process.env.BANKPILOT_G8J_EVIDENCE_DIR ?? 'test-results/g8j');
export default defineConfig({
  testDir: './tests/e2e', testMatch: 'g8j-*.spec.ts', fullyParallel: false,
  workers: 1, retries: 0, timeout: 120_000, outputDir: resolve(evidence, 'artifacts'),
  use: { browserName: 'chromium', viewport: { width: 1440, height: 1000 }, actionTimeout: 15_000, trace: 'on', screenshot: 'only-on-failure' },
  reporter: [['list'], ['json', { outputFile: resolve(evidence, 'report.json') }], ['html', { outputFolder: resolve(evidence, 'html'), open: 'never' }]],
});
