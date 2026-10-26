import { defineConfig } from '@playwright/test';

// Deliberately does not load the workspace .env or launch the existing demo.
const output = process.env.BANKPILOT_G8I_EVIDENCE_DIR ?? 'test-results/g8i-clean-delivery';
export default defineConfig({
  testDir: './tests/e2e', testMatch: 'g8i-clean-delivery.spec.ts',
  fullyParallel: false, workers: 1, retries: 0, timeout: 120_000,
  outputDir: `${output}/artifacts`,
  reporter: [['list'], ['json', { outputFile: `${output}/report.json` }], ['html', { outputFolder: `${output}/html`, open: 'never' }]],
  use: { browserName: 'chromium', viewport: { width: 1440, height: 1000 }, actionTimeout: 15_000, screenshot: 'only-on-failure', trace: 'off' },
});
