import { defineConfig } from 'vitest/config';

// Real Postgres for e2e: a separate database on the docker compose Postgres (host port 5433).
const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  'postgresql://shield:shield@localhost:5433/shield_comment_test?schema=public';

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    globals: true,
    root: './',
    include: ['**/*.e2e-spec.ts'],
    exclude: ['**/node_modules/**', 'dist/**', 'legacy-auth/**'],
    globalSetup: ['./test/utils/global-setup.ts'],
    // Specs share one database, so run files one at a time.
    fileParallelism: false,
    env: {
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      DATABASE_URL: TEST_DATABASE_URL,
      // Locally the direct and pooled URLs are the same database.
      DIRECT_URL: process.env.TEST_DIRECT_URL ?? TEST_DATABASE_URL,
      // Redis is stubbed in e2e specs; this only satisfies env validation.
      REDIS_URL: 'redis://localhost:6379',
      BETTER_AUTH_SECRET: 'e2e-better-auth-secret-0123456789abcdef',
      BETTER_AUTH_URL: 'http://localhost:3000',
      TRUSTED_ORIGINS: 'http://localhost:5173,http://localhost:5174',
    },
  },
});
