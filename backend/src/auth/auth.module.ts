import { ConfigService } from '@nestjs/config';
import { getDrizzleToken } from '@nestjs/drizzle';
import { AuthModule as BetterAuthModule } from '@thallesp/nestjs-better-auth';
import type { SecondaryStorage } from 'better-auth';
import {
  NodeEnv,
  type EnvironmentVariables,
} from '../config/env.validation.js';
import type { Database } from '../db/database.js';
import { AUTH_SECONDARY_STORAGE } from '../redis/redis-secondary-storage.js';
import { createBetterAuth } from './better-auth.js';
import { PasswordService } from './password.service.js';

/**
 * Better Auth on NestJS: the integration's handler owns all of `/api/auth/*`.
 * Needs `bodyParser: false` in `NestFactory.create` / `createNestApplication`; the library
 * re-adds JSON + urlencoded parsing for every other route.
 *
 * - CORS stays in `configureApp()` (`disableTrustedOriginsCors`).
 * - The integration's `AuthGuard` is the global guard: every route needs a session unless it
 *   (or its controller) has `@Public()` (src/auth/decorators/public.decorator.ts).
 * - `AUTH_SECONDARY_STORAGE` comes from the global RedisModule.
 */
export const AuthModule = BetterAuthModule.forRootAsync({
  inject: [getDrizzleToken(), ConfigService, AUTH_SECONDARY_STORAGE],
  useFactory: (
    db: Database,
    config: ConfigService<EnvironmentVariables, true>,
    secondaryStorage: SecondaryStorage,
  ) => ({
    auth: createBetterAuth(db, {
      secret: config.get('BETTER_AUTH_SECRET', { infer: true }),
      baseURL: config.get('BETTER_AUTH_URL', { infer: true }),
      trustedOrigins: splitList(config.get('TRUSTED_ORIGINS', { infer: true })),
      // Stateless; Better Auth isn't DI-managed, so it gets its own instance.
      passwords: new PasswordService(),
      secondaryStorage,
      rateLimit: config.get('NODE_ENV', { infer: true }) !== NodeEnv.Test,
    }),
    disableTrustedOriginsCors: true,
  }),
});

function splitList(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
}
