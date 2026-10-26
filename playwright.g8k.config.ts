import { defineConfig } from '@playwright/test';
import { resolve } from 'node:path';

// Reuses the isolated real local authentication/API/PostgreSQL/worker fixture.
// Archive and planning-state fixtures are explicit; model HTTP alone is controlled.
const evidence = resolve(process.env.BANKPILOT_G8K_EVIDENCE_DIR ?? 'test-results/g8k');
export default defineConfig({
  testDir: './tests/e2e', testMatch: ['g8k-*.spec.ts', 'g8j-history.spec.ts'],
  fullyParallel: false, workers: 1, retries: 0, timeout: 120_000,
  outputDir: resolve(evidence, 'artifacts'),
  use: { browserName: 'chromium', viewport: { width: 1440, height: 1000 }, actionTimeout: 15_000, trace: 'on', screenshot: 'only-on-failure' },
  reporter: [['list'], ['json', { outputFile: resolve(evidence, 'report.json') }], ['html', { outputFolder: resolve(evidence, 'html'), open: 'never' }]],
});
