import { and, eq, sql } from 'drizzle-orm';
import {
  comments,
  metaConnections,
  socialPages,
  type CommentPlatform,
} from '../db/schema/index.js';
import type { IngestRoute } from './comment-ingest.rules.js';
import type { CommentsExecutor } from './comments.queries.js';

/**
 * Queries of the `comment-ingest` worker (M4-T5). Routing is the one unscoped read: it looks a
 * Page up by its globally unique Meta id (`page_id` / `ig_business_id`, Module 3 D7) to find the
 * workspace; everything after it is scoped by that `workspace_id`.
 */

/** The Page (and its workspace's connection status) a webhook `entry.id` belongs to. */
export async function findIngestRoute(
  executor: CommentsExecutor,
  platform: CommentPlatform,
  metaId: string,
): Promise<IngestRoute | undefined> {
  const [row] = await executor
    .select({
      workspaceId: socialPages.workspaceId,
      socialPageId: socialPages.id,
      pageId: socialPages.pageId,
      isActive: socialPages.isActive,
      connectionStatus: metaConnections.status,
    })
    .from(socialPages)
    .leftJoin(
      metaConnections,
      eq(metaConnections.workspaceId, socialPages.workspaceId),
    )
    .where(
      platform === 'FACEBOOK'
        ? eq(socialPages.pageId, metaId)
        : eq(socialPages.igBusinessId, metaId),
    )
    .limit(1);
  return row;
}

/**
 * Verb `edited` on the workspace's comment: new message + raw payload + `edited_at = at`, unless
 * the row already holds a **newer** edit (`edited_at > at`: an older edit delivered late), then
 * only the row is returned. `undefined` = no such comment in this workspace.
 */
export async function applyCommentEdit(
  executor: CommentsExecutor,
  workspaceId: string,
  commentId: string,
  edit: {
    message: string | null;
    rawPayload: Record<string, unknown>;
    at: Date;
  },
): Promise<
  { id: string; applied: boolean; deletedAt: Date | null } | undefined
> {
  const stale = sql`${comments.editedAt} is not null and ${comments.editedAt} > ${edit.at}`;
  const [row] = await executor
    .update(comments)
    .set({
      message: sql`case when ${stale} then ${comments.message} else ${edit.message} end`,
      rawPayload: sql`case when ${stale} then ${comments.rawPayload} else ${JSON.stringify(edit.rawPayload)}::jsonb end`,
      editedAt: sql`case when ${stale} then ${comments.editedAt} else ${edit.at} end`,
      // M5-T12 (D11): an applied edit of a live comment owes a new classification.
      moderationStage: sql`case when ${stale} or ${comments.deletedAt} is not null then ${comments.moderationStage} else 'classify' end`,
    })
    .where(
      and(
        eq(comments.workspaceId, workspaceId),
        eq(comments.commentId, commentId),
      ),
    )
    .returning({
      id: comments.id,
      editedAt: comments.editedAt,
      deletedAt: comments.deletedAt,
    });
  if (!row) return undefined;
  return {
    id: row.id,
    applied: row.editedAt?.getTime() === edit.at.getTime(),
    deletedAt: row.deletedAt,
  };
}

/**
 * Verb `remove` on the workspace's comment: `deleted_at` (kept if already set). `undefined` = no
 * such comment in this workspace.
 */
export async function markCommentDeleted(
  executor: CommentsExecutor,
  workspaceId: string,
  commentId: string,
  at: Date,
): Promise<{ id: string } | undefined> {
  const [row] = await executor
    .update(comments)
    .set({
      deletedAt: sql`coalesce(${comments.deletedAt}, ${at})`,
    })
    .where(
      and(
        eq(comments.workspaceId, workspaceId),
        eq(comments.commentId, commentId),
      ),
    )
    .returning({ id: comments.id });
  return row;
}
