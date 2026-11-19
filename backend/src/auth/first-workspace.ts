import { randomBytes } from 'node:crypto';
import { asc, eq } from 'drizzle-orm';
import type { SubscriptionService } from '../billing/subscription.service.js';
import type { Database } from '../db/database.js';
import { workspaceMembers, workspaces } from '../db/schema/index.js';

export const WORKSPACE_NAME_MAX = 80;

/** `"Rahim's Shop!"` → `rahim-s-shop-1a2b3c` (ASCII, ≤ 47 chars, random suffix keeps it unique). */
export function slugify(name: string): string {
  const base =
    name
      .normalize('NFKD')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'workspace';
  return `${base}-${randomBytes(3).toString('hex')}`;
}

/**
 * Optional `workspaceName` from the sign-up body. Returns `undefined` when absent and `null`
 * when present but invalid (the sign-up `before` hook rejects that with 400).
 */
export function parseWorkspaceName(body: unknown): string | null | undefined {
  if (!body || typeof body !== 'object' || !('workspaceName' in body))
    return undefined;
  const raw = (body as { workspaceName: unknown }).workspaceName;
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string') return null;
  const name = raw.trim();
  return name.length >= 1 && name.length <= WORKSPACE_NAME_MAX ? name : null;
}

/** `workspaceName` if given, else "<name>'s workspace" (cut to the max length). */
export function firstWorkspaceName(body: unknown): string {
  const given = parseWorkspaceName(body);
  if (given) return given;
  const owner =
    body &&
    typeof body === 'object' &&
    'name' in body &&
    typeof body.name === 'string'
      ? body.name.trim()
      : '';
  return (owner ? `${owner}'s workspace` : 'My workspace').slice(
    0,
    WORKSPACE_NAME_MAX,
  );
}

/** The billing calls a new session makes (`SubscriptionService`, PW-T3, PR-T3). */
export type SessionBilling = Pick<
  SubscriptionService,
  'linkWorkspace' | 'isSetUp'
>;

/**
 * The workspace a new session starts in: the user's oldest membership. With `createName`
 * (sign-up only) and no membership yet, creates the first workspace with the user as `owner`.
 *
 * Runs from `databaseHooks.session.create.before`, i.e. after the user row exists and before
 * the session row is written, so the sign-up session (and its cookie cache) already carries
 * `activeOrganizationId`. The Drizzle adapter runs without transactions, so the user row is
 * committed; workspace + owner membership + billing go in one transaction of their own.
 *
 * Billing (PW-T3; PR-T3, PR-D10 no trial at sign-up): sign-up links the new workspace to the
 * user's billing account (made on first use) in that same transaction, with **no plan** (the client
 * picks one, or a trial, on `/plans`). Later session creates repair an owner whose oldest workspace
 * has no account (e.g. a sign-up during the 0023 deploy): it gets the account + link then.
 */
export async function resolveActiveWorkspace(
  db: Database,
  billing: SessionBilling,
  userId: string,
  createName?: string,
): Promise<string | null> {
  const [membership] = await db
    .select({
      workspaceId: workspaceMembers.workspaceId,
      role: workspaceMembers.role,
    })
    .from(workspaceMembers)
    .where(eq(workspaceMembers.userId, userId))
    .orderBy(asc(workspaceMembers.createdAt))
    .limit(1);
  if (membership) {
    if (
      membership.role === 'owner' &&
      !(await billing.isSetUp(membership.workspaceId))
    ) {
      await billing.linkWorkspace(userId, membership.workspaceId);
    }
    return membership.workspaceId;
  }
  if (!createName) return null;

  return db.transaction(async (tx) => {
    const [workspace] = await tx
      .insert(workspaces)
      .values({ name: createName, slug: slugify(createName) })
      .returning({ id: workspaces.id });
    await tx
      .insert(workspaceMembers)
      .values({ workspaceId: workspace!.id, userId, role: 'owner' });
    await billing.linkWorkspace(userId, workspace!.id, tx);
    return workspace!.id;
  });
}
