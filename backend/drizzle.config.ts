import 'dotenv/config';
import { defineConfig } from 'drizzle-kit';

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
