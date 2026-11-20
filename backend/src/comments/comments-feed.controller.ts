import {
  Body,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { Session } from '@thallesp/nestjs-better-auth';
import type { AuthSession, WorkspaceContext } from '../auth/auth-session.js';
import { CurrentWorkspace } from '../auth/decorators/current-workspace.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { WorkspaceAccessGuard } from '../auth/guards/workspace-access.guard.js';
import type { Database } from '../db/database.js';
import { ModerationActionExecutor } from '../moderation/moderation-action.executor.js';
import { overrideError, toOverrideInput } from './comment-override.js';
import { listCommentsFeed, toFeedFilter } from './comments-feed.js';
import { CommentOverrideDto } from './dto/comment-override.dto.js';
import {
  type CommentFeedItem,
  CommentsFeedQueryDto,
  type CommentsFeedResponse,
} from './dto/comments-feed.dto.js';

/**
 * Workspace comments feed (M6-T3). D7 (2026-11-20): every member role may read it, impersonated
 * sessions too (the guard keeps them on their own workspace); non-members get 404.
 *
 * M6-T4 `POST :commentId/override` (D7/D8): every member acts, impersonated sessions too (the
 * `moderation_actions` row carries the session user). → `ModerationActionExecutor` (USER stamps
 * `overridden_at`, so the AI never changes the comment again) → 200 + the updated feed item.
 * Errors: see `overrideError` (404 / 409 `code` / 503 / 502).
 */
@Controller('workspaces/:workspaceId/comments')
@UseGuards(WorkspaceAccessGuard)
@Roles('owner', 'admin', 'moderator')
export class CommentsFeedController {
  constructor(
    @InjectDrizzle() private readonly db: Database,
    private readonly executor: ModerationActionExecutor,
  ) {}

  @Get()
  list(
    @CurrentWorkspace() workspace: WorkspaceContext,
    @Query() query: CommentsFeedQueryDto,
  ): Promise<CommentsFeedResponse> {
    return listCommentsFeed(this.db, workspace.id, toFeedFilter(query));
  }

  @Post(':commentId/override')
  @HttpCode(200)
  async override(
    @CurrentWorkspace() workspace: WorkspaceContext,
    @Session() session: AuthSession,
    @Param('commentId') commentId: string,
    @Body() body: CommentOverrideDto,
  ): Promise<CommentFeedItem> {
    const result = await this.executor.execute(
      toOverrideInput(workspace.id, commentId, session.user.id, body),
    );
    const error = overrideError(result);
    if (error) throw error;
    const { items } = await listCommentsFeed(this.db, workspace.id, {
      commentId,
      limit: 1,
    });
    if (!items[0]) throw new NotFoundException('Comment not found');
    return items[0];
  }
}
