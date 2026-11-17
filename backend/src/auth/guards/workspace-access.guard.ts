import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { InjectDrizzle } from '@nestjs/drizzle';
import type { Database } from '../../db/database.js';
import type { AuthRequest } from '../auth-session.js';
import { findWorkspaceMembership } from '../authz-queries.js';
import {
  assertWorkspaceAllowed,
  requiredWorkspaceRoles,
} from './workspace-roles.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Tenant isolation for routes with a `:workspaceId` param (`@UseGuards(WorkspaceAccessGuard)`).
 * Runs after the global Better Auth guard.
 * - Not a member, no such workspace, or a malformed id: 404, so other tenants' ids can't be probed.
 * - Impersonated session (`impersonatedBy`): only its `activeOrganizationId`; anything else is 404.
 * - Suspended workspace, or member role outside `@Roles(...)`: 403.
 * On success sets `request.workspace = { id, role }` (read it with `@CurrentWorkspace()`).
 */
@Injectable()
export class WorkspaceAccessGuard implements CanActivate {
  constructor(
    @InjectDrizzle() private readonly db: Database,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthRequest>();
    const { session } = request;
    if (!session) throw new UnauthorizedException();

    const workspaceId = request.params['workspaceId'];
    if (typeof workspaceId !== 'string' || !UUID.test(workspaceId)) {
      throw new NotFoundException('Workspace not found');
    }
    const workspaceKey = workspaceId.toLowerCase();
    if (
      session.session.impersonatedBy &&
      session.session.activeOrganizationId?.toLowerCase() !== workspaceKey
    ) {
      throw new NotFoundException('Workspace not found');
    }

    const membership = await findWorkspaceMembership(
      this.db,
      workspaceKey,
      session.user.id,
    );
    if (!membership) throw new NotFoundException('Workspace not found');
    assertWorkspaceAllowed(
      membership,
      requiredWorkspaceRoles(this.reflector, context),
    );

    request.workspace = { id: workspaceKey, role: membership.role };
    return true;
  }
}
