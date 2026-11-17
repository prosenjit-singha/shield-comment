import type { BetterAuthPlugin } from 'better-auth';
import { APIError, createAuthEndpoint } from 'better-auth/api';
import { setSessionCookie } from 'better-auth/cookies';
import type { Database } from '../db/database.js';
import {
  redeemImpersonationToken,
  resolveImpersonationTarget,
} from '../impersonation/impersonation-queries.js';
import {
  impersonationSessionExpiry,
  isWellFormedImpersonationToken,
} from '../impersonation/impersonation-token.js';
import { findPlatformUser } from './authz-queries.js';

export const IMPERSONATE_EXCHANGE_PATH = '/impersonate-exchange';

const SUPER_ADMIN_ROLE = 'super_admin';
const INVALID_TOKEN = {
  message: 'Invalid or expired impersonation token',
  code: 'INVALID_IMPERSONATION_TOKEN',
};

/**
 * `POST /api/auth/impersonate-exchange` `{ token }` (M1-T3). The client app's `/impersonate` page
 * posts the token from `POST /api/admin/clients/:workspaceId/impersonate` here, on its own origin.
 *
 * 1. Burns the token atomically (`used_at = now`): unknown / expired / used → 401, bad shape → 400.
 * 2. Re-checks, now, that the issuing admin is still an unbanned super admin (403) and the workspace
 *    can still be impersonated (404 gone, 409 suspended or no unbanned owner).
 * 3. Creates a session for the workspace's oldest unbanned owner with `impersonatedBy = adminId`
 *    and `activeOrganizationId = workspaceId`, expiring in exactly 1 hour (never refreshed: see the
 *    `session.update.before` hook in better-auth.ts), and sets the cookie on the calling origin.
 *    "Don't remember me" = browser-session cookie, and Better Auth skips refreshes for it too.
 */
export function impersonationExchange(db: Database) {
  return {
    id: 'impersonation-exchange',
    endpoints: {
      impersonateExchange: createAuthEndpoint(
        IMPERSONATE_EXCHANGE_PATH,
        { method: 'POST' },
        async (ctx) => {
          const token = (ctx.body as { token?: unknown } | undefined)?.token;
          if (!isWellFormedImpersonationToken(token)) {
            throw new APIError('BAD_REQUEST', INVALID_TOKEN);
          }

          const now = new Date();
          const redeemed = await redeemImpersonationToken(db, token, now);
          if (!redeemed.ok) {
            ctx.context.logger.warn(
              `impersonate-exchange rejected: ${redeemed.reason} token`,
            );
            throw new APIError('UNAUTHORIZED', INVALID_TOKEN);
          }

          const admin = await findPlatformUser(db, redeemed.adminId);
          if (!admin || admin.banned || admin.role !== SUPER_ADMIN_ROLE) {
            throw new APIError('FORBIDDEN', { message: 'Super admin only' });
          }

          const target = await resolveImpersonationTarget(
            db,
            redeemed.targetWorkspaceId,
            now,
          );
          if (!target.ok) {
            if (target.reason === 'not_found') {
              throw new APIError('NOT_FOUND', {
                message: 'Workspace not found',
              });
            }
            throw new APIError('CONFLICT', {
              message:
                target.reason === 'suspended'
                  ? 'Workspace is suspended'
                  : 'Workspace has no owner that can be impersonated',
            });
          }

          const user = await ctx.context.internalAdapter.findUserById(
            target.owner.id,
          );
          if (!user) {
            throw new APIError('CONFLICT', {
              message: 'Workspace has no owner that can be impersonated',
            });
          }
          // `overrideAll` keeps our expiresAt (dontRememberMe would otherwise force 1 day).
          const session = await ctx.context.internalAdapter.createSession(
            user.id,
            true,
            {
              impersonatedBy: redeemed.adminId,
              activeOrganizationId: target.workspaceId,
              expiresAt: impersonationSessionExpiry(now),
            },
            true,
          );
          if (!session) {
            throw new APIError('INTERNAL_SERVER_ERROR', {
              message: 'Could not create session',
            });
          }
          await setSessionCookie(ctx, { session, user }, true);

          const created = session as typeof session & {
            impersonatedBy?: string | null;
            activeOrganizationId?: string | null;
          };
          return ctx.json({
            user: { id: user.id, email: user.email, name: user.name },
            session: {
              expiresAt: created.expiresAt,
              impersonatedBy: created.impersonatedBy ?? null,
              activeOrganizationId: created.activeOrganizationId ?? null,
            },
          });
        },
      ),
    },
  } satisfies BetterAuthPlugin;
}
