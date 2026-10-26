import { defineConfig } from '@playwright/test';
import { resolve } from 'node:path';

// Isolated loopback fixture with its own user, schema, UI and controlled model.
const evidence = resolve(process.env.BANKPILOT_G9B_EVIDENCE_DIR ?? 'test-results/g9b-funds-refresh');
export default defineConfig({
  testDir: './tests/e2e',
  testMatch: 'g9b-funds-refresh.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  outputDir: resolve(evidence, 'artifacts'),
  use: { browserName: 'chromium', viewport: { width: 1440, height: 1000 }, actionTimeout: 15_000, trace: 'on', screenshot: 'only-on-failure' },
  reporter: [['list'], ['json', { outputFile: resolve(evidence, 'report.json') }]],
});
