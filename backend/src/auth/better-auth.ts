import { APIError, betterAuth, type SecondaryStorage } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { createAuthMiddleware } from 'better-auth/api';
import { admin, organization } from 'better-auth/plugins';
import { uuidv7 } from 'uuidv7';
import type { Database } from '../db/database.js';
import * as schema from '../db/schema/index.js';
import {
  firstWorkspaceName,
  parseWorkspaceName,
  resolveActiveWorkspace,
  WORKSPACE_NAME_MAX,
} from './first-workspace.js';
import type { PasswordService } from './password.service.js';
import { platformAc, platformRoles, workspaceAc, workspaceRoles } from './permissions.js';

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
}

const SIGN_UP_PATH = '/sign-up/email';

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
    // `usePlural` maps Better Auth's `user` model to our `users` table, etc. No adapter
    // transactions (default): src/auth/first-workspace.ts relies on the user row being committed.
    database: drizzleAdapter(db, { provider: 'pg', usePlural: true, schema }),
    secondaryStorage: settings.secondaryStorage,
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 8,
      password: {
        hash: (password) => settings.passwords.hash(password),
        verify: ({ hash, password }) => settings.passwords.verify(hash, password),
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
      // Same UUIDv7 ids as every other table (src/db/schema/columns.ts).
      database: { generateId: () => uuidv7() },
    },
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path === SIGN_UP_PATH && parseWorkspaceName(ctx.body) === null) {
          throw new APIError('BAD_REQUEST', {
            message: `workspaceName must be 1-${WORKSPACE_NAME_MAX} characters`,
          });
        }
      }),
    },
    databaseHooks: {
      session: {
        create: {
          // Sign-up creates the first workspace (owner); every new session starts in a workspace.
          // Sessions that already carry one (impersonation, M1-T3) keep it.
          before: async (session, ctx) => {
            const current = (session as { activeOrganizationId?: string | null }).activeOrganizationId;
            if (current) return;
            const createName = ctx?.path === SIGN_UP_PATH ? firstWorkspaceName(ctx.body) : undefined;
            const activeOrganizationId = await resolveActiveWorkspace(db, session.userId, createName);
            return { data: { ...session, activeOrganizationId } };
          },
        },
      },
    },
    plugins: [
      organization({
        ac: workspaceAc,
        roles: workspaceRoles,
        creatorRole: 'owner',
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
          member: { modelName: 'workspaceMember', fields: { organizationId: 'workspaceId' } },
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
    ],
  });
}

export type BetterAuth = ReturnType<typeof createBetterAuth>;
