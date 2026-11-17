import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';

const WORKSPACE_FIELDS = {
  id: true,
  name: true,
  slug: true,
  status: true,
  createdAt: true,
} as const;

/** Every query here is explicitly scoped by workspace id (AGENTS.md tenant rule). */
@Injectable()
export class WorkspacesService {
  constructor(private readonly prisma: PrismaService) {}

  async listForUser(userId: string, onlyWorkspaceId?: string) {
    const memberships = await this.prisma.workspaceMember.findMany({
      where: { userId, ...(onlyWorkspaceId ? { workspaceId: onlyWorkspaceId } : {}) },
      select: { role: true, workspace: { select: WORKSPACE_FIELDS } },
      orderBy: { createdAt: 'asc' },
    });
    return memberships.map((m) => ({ ...m.workspace, role: m.role }));
  }

  findById(workspaceId: string) {
    return this.prisma.workspace.findUniqueOrThrow({
      where: { id: workspaceId },
      select: { ...WORKSPACE_FIELDS, _count: { select: { members: true } } },
    });
  }

  rename(workspaceId: string, name: string) {
    return this.prisma.workspace.update({
      where: { id: workspaceId },
      data: { name },
      select: WORKSPACE_FIELDS,
    });
  }
}
