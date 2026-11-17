import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { and, asc, count, eq } from 'drizzle-orm';
import type { Database } from '../db/database.js';
import {
  workspaceMembers,
  workspaces,
  type WorkspaceRole,
} from '../db/schema/index.js';

const WORKSPACE_FIELDS = {
  id: workspaces.id,
  name: workspaces.name,
  slug: workspaces.slug,
  status: workspaces.status,
  createdAt: workspaces.createdAt,
} as const;

/** Every query here is scoped by `workspace_id` (or, for the caller's own list, `user_id`). */
@Injectable()
export class WorkspacesService {
  constructor(@InjectDrizzle() private readonly db: Database) {}

  /** The user's workspaces + role, oldest membership first. `onlyWorkspaceId` for impersonated sessions. */
  async listForUser(userId: string, onlyWorkspaceId?: string | null) {
    const rows = await this.db
      .select({ ...WORKSPACE_FIELDS, role: workspaceMembers.role })
      .from(workspaceMembers)
      .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
      .where(
        and(
          eq(workspaceMembers.userId, userId),
          onlyWorkspaceId
            ? eq(workspaceMembers.workspaceId, onlyWorkspaceId)
            : undefined,
        ),
      )
      .orderBy(asc(workspaceMembers.createdAt));
    return rows.map((row) => ({ ...row, role: row.role as WorkspaceRole }));
  }

  async findById(workspaceId: string) {
    const [workspace] = await this.db
      .select(WORKSPACE_FIELDS)
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
      .limit(1);
    if (!workspace) throw new NotFoundException('Workspace not found');
    const [members] = await this.db
      .select({ total: count() })
      .from(workspaceMembers)
      .where(eq(workspaceMembers.workspaceId, workspaceId));
    return { ...workspace, memberCount: members?.total ?? 0 };
  }

  async rename(workspaceId: string, name: string) {
    const [workspace] = await this.db
      .update(workspaces)
      .set({ name })
      .where(eq(workspaces.id, workspaceId))
      .returning(WORKSPACE_FIELDS);
    if (!workspace) throw new NotFoundException('Workspace not found');
    return workspace;
  }
}
