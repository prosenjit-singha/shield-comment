import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { WorkspaceMemberRole } from '../generated/prisma/client.js';
import type { AuthenticatedRequest } from '../auth/auth.types.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { WORKSPACE_ROLES_KEY } from './workspace-roles.decorator.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Tenant isolation for every route with a `:workspaceId` param.
 * - Not a member (or no such workspace): 404, so other tenants' ids can't be probed.
 * - Impersonation tokens only reach the one workspace baked into the token.
 * - Suspended workspace, or member role below `@WorkspaceRoles(...)`: 403.
 * On success, `request.workspace = { id, role }` (read it with `@CurrentWorkspace()`).
 */
@Injectable()
export class WorkspaceAccessGuard implements CanActivate {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const workspaceId = request.params['workspaceId'];
    if (typeof workspaceId !== 'string' || !UUID.test(workspaceId)) {
      throw new NotFoundException('Workspace not found');
    }
    const { user } = request;
    if (user.workspaceId && user.workspaceId !== workspaceId) {
      throw new NotFoundException('Workspace not found');
    }

    const membership = await this.prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId: user.sub } },
      select: { role: true, workspace: { select: { status: true } } },
    });
    if (!membership) throw new NotFoundException('Workspace not found');
    if (membership.workspace.status !== 'ACTIVE') {
      throw new ForbiddenException('Workspace is suspended');
    }

    const allowed = this.reflector.getAllAndOverride<WorkspaceMemberRole[] | undefined>(
      WORKSPACE_ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (allowed?.length && !allowed.includes(membership.role)) {
      throw new ForbiddenException('Insufficient workspace role');
    }

    request.workspace = { id: workspaceId, role: membership.role };
    return true;
  }
}
