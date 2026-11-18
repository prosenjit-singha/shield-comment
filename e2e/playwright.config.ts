import { defineConfig, devices } from '@playwright/test';
import { env } from './src/env.js';

/**
 * Gate suite against the compose stack (`docker compose up --build`): `npm test` from the host,
 * `npm run test:docker` in the compose `e2e` service. Settings: `src/env.ts`.
 * One worker: the specs share the run's seeded users.
 */
export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  outputDir: 'test-results',
  globalSetup: './src/global-setup.ts',
  globalTeardown: './src/global-teardown.ts',
  use: {
    baseURL: env.adminUrl,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    locale: 'en-US',
    timezoneId: 'Asia/Dhaka',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: {
          ...(env.chromiumPath ? { executablePath: env.chromiumPath } : {}),
          // In Docker, *.localhost would resolve to the e2e container itself: map the trusted
          // origins (admin.localhost / app.localhost) to the compose services instead.
          args: env.hostResolverRules ? [`--host-resolver-rules=${env.hostResolverRules}`] : [],
        },
      },
    },
  ],
});
