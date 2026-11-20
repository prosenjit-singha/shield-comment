import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Session } from '@thallesp/nestjs-better-auth';
import type { Request } from 'express';
import type { AuthSession } from '../auth/auth-session.js';
import { SuperAdminGuard } from '../auth/guards/super-admin.guard.js';
import { requestIp } from './admin-impersonation.service.js';
import { auditUserAgent } from './plan-rules.js';
import { AdminPlansService } from './admin-plans.service.js';
import {
  type PlatformSettings,
  UpdatePlatformSettingsDto,
} from './dto/platform-settings.dto.js';
import {
  ListPlanAuditQueryDto,
  type PlanAuditList,
} from './dto/plan-audit.dto.js';
import {
  type AdminPlansResponse,
  type AdminPlanUpdateResponse,
  ListPlansQueryDto,
  UpdatePlanDto,
} from './dto/plans.dto.js';

/**
 * A7 `/admin/settings` API (M2-T11, audit log M2-T15). Response types: `src/admin/dto/plans.dto.ts`
 * and `src/admin/dto/plan-audit.dto.ts`.
 */
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
   * Plan edit history `{ items, total, skip, take }`, newest first; `planId` filters one plan.
   * Declared before `plans/:planId` for readability (that route is PATCH only, so no clash).
   */
  @Get('plans/audit')
  listPlanAudit(@Query() query: ListPlanAuditQueryDto): Promise<PlanAuditList> {
    return this.plans.listAudit(query);
  }

  /**
   * One plan per request (the A7 editor saves each plan card on its own): partial body →
   * `{ plan }`. 400 invalid / empty / yearly > monthly, 404 unknown plan. A real change writes a
   * `plan_audit_logs` row (who, changed fields before → after, IP, user agent); a no-op doesn't.
   */
  @Patch('plans/:planId')
  updatePlan(
    @Param('planId') planId: string,
    @Body() body: UpdatePlanDto,
    @Session() session: AuthSession,
    @Req() req: Request,
  ): Promise<AdminPlanUpdateResponse> {
    return this.plans.update(planId, body, {
      adminId: session.user.id,
      ipAddress: requestIp(req),
      userAgent: auditUserAgent(req.headers['user-agent']),
    });
  }

  /** Support WhatsApp number (PR-T4, PR-D18) + playground daily limit (M6-T7b): `PlatformSettings`. */
  @Get('platform')
  platformSettings(): Promise<PlatformSettings> {
    return this.plans.platformSettings();
  }

  /** Partial body, at least one key (400 otherwise); absent keys keep their value. */
  @Patch('platform')
  updatePlatformSettings(
    @Body() body: UpdatePlatformSettingsDto,
    @Session() session: AuthSession,
  ): Promise<PlatformSettings> {
    return this.plans.updatePlatformSettings(body, session.user.id);
  }
}
