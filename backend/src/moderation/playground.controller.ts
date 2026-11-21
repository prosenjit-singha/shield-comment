import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import type { WorkspaceContext } from '../auth/auth-session.js';
import { CurrentWorkspace } from '../auth/decorators/current-workspace.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { WorkspaceAccessGuard } from '../auth/guards/workspace-access.guard.js';
import {
  PlaygroundTestDto,
  type PlaygroundTestResponse,
  type PlaygroundUsageResponse,
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

  /** Today's limit, use and reset time (read only; never counts a test). */
  @Get('usage')
  usage(
    @CurrentWorkspace() workspace: WorkspaceContext,
  ): Promise<PlaygroundUsageResponse> {
    return this.playground.usage(workspace.id);
  }

  @Post('test')
  // Own daily limit, so not the global one too (M9-T2).
  @SkipThrottle({ global: true })
  @HttpCode(HttpStatus.OK)
  test(
    @CurrentWorkspace() workspace: WorkspaceContext,
    @Body() dto: PlaygroundTestDto,
  ): Promise<PlaygroundTestResponse> {
    return this.playground.test(workspace.id, dto);
  }
}
