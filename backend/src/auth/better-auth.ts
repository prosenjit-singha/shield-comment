import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { uuidv7 } from 'uuidv7';
import type { Database } from '../db/database.js';
import * as schema from '../db/schema/index.js';

export interface BetterAuthSettings {
  /** `BETTER_AUTH_SECRET`: signs session cookies. At least 32 chars. */
  secret: string;
  /** `BETTER_AUTH_URL`: public URL of this backend (no `/api/auth`). */
  baseURL: string;
  /** `TRUSTED_ORIGINS`: app origins allowed to call `/api/auth/*` (CSRF / redirect checks). */
  trustedOrigins: string[];
}

/**
 * Better Auth server instance, mounted at `/api/auth/*` by `@thallesp/nestjs-better-auth`.
 *
 * SW-T3 spike: core tables + email/password only. SW-T4 adds the `organization` and `admin`
 * plugins, argon2id `password.hash/verify`, Redis `secondaryStorage`, `cookieCache` and rate limits.
 */
export function createBetterAuth(db: Database, settings: BetterAuthSettings) {
  return betterAuth({
    appName: 'ShieldComment BD',
    basePath: '/api/auth',
    secret: settings.secret,
    baseURL: settings.baseURL,
    trustedOrigins: settings.trustedOrigins,
    // `usePlural` maps Better Auth's `user` model to our `users` table, etc.
    database: drizzleAdapter(db, { provider: 'pg', usePlural: true, schema }),
    emailAndPassword: { enabled: true, minPasswordLength: 8 },
    advanced: {
      // Same UUIDv7 ids as every other table (src/db/schema/columns.ts).
      database: { generateId: () => uuidv7() },
    },
  });
}

export type BetterAuth = ReturnType<typeof createBetterAuth>;
