import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import type { WorkspaceContext } from '../auth/auth-session.js';
import { CurrentWorkspace } from '../auth/decorators/current-workspace.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { WorkspaceAccessGuard } from '../auth/guards/workspace-access.guard.js';
import { UpdateWorkspaceDto } from './dto/update-workspace.dto.js';
import { WorkspacesService } from './workspaces.service.js';

/** Workspace settings. Owner/admin only; moderators get 403, non-members 404. */
@Controller('workspaces/:workspaceId')
@UseGuards(WorkspaceAccessGuard)
@Roles('owner', 'admin')
export class WorkspacesController {
  constructor(private readonly workspaces: WorkspacesService) {}

  @Get()
  async get(@CurrentWorkspace() workspace: WorkspaceContext) {
    const found = await this.workspaces.findById(workspace.id);
    return { ...found, role: workspace.role };
  }

  @Patch()
  async update(
    @CurrentWorkspace() workspace: WorkspaceContext,
    @Body() dto: UpdateWorkspaceDto,
  ) {
    const updated = await this.workspaces.rename(workspace.id, dto.name);
    return { ...updated, role: workspace.role };
  }
}
