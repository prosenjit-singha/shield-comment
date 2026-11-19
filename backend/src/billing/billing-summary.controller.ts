import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Header,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Session } from '@thallesp/nestjs-better-auth';
import type { AuthSession, WorkspaceContext } from '../auth/auth-session.js';
import { CurrentWorkspace } from '../auth/decorators/current-workspace.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { WorkspaceAccessGuard } from '../auth/guards/workspace-access.guard.js';
import { BillingSummaryService } from './billing-summary.service.js';
import type { BillingSummary } from './dto/billing-summary.dto.js';
import { StartTrialDto } from './dto/start-trial.dto.js';
import { SubscriptionService } from './subscription.service.js';

/**
 * Client billing routes under `workspaces/:workspaceId/billing` (non-member or unknown workspace
 * 404, no session 401):
 * - `GET summary` (PW-T6, plan §3.7): **any member**, an impersonated session too (the guard keeps
 *   it on its own workspace). Not cached (`no-store`): usage moves with every comment.
 * - `POST trial` (PR-T3, PR-D10): **owner only** (others 403); an impersonated session is refused
 *   (403: an admin never starts a client's trial). 201 + the new summary.
 */
@Controller('workspaces/:workspaceId/billing')
@UseGuards(WorkspaceAccessGuard)
export class BillingSummaryController {
  constructor(
    private readonly billing: BillingSummaryService,
    private readonly subscriptions: SubscriptionService,
  ) {}

  @Get('summary')
  @Header('Cache-Control', 'private, no-store')
  summary(
    @CurrentWorkspace() workspace: WorkspaceContext,
  ): Promise<BillingSummary> {
    return this.billing.summary(workspace.id);
  }

  @Post('trial')
  @Roles('owner')
  @Header('Cache-Control', 'private, no-store')
  async startTrial(
    @Session() session: AuthSession,
    @CurrentWorkspace() workspace: WorkspaceContext,
    @Body() body: StartTrialDto,
  ): Promise<BillingSummary> {
    if (session.session.impersonatedBy) {
      throw new ForbiddenException(
        'Starting a trial is not allowed while impersonating',
      );
    }
    await this.subscriptions.startTrial(workspace.id, body.planId);
    return this.billing.summary(workspace.id);
  }
}
