import { ConfigService } from '@nestjs/config';
import { getDrizzleToken } from '@nestjs/drizzle';
import { AuthModule as BetterAuthModule } from '@thallesp/nestjs-better-auth';
import type { SecondaryStorage } from 'better-auth';
import { BillingModule } from '../billing/billing.module.js';
import { LimitService } from '../billing/limit.service.js';
import { SubscriptionService } from '../billing/subscription.service.js';
import {
  NodeEnv,
  type EnvironmentVariables,
} from '../config/env.validation.js';
import { DEFAULT_CLIENT_APP_URL } from '../admin/admin-impersonation.service.js';
import type { Database } from '../db/database.js';
import { EmailService } from '../email/email.service.js';
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
 * - `SubscriptionService` (from `BillingModule`): workspace links at sign-up / org create (PW-T3, no trial since PR-T3);
 *   `LimitService`: the `/organization/create` workspace limit (PW-T5) + invite seats (M7-T5);
 *   `EmailService` (global `EmailModule`): invitation (M7-T5), password reset and
 *   verification emails (M9-T5).
 * - Client IP (rate limit, session `ipAddress`): `X-Forwarded-For`, which `configureApp()` has
 *   already replaced with the resolved IP (src/common/http/client-ip.ts, M9-T1).
 */
export const AuthModule = BetterAuthModule.forRootAsync({
  imports: [BillingModule],
  inject: [
    getDrizzleToken(),
    ConfigService,
    AUTH_SECONDARY_STORAGE,
    SubscriptionService,
    LimitService,
    EmailService,
  ],
  useFactory: (
    db: Database,
    config: ConfigService<EnvironmentVariables, true>,
    secondaryStorage: SecondaryStorage,
    billing: SubscriptionService,
    limits: LimitService,
    email: EmailService,
  ) => ({
    auth: createBetterAuth(db, {
      secret: config.get('BETTER_AUTH_SECRET', { infer: true }),
      baseURL: config.get('BETTER_AUTH_URL', { infer: true }),
      trustedOrigins: splitList(config.get('TRUSTED_ORIGINS', { infer: true })),
      // Stateless; Better Auth isn't DI-managed, so it gets its own instance.
      passwords: new PasswordService(),
      secondaryStorage,
      rateLimit: config.get('NODE_ENV', { infer: true }) !== NodeEnv.Test,
      billing,
      limits,
      emails: {
        email,
        clientAppUrl:
          config.get('CLIENT_APP_URL', { infer: true }) ??
          DEFAULT_CLIENT_APP_URL,
      },
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
