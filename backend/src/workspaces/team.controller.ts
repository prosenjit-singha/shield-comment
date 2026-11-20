import { Controller, Get, Header, UseGuards } from '@nestjs/common';
import type { WorkspaceContext } from '../auth/auth-session.js';
import { CurrentWorkspace } from '../auth/decorators/current-workspace.decorator.js';
import { WorkspaceAccessGuard } from '../auth/guards/workspace-access.guard.js';
import { TeamService, type TeamView } from './team.service.js';

/**
 * `GET /api/workspaces/:workspaceId/team` (C11, M7-T6, reading 5): every member, an impersonated
 * session too (D2; the guard keeps it on its own workspace); non-members 404. Team changes go
 * through the Better Auth organization endpoints (no wrapper write routes).
 */
@Controller('workspaces/:workspaceId/team')
@UseGuards(WorkspaceAccessGuard)
export class TeamController {
  constructor(private readonly team: TeamService) {}

  @Get()
  @Header('Cache-Control', 'private, no-store')
  get(@CurrentWorkspace() workspace: WorkspaceContext): Promise<TeamView> {
    return this.team.team(workspace.id);
  }
}
