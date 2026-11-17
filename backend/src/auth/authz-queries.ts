import { and, eq } from 'drizzle-orm';
import type { Database } from '../db/database.js';
import {
  users,
  workspaceMembers,
  workspaces,
  type WorkspaceRole,
} from '../db/schema/index.js';

export interface WorkspaceMembership {
  role: WorkspaceRole;
  status: 'ACTIVE' | 'SUSPENDED';
}

/**
 * The caller's membership in one workspace (+ the workspace status), or `undefined` when the
 * user isn't a member or the workspace doesn't exist. Scoped by `workspace_id` + `user_id`.
 */
export async function findWorkspaceMembership(
  db: Database,
  workspaceId: string,
  userId: string,
): Promise<WorkspaceMembership | undefined> {
  const [row] = await db
    .select({ role: workspaceMembers.role, status: workspaces.status })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
    .where(
      and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.userId, userId),
      ),
    )
    .limit(1);
  // The DB check constraint limits `role` to WORKSPACE_ROLES.
  return row
    ? { role: row.role as WorkspaceRole, status: row.status }
    : undefined;
}

/** Current platform role + ban flag straight from Postgres (the session cookie cache can lag 5 min). */
export async function findPlatformUser(
  db: Database,
  userId: string,
): Promise<{ role: string; banned: boolean } | undefined> {
  const [row] = await db
    .select({ role: users.role, banned: users.banned })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return row;
}
