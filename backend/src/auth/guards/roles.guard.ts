import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
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

/**
 * Workspace role check for routes that act on the session's **active** workspace
 * (`@UseGuards(RolesGuard)` + `@Roles('owner', 'admin')`). A no-op without `@Roles`.
 * - After `WorkspaceAccessGuard` it re-checks the already resolved `request.workspace`.
 * - Otherwise it loads the membership of `session.activeOrganizationId` (an impersonated session's
 *   active workspace is its only one): none → 403, suspended or role not listed → 403.
 * On success sets `request.workspace` (read it with `@CurrentWorkspace()`).
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(
    @InjectDrizzle() private readonly db: Database,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const allowed = requiredWorkspaceRoles(this.reflector, context);
    if (!allowed) return true;

    const request = context.switchToHttp().getRequest<AuthRequest>();
    const { session } = request;
    if (!session) throw new UnauthorizedException();

    if (request.workspace) {
      if (!allowed.includes(request.workspace.role)) {
        throw new ForbiddenException('Insufficient workspace role');
      }
      return true;
    }

    const workspaceId = session.session.activeOrganizationId;
    const membership = workspaceId
      ? await findWorkspaceMembership(this.db, workspaceId, session.user.id)
      : undefined;
    if (!workspaceId || !membership)
      throw new ForbiddenException('No active workspace');
    assertWorkspaceAllowed(membership, allowed);

    request.workspace = { id: workspaceId, role: membership.role };
    return true;
  }
}
