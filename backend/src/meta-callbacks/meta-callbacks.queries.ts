import { and, asc, eq, gt, inArray, isNotNull, ne, or, sql } from 'drizzle-orm';
import type { Database } from '../db/database.js';
import {
  comments,
  type MetaConnectionStatus,
  metaConnections,
  metaDataDeletionRequests,
  type MetaDataDeletionStatus,
  moderationActions,
  socialPages,
  webhookEvents,
  workspaces,
} from '../db/schema/index.js';

/**
 * Queries behind the Deauthorize + Data Deletion callbacks (M4-T6) and the `debug_token` check
 * (M4-T7). The only unscoped reads are the routing reads by `facebook_user_id` (ids only:
 * connections, and since M4-T9 comments stamped by a disconnect) and the token check's
 * system-wide page of connections; every write is scoped by `workspace_id`.
 */

/** A database or a transaction. */
export type CallbacksExecutor = Pick<
  Database,
  'select' | 'selectDistinct' | 'insert' | 'update' | 'delete'
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
 * Data Deletion routing read (M4-T9): every workspace that holds data of the Facebook user, i.e.
 * a connection of theirs **or** comments a disconnect stamped with their id (the connection may be
 * long gone). Distinct, ordered by workspace id (same lock order as every other caller).
 */
export async function findWorkspacesWithFacebookUserData(
  executor: CallbacksExecutor,
  facebookUserId: string,
): Promise<string[]> {
  const [connected, stamped] = await Promise.all([
    findConnectionsByFacebookUser(executor, facebookUserId),
    executor
      .selectDistinct({ workspaceId: comments.workspaceId })
      .from(comments)
      .where(eq(comments.facebookUserId, facebookUserId)),
  ]);
  const ids = new Set([
    ...connected.map((ref) => ref.workspaceId),
    ...stamped.map((row) => row.workspaceId),
  ]);
  return [...ids].sort();
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
  /** `moderation_actions` of the deleted comments (M5-T7; FK restrict, so they go first). */
  moderationActions: number;
  webhookEvents: number;
  comments: number;
  pages: number;
  connections: number;
}

export interface WorkspaceDeletionTarget {
  workspaceId: string;
  /** The user's connection in this workspace (`null` = none any more, e.g. disconnected). */
  connectionId: string | null;
  /** That connection's Page row ids (empty without a connection). */
  pageIds: string[];
  /** The requesting user: comments a disconnect stamped with this id are deleted too (M4-T9). */
  facebookUserId: string;
}

/**
 * Data Deletion (D6) for one workspace, inside the caller's transaction, in FK-safe order:
 * the `moderation_actions` of the deleted comments (M5-T7) → the `webhook_events` of the deleted
 * comments → the comments (the Pages' comments, before the
 * Pages, else `on delete set null` would keep them, **plus** comments a disconnect stamped with
 * the user's Facebook id, M4-T9) → the Pages → the connection. Every statement is scoped by
 * `workspace_id`. `daily_comment_stats`, `daily_ai_usage` and `moderation_policies` stay (no
 * personal data, D4). The classification (incl. `reasoning`, D9) goes with the comment row.
 */
export async function deleteWorkspaceMetaData(
  tx: CallbacksExecutor,
  target: WorkspaceDeletionTarget,
): Promise<WorkspaceDeletionCounts> {
  const { workspaceId, connectionId, pageIds, facebookUserId } = target;
  const commentScope = and(
    eq(comments.workspaceId, workspaceId),
    pageIds.length > 0
      ? or(
          inArray(comments.socialPageId, pageIds),
          eq(comments.facebookUserId, facebookUserId),
        )
      : eq(comments.facebookUserId, facebookUserId),
  );
  const userComments = tx
    .select({ commentId: comments.commentId })
    .from(comments)
    .where(commentScope);
  const deletedActions = (
    await tx
      .delete(moderationActions)
      .where(
        and(
          eq(moderationActions.workspaceId, workspaceId),
          inArray(
            moderationActions.commentId,
            tx.select({ id: comments.id }).from(comments).where(commentScope),
          ),
        ),
      )
      .returning({ id: moderationActions.id })
  ).length;
  // event_id = `<platform>:<commentId>:<verb>` (D4): the comment id is the 2nd part.
  const deletedEvents = (
    await tx
      .delete(webhookEvents)
      .where(
        and(
          eq(webhookEvents.workspaceId, workspaceId),
          inArray(
            sql`split_part(${webhookEvents.eventId}, ':', 2)`,
            userComments,
          ),
        ),
      )
      .returning({ id: webhookEvents.id })
  ).length;
  const deletedComments = (
    await tx.delete(comments).where(commentScope).returning({ id: comments.id })
  ).length;
  let deletedPages = 0;
  if (pageIds.length > 0) {
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
  let deletedConnections = 0;
  if (connectionId !== null) {
    deletedConnections = (
      await tx
        .delete(metaConnections)
        .where(
          and(
            eq(metaConnections.workspaceId, workspaceId),
            eq(metaConnections.id, connectionId),
          ),
        )
        .returning({ id: metaConnections.id })
    ).length;
  }
  return {
    moderationActions: deletedActions,
    webhookEvents: deletedEvents,
    comments: deletedComments,
    pages: deletedPages,
    connections: deletedConnections,
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

/** A connection the daily `debug_token` check looks at (M4-T7). */
export interface TokenCheckRow {
  id: string;
  workspaceId: string;
  facebookUserId: string;
  status: MetaConnectionStatus;
  encryptedUserAccessToken: string;
  tokenExpiresAt: Date | null;
}

/**
 * System job read (M4-T7, D8): one page of ACTIVE + NEEDS_REAUTH connections that hold a user
 * token, across all workspaces (keyset on the UUIDv7 `id`, so new rows land at the end). REVOKED
 * rows are never read. The writes that follow are scoped by `workspace_id` + `id`.
 */
export async function listConnectionsForTokenCheck(
  executor: CallbacksExecutor,
  afterId: string | null,
  limit: number,
): Promise<TokenCheckRow[]> {
  const rows = await executor
    .select({
      id: metaConnections.id,
      workspaceId: metaConnections.workspaceId,
      facebookUserId: metaConnections.facebookUserId,
      status: metaConnections.status,
      encryptedUserAccessToken: metaConnections.encryptedUserAccessToken,
      tokenExpiresAt: metaConnections.tokenExpiresAt,
    })
    .from(metaConnections)
    .where(
      and(
        inArray(metaConnections.status, ['ACTIVE', 'NEEDS_REAUTH']),
        isNotNull(metaConnections.encryptedUserAccessToken),
        afterId === null ? undefined : gt(metaConnections.id, afterId),
      ),
    )
    .orderBy(asc(metaConnections.id))
    .limit(limit);
  return rows.flatMap((row) =>
    row.encryptedUserAccessToken === null
      ? []
      : [{ ...row, encryptedUserAccessToken: row.encryptedUserAccessToken }],
  );
}

export interface TokenCheckUpdate {
  workspaceId: string;
  connectionId: string;
  /** Status + token the check read; the UPDATE only applies if both are still the same. */
  observedStatus: MetaConnectionStatus;
  observedToken: string;
  status: Extract<MetaConnectionStatus, 'ACTIVE' | 'NEEDS_REAUTH'>;
  /** `undefined` = keep the stored expiry. */
  tokenExpiresAt: Date | null | undefined;
  now: Date;
}

/**
 * Writes a `debug_token` verdict (M4-T7) as one conditional UPDATE: the row lock it takes
 * re-checks status + token, so a concurrent Deauthorize (REVOKED, token cleared) or re-connect
 * (new token) wins and this becomes a no-op. `status_changed_at` moves only when the status does.
 * Single statement, one row lock: no lock-order issue with the workspace → connection callers.
 * `true` = the row changed.
 */
export async function applyTokenCheckResult(
  executor: CallbacksExecutor,
  update: TokenCheckUpdate,
): Promise<boolean> {
  const rows = await executor
    .update(metaConnections)
    .set({
      status: update.status,
      ...(update.status === update.observedStatus
        ? {}
        : { statusChangedAt: update.now }),
      ...(update.tokenExpiresAt === undefined
        ? {}
        : { tokenExpiresAt: update.tokenExpiresAt }),
      updatedAt: update.now,
    })
    .where(
      and(
        eq(metaConnections.workspaceId, update.workspaceId),
        eq(metaConnections.id, update.connectionId),
        eq(metaConnections.status, update.observedStatus),
        eq(metaConnections.encryptedUserAccessToken, update.observedToken),
      ),
    )
    .returning({ id: metaConnections.id });
  return rows.length > 0;
}
