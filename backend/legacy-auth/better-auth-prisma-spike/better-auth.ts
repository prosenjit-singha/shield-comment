import { betterAuth } from 'better-auth';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import type { PrismaClient } from '../generated/prisma/client.js';

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
 * SW-T2 spike: core tables + email/password only. SW-T3 adds the `organization` and `admin`
 * plugins, argon2id `password.hash/verify`, Redis `secondaryStorage`, `cookieCache` and rate limits.
 */
export function createBetterAuth(prisma: PrismaClient, settings: BetterAuthSettings) {
  return betterAuth({
    appName: 'ShieldComment BD',
    basePath: '/api/auth',
    secret: settings.secret,
    baseURL: settings.baseURL,
    trustedOrigins: settings.trustedOrigins,
    database: prismaAdapter(prisma, { provider: 'postgresql' }),
    emailAndPassword: { enabled: true, minPasswordLength: 8 },
    advanced: {
      // Let Prisma's `@default(uuid(7))` make the ids, so Better Auth rows match our UUIDv7 convention.
      database: { generateId: false },
    },
  });
}

export type BetterAuth = ReturnType<typeof createBetterAuth>;
