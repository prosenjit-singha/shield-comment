import { and, asc, eq, gt, isNotNull, isNull, lt, or } from 'drizzle-orm';
import type { Database } from '../db/database.js';
import {
  impersonationAuditLogs,
  users,
  workspaceMembers,
  workspaces,
} from '../db/schema/index.js';
import {
  hashImpersonationToken,
  impersonationTokenExpiry,
  type RedeemFailure,
  redeemFailure,
} from './impersonation-token.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ImpersonationOwner {
  id: string;
  email: string;
  name: string;
}

export type ImpersonationTarget =
  | { ok: true; workspaceId: string; owner: ImpersonationOwner }
  | { ok: false; reason: 'not_found' | 'suspended' | 'no_owner' };

/**
 * The user an impersonation of `workspaceId` signs in as (user decision, M1-T3): the oldest
 * `owner` membership (`created_at`, then `id`), skipping banned owners. A ban whose `banExpires`
 * has passed doesn't count (Better Auth's admin plugin lifts it on the next session).
 */
export async function findImpersonationOwner(
  db: Database,
  workspaceId: string,
  now: Date,
): Promise<ImpersonationOwner | undefined> {
  const [owner] = await db
    .select({ id: users.id, email: users.email, name: users.name })
    .from(workspaceMembers)
    .innerJoin(users, eq(users.id, workspaceMembers.userId))
    .where(
      and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.role, 'owner'),
        or(
          eq(users.banned, false),
          and(isNotNull(users.banExpires), lt(users.banExpires, now)),
        ),
      ),
    )
    .orderBy(asc(workspaceMembers.createdAt), asc(workspaceMembers.id))
    .limit(1);
  return owner;
}

/**
 * Can `workspaceId` be impersonated right now? Unknown or malformed id → `not_found`;
 * SUSPENDED → `suspended`; no unbanned owner → `no_owner` (both 409, user decision M1-T3).
 */
export async function resolveImpersonationTarget(
  db: Database,
  workspaceId: string,
  now: Date,
): Promise<ImpersonationTarget> {
  if (!UUID.test(workspaceId)) return { ok: false, reason: 'not_found' };
  const [workspace] = await db
    .select({ id: workspaces.id, status: workspaces.status })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  if (!workspace) return { ok: false, reason: 'not_found' };
  if (workspace.status === 'SUSPENDED')
    return { ok: false, reason: 'suspended' };
  const owner = await findImpersonationOwner(db, workspace.id, now);
  if (!owner) return { ok: false, reason: 'no_owner' };
  return { ok: true, workspaceId: workspace.id, owner };
}

/** Stores the hash of a fresh token (60 s) in the audit log. */
export async function recordImpersonationToken(
  db: Database,
  input: {
    token: string;
    adminId: string;
    workspaceId: string;
    ipAddress: string | null;
    now: Date;
  },
): Promise<{ id: string; expiresAt: Date }> {
  const [row] = await db
    .insert(impersonationAuditLogs)
    .values({
      adminId: input.adminId,
      targetWorkspaceId: input.workspaceId,
      tokenHash: hashImpersonationToken(input.token),
      expiresAt: impersonationTokenExpiry(input.now),
      ipAddress: input.ipAddress,
    })
    .returning({
      id: impersonationAuditLogs.id,
      expiresAt: impersonationAuditLogs.expiresAt,
    });
  return row!;
}

export type RedeemResult =
  | { ok: true; auditId: string; adminId: string; targetWorkspaceId: string }
  | { ok: false; reason: RedeemFailure };

/** The burn: one statement, so two concurrent exchanges of the same token can't both win. */
export function burnImpersonationTokenQuery(
  db: Database,
  tokenHash: string,
  now: Date,
) {
  return db
    .update(impersonationAuditLogs)
    .set({ usedAt: now })
    .where(
      and(
        eq(impersonationAuditLogs.tokenHash, tokenHash),
        isNull(impersonationAuditLogs.usedAt),
        gt(impersonationAuditLogs.expiresAt, now),
      ),
    )
    .returning({
      auditId: impersonationAuditLogs.id,
      adminId: impersonationAuditLogs.adminId,
      targetWorkspaceId: impersonationAuditLogs.targetWorkspaceId,
    });
}

/**
 * Atomically marks the token used (`used_at = now`) if it exists, is unused and hasn't expired.
 * On a miss, reads the row once more only to say why (unknown / expired / used).
 */
export async function redeemImpersonationToken(
  db: Database,
  token: string,
  now: Date,
): Promise<RedeemResult> {
  const tokenHash = hashImpersonationToken(token);
  const [burned] = await burnImpersonationTokenQuery(db, tokenHash, now);
  if (burned) return { ok: true, ...burned };
  const [row] = await db
    .select({
      expiresAt: impersonationAuditLogs.expiresAt,
      usedAt: impersonationAuditLogs.usedAt,
    })
    .from(impersonationAuditLogs)
    .where(eq(impersonationAuditLogs.tokenHash, tokenHash))
    .limit(1);
  // A row that looks redeemable here lost a race with a concurrent exchange.
  return { ok: false, reason: redeemFailure(row, now) ?? 'used' };
}
