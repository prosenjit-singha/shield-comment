import { and, asc, eq, inArray, isNotNull, ne, or, sql } from 'drizzle-orm';
import type { Database } from '../db/database.js';
import {
  comments,
  metaConnections,
  metaDataDeletionRequests,
  type MetaDataDeletionStatus,
  socialPages,
  webhookEvents,
  workspaces,
} from '../db/schema/index.js';

/**
 * Queries behind the Deauthorize + Data Deletion callbacks (M4-T6). The only unscoped reads are the
 * routing reads by `facebook_user_id` (ids only); everything after them is scoped by
 * `workspace_id`.
 */

/** A database or a transaction. */
export type CallbacksExecutor = Pick<
  Database,
  'select' | 'insert' | 'update' | 'delete'
>;

export interface ConnectionRef {
  id: string;
  workspaceId: string;
}

/**
 * Routing read: the connections of a Facebook user (one per workspace; one user can own several).
 * Ordered by workspace id, so every caller locks workspaces in the same order (no deadlocks).
 */
export function findConnectionsByFacebookUser(
  executor: CallbacksExecutor,
  facebookUserId: string,
): Promise<ConnectionRef[]> {
  return executor
    .select({
      id: metaConnections.id,
      workspaceId: metaConnections.workspaceId,
    })
    .from(metaConnections)
    .where(eq(metaConnections.facebookUserId, facebookUserId))
    .orderBy(asc(metaConnections.workspaceId));
}

/**
 * `FOR NO KEY UPDATE` on the workspace row, like the Page toggle (M3-T6): serialises with toggles
 * and the other callbacks of that workspace. `false` = the workspace is gone.
 */
export async function lockWorkspace(
  tx: CallbacksExecutor,
  workspaceId: string,
): Promise<boolean> {
  const [row] = await tx
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .for('no key update');
  return row !== undefined;
}

/**
 * `FOR UPDATE` on the workspace's connection, re-checked against the Facebook user (it may have
 * been re-connected by someone else since the routing read). `undefined` = no longer theirs.
 */
export async function lockConnection(
  tx: CallbacksExecutor,
  workspaceId: string,
  facebookUserId: string,
): Promise<ConnectionRef | undefined> {
  const [row] = await tx
    .select({
      id: metaConnections.id,
      workspaceId: metaConnections.workspaceId,
    })
    .from(metaConnections)
    .where(
      and(
        eq(metaConnections.workspaceId, workspaceId),
        eq(metaConnections.facebookUserId, facebookUserId),
      ),
    )
    .for('update');
  return row;
}

/**
 * Deauthorize (D6): status `REVOKED` and the user token cleared. Only touches a row that still
 * has something to change, so a repeat is a no-op (`updated_at`/`status_changed_at` kept);
 * `status_changed_at` moves only when the status changes. `true` = the row changed.
 */
export async function revokeConnection(
  tx: CallbacksExecutor,
  workspaceId: string,
  connectionId: string,
  now: Date,
): Promise<boolean> {
  const rows = await tx
    .update(metaConnections)
    .set({
      status: 'REVOKED',
      statusChangedAt: sql`case when ${metaConnections.status} = 'REVOKED' then ${metaConnections.statusChangedAt} else ${now} end`,
      encryptedUserAccessToken: null,
      tokenExpiresAt: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(metaConnections.workspaceId, workspaceId),
        eq(metaConnections.id, connectionId),
        or(
          ne(metaConnections.status, 'REVOKED'),
          isNotNull(metaConnections.encryptedUserAccessToken),
          isNotNull(metaConnections.tokenExpiresAt),
        ),
      ),
    )
    .returning({ id: metaConnections.id });
  return rows.length > 0;
}

/**
 * Deauthorize (D6): every Page of the workspace off and its Page token cleared (only rows that
 * still need it). Returns how many Pages changed.
 */
export async function deactivateWorkspacePages(
  tx: CallbacksExecutor,
  workspaceId: string,
  now: Date,
): Promise<number> {
  const rows = await tx
    .update(socialPages)
    .set({ isActive: false, encryptedPageAccessToken: null, updatedAt: now })
    .where(
      and(
        eq(socialPages.workspaceId, workspaceId),
        or(
          eq(socialPages.isActive, true),
          isNotNull(socialPages.encryptedPageAccessToken),
        ),
      ),
    )
    .returning({ id: socialPages.id });
  return rows.length;
}

/** The workspace's Page row ids, locked `FOR UPDATE` (blocks new comments referencing them). */
export async function lockWorkspacePages(
  tx: CallbacksExecutor,
  workspaceId: string,
): Promise<string[]> {
  const rows = await tx
    .select({ id: socialPages.id })
    .from(socialPages)
    .where(eq(socialPages.workspaceId, workspaceId))
    .orderBy(asc(socialPages.id))
    .for('update');
  return rows.map((row) => row.id);
}

export interface WorkspaceDeletionCounts {
  webhookEvents: number;
  comments: number;
  pages: number;
  connections: number;
}

/**
 * Data Deletion (D6) for one workspace, inside the caller's transaction, in FK-safe order:
 * the `webhook_events` of the Pages' comments → those comments (before the Pages, else
 * `on delete set null` would keep them) → the Pages → the connection. Every statement is scoped
 * by `workspace_id`. `daily_comment_stats` stay (no personal data, D4).
 */
export async function deleteWorkspaceMetaData(
  tx: CallbacksExecutor,
  workspaceId: string,
  connectionId: string,
  pageIds: string[],
): Promise<WorkspaceDeletionCounts> {
  let deletedEvents = 0;
  let deletedComments = 0;
  let deletedPages = 0;
  if (pageIds.length > 0) {
    const pageComments = tx
      .select({ commentId: comments.commentId })
      .from(comments)
      .where(
        and(
          eq(comments.workspaceId, workspaceId),
          inArray(comments.socialPageId, pageIds),
        ),
      );
    // event_id = `<platform>:<commentId>:<verb>` (D4): the comment id is the 2nd part.
    deletedEvents = (
      await tx
        .delete(webhookEvents)
        .where(
          and(
            eq(webhookEvents.workspaceId, workspaceId),
            inArray(
              sql`split_part(${webhookEvents.eventId}, ':', 2)`,
              pageComments,
            ),
          ),
        )
        .returning({ id: webhookEvents.id })
    ).length;
    deletedComments = (
      await tx
        .delete(comments)
        .where(
          and(
            eq(comments.workspaceId, workspaceId),
            inArray(comments.socialPageId, pageIds),
          ),
        )
        .returning({ id: comments.id })
    ).length;
    deletedPages = (
      await tx
        .delete(socialPages)
        .where(
          and(
            eq(socialPages.workspaceId, workspaceId),
            inArray(socialPages.id, pageIds),
          ),
        )
        .returning({ id: socialPages.id })
    ).length;
  }
  const connections = await tx
    .delete(metaConnections)
    .where(
      and(
        eq(metaConnections.workspaceId, workspaceId),
        eq(metaConnections.id, connectionId),
      ),
    )
    .returning({ id: metaConnections.id });
  return {
    webhookEvents: deletedEvents,
    comments: deletedComments,
    pages: deletedPages,
    connections: connections.length,
  };
}

export interface DataDeletionRequestRow {
  id: string;
  confirmationCode: string;
  facebookUserId: string;
  status: MetaDataDeletionStatus;
  createdAt: Date;
  completedAt: Date | null;
}

const requestColumns = {
  id: metaDataDeletionRequests.id,
  confirmationCode: metaDataDeletionRequests.confirmationCode,
  facebookUserId: metaDataDeletionRequests.facebookUserId,
  status: metaDataDeletionRequests.status,
  createdAt: metaDataDeletionRequests.createdAt,
  completedAt: metaDataDeletionRequests.completedAt,
};

/**
 * Inserts a `PENDING` request unless the user already has one (partial unique index): `undefined`
 * = an open request exists (read it with `findPendingDeletionRequest`).
 */
export async function insertDeletionRequest(
  executor: CallbacksExecutor,
  facebookUserId: string,
  confirmationCode: string,
): Promise<DataDeletionRequestRow | undefined> {
  const [row] = await executor
    .insert(metaDataDeletionRequests)
    .values({ facebookUserId, confirmationCode, status: 'PENDING' })
    .onConflictDoNothing({
      target: metaDataDeletionRequests.facebookUserId,
      where: sql`${metaDataDeletionRequests.status} = 'PENDING'`,
    })
    .returning(requestColumns);
  return row;
}

export async function findPendingDeletionRequest(
  executor: CallbacksExecutor,
  facebookUserId: string,
): Promise<DataDeletionRequestRow | undefined> {
  const [row] = await executor
    .select(requestColumns)
    .from(metaDataDeletionRequests)
    .where(
      and(
        eq(metaDataDeletionRequests.facebookUserId, facebookUserId),
        eq(metaDataDeletionRequests.status, 'PENDING'),
      ),
    );
  return row;
}

export async function findDeletionRequestByCode(
  executor: CallbacksExecutor,
  confirmationCode: string,
): Promise<DataDeletionRequestRow | undefined> {
  const [row] = await executor
    .select(requestColumns)
    .from(metaDataDeletionRequests)
    .where(eq(metaDataDeletionRequests.confirmationCode, confirmationCode));
  return row;
}

/** The request row, `FOR UPDATE` (one deletion job per request at a time). */
export async function lockDeletionRequest(
  tx: CallbacksExecutor,
  requestId: string,
): Promise<DataDeletionRequestRow | undefined> {
  const [row] = await tx
    .select(requestColumns)
    .from(metaDataDeletionRequests)
    .where(eq(metaDataDeletionRequests.id, requestId))
    .for('update');
  return row;
}

export async function completeDeletionRequest(
  tx: CallbacksExecutor,
  requestId: string,
  now: Date,
): Promise<void> {
  await tx
    .update(metaDataDeletionRequests)
    .set({ status: 'COMPLETED', completedAt: now, updatedAt: now })
    .where(eq(metaDataDeletionRequests.id, requestId));
}
