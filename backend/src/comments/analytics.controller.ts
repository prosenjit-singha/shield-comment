import {
  Controller,
  Get,
  Query,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import type { WorkspaceContext } from '../auth/auth-session.js';
import { CurrentWorkspace } from '../auth/decorators/current-workspace.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { WorkspaceAccessGuard } from '../auth/guards/workspace-access.guard.js';
import type { Database } from '../db/database.js';
import {
  commentsExport,
  type CsvExport,
  dailyStatsExport,
  workspaceAnalytics,
} from './analytics.js';
import {
  AnalyticsQueryDto,
  type AnalyticsResponse,
} from './dto/analytics.dto.js';

/** UTF-8 CSV download (the builder already starts it with a BOM for Excel). */
const csvFile = ({ filename, csv }: CsvExport) =>
  new StreamableFile(Buffer.from(csv, 'utf8'), {
    type: 'text/csv; charset=utf-8',
    disposition: `attachment; filename="${filename}"`,
  });

/**
 * Workspace analytics + CSV exports (M6-T6; D11 a, D12 b). D7: every member role reads them,
 * impersonated sessions too (the guard keeps them on their own workspace); non-members get 404.
 * The per-comment CSV needs the Pro flag `whiteLabelReports` (409 otherwise).
 */
@Controller('workspaces/:workspaceId/analytics')
@UseGuards(WorkspaceAccessGuard)
@Roles('owner', 'admin', 'moderator')
export class AnalyticsController {
  constructor(@InjectDrizzle() private readonly db: Database) {}

  @Get()
  analytics(
    @CurrentWorkspace() workspace: WorkspaceContext,
    @Query() query: AnalyticsQueryDto,
  ): Promise<AnalyticsResponse> {
    return workspaceAnalytics(this.db, workspace.id, query, new Date());
  }

  @Get('export.csv')
  async exportCsv(
    @CurrentWorkspace() workspace: WorkspaceContext,
    @Query() query: AnalyticsQueryDto,
  ): Promise<StreamableFile> {
    return csvFile(
      await dailyStatsExport(this.db, workspace.id, query, new Date()),
    );
  }

  @Get('comments.csv')
  async commentsCsv(
    @CurrentWorkspace() workspace: WorkspaceContext,
    @Query() query: AnalyticsQueryDto,
  ): Promise<StreamableFile> {
    return csvFile(
      await commentsExport(this.db, workspace.id, query, new Date()),
    );
  }
}
