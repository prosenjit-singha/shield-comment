import {
  Body,
  Controller,
  Get,
  HttpCode,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Session } from '@thallesp/nestjs-better-auth';
import type { Request } from 'express';
import type { AuthSession } from '../auth/auth-session.js';
import { SuperAdminGuard } from '../auth/guards/super-admin.guard.js';
import { AdminAiSettingsService } from './admin-ai-settings.service.js';
import { requestIp } from './admin-impersonation.service.js';
import {
  type AiConnectionTestResponse,
  type AiSettingsAuditList,
  type AiSettingsResponse,
  ListAiSettingsAuditQueryDto,
  TestAiConnectionDto,
  UpdateAiSettingsDto,
} from './dto/ai-settings.dto.js';
import { auditUserAgent } from './plan-rules.js';

/**
 * A7 `/admin/settings` "AI provider" API (M5-T3, D16). Types: `src/admin/dto/ai-settings.dto.ts`.
 * No response ever contains an API key (only `last4` + source).
 */
@Controller('admin/settings/ai')
@UseGuards(SuperAdminGuard)
export class AdminAiSettingsController {
  constructor(private readonly settings: AdminAiSettingsService) {}

  /** Effective provider + model (with sources) and per-provider key status. */
  @Get()
  get(): Promise<AiSettingsResponse> {
    return this.settings.get();
  }

  /**
   * `{ provider?, model?, keys?: { <provider>: key | null } }` → the GET shape. 400 invalid/empty,
   * 503 `KEY_ENCRYPTION_NOT_CONFIGURED` on a key save without a token cipher.
   */
  @Patch()
  update(
    @Body() body: UpdateAiSettingsDto,
    @Session() session: AuthSession,
    @Req() req: Request,
  ): Promise<AiSettingsResponse> {
    return this.settings.update(body, {
      adminId: session.user.id,
      ipAddress: requestIp(req),
      userAgent: auditUserAgent(req.headers['user-agent']),
    });
  }

  /** Connection probe with the saved config or a draft `{ provider?, model?, apiKey? }` over it. */
  @Post('test')
  @HttpCode(200)
  test(@Body() body: TestAiConnectionDto): Promise<AiConnectionTestResponse> {
    return this.settings.test({
      provider: body.provider,
      model: body.model,
      apiKey: body.apiKey,
    });
  }

  /** `{ items, total, skip, take }`, newest first. */
  @Get('audit')
  listAudit(
    @Query() query: ListAiSettingsAuditQueryDto,
  ): Promise<AiSettingsAuditList> {
    return this.settings.listAudit(query);
  }
}
