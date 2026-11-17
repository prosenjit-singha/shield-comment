import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';

/** `backend/drizzle/`, from both `src/db/` (tests) and `dist/db/` (Docker image). */
export const MIGRATIONS_FOLDER = join(import.meta.dirname, '..', '..', 'drizzle');

/**
 * Applies pending SQL migrations from `drizzle/` with Drizzle's runtime migrator, so the
 * production image doesn't need drizzle-kit. Applied migrations are tracked in
 * `drizzle.__drizzle_migrations` (same table `drizzle-kit migrate` uses).
 */
export async function runMigrations(
  connectionString: string,
  migrationsFolder = MIGRATIONS_FOLDER,
): Promise<void> {
  const pool = new Pool({ connectionString, max: 1 });
  try {
    await migrate(drizzle({ client: pool }), { migrationsFolder });
  } finally {
    await pool.end();
  }
}
