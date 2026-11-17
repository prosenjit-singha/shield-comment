import { runMigrations } from '../../src/db/migrator.js';

/** Applies all Drizzle migrations to the e2e database once before any spec runs. */
export default async function setup(): Promise<void> {
  // Same precedence as the migrate script: DIRECT_URL, else the runtime URL.
  const url =
    process.env.TEST_DIRECT_URL ??
    process.env.TEST_DATABASE_URL ??
    'postgresql://shield:shield@localhost:5433/shield_comment_test?schema=public';
  await runMigrations(url);
}
