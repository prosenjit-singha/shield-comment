import { APIError, betterAuth, type SecondaryStorage } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { createAuthMiddleware, getSessionFromCtx } from 'better-auth/api';
import { admin, organization } from 'better-auth/plugins';
import { and, eq, type SQL } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import type { LimitService } from '../billing/limit.service.js';
import type { Database } from '../db/database.js';
import * as schema from '../db/schema/index.js';
import type { EmailService } from '../email/email.service.js';
import { CLIENT_IP_HEADER } from '../common/http/client-ip.js';
import {
  firstWorkspaceName,
  parseWorkspaceName,
  resolveActiveWorkspace,
  type SessionBilling,
  WORKSPACE_NAME_MAX,
} from './first-workspace.js';
import { impersonationExchange } from './impersonation-exchange.plugin.js';
import type { PasswordService } from './password.service.js';
import {
  ACCEPT_INVITATION_PATH,
  assertInviteRole,
  assertMemberChange,
  assertNotImpersonating,
  assertSeatAvailable,
  assertSignUpInvite,
  createInvitationMailer,
  INVITATION_EXPIRES_IN_SEC,
  INVITE_MEMBER_PATH,
  isUuid,
  LEAVE_PATH,
  MEMBER_CHANGE_CODES,
  type MemberChange,
  REMOVE_MEMBER_PATH,
  roleList,
  signUpInvitationId,
  TEAM_WRITE_PATHS,
  UPDATE_MEMBER_ROLE_PATH,
} from './workspace-invites.js';
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
  /** Account-pooled workspace limit (PW-T5) and invite seat check (M7-T5), `LimitService`. */
  limits: AuthLimits;
  /** Invitation emails (M7-T5): `EmailService` + `CLIENT_APP_URL` for the `/invite/<id>` link. */
  invitations: { email: Pick<EmailService, 'send'>; clientAppUrl: string };
}

/** The `SubscriptionService` calls Better Auth's hooks make (PW-T3). */
export type AuthBilling = SessionBilling;

/** The `LimitService` calls the organization hooks make (PW-T5, M7-T5, M7-T6). */
export type AuthLimits = Pick<
  LimitService,
  'canCreateWorkspace' | 'canInvite' | 'canAccept'
>;

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
  const secureCookies = new URL(settings.baseURL).protocol === 'https:';
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
        // Password reset (D2/D10, wired in M9-T5; M9-T5 adds the verification-email resend here).
        '/request-password-reset': { window: 60, max: 3 },
        '/reset-password': { window: 60, max: 3 },
        // Polled by both apps on every navigation; cheap thanks to the cookie cache.
        '/get-session': false,
      },
    },
    advanced: {
      // Explicit cookie flags (M9-T3, reading 4): `Secure` + `__Secure-` prefix exactly when the
      // public URL is https. Compose runs production on http://*.localhost, so it stays off there.
      useSecureCookies: secureCookies,
      // Better Auth skips the Origin check under NODE_ENV=test by default; keep it on everywhere so
      // e2e runs the production CSRF check (cookie-carrying POSTs need a TRUSTED_ORIGINS Origin).
      disableOriginCheck: false,
      defaultCookieAttributes: {
        httpOnly: true,
        sameSite: 'lax',
        secure: secureCookies,
      },
      // Only this header: configureApp() replaces it with the resolved client IP (M9-T1).
      ipAddress: { ipAddressHeaders: [CLIENT_IP_HEADER] },
      // Same UUIDv7 ids as every other table (src/db/schema/columns.ts).
      database: { generateId: () => uuidv7() },
    },
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path === SIGN_UP_PATH) {
          // D8 (M7-T6): a sign-up from an invite (`invitationId`, no `workspaceName`) gets no
          // workspace, billing account or trial; the invite must be live and for this email.
          const invitationId = signUpInvitationId(ctx.body);
          if (invitationId) {
            const [invite] = await db
              .select({
                status: schema.workspaceInvitations.status,
                expiresAt: schema.workspaceInvitations.expiresAt,
                email: schema.workspaceInvitations.email,
              })
              .from(schema.workspaceInvitations)
              .where(eq(schema.workspaceInvitations.id, invitationId));
            assertSignUpInvite(invite, (ctx.body as { email?: unknown }).email);
          } else if (parseWorkspaceName(ctx.body) === null) {
            throw new APIError('BAD_REQUEST', {
              message: `workspaceName must be 1-${WORKSPACE_NAME_MAX} characters`,
            });
          }
          return;
        }
        const teamWrite = TEAM_WRITE_PATHS.has(ctx.path);
        if (!teamWrite && !isBlockedWhileImpersonating(ctx.path)) return;
        const current = await getSessionFromCtx(ctx);
        const session = current?.session as
          | (SessionFields & { activeOrganizationId?: string | null })
          | undefined;
        if (teamWrite) assertNotImpersonating(session?.impersonatedBy);
        else if (session?.impersonatedBy) {
          throw new APIError('FORBIDDEN', {
            message: 'Not allowed while impersonating',
          });
        }
        // D7 role rules run here, before the plugin cancels an older invite of the same email
        // (re-invite) and also for `resend: true`, which skips `beforeCreateInvitation`.
        if (ctx.path === INVITE_MEMBER_PATH && current) {
          await checkInviteRole(
            db,
            current.user.id,
            ctx.body as InviteBody | undefined,
            session?.activeOrganizationId,
          );
        }
        // D7 + D11 (M7-T6): the plugin's member hooks don't see the caller, so the actor rules
        // (and the owner protection, which must beat the plugin's own 400s) run here.
        if (MEMBER_CHANGE_PATHS.has(ctx.path) && current) {
          await checkMemberChange(
            db,
            current.user.id,
            ctx.path,
            ctx.body as MemberChangeBody | undefined,
            session?.activeOrganizationId,
          );
        }
      }),
      // Accept (M7-T6, D8): the plugin moves the stored session to the invited workspace but not
      // the 5-minute cookie cache; re-read the session so the response carries a fresh one.
      after: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== ACCEPT_INVITATION_PATH) return;
        const returned = ctx.context.returned;
        if (
          !returned ||
          typeof returned !== 'object' ||
          !('member' in returned)
        )
          return;
        ctx.context.session = null;
        await getSessionFromCtx(ctx, { disableCookieCache: true });
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
            // A sign-up from an invite (D8) starts with no workspace until it accepts.
            const createName =
              ctx?.path === SIGN_UP_PATH &&
              signUpInvitationId(ctx.body) === undefined
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
        // D7 (Module 7): 7-day links; re-inviting an email cancels its older pending invite.
        invitationExpiresIn: INVITATION_EXPIRES_IN_SEC,
        cancelPendingInvitationsOnReInvite: true,
        // M7-D18 (user, 2026-11-20): our uuidv7 ids would turn on Better Auth's verified-email gate
        // for accept/reject; the proof is the signed-in invited email + the emailed 7-day link.
        requireEmailVerificationOnInvitation: false,
        sendInvitationEmail: createInvitationMailer(
          settings.invitations.email,
          settings.invitations.clientAppUrl,
        ),
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
          // D9/D10 (M7-T5): seats pooled on the workspace's billing account = members + pending
          // unexpired invites; a re-invite's older invite is already cancelled here, so it frees
          // its seat. 409 `SEAT_LIMIT_REACHED` / `NO_ACTIVE_PLAN`.
          beforeCreateInvitation: async ({ organization }) => {
            assertSeatAvailable(
              await settings.limits.canInvite(organization.id),
            );
          },
          // D9/D10 (M7-T6): re-check at accept; the invite itself already holds a seat, so only an
          // account over its limit (downgrade) or without a live plan is refused (409).
          beforeAcceptInvitation: async ({ organization }) => {
            assertSeatAvailable(
              await settings.limits.canAccept(organization.id),
            );
          },
          // D11 backstop (the before-middleware answers first for HTTP calls).
          beforeUpdateMemberRole: async ({ member, newRole }) => {
            if (member.role === 'owner' || roleList(newRole)?.includes('owner'))
              throw new APIError('FORBIDDEN', {
                code: MEMBER_CHANGE_CODES.ownerProtected,
                message: 'The workspace owner can’t change.',
              });
          },
          beforeRemoveMember: async ({ member }) => {
            if (member.role === 'owner')
              throw new APIError('FORBIDDEN', {
                code: MEMBER_CHANGE_CODES.ownerProtected,
                message: 'The workspace owner can’t be removed.',
              });
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

type InviteBody = {
  role?: unknown;
  organizationId?: unknown;
};

/**
 * D7 for `/organization/invite-member`: the caller's role in the target workspace decides which
 * roles they may invite. No membership or a malformed body → the plugin answers (400/403).
 */
async function checkInviteRole(
  db: Database,
  userId: string,
  body: InviteBody | undefined,
  activeWorkspaceId: string | null | undefined,
): Promise<void> {
  const workspaceId =
    typeof body?.organizationId === 'string'
      ? body.organizationId
      : activeWorkspaceId;
  const roles = roleList(body?.role);
  if (!workspaceId || !roles?.length) return;
  const [member] = await db
    .select({ role: schema.workspaceMembers.role })
    .from(schema.workspaceMembers)
    .where(
      and(
        eq(schema.workspaceMembers.workspaceId, workspaceId),
        eq(schema.workspaceMembers.userId, userId),
      ),
    );
  if (!member) return;
  // One role per invite (the DB role check allows a single value).
  assertInviteRole(member.role, roles.length === 1 ? String(roles[0]) : '');
}

const MEMBER_CHANGE_PATHS: ReadonlySet<string> = new Set([
  UPDATE_MEMBER_ROLE_PATH,
  REMOVE_MEMBER_PATH,
  LEAVE_PATH,
]);

type MemberChangeBody = {
  organizationId?: unknown;
  memberId?: unknown;
  memberIdOrEmail?: unknown;
  role?: unknown;
};

/**
 * D7 + D11 for `update-member-role`, `remove-member` and `leave`: the caller's and the target's
 * roles in that workspace decide. Unknown workspace/member or a malformed body → the plugin answers.
 */
async function checkMemberChange(
  db: Database,
  userId: string,
  path: string,
  body: MemberChangeBody | undefined,
  activeWorkspaceId: string | null | undefined,
): Promise<void> {
  const workspaceId =
    typeof body?.organizationId === 'string'
      ? body.organizationId
      : activeWorkspaceId;
  if (!isUuid(workspaceId)) return;
  const roleWhere = async (where: SQL) =>
    (
      await db
        .select({ role: schema.workspaceMembers.role })
        .from(schema.workspaceMembers)
        .innerJoin(
          schema.users,
          eq(schema.users.id, schema.workspaceMembers.userId),
        )
        .where(and(eq(schema.workspaceMembers.workspaceId, workspaceId), where))
    )[0]?.role;

  const actorRole = await roleWhere(eq(schema.workspaceMembers.userId, userId));
  if (!actorRole) return;
  let change: MemberChange;
  if (path === LEAVE_PATH) change = { action: 'leave' };
  else {
    const ref =
      path === UPDATE_MEMBER_ROLE_PATH ? body?.memberId : body?.memberIdOrEmail;
    const targetRole =
      typeof ref === 'string' && ref.includes('@')
        ? await roleWhere(eq(schema.users.email, ref.toLowerCase()))
        : isUuid(ref)
          ? await roleWhere(eq(schema.workspaceMembers.id, ref))
          : undefined;
    if (!targetRole) return;
    if (path === REMOVE_MEMBER_PATH) change = { action: 'remove', targetRole };
    else {
      const newRoles = roleList(body?.role);
      if (!newRoles) return;
      change = { action: 'update', targetRole, newRoles };
    }
  }
  assertMemberChange(actorRole, change);
}
