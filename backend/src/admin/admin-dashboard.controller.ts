import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { SuperAdminGuard } from '../auth/guards/super-admin.guard.js';
import { AdminDashboardService } from './admin-dashboard.service.js';
import {
  DashboardStatsQueryDto,
  type DashboardStatsResponse,
} from './dto/dashboard-stats.dto.js';

@Controller('admin/dashboard')
@UseGuards(SuperAdminGuard)
export class AdminDashboardController {
  constructor(private readonly dashboard: AdminDashboardService) {}

  /**
   * KPIs + chart series, bucketed by Asia/Dhaka day (`7d`/`30d`/`90d`, default `30d`) or month
   * (`12m`), or a custom `from`/`to` (≤ 92 days daily, else monthly, ≤ 24 months).
   * See `DashboardStatsResponse` for the shape.
   */
  @Get('stats')
  stats(
    @Query() query: DashboardStatsQueryDto,
  ): Promise<DashboardStatsResponse> {
    return this.dashboard.stats(query);
  }
}
