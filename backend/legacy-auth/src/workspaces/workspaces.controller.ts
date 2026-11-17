import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, UseGuards } from '@nestjs/common';
import type { AccessTokenPayload, WorkspaceContext } from '../auth/auth.types.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { UpdateWorkspaceDto } from './dto/update-workspace.dto.js';
import { WorkspaceAccessGuard } from './workspace-access.guard.js';
import { CurrentWorkspace, WorkspaceRoles } from './workspace-roles.decorator.js';
import { WorkspacesService } from './workspaces.service.js';

@Controller('workspaces')
export class WorkspacesController {
  constructor(private readonly workspaces: WorkspacesService) {}

  /** Workspaces the caller belongs to (only the impersonated one for impersonation tokens). */
  @Get()
  list(@CurrentUser() user: AccessTokenPayload) {
    return this.workspaces.listForUser(user.sub, user.workspaceId);
  }

  @Get(':workspaceId')
  @UseGuards(WorkspaceAccessGuard)
  async get(
    @Param('workspaceId', ParseUUIDPipe) _workspaceId: string,
    @CurrentWorkspace() workspace: WorkspaceContext,
  ) {
    const found = await this.workspaces.findById(workspace.id);
    return { ...found, role: workspace.role };
  }

  @Patch(':workspaceId')
  @UseGuards(WorkspaceAccessGuard)
  @WorkspaceRoles('OWNER', 'ADMIN')
  rename(
    @Param('workspaceId', ParseUUIDPipe) _workspaceId: string,
    @CurrentWorkspace() workspace: WorkspaceContext,
    @Body() dto: UpdateWorkspaceDto,
  ) {
    return this.workspaces.rename(workspace.id, dto.name);
  }
}
