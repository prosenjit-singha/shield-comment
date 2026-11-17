import { relaxHappyEyeballsTimeout } from '../common/net/happy-eyeballs.js';
import { migrationDatabaseUrl } from './connection-url.js';
import { runMigrations } from './migrator.js';

/**
 * Entry point of the compose `migrate` service: `node dist/db/migrate.js`.
 * Locally: `npm run db:deploy` (after `npm run build`) or `npx drizzle-kit migrate`.
 * Uses `DIRECT_URL` (Neon direct, not the `-pooler` host), falling back to `DATABASE_URL`.
 */
relaxHappyEyeballsTimeout();
const url = migrationDatabaseUrl();
if (!url) {
  console.error('DIRECT_URL / DATABASE_URL is not set');
  process.exit(1);
}
try {
  await runMigrations(url);
  console.log(`Migrations applied (${new URL(url).host})`);
} catch (error) {
  console.error('Migration failed', error);
  process.exit(1);
}
