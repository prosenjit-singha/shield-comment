import { randomBytes } from 'node:crypto';
import { asc, eq } from 'drizzle-orm';
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

/**
 * The workspace a new session starts in: the user's oldest membership. With `createName`
 * (sign-up only) and no membership yet, creates the first workspace with the user as `owner`.
 *
 * Runs from `databaseHooks.session.create.before`, i.e. after the user row exists and before
 * the session row is written, so the sign-up session (and its cookie cache) already carries
 * `activeOrganizationId`. The Drizzle adapter runs without transactions, so the user row is
 * committed; workspace + owner membership go in one transaction of their own.
 */
export async function resolveActiveWorkspace(
  db: Database,
  userId: string,
  createName?: string,
): Promise<string | null> {
  const [membership] = await db
    .select({ workspaceId: workspaceMembers.workspaceId })
    .from(workspaceMembers)
    .where(eq(workspaceMembers.userId, userId))
    .orderBy(asc(workspaceMembers.createdAt))
    .limit(1);
  if (membership) return membership.workspaceId;
  if (!createName) return null;

  return db.transaction(async (tx) => {
    const [workspace] = await tx
      .insert(workspaces)
      .values({ name: createName, slug: slugify(createName) })
      .returning({ id: workspaces.id });
    await tx
      .insert(workspaceMembers)
      .values({ workspaceId: workspace!.id, userId, role: 'owner' });
    return workspace!.id;
  });
}
