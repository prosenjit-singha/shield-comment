import { APIError, betterAuth, type SecondaryStorage } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { createAuthMiddleware, getSessionFromCtx } from 'better-auth/api';
import { admin, organization } from 'better-auth/plugins';
import { uuidv7 } from 'uuidv7';
import type { LimitService } from '../billing/limit.service.js';
import type { Database } from '../db/database.js';
import * as schema from '../db/schema/index.js';
import { CLIENT_IP_HEADER } from './client-ip.js';
import {
  firstWorkspaceName,
  parseWorkspaceName,
  resolveActiveWorkspace,
  type SessionBilling,
  WORKSPACE_NAME_MAX,
} from './first-workspace.js';
import { impersonationExchange } from './impersonation-exchange.plugin.js';
import type { PasswordService } from './password.service.js';
import { assertWorkspaceCreateAllowed } from './workspace-limit.js';
import {
  platformAc,
  platformRoles,
  workspaceAc,
  workspaceRoles,
} from './permissions.js';

export interface BetterAuthSettings {
  /** `BETTER_AUTH_SECRET`: signs session cookies. At least 32 chars. */
  secret: string;
  /** `BETTER_AUTH_URL`: public URL of this backend (no `/api/auth`). */
  baseURL: string;
  /** `TRUSTED_ORIGINS`: app origins allowed to call `/api/auth/*` (CSRF / redirect checks). */
  trustedOrigins: string[];
  /** argon2id hashing (`@node-rs/argon2`) for `emailAndPassword.password`. */
  passwords: PasswordService;
  /** Redis in the app (src/redis/redis-secondary-storage.ts), in-memory in e2e. */
  secondaryStorage: SecondaryStorage;
  /** Off in e2e: every supertest request shares one "no IP" bucket. */
  rateLimit: boolean;
  /**
   * Billing accounts (PW-T3; no trial since PR-T3): sign-up / session-create setup and the
   * `/organization/create` workspace link (`SubscriptionService`).
   */
  billing: AuthBilling;
  /** Account-pooled workspace limit for `/organization/create` (PW-T5, `LimitService`). */
  limits: AuthLimits;
}

/** The `SubscriptionService` calls Better Auth's hooks make (PW-T3). */
export type AuthBilling = SessionBilling;

/** The `LimitService` call the `/organization/create` before-hook makes (PW-T5). */
export type AuthLimits = Pick<LimitService, 'canCreateWorkspace'>;

const SIGN_UP_PATH = '/sign-up/email';

/**
 * Better Auth's built-in impersonation is blocked (user decision, M1-T3): the audited token flow
 * (`POST /api/admin/clients/:workspaceId/impersonate` → `POST /api/auth/impersonate-exchange`)
 * is the only way in. `disabledPaths` answers 404 before the endpoint runs.
 */
export const DISABLED_AUTH_PATHS = [
  '/admin/impersonate-user',
  '/admin/stop-impersonating',
];

/**
 * The owner's account routes (user decision, M1-GATE): an impersonator acts inside the workspace but
 * never changes the owner's credentials, profile, linked accounts or other sessions. `get-session`
 * and `sign-out` stay open. `/set-password` is server-only in Better Auth 1.7 (no HTTP route); it is
 * listed in case a later version exposes it.
 */
export const IMPERSONATION_BLOCKED_ACCOUNT_PATHS: ReadonlySet<string> = new Set(
  [
    '/change-password',
    '/set-password',
    '/verify-password',
    '/change-email',
    '/update-user',
    '/delete-user',
    '/delete-user/callback',
    '/revoke-session',
    '/revoke-sessions',
    '/revoke-other-sessions',
    '/link-social',
    '/unlink-account',
    '/get-access-token',
    '/refresh-token',
  ],
);

/**
 * Paths an impersonated session may not call (403): the admin plugin (an owner may be a super admin),
 * anything that would move or widen its workspace lock, and the owner's account routes.
 */
export function isBlockedWhileImpersonating(path: string): boolean {
  return (
    path.startsWith('/admin/') ||
    path === '/organization/set-active' ||
    path === '/organization/create' ||
    IMPERSONATION_BLOCKED_ACCOUNT_PATHS.has(path)
  );
}

type SessionFields = {
  impersonatedBy?: string | null;
  expiresAt?: Date | string;
};

/**
 * Better Auth server instance, mounted at `/api/auth/*` by `@thallesp/nestjs-better-auth`.
 * Design: docs/project-documentation/tech-stack.md §3.
 */
export function createBetterAuth(db: Database, settings: BetterAuthSettings) {
  return betterAuth({
    appName: 'ShieldComment BD',
    basePath: '/api/auth',
    secret: settings.secret,
    baseURL: settings.baseURL,
    trustedOrigins: settings.trustedOrigins,
    disabledPaths: DISABLED_AUTH_PATHS,
    // `usePlural` maps Better Auth's `user` model to our `users` table, etc. No adapter
    // transactions (default): src/auth/first-workspace.ts relies on the user row being committed.
    database: drizzleAdapter(db, { provider: 'pg', usePlural: true, schema }),
    secondaryStorage: settings.secondaryStorage,
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 8,
      password: {
        hash: (password) => settings.passwords.hash(password),
        verify: ({ hash, password }) =>
          settings.passwords.verify(hash, password),
      },
    },
    session: {
      // Postgres stays the source of truth (list / revoke); Redis is the fast lookup.
      storeSessionInDatabase: true,
      // Signed session snapshot in a cookie: most requests skip Redis and the DB (Neon sleeps).
      // A revoked session or changed role can live on for up to this long.
      cookieCache: { enabled: true, maxAge: 5 * 60 },
    },
    rateLimit: {
      enabled: settings.rateLimit,
      storage: 'secondary-storage',
      window: 60,
      max: 100,
      customRules: {
        '/sign-in/email': { window: 60, max: 10 },
        [SIGN_UP_PATH]: { window: 60, max: 5 },
        // Polled by both apps on every navigation; cheap thanks to the cookie cache.
        '/get-session': false,
      },
    },
    advanced: {
      // Only this header; src/auth/client-ip.ts fills it with the socket address when unusable.
      ipAddress: { ipAddressHeaders: [CLIENT_IP_HEADER] },
      // Same UUIDv7 ids as every other table (src/db/schema/columns.ts).
      database: { generateId: () => uuidv7() },
    },
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (
          ctx.path === SIGN_UP_PATH &&
          parseWorkspaceName(ctx.body) === null
        ) {
          throw new APIError('BAD_REQUEST', {
            message: `workspaceName must be 1-${WORKSPACE_NAME_MAX} characters`,
          });
        }
        if (isBlockedWhileImpersonating(ctx.path)) {
          const current = await getSessionFromCtx(ctx);
          if ((current?.session as SessionFields | undefined)?.impersonatedBy) {
            throw new APIError('FORBIDDEN', {
              message: 'Not allowed while impersonating',
            });
          }
        }
      }),
    },
    databaseHooks: {
      session: {
        create: {
          // Sign-up creates the first workspace (owner); every new session starts in a workspace.
          // Sessions that already carry one (impersonation, M1-T3) keep it.
          before: async (session, ctx) => {
            const current = (
              session as { activeOrganizationId?: string | null }
            ).activeOrganizationId;
            if (current) return;
            const createName =
              ctx?.path === SIGN_UP_PATH
                ? firstWorkspaceName(ctx.body)
                : undefined;
            const activeOrganizationId = await resolveActiveWorkspace(
              db,
              settings.billing,
              session.userId,
              createName,
            );
            return { data: { ...session, activeOrganizationId } };
          },
        },
        update: {
          // Impersonated sessions last exactly 1 hour (M1-T3): `get-session` (also run by the global
          // guard on every request) would otherwise push expiresAt to now + 7 days, because the
          // `updateAge` check is always due for a session that short. It sets ctx.context.session to
          // the session it refreshes just before this update.
          before: async (data, ctx) => {
            const current = ctx?.context.session?.session as
              SessionFields | undefined;
            if (
              !current?.impersonatedBy ||
              !('expiresAt' in data) ||
              !current.expiresAt
            )
              return;
            return {
              data: { ...data, expiresAt: new Date(current.expiresAt) },
            };
          },
        },
      },
    },
    plugins: [
      organization({
        ac: workspaceAc,
        roles: workspaceRoles,
        creatorRole: 'owner',
        organizationHooks: {
          // PW-T5 (plan §3.6, PW-D10/D11): the creator's account needs a live plan (else 403
          // `no_active_plan`) with room under `limits.workspaces` (else 403
          // `workspace_limit_reached`). The sign-up workspace is made by first-workspace.ts, not
          // through this hook.
          beforeCreateOrganization: async ({ user }) => {
            assertWorkspaceCreateAllowed(
              await settings.limits.canCreateWorkspace(user.id),
            );
          },
          // A workspace created after sign-up belongs to the creator's billing account (PW-T3,
          // plan §3.1); no new trial.
          afterCreateOrganization: async ({ organization, user }) => {
            await settings.billing.linkWorkspace(user.id, organization.id);
          },
        },
        schema: {
          organization: {
            modelName: 'workspace',
            additionalFields: {
              status: {
                type: ['ACTIVE', 'SUSPENDED'],
                required: false,
                defaultValue: 'ACTIVE',
                input: false,
              },
            },
          },
          member: {
            modelName: 'workspaceMember',
            fields: { organizationId: 'workspaceId' },
          },
          invitation: {
            modelName: 'workspaceInvitation',
            fields: { organizationId: 'workspaceId' },
          },
        },
      }),
      admin({
        ac: platformAc,
        roles: platformRoles,
        adminRoles: ['super_admin'],
        defaultRole: 'user',
      }),
      impersonationExchange(db),
    ],
  });
}

export type BetterAuth = ReturnType<typeof createBetterAuth>;
