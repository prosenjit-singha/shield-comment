import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import type { WorkspaceContext } from '../auth/auth-session.js';
import { CurrentWorkspace } from '../auth/decorators/current-workspace.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { WorkspaceAccessGuard } from '../auth/guards/workspace-access.guard.js';
import type { Database } from '../db/database.js';
import { listCommentsFeed, toFeedFilter } from './comments-feed.js';
import {
  CommentsFeedQueryDto,
  type CommentsFeedResponse,
} from './dto/comments-feed.dto.js';

/**
 * Workspace comments feed (M6-T3). D7 (2026-11-20): every member role may read it, impersonated
 * sessions too (the guard keeps them on their own workspace); non-members get 404.
 */
@Controller('workspaces/:workspaceId/comments')
@UseGuards(WorkspaceAccessGuard)
@Roles('owner', 'admin', 'moderator')
export class CommentsFeedController {
  constructor(@InjectDrizzle() private readonly db: Database) {}

  @Get()
  list(
    @CurrentWorkspace() workspace: WorkspaceContext,
    @Query() query: CommentsFeedQueryDto,
  ): Promise<CommentsFeedResponse> {
    return listCommentsFeed(this.db, workspace.id, toFeedFilter(query));
  }
}
