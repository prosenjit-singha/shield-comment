import { createHash } from 'node:crypto';
import { and, desc, eq, sql } from 'drizzle-orm';
import { dhakaBucketKey } from '../admin/dashboard-range.js';
import type { Database } from '../db/database.js';
import {
  comments,
  dailyCommentStats,
  webhookEvents,
  type CommentPlatform,
} from '../db/schema/index.js';

/**
 * Storage helpers for webhook ingestion (M4-T2). The M4-T5 worker calls them inside its tx;
 * routing and verb rules (D2/D4) live in the worker, not here. Every query is scoped by
 * `workspace_id` except the global unique-key inserts (a Meta comment id belongs to one
 * workspace, D7 of Module 3).
 */

/** A database or a transaction. */
export type CommentsExecutor = Pick<Database, 'select' | 'insert' | 'update'>;

export type NewComment = typeof comments.$inferInsert;
export type CommentRow = typeof comments.$inferSelect;
export type DailyCommentStatsRow = typeof dailyCommentStats.$inferSelect;

/** A comment as lists show it (no `raw_payload`). */
export type WorkspaceComment = Omit<CommentRow, 'rawPayload'>;

/** Asia/Dhaka calendar day (`YYYY-MM-DD`) of an instant: the `daily_comment_stats.day` key. */
export function dhakaDayKey(instant: Date = new Date()): string {
  return dhakaBucketKey(instant, 'day');
}

/** `webhook_events.payload_hash`: sha256 hex of the change payload as JSON. */
export function webhookPayloadHash(payload: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(payload ?? null))
    .digest('hex');
}

/**
 * Records a webhook event. `true` = new; `false` = `event_id` already recorded (duplicate
 * delivery or job retry after commit), nothing written.
 */
export async function insertWebhookEvent(
  executor: CommentsExecutor,
  values: { eventId: string; workspaceId: string; payloadHash: string },
): Promise<boolean> {
  const rows = await executor
    .insert(webhookEvents)
    .values(values)
    .onConflictDoNothing({ target: webhookEvents.eventId })
    .returning({ id: webhookEvents.id });
  return rows.length > 0;
}

/** Sets `processed_at` on the workspace's event. `false` = no such event in this workspace. */
export async function markWebhookEventProcessed(
  executor: CommentsExecutor,
  workspaceId: string,
  eventId: string,
  at: Date = new Date(),
): Promise<boolean> {
  const rows = await executor
    .update(webhookEvents)
    .set({ processedAt: at })
    .where(
      and(
        eq(webhookEvents.workspaceId, workspaceId),
        eq(webhookEvents.eventId, eventId),
      ),
    )
    .returning({ id: webhookEvents.id });
  return rows.length > 0;
}

/** Inserts a comment; `undefined` = `comment_id` already stored (nothing written). */
export async function insertComment(
  executor: CommentsExecutor,
  values: NewComment,
): Promise<CommentRow | undefined> {
  const [row] = await executor
    .insert(comments)
    .values(values)
    .onConflictDoNothing({ target: comments.commentId })
    .returning();
  return row;
}

export type DailyCommentStatsDelta = {
  workspaceId: string;
  /** Meta Page id. */
  pageId: string;
  platform: CommentPlatform;
  /** Dhaka day (`dhakaDayKey()`). */
  day: string;
  received?: number;
  edited?: number;
  removed?: number;
};

/** Adds to the day's counters, creating the row on first use. Returns the new totals. */
export async function incrementDailyCommentStats(
  executor: CommentsExecutor,
  delta: DailyCommentStatsDelta,
): Promise<DailyCommentStatsRow> {
  const received = delta.received ?? 0;
  const edited = delta.edited ?? 0;
  const removed = delta.removed ?? 0;
  for (const value of [received, edited, removed]) {
    if (!Number.isInteger(value) || value < 0) {
      throw new Error('Daily comment stats deltas must be integers ≥ 0');
    }
  }
  const [row] = await executor
    .insert(dailyCommentStats)
    .values({
      workspaceId: delta.workspaceId,
      pageId: delta.pageId,
      platform: delta.platform,
      day: delta.day,
      receivedCount: received,
      editedCount: edited,
      removedCount: removed,
    })
    .onConflictDoUpdate({
      target: [
        dailyCommentStats.workspaceId,
        dailyCommentStats.pageId,
        dailyCommentStats.platform,
        dailyCommentStats.day,
      ],
      set: {
        receivedCount: sql`${dailyCommentStats.receivedCount} + ${received}`,
        editedCount: sql`${dailyCommentStats.editedCount} + ${edited}`,
        removedCount: sql`${dailyCommentStats.removedCount} + ${removed}`,
        updatedAt: sql`now()`,
      },
    })
    .returning();
  return row!;
}

const workspaceCommentColumns = {
  id: comments.id,
  commentId: comments.commentId,
  workspaceId: comments.workspaceId,
  socialPageId: comments.socialPageId,
  platform: comments.platform,
  postId: comments.postId,
  authorId: comments.authorId,
  authorName: comments.authorName,
  message: comments.message,
  status: comments.status,
  editedAt: comments.editedAt,
  deletedAt: comments.deletedAt,
  createdAt: comments.createdAt,
  updatedAt: comments.updatedAt,
};

/** The workspace's comments, newest first (`created_at`, then `id`). */
export function listWorkspaceComments(
  executor: CommentsExecutor,
  workspaceId: string,
  page: { skip?: number; take?: number } = {},
): Promise<WorkspaceComment[]> {
  return executor
    .select(workspaceCommentColumns)
    .from(comments)
    .where(eq(comments.workspaceId, workspaceId))
    .orderBy(desc(comments.createdAt), desc(comments.id))
    .offset(page.skip ?? 0)
    .limit(page.take ?? 50);
}

/**
 * One comment of the workspace by Meta comment id (`undefined` when it belongs to no comment of
 * **this** workspace). `lock` = `SELECT … FOR UPDATE` (inside a transaction).
 */
export async function findWorkspaceComment(
  executor: CommentsExecutor,
  workspaceId: string,
  commentId: string,
  lock = false,
): Promise<WorkspaceComment | undefined> {
  const query = executor
    .select(workspaceCommentColumns)
    .from(comments)
    .where(
      and(
        eq(comments.workspaceId, workspaceId),
        eq(comments.commentId, commentId),
      ),
    );
  const [row] = await (lock ? query.for('update') : query);
  return row;
}

/** The workspace's daily stats for an inclusive Dhaka day range, oldest first. */
export function listDailyCommentStats(
  executor: CommentsExecutor,
  workspaceId: string,
  range: { from: string; to: string },
): Promise<DailyCommentStatsRow[]> {
  return executor
    .select()
    .from(dailyCommentStats)
    .where(
      and(
        eq(dailyCommentStats.workspaceId, workspaceId),
        sql`${dailyCommentStats.day} between ${range.from} and ${range.to}`,
      ),
    )
    .orderBy(
      dailyCommentStats.day,
      dailyCommentStats.pageId,
      dailyCommentStats.platform,
    );
}
