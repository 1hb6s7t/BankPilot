import { defineConfig } from '@playwright/test';
import { resolve } from 'node:path';

// G8H creates its own loopback API, UI, user, database schema and real worker.
// It never loads .env, invokes a cloud provider or targets the user's running demo.
const evidence = resolve(process.env.BANKPILOT_G8H_EVIDENCE_DIR ?? 'test-results/g8h');
export default defineConfig({
  testDir: './tests/e2e',
  testMatch: 'g8h-*.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 120_000,
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
