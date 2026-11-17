import { createParamDecorator, type ExecutionContext, SetMetadata } from '@nestjs/common';
import type { WorkspaceMemberRole } from '../generated/prisma/client.js';
import type { AuthenticatedRequest, WorkspaceContext } from '../auth/auth.types.js';

export const WORKSPACE_ROLES_KEY = 'workspace:roles';

/** Member roles allowed on this route (checked by `WorkspaceAccessGuard`). Default: any member. */
export const WorkspaceRoles = (...roles: WorkspaceMemberRole[]) =>
  SetMetadata(WORKSPACE_ROLES_KEY, roles);

/** The verified workspace scope. Use its `id` in every tenant query. */
export const CurrentWorkspace = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): WorkspaceContext => {
    const { workspace } = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!workspace) {
      throw new Error('@CurrentWorkspace() used on a route without WorkspaceAccessGuard');
    }
    return workspace;
  },
);
