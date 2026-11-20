import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Session } from '@thallesp/nestjs-better-auth';
import type { Request } from 'express';
import type { AuthSession } from '../auth/auth-session.js';
import { SuperAdminGuard } from '../auth/guards/super-admin.guard.js';
import { AdminAiService, type TopupActor } from './admin-ai.service.js';
import { requestIp } from './admin-impersonation.service.js';
import {
  type AiAnalysesResponse,
  type AiCreditTopup,
  type AiCreditTopupsResponse,
  type AiSpendSummary,
  CreateAiCreditTopupDto,
  ListAiAnalysesQueryDto,
} from './dto/admin-ai.dto.js';
import { auditUserAgent } from './plan-rules.js';

/**
 * Admin AI analysis log, spend summary and credit top-ups (M5-T15d, D25/D26). Platform-wide
 * (every workspace), super admin only: not tenant routes. Shapes: `src/admin/dto/admin-ai.dto.ts`.
 */
@Controller('admin/ai')
@UseGuards(SuperAdminGuard)
export class AdminAiController {
  constructor(private readonly ai: AdminAiService) {}

  @Get('analyses')
  analyses(
    @Query() query: ListAiAnalysesQueryDto,
  ): Promise<AiAnalysesResponse> {
    return this.ai.analyses(query.limit);
  }

  @Get('summary')
  summary(): Promise<AiSpendSummary> {
    return this.ai.summary();
  }

  @Get('credit-topups')
  listTopups(): Promise<AiCreditTopupsResponse> {
    return this.ai.listTopups();
  }

  @Post('credit-topups')
  addTopup(
    @Body() body: CreateAiCreditTopupDto,
    @Session() session: AuthSession,
    @Req() req: Request,
  ): Promise<{ topup: AiCreditTopup }> {
    return this.ai.addTopup(body, actor(session, req));
  }

  @Delete('credit-topups/:id')
  @HttpCode(204)
  deleteTopup(
    @Param('id') id: string,
    @Session() session: AuthSession,
    @Req() req: Request,
  ): Promise<void> {
    return this.ai.deleteTopup(id, actor(session, req));
  }
}

function actor(session: AuthSession, req: Request): TopupActor {
  return {
    adminId: session.user.id,
    adminName: session.user.name,
    ipAddress: requestIp(req),
    userAgent: auditUserAgent(req.headers['user-agent']),
  };
}
