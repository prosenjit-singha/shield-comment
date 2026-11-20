import { BadRequestException } from '@nestjs/common';
import { and, desc, eq, gt, gte, ilike, inArray, lt, sql } from 'drizzle-orm';
import { escapeLike } from '../admin/client-list-query.js';
import { addDays, dhakaMidnight } from '../admin/dashboard-range.js';
import type { Database } from '../db/database.js';
import {
  comments,
  type CommentPlatform,
  type CommentStatus,
  moderationActions,
  socialPages,
} from '../db/schema/index.js';
import type { ModerationCategory } from '../moderation/moderation.constants.js';
import type {
  CommentFeedAction,
  CommentsFeedQueryDto,
  CommentsFeedResponse,
} from './dto/comments-feed.dto.js';

/**
 * Workspace comments feed (M6-T3): newest first, keyset paging over (`created_at` desc, `id`
 * desc), served by the `comments (workspace_id, created_at desc)` index. Every query is scoped
 * by `workspace_id` (the Page join and the action lookup too).
 */

export interface FeedCursor {
  createdAt: Date;
  id: string;
}

export interface CommentsFeedFilter {
  /** One comment (`comments.id`): the override answer (M6-T4). */
  commentId?: string;
  status?: CommentStatus;
  category?: ModerationCategory;
  platform?: CommentPlatform;
  /** `social_pages.id`. */
  pageId?: string;
  /** Inclusive lower bound (Dhaka midnight of `from`). */
  start?: Date;
  /** Exclusive upper bound (Dhaka midnight of the day after `to`). */
  end?: Date;
  q?: string;
  since?: Date;
  cursor?: FeedCursor;
  limit: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Opaque cursor: base64url of `<created_at ISO>|<id>`. */
export function encodeFeedCursor(cursor: FeedCursor): string {
  return Buffer.from(`${cursor.createdAt.toISOString()}|${cursor.id}`).toString(
    'base64url',
  );
}

/** `undefined` = not a cursor this API issued. */
export function decodeFeedCursor(raw: string): FeedCursor | undefined {
  if (!/^[A-Za-z0-9_-]+$/.test(raw)) return undefined;
  const [iso, id, ...rest] = Buffer.from(raw, 'base64url')
    .toString('utf8')
    .split('|');
  if (rest.length > 0 || !iso || !id || !UUID.test(id)) return undefined;
  const createdAt = new Date(iso);
  if (Number.isNaN(createdAt.getTime()) || createdAt.toISOString() !== iso) {
    return undefined;
  }
  return { createdAt, id };
}

/** Validated query → filter. 400 on a bad cursor or `from` after `to`. */
export function toFeedFilter(query: CommentsFeedQueryDto): CommentsFeedFilter {
  const { from, to, since, cursor, ...rest } = query;
  if (from && to && from > to) {
    throw new BadRequestException('from must not be after to');
  }
  const decoded = cursor === undefined ? undefined : decodeFeedCursor(cursor);
  if (cursor !== undefined && !decoded) {
    throw new BadRequestException('cursor is invalid');
  }
  return {
    ...rest,
    start: from ? dhakaMidnight(from) : undefined,
    end: to ? dhakaMidnight(addDays(to, 1)) : undefined,
    since: since ? new Date(since) : undefined,
    cursor: decoded,
  };
}

export async function listCommentsFeed(
  db: Pick<Database, 'select' | 'selectDistinctOn'>,
  workspaceId: string,
  filter: CommentsFeedFilter,
): Promise<CommentsFeedResponse> {
  const conditions = [eq(comments.workspaceId, workspaceId)];
  if (filter.commentId) conditions.push(eq(comments.id, filter.commentId));
  if (filter.status) conditions.push(eq(comments.status, filter.status));
  if (filter.category) conditions.push(eq(comments.category, filter.category));
  if (filter.platform) conditions.push(eq(comments.platform, filter.platform));
  if (filter.pageId) conditions.push(eq(comments.socialPageId, filter.pageId));
  if (filter.start) conditions.push(gte(comments.createdAt, filter.start));
  if (filter.end) conditions.push(lt(comments.createdAt, filter.end));
  if (filter.since) conditions.push(gt(comments.createdAt, filter.since));
  if (filter.q) {
    conditions.push(ilike(comments.message, `%${escapeLike(filter.q)}%`));
  }
  if (filter.cursor) {
    conditions.push(
      sql`(${comments.createdAt}, ${comments.id}) < (${filter.cursor.createdAt.toISOString()}::timestamptz, ${filter.cursor.id}::uuid)`,
    );
  }

  const rows = await db
    .select({
      id: comments.id,
      platform: comments.platform,
      pageId: socialPages.id,
      pageName: socialPages.pageName,
      postId: comments.postId,
      authorName: comments.authorName,
      message: comments.message,
      status: comments.status,
      statusReason: comments.statusReason,
      category: comments.category,
      confidence: comments.confidence,
      language: comments.language,
      reasoning: comments.reasoning,
      ruleMatch: comments.ruleMatch,
      overriddenAt: comments.overriddenAt,
      editedAt: comments.editedAt,
      createdAt: comments.createdAt,
    })
    .from(comments)
    .leftJoin(
      socialPages,
      and(
        eq(socialPages.id, comments.socialPageId),
        eq(socialPages.workspaceId, workspaceId),
      ),
    )
    .where(and(...conditions))
    .orderBy(desc(comments.createdAt), desc(comments.id))
    .limit(filter.limit + 1);

  const page = rows.slice(0, filter.limit);
  const last = page.at(-1);
  const nextCursor =
    rows.length > filter.limit && last ? encodeFeedCursor(last) : null;

  const actions = new Map<string, CommentFeedAction>();
  if (page.length > 0) {
    const latest = await db
      .selectDistinctOn([moderationActions.commentId], {
        commentId: moderationActions.commentId,
        action: moderationActions.action,
        source: moderationActions.source,
        state: moderationActions.state,
        completedAt: moderationActions.completedAt,
        createdAt: moderationActions.createdAt,
      })
      .from(moderationActions)
      .where(
        and(
          eq(moderationActions.workspaceId, workspaceId),
          inArray(
            moderationActions.commentId,
            page.map((row) => row.id),
          ),
        ),
      )
      .orderBy(
        moderationActions.commentId,
        desc(moderationActions.createdAt),
        desc(moderationActions.id),
      );
    for (const a of latest) {
      actions.set(a.commentId, {
        action: a.action,
        source: a.source,
        state: a.state,
        at: a.completedAt ?? a.createdAt,
      });
    }
  }

  return {
    items: page.map(({ pageId, pageName, ...row }) => ({
      ...row,
      page: pageId && pageName ? { id: pageId, name: pageName } : null,
      lastAction: actions.get(row.id) ?? null,
    })),
    nextCursor,
  };
}
