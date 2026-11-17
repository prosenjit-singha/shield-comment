import { runMigrations } from './migrator.js';

/**
 * Entry point of the compose `migrate` service: `node dist/db/migrate.js`.
 * Locally: `npm run db:deploy` (after `npm run build`) or `npx drizzle-kit migrate`.
 */
const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set');
  process.exit(1);
}
try {
  await runMigrations(url);
  console.log('Migrations applied');
} catch (error) {
  console.error('Migration failed', error);
  process.exit(1);
}
