import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { AuthRequest, WorkspaceContext } from '../auth-session.js';

/** The verified workspace scope. Use its `id` in every tenant query. */
export const CurrentWorkspace = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): WorkspaceContext => {
    const { workspace } = ctx.switchToHttp().getRequest<AuthRequest>();
    if (!workspace) {
      throw new Error(
        '@CurrentWorkspace() needs WorkspaceAccessGuard or RolesGuard on the route',
      );
    }
    return workspace;
  },
);
