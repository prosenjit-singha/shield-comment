import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import type { WorkspaceContext } from '../auth/auth-session.js';
import { CurrentWorkspace } from '../auth/decorators/current-workspace.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { WorkspaceAccessGuard } from '../auth/guards/workspace-access.guard.js';
import {
  PlaygroundTestDto,
  type PlaygroundTestResponse,
} from './dto/playground.dto.js';
import { PlaygroundService } from './playground.js';

/**
 * Moderation playground (M6-T7). D7: every member role, impersonated sessions too (the guard
 * keeps them on their own workspace); non-members get 404. Contract in `dto/playground.dto.ts`.
 */
@Controller('workspaces/:workspaceId/playground')
@UseGuards(WorkspaceAccessGuard)
@Roles('owner', 'admin', 'moderator')
export class PlaygroundController {
  constructor(private readonly playground: PlaygroundService) {}

  @Post('test')
  @HttpCode(HttpStatus.OK)
  test(
    @CurrentWorkspace() workspace: WorkspaceContext,
    @Body() dto: PlaygroundTestDto,
  ): Promise<PlaygroundTestResponse> {
    return this.playground.test(workspace.id, dto);
  }
}
