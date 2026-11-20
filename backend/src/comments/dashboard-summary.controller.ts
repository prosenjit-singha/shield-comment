import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import type { WorkspaceContext } from '../auth/auth-session.js';
import { CurrentWorkspace } from '../auth/decorators/current-workspace.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { WorkspaceAccessGuard } from '../auth/guards/workspace-access.guard.js';
import type { Database } from '../db/database.js';
import { workspaceDashboardSummary } from './dashboard-summary.js';
import {
  DEFAULT_SUMMARY_RANGE,
  DashboardSummaryQueryDto,
  type DashboardSummaryResponse,
} from './dto/dashboard-summary.dto.js';

/**
 * Client dashboard summary (M6-T5, D10 a). D7: every member role reads it, impersonated sessions
 * too (the guard keeps them on their own workspace); non-members get 404.
 */
@Controller('workspaces/:workspaceId/dashboard')
@UseGuards(WorkspaceAccessGuard)
@Roles('owner', 'admin', 'moderator')
export class DashboardSummaryController {
  constructor(@InjectDrizzle() private readonly db: Database) {}

  @Get('summary')
  summary(
    @CurrentWorkspace() workspace: WorkspaceContext,
    @Query() query: DashboardSummaryQueryDto,
  ): Promise<DashboardSummaryResponse> {
    return workspaceDashboardSummary(
      this.db,
      workspace.id,
      query.range ?? DEFAULT_SUMMARY_RANGE,
      new Date(),
    );
  }
}
