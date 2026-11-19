import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  UseGuards,
} from '@nestjs/common';
import type { WorkspaceContext } from '../auth/auth-session.js';
import { CurrentWorkspace } from '../auth/decorators/current-workspace.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { WorkspaceAccessGuard } from '../auth/guards/workspace-access.guard.js';
import { TogglePageDto } from './dto/toggle-page.dto.js';
import type {
  TogglePageResponse,
  WorkspacePagesResponse,
} from './dto/workspace-pages.dto.js';
import { SocialPagesService } from './social-pages.service.js';

/**
 * Connected Pages of a workspace (M3-T6, D5): owner/admin only (moderator/member 403, non-member
 * 404). Unlike Meta connect, an impersonated session may use both routes (the guard keeps it on
 * its own workspace). Responses never carry tokens or ciphertexts.
 */
@Controller('workspaces/:workspaceId/pages')
@UseGuards(WorkspaceAccessGuard)
@Roles('owner', 'admin')
export class SocialPagesController {
  constructor(private readonly pages: SocialPagesService) {}

  /**
   * `{ items: WorkspacePage[], pageLimit: { limit, activeCount }, connection }`; `pageLimit` is
   * pooled across the billing account (PW-T5; no live plan → `limit` 0).
   */
  @Get()
  list(
    @CurrentWorkspace() workspace: WorkspaceContext,
  ): Promise<WorkspacePagesResponse> {
    return this.pages.list(workspace.id);
  }

  /**
   * `{ isActive }` → `{ page, changed }`. 400 non-uuid id / bad body, 404 not this workspace's Page,
   * 409 `code: CONNECTION_NEEDS_REAUTH`, `PAGE_TOKEN_MISSING`, `NO_ACTIVE_PLAN` (PW-T5) or
   * `PAGE_LIMIT_REACHED` (`details: { limit, activeCount }`, pooled per billing account),
   * switch-on only (M4-T8): 502 `code: META_SUBSCRIBE_FAILED` (Graph `subscribed_apps` failed,
   * nothing changed), 503 when Meta or the token cipher is not configured.
   */
  @Patch(':id/toggle')
  toggle(
    @CurrentWorkspace() workspace: WorkspaceContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: TogglePageDto,
  ): Promise<TogglePageResponse> {
    return this.pages.toggle(workspace.id, id.toLowerCase(), dto.isActive);
  }
}
