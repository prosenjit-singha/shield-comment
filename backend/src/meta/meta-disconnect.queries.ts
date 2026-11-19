import { and, asc, count, eq, inArray, isNotNull } from 'drizzle-orm';
import type { Database } from '../db/database.js';
import {
  comments,
  metaConnections,
  postContexts,
  socialPages,
} from '../db/schema/index.js';

/**
 * Queries behind Meta disconnect (M4-T9, Module 4 D7 + decision 2026-11-19 "Keep FB user id on
 * comments"). Every statement is scoped by `workspace_id`, except the yes/no check whether the
 * Facebook user still has a connection in **another** workspace (ids only, no data returned).
 * Token columns are read only to decrypt them for the best-effort Graph calls after commit; the
 * API never returns them.
 */

/** A database or a transaction. */
export type DisconnectExecutor = Pick<Database, 'select' | 'update' | 'delete'>;

export interface DisconnectConnectionRow {
  id: string;
  facebookUserId: string;
  /** `null` once Deauthorize revoked the connection. */
  encryptedUserAccessToken: string | null;
}

export interface DisconnectPageRow {
  /** `social_pages.id`. */
  id: string;
  /** Facebook Page id. */
  pageId: string;
  encryptedPageAccessToken: string | null;
}

export interface DisconnectSnapshot {
  connection: DisconnectConnectionRow | undefined;
  pages: DisconnectPageRow[];
}

const connectionColumns = {
  id: metaConnections.id,
  facebookUserId: metaConnections.facebookUserId,
  encryptedUserAccessToken: metaConnections.encryptedUserAccessToken,
};

const pageColumns = {
  id: socialPages.id,
  pageId: socialPages.pageId,
  encryptedPageAccessToken: socialPages.encryptedPageAccessToken,
};

/** The workspace's connection, `lock` = `FOR UPDATE` (inside the disconnect transaction). */
export async function findDisconnectConnection(
  executor: DisconnectExecutor,
  workspaceId: string,
  lock = false,
): Promise<DisconnectConnectionRow | undefined> {
  const query = executor
    .select(connectionColumns)
    .from(metaConnections)
    .where(eq(metaConnections.workspaceId, workspaceId));
  const [row] = await (lock ? query.for('update') : query);
  return row;
}

/**
 * The workspace's Pages ordered by row id, `lock` = `FOR UPDATE` (blocks new comments that would
 * reference them, and toggles of these Pages, until the transaction ends).
 */
export function findDisconnectPages(
  executor: DisconnectExecutor,
  workspaceId: string,
  lock = false,
): Promise<DisconnectPageRow[]> {
  const query = executor
    .select(pageColumns)
    .from(socialPages)
    .where(eq(socialPages.workspaceId, workspaceId))
    .orderBy(asc(socialPages.id));
  return lock ? query.for('update') : query;
}

/**
 * Comments of the Pages about to be deleted: stamped with the connection's Facebook user id (so a
 * later Data Deletion request still finds them) when there is one, else only counted. Their
 * `social_page_id` becomes `null` through the FK when the Pages are deleted. Returns the count.
 * Their classification and `moderation_actions` (M5-T7, FK to the comment, not the Page) stay with
 * them; Data Deletion removes those with the comments.
 */
export async function keepPageComments(
  tx: DisconnectExecutor,
  workspaceId: string,
  pageRowIds: string[],
  facebookUserId: string | null,
): Promise<number> {
  if (pageRowIds.length === 0) return 0;
  const scope = and(
    eq(comments.workspaceId, workspaceId),
    inArray(comments.socialPageId, pageRowIds),
  );
  if (facebookUserId === null) {
    const [row] = await tx
      .select({ value: count() })
      .from(comments)
      .where(scope);
    return row?.value ?? 0;
  }
  const rows = await tx
    .update(comments)
    .set({ facebookUserId })
    .where(scope)
    .returning({ id: comments.id });
  return rows.length;
}

/**
 * Hard-deletes the given Pages of the workspace (frees `page_id` + `ig_business_id`), their
 * `post_contexts` caption cache first (M5-T10; the FK also cascades).
 */
export async function deleteWorkspacePages(
  tx: DisconnectExecutor,
  workspaceId: string,
  pageRowIds: string[],
): Promise<number> {
  if (pageRowIds.length === 0) return 0;
  await tx
    .delete(postContexts)
    .where(
      and(
        eq(postContexts.workspaceId, workspaceId),
        inArray(postContexts.socialPageId, pageRowIds),
      ),
    );
  const rows = await tx
    .delete(socialPages)
    .where(
      and(
        eq(socialPages.workspaceId, workspaceId),
        inArray(socialPages.id, pageRowIds),
      ),
    )
    .returning({ id: socialPages.id });
  return rows.length;
}

/** Hard-deletes the workspace's connection row. `true` = deleted. */
export async function deleteWorkspaceConnection(
  tx: DisconnectExecutor,
  workspaceId: string,
  connectionId: string,
): Promise<boolean> {
  const rows = await tx
    .delete(metaConnections)
    .where(
      and(
        eq(metaConnections.workspaceId, workspaceId),
        eq(metaConnections.id, connectionId),
      ),
    )
    .returning({ id: metaConnections.id });
  return rows.length > 0;
}

/**
 * Whether the Facebook user still has a connection holding a user token in any workspace (run
 * after the delete, so the disconnected one no longer counts). `DELETE /me/permissions` would log
 * the app out of the whole Facebook account and break those connections too, so it is skipped.
 */
export async function facebookUserStillConnected(
  executor: DisconnectExecutor,
  facebookUserId: string,
): Promise<boolean> {
  const [row] = await executor
    .select({ id: metaConnections.id })
    .from(metaConnections)
    .where(
      and(
        eq(metaConnections.facebookUserId, facebookUserId),
        isNotNull(metaConnections.encryptedUserAccessToken),
      ),
    )
    .limit(1);
  return row !== undefined;
}
