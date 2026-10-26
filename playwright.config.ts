import { defineConfig } from '@playwright/test';
process.loadEnvFile('.env');
export default defineConfig({
  testDir: './tests/e2e', fullyParallel: false, workers: 1, timeout: 60_000,
  // Requires a separate exported instance and an actual stop/restart between runs.
  testIgnore: ['**/g8i-clean-delivery.spec.ts', '**/g8n-live-*.spec.ts'],
  use: { baseURL: 'http://localhost:5178', viewport: { width: 1440, height: 1000 }, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  reporter: [['list'], ['html', { open: 'never' }]],
});
