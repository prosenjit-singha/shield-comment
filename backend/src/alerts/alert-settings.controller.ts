import {
  Body,
  Controller,
  Get,
  Header,
  Patch,
  UseGuards,
} from '@nestjs/common';
import type { WorkspaceContext } from '../auth/auth-session.js';
import { CurrentWorkspace } from '../auth/decorators/current-workspace.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { WorkspaceAccessGuard } from '../auth/guards/workspace-access.guard.js';
import { AlertSettingsService } from './alert-settings.service.js';
import {
  type AlertSettingsResponse,
  UpdateAlertSettingsDto,
} from './dto/alert-settings.dto.js';

/**
 * C12 alert settings (M7-T7, reading 12): every member reads, owner/admin edit (moderators 403,
 * non-members 404). D2: an impersonated session may read and edit them.
 */
@Controller('workspaces/:workspaceId/alerts/settings')
@UseGuards(WorkspaceAccessGuard)
export class AlertSettingsController {
  constructor(private readonly settings: AlertSettingsService) {}

  @Get()
  @Header('Cache-Control', 'private, no-store')
  get(
    @CurrentWorkspace() workspace: WorkspaceContext,
  ): Promise<AlertSettingsResponse> {
    return this.settings.get(workspace.id);
  }

  /** Partial body; errors listed in `dto/alert-settings.dto.ts`. */
  @Patch()
  @Roles('owner', 'admin')
  update(
    @CurrentWorkspace() workspace: WorkspaceContext,
    @Body() dto: UpdateAlertSettingsDto,
  ): Promise<AlertSettingsResponse> {
    return this.settings.update(workspace.id, dto);
  }
}
