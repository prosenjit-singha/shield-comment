/**
 * URL for schema migrations: Neon's **direct** `DIRECT_URL` when set, else `DATABASE_URL`
 * (local Docker Postgres, where both are the same). The app itself always uses the pooled
 * `DATABASE_URL` (see db.module.ts). `drizzle.config.ts` repeats this rule inline because
 * drizzle-kit loads it outside the ESM build.
 */
export function migrationDatabaseUrl(
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  return env.DIRECT_URL?.trim() || env.DATABASE_URL?.trim() || undefined;
}
