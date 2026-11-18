import { Controller, Delete, HttpCode, UseGuards } from '@nestjs/common';
import { Session } from '@thallesp/nestjs-better-auth';
import type { AuthSession, WorkspaceContext } from '../auth/auth-session.js';
import { CurrentWorkspace } from '../auth/decorators/current-workspace.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { WorkspaceAccessGuard } from '../auth/guards/workspace-access.guard.js';
import type { MetaDisconnectResponse } from './dto/workspace-pages.dto.js';
import { MetaDisconnectService } from './meta-disconnect.service.js';

/**
 * `DELETE /api/workspaces/:workspaceId/meta/connection` (M4-T9, Module 4 D7): owner/admin
 * (moderator/member 403, non-member 404), impersonated session 403 (like connect). Hard-deletes
 * the connection + Pages (comments kept), then unsubscribes the Pages and revokes the app's
 * permissions on Meta best effort. 200 `{ disconnected, pagesDeleted, commentsKept }`, also when
 * there was nothing to delete (`disconnected: false`). Works without Meta configured (no Graph).
 */
@Controller('workspaces/:workspaceId/meta/connection')
@UseGuards(WorkspaceAccessGuard)
@Roles('owner', 'admin')
export class MetaConnectionController {
  constructor(private readonly disconnects: MetaDisconnectService) {}

  @Delete()
  @HttpCode(200)
  disconnect(
    @Session() session: AuthSession,
    @CurrentWorkspace() workspace: WorkspaceContext,
  ): Promise<MetaDisconnectResponse> {
    return this.disconnects.disconnect(session, workspace);
  }
}
