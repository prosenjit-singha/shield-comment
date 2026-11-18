import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { SuperAdminGuard } from '../auth/guards/super-admin.guard.js';
import { AdminSystemService } from './admin-system.service.js';
import {
  SystemHealthQueryDto,
  type SystemHealthResponse,
} from './dto/system-health.dto.js';

@Controller('admin/system')
@UseGuards(SuperAdminGuard)
export class AdminSystemController {
  constructor(private readonly system: AdminSystemService) {}

  /**
   * DB/Redis status + latency, process info, queue counts, latest migration. Always 200 (down
   * dependencies are in the body). Queries the DB: never point an uptime monitor here.
   */
  @Get('health')
  health(
    // Unused: only there so unknown query params get a 400 from the global ValidationPipe.
    @Query() _query: SystemHealthQueryDto,
  ): Promise<SystemHealthResponse> {
    return this.system.health();
  }
}
