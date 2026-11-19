import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Database } from '../db/database.js';
import {
  type CommentPlatform,
  comments,
  type MetaConnectionStatus,
  metaConnections,
  socialPages,
} from '../db/schema/index.js';
import type {
  CommentStatus,
  ModerationActionType,
} from './moderation.constants.js';

/**
 * Reads and writes of the Meta action executor (M5-T9). Every query is scoped by `workspace_id`.
 * The Page token ciphertext read here never leaves the backend.
 */

/** A database or a transaction. */
export type ActionQueryExecutor = Pick<Database, 'select' | 'update'>;

/** The comment's Page (`null` once a disconnect orphaned the comment, M4-T9 D7). */
export interface ActionTargetPage {
  /** `social_pages.id`. */
  id: string;
  /** Facebook Page id (part of the Page token's cipher context). */
  pageId: string;
  isActive: boolean;
  encryptedPageAccessToken: string | null;
}

/** What the executor needs about one comment of the workspace. */
export interface ActionTarget {
  /** `comments.id`. */
  id: string;
  workspaceId: string;
  /** Meta comment id (the Graph object). */
  metaCommentId: string;
  platform: CommentPlatform;
  status: CommentStatus;
  deletedAt: Date | null;
  /** D10 human stamp. */
  overriddenAt: Date | null;
  page: ActionTargetPage | null;
  /** The workspace's Meta connection status (`null` = none). */
  connectionStatus: MetaConnectionStatus | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The comment + its Page + the workspace connection, all scoped by `workspace_id` (the Page join
 * also requires the Page to be this workspace's). `undefined` = no such comment in the workspace
 * (a malformed id included).
 */
export async function findActionTarget(
  executor: ActionQueryExecutor,
  workspaceId: string,
  commentId: string,
): Promise<ActionTarget | undefined> {
  if (!UUID.test(commentId) || !UUID.test(workspaceId)) return undefined;
  const [row] = await executor
    .select({
      id: comments.id,
      workspaceId: comments.workspaceId,
      metaCommentId: comments.commentId,
      platform: comments.platform,
      status: comments.status,
      deletedAt: comments.deletedAt,
      overriddenAt: comments.overriddenAt,
      pageRowId: socialPages.id,
      pageId: socialPages.pageId,
      pageIsActive: socialPages.isActive,
      encryptedPageAccessToken: socialPages.encryptedPageAccessToken,
      connectionStatus: metaConnections.status,
    })
    .from(comments)
    .leftJoin(
      socialPages,
      and(
        eq(socialPages.id, comments.socialPageId),
        eq(socialPages.workspaceId, workspaceId),
      ),
    )
    .leftJoin(metaConnections, eq(metaConnections.workspaceId, workspaceId))
    .where(
      and(eq(comments.workspaceId, workspaceId), eq(comments.id, commentId)),
    );
  if (!row) return undefined;
  const page: ActionTargetPage | null =
    row.pageRowId !== null && row.pageId !== null && row.pageIsActive !== null
      ? {
          id: row.pageRowId,
          pageId: row.pageId,
          isActive: row.pageIsActive,
          encryptedPageAccessToken: row.encryptedPageAccessToken,
        }
      : null;
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    metaCommentId: row.metaCommentId,
    platform: row.platform,
    status: row.status,
    deletedAt: row.deletedAt,
    overriddenAt: row.overriddenAt,
    page,
    connectionStatus: row.connectionStatus,
  };
}

/**
 * D10: the first human action stamps the comment (`overridden_at` keeps the first stamp), so the
 * AI never changes it again. `true` = the comment exists in the workspace.
 */
export async function stampCommentOverride(
  executor: ActionQueryExecutor,
  workspaceId: string,
  commentId: string,
  at: Date,
): Promise<boolean> {
  const rows = await executor
    .update(comments)
    .set({
      overriddenAt: sql`coalesce(${comments.overriddenAt}, ${at})`,
      updatedAt: at,
    })
    .where(
      and(eq(comments.workspaceId, workspaceId), eq(comments.id, commentId)),
    )
    .returning({ id: comments.id });
  return rows.length > 0;
}

/** The comment status a succeeded action leaves (REPLY changes nothing). */
export function statusAfterAction(
  action: ModerationActionType,
): CommentStatus | null {
  switch (action) {
    case 'HIDE':
      return 'HIDDEN';
    case 'UNHIDE':
      return 'VISIBLE';
    case 'DELETE':
      return 'DELETED';
    case 'REPLY':
      return null;
  }
}

/**
 * Mirrors a succeeded action on the comment: HIDE → `HIDDEN`, UNHIDE → `VISIBLE` (both only while
 * the comment is not deleted), DELETE → `DELETED` + `deleted_at` (first value kept). REPLY: no
 * change. `true` = the row changed.
 */
export async function applyActionToComment(
  executor: ActionQueryExecutor,
  workspaceId: string,
  commentId: string,
  action: ModerationActionType,
  at: Date,
): Promise<boolean> {
  const status = statusAfterAction(action);
  if (status === null) return false;
  const scope = and(
    eq(comments.workspaceId, workspaceId),
    eq(comments.id, commentId),
  );
  const rows = await executor
    .update(comments)
    .set(
      action === 'DELETE'
        ? {
            status,
            deletedAt: sql`coalesce(${comments.deletedAt}, ${at})`,
            updatedAt: at,
          }
        : { status, updatedAt: at },
    )
    .where(action === 'DELETE' ? scope : and(scope, isNull(comments.deletedAt)))
    .returning({ id: comments.id });
  return rows.length > 0;
}
