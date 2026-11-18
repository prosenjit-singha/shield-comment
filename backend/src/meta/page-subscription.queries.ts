import { and, asc, eq, exists, gt, isNotNull } from 'drizzle-orm';
import type { Database } from '../db/database.js';
import { metaConnections, socialPages } from '../db/schema/index.js';

/**
 * Queries behind `subscribed_apps` (M4-T8, D10). These are the only Page queries that read the
 * encrypted Page token (never returned by the API). Every query is scoped by `workspace_id`,
 * except the backfill's system-wide read of active Pages (ids + ciphertext), whose writes are
 * scoped again by `workspace_id` + id.
 */

/** A database or a transaction. */
export type SubscriptionExecutor = Pick<Database, 'select' | 'update'>;

/** What a Graph `subscribed_apps` call needs about one Page. */
export interface PageTokenRow {
  /** `social_pages.id`. */
  id: string;
  workspaceId: string;
  /** Facebook Page id. */
  pageId: string;
  isActive: boolean;
  /** `TokenCipherService` ciphertext (`null` = no token stored). */
  encryptedPageAccessToken: string | null;
}

const tokenColumns = {
  id: socialPages.id,
  workspaceId: socialPages.workspaceId,
  pageId: socialPages.pageId,
  isActive: socialPages.isActive,
  encryptedPageAccessToken: socialPages.encryptedPageAccessToken,
};

/** One Page of the workspace with its token ciphertext (`undefined` = not this workspace's). */
export async function findWorkspacePageToken(
  executor: SubscriptionExecutor,
  workspaceId: string,
  id: string,
): Promise<PageTokenRow | undefined> {
  const [row] = await executor
    .select(tokenColumns)
    .from(socialPages)
    .where(
      and(eq(socialPages.workspaceId, workspaceId), eq(socialPages.id, id)),
    );
  return row;
}

/**
 * System read for the one-off backfill (M4-T8): one page of **active** Pages that hold a token,
 * across all workspaces, keyset on the UUIDv7 `id`.
 */
export function listActivePagesWithToken(
  executor: SubscriptionExecutor,
  afterId: string | null,
  limit: number,
): Promise<PageTokenRow[]> {
  return executor
    .select(tokenColumns)
    .from(socialPages)
    .where(
      and(
        eq(socialPages.isActive, true),
        isNotNull(socialPages.encryptedPageAccessToken),
        afterId === null ? undefined : gt(socialPages.id, afterId),
      ),
    )
    .orderBy(asc(socialPages.id))
    .limit(limit);
}

export interface NeedsReauthUpdate {
  workspaceId: string;
  /** `social_pages.id` whose Page token Graph rejected. */
  pageRowId: string;
  /** The ciphertext that was used: a re-connect since then (new token) wins. */
  observedPageToken: string;
  now: Date;
}

/**
 * Graph said the Page token is invalid (D10): the workspace connection `ACTIVE` → `NEEDS_REAUTH`.
 * One conditional UPDATE: only an `ACTIVE` row changes (so `status_changed_at` moves only on a
 * real change, a REVOKED row is never touched, a NEEDS_REAUTH row stays as is), and only while
 * that Page still holds the token that failed (a re-connect in between stored a new one).
 * `true` = the connection changed.
 */
export async function markConnectionNeedsReauth(
  executor: SubscriptionExecutor,
  update: NeedsReauthUpdate,
): Promise<boolean> {
  const rows = await executor
    .update(metaConnections)
    .set({
      status: 'NEEDS_REAUTH',
      statusChangedAt: update.now,
      updatedAt: update.now,
    })
    .where(
      and(
        eq(metaConnections.workspaceId, update.workspaceId),
        eq(metaConnections.status, 'ACTIVE'),
        exists(
          executor
            .select({ id: socialPages.id })
            .from(socialPages)
            .where(
              and(
                eq(socialPages.workspaceId, update.workspaceId),
                eq(socialPages.id, update.pageRowId),
                eq(
                  socialPages.encryptedPageAccessToken,
                  update.observedPageToken,
                ),
              ),
            ),
        ),
      ),
    )
    .returning({ id: metaConnections.id });
  return rows.length > 0;
}
