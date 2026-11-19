import { Controller, Get, Header, UseGuards } from '@nestjs/common';
import type { WorkspaceContext } from '../auth/auth-session.js';
import { CurrentWorkspace } from '../auth/decorators/current-workspace.decorator.js';
import { WorkspaceAccessGuard } from '../auth/guards/workspace-access.guard.js';
import { BillingSummaryService } from './billing-summary.service.js';
import type { BillingSummary } from './dto/billing-summary.dto.js';

/**
 * Client billing summary (PW-T6, plan §3.7): **any member** (owner, admin, moderator; no
 * `@Roles`), an impersonated session too (the guard keeps it on its own workspace); non-member or
 * unknown workspace 404, no session 401. Not cached (`no-store`): usage moves with every comment.
 */
@Controller('workspaces/:workspaceId/billing')
@UseGuards(WorkspaceAccessGuard)
export class BillingSummaryController {
  constructor(private readonly billing: BillingSummaryService) {}

  @Get('summary')
  @Header('Cache-Control', 'private, no-store')
  summary(
    @CurrentWorkspace() workspace: WorkspaceContext,
  ): Promise<BillingSummary> {
    return this.billing.summary(workspace.id);
  }
}
