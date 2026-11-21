import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { Session } from '@thallesp/nestjs-better-auth';
import type { AuthSession, WorkspaceContext } from '../auth/auth-session.js';
import { CurrentWorkspace } from '../auth/decorators/current-workspace.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { WorkspaceAccessGuard } from '../auth/guards/workspace-access.guard.js';
import {
  AlertDispatchService,
  type TestAlertResponse,
} from './alert-dispatch.service.js';
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

/**
 * "Send test alert" (M7-T9, reading 12): owner/admin; an impersonated session may send one
 * (orchestrator decision 2026-11-20), logged with the session user. Sends through the channels a
 * real alert would use now → 200 `{ deliveries: [{ channel, status, errorKind }] }`; 409
 * `ALERT_NO_CHANNEL`; 429 `ALERT_TEST_RATE_LIMITED` (`details { max: 5 }`, per workspace per hour).
 * No cool-down effect; rows are stored with `is_test` (not the "last alert").
 */
@Controller('workspaces/:workspaceId/alerts/test')
// Own limit (5 / workspace / hour), so not the global one too (M9-T2).
@SkipThrottle({ global: true })
@UseGuards(WorkspaceAccessGuard)
@Roles('owner', 'admin')
export class AlertTestController {
  constructor(private readonly alerts: AlertDispatchService) {}

  @Post()
  @HttpCode(200)
  send(
    @CurrentWorkspace() workspace: WorkspaceContext,
    @Session() session: AuthSession,
  ): Promise<TestAlertResponse> {
    return this.alerts.sendTest(workspace.id, {
      userId: session.user.id,
      impersonatedBy: session.session.impersonatedBy ?? null,
    });
  }
}
