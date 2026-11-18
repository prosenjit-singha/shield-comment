import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Query,
  UseGuards,
} from '@nestjs/common';
import { SuperAdminGuard } from '../auth/guards/super-admin.guard.js';
import { AdminPlansService } from './admin-plans.service.js';
import {
  type AdminPlansResponse,
  type AdminPlanUpdateResponse,
  ListPlansQueryDto,
  UpdatePlanDto,
} from './dto/plans.dto.js';

/** A7 `/admin/settings` API (M2-T11). Response types: `src/admin/dto/plans.dto.ts`. */
@Controller('admin/settings')
@UseGuards(SuperAdminGuard)
export class AdminSettingsController {
  constructor(private readonly plans: AdminPlansService) {}

  /** `{ items: AdminPlan[] }`, ordered by `sortOrder`. */
  @Get('plans')
  listPlans(
    // Unused: only there so unknown query params get a 400 from the global ValidationPipe.
    @Query() _query: ListPlansQueryDto,
  ): Promise<AdminPlansResponse> {
    return this.plans.list();
  }

  /**
   * One plan per request (the A7 editor saves each plan card on its own): partial body →
   * `{ plan }`. 400 invalid / empty / offer > original, 404 unknown plan.
   */
  @Patch('plans/:planId')
  updatePlan(
    @Param('planId') planId: string,
    @Body() body: UpdatePlanDto,
  ): Promise<AdminPlanUpdateResponse> {
    return this.plans.update(planId, body);
  }
}
