-- SW-T2: baseline migration for the switch from Prisma to Drizzle.
-- The schema has no tables yet (Better Auth tables arrive in SW-T3). This file proves the
-- pipeline end to end: drizzle-kit writes the journal, and the runtime migrator
-- (src/db/migrate.ts, compose `migrate` service, e2e global setup) records it in
-- drizzle.__drizzle_migrations.
SELECT 1;
