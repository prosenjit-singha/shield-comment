import { ConfigService } from '@nestjs/config';
import { getDrizzleToken } from '@nestjs/drizzle';
import { AuthModule as BetterAuthModule } from '@thallesp/nestjs-better-auth';
import type { EnvironmentVariables } from '../config/env.validation.js';
import type { Database } from '../db/database.js';
import { createBetterAuth } from './better-auth.js';

/**
 * Better Auth on NestJS: the integration's handler owns all of `/api/auth/*`.
 * Needs `bodyParser: false` in `NestFactory.create` / `createNestApplication`; the library
 * re-adds JSON + urlencoded parsing for every other route.
 *
 * - CORS stays in `configureApp()` (`disableTrustedOriginsCors`).
 * - No global guard yet: SW-T4 turns it on together with `@Public()` for open routes.
 *   Until then, protect a route with `@UseGuards(AuthGuard)` from the integration.
 */
export const AuthModule = BetterAuthModule.forRootAsync({
  inject: [getDrizzleToken(), ConfigService],
  useFactory: (db: Database, config: ConfigService<EnvironmentVariables, true>) => ({
    auth: createBetterAuth(db, {
      secret: config.get('BETTER_AUTH_SECRET', { infer: true }),
      baseURL: config.get('BETTER_AUTH_URL', { infer: true }),
      trustedOrigins: splitList(config.get('TRUSTED_ORIGINS', { infer: true })),
    }),
    disableTrustedOriginsCors: true,
  }),
  disableGlobalAuthGuard: true,
});

function splitList(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
}
