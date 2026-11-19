import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import type { WorkspaceContext } from '../auth/auth-session.js';
import { CurrentWorkspace } from '../auth/decorators/current-workspace.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { WorkspaceAccessGuard } from '../auth/guards/workspace-access.guard.js';
import {
  type ModerationPolicyResponse,
  type ModerationPolicyUpdateResponse,
  UpdateModerationPolicyDto,
} from './dto/moderation-policy.dto.js';
import { ModerationPolicyService } from './moderation-policy.service.js';

/**
 * Workspace moderation policy (M5-T8, D5): owner/admin only (moderator/member 403, non-member
 * 404). Like the Page toggle, an impersonated session may read and edit it (the guard keeps it on
 * its own workspace). Module 6 `/rules` and the M5-T15 "AI analysis" card build on it.
 */
@Controller('workspaces/:workspaceId/moderation/policy')
@UseGuards(WorkspaceAccessGuard)
@Roles('owner', 'admin')
export class ModerationPolicyController {
  constructor(private readonly policies: ModerationPolicyService) {}

  @Get()
  get(
    @CurrentWorkspace() workspace: WorkspaceContext,
  ): Promise<ModerationPolicyResponse> {
    return this.policies.get(workspace.id);
  }

  /** Partial body (`UpdateModerationPolicyDto`); errors listed in `dto/moderation-policy.dto.ts`. */
  @Patch()
  update(
    @CurrentWorkspace() workspace: WorkspaceContext,
    @Body() dto: UpdateModerationPolicyDto,
  ): Promise<ModerationPolicyUpdateResponse> {
    return this.policies.update(workspace.id, dto);
  }
}
