import { existsSync } from 'node:fs';
import { setDefaultAutoSelectFamilyAttemptTimeout } from 'node:net';
import { defineConfig } from 'drizzle-kit';

// drizzle-kit is dev-only, so the development env files, same order as the npm scripts:
// .env → .env.development → .env.local, later wins, real env vars always win. loadEnvFile never
// overwrites a set variable, so the winner loads first.
for (const file of ['.env.local', '.env.development', '.env']) {
  if (existsSync(file)) process.loadEnvFile(file);
}

// Same as src/common/net/happy-eyeballs.ts: a slow first connect to Neon can exceed Node's 250 ms default.
setDefaultAutoSelectFamilyAttemptTimeout(1000);

// Generate: `npm run db:generate -- --name <name>` · apply locally: `npm run db:migrate`.
// `casing` must match the runtime `drizzle()` call in src/db/db.module.ts.
// Migrations use Neon's direct `DIRECT_URL` (pooled `DATABASE_URL` locally); same rule as src/db/connection-url.ts.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema/index.ts',
  out: './drizzle',
  casing: 'snake_case',
  dbCredentials: {
    url: process.env.DIRECT_URL?.trim() || process.env.DATABASE_URL || '',
  },
  migrations: { schema: 'drizzle', table: '__drizzle_migrations' },
  strict: true,
  verbose: true,
});
