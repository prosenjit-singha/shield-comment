import { Controller, Get } from '@nestjs/common';
import { Session } from '@thallesp/nestjs-better-auth';
import type { AuthSession } from '../auth/auth-session.js';
import { WorkspacesService } from '../workspaces/workspaces.service.js';

@Controller('me')
export class MeController {
  constructor(private readonly workspaces: WorkspacesService) {}

  /**
   * The signed-in user, their workspaces (with member role), the active workspace and
   * `impersonatedBy`. An impersonated session only sees the workspace it is locked to.
   */
  @Get()
  async me(@Session() session: AuthSession) {
    const { user } = session;
    const { activeOrganizationId, impersonatedBy } = session.session;
    const workspaces =
      impersonatedBy && !activeOrganizationId
        ? []
        : await this.workspaces.listForUser(
            user.id,
            impersonatedBy ? activeOrganizationId : undefined,
          );
    return {
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        image: user.image ?? null,
        emailVerified: user.emailVerified,
        role: user.role ?? 'user',
      },
      workspaces,
      activeWorkspaceId: activeOrganizationId ?? null,
      impersonatedBy: impersonatedBy ?? null,
    };
  }
}
