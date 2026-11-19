import { and, eq } from 'drizzle-orm';
import type { Database } from '../db/database.js';
import {
  type CommentPlatform,
  type MetaConnectionStatus,
  metaConnections,
  postContexts,
  socialPages,
} from '../db/schema/index.js';

/**
 * Reads and writes behind `PostContextService` (M5-T10, D8). Every query is scoped by
 * `workspace_id`. The Page token ciphertext read here never leaves the backend; captions are never
 * logged.
 */

/** A database or a transaction. */
export type PostContextExecutor = Pick<Database, 'select' | 'insert'>;

/** The comment's Page + the workspace connection status. */
export interface PostContextSource {
  /** `social_pages.id`. */
  pageRowId: string;
  /** Facebook Page id (part of the Page token's cipher context). */
  pageId: string;
  pageName: string;
  isActive: boolean;
  encryptedPageAccessToken: string | null;
  /** `null` = the workspace has no connection. */
  connectionStatus: MetaConnectionStatus | null;
}

export interface CachedPostContext {
  caption: string | null;
  fetchedAt: Date;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The Page (only if it is this workspace's) + the connection; `undefined` = no such Page. */
export async function findPostContextSource(
  executor: PostContextExecutor,
  workspaceId: string,
  pageRowId: string,
): Promise<PostContextSource | undefined> {
  if (!UUID.test(workspaceId) || !UUID.test(pageRowId)) return undefined;
  const [row] = await executor
    .select({
      pageRowId: socialPages.id,
      pageId: socialPages.pageId,
      pageName: socialPages.pageName,
      isActive: socialPages.isActive,
      encryptedPageAccessToken: socialPages.encryptedPageAccessToken,
      connectionStatus: metaConnections.status,
    })
    .from(socialPages)
    .leftJoin(metaConnections, eq(metaConnections.workspaceId, workspaceId))
    .where(
      and(
        eq(socialPages.workspaceId, workspaceId),
        eq(socialPages.id, pageRowId),
      ),
    );
  return row;
}

/** The cached caption of a post of the workspace (`undefined` = never fetched). */
export async function findCachedPostContext(
  executor: PostContextExecutor,
  workspaceId: string,
  platform: CommentPlatform,
  postId: string,
): Promise<CachedPostContext | undefined> {
  const [row] = await executor
    .select({
      caption: postContexts.caption,
      fetchedAt: postContexts.fetchedAt,
    })
    .from(postContexts)
    .where(
      and(
        eq(postContexts.workspaceId, workspaceId),
        eq(postContexts.platform, platform),
        eq(postContexts.postId, postId),
      ),
    );
  return row;
}

export interface PostContextWrite {
  workspaceId: string;
  socialPageId: string;
  platform: CommentPlatform;
  postId: string;
  /** Already normalised and ≤ `MAX_STORED_CAPTION_CHARS`; `null` = no text. */
  caption: string | null;
  fetchedAt: Date;
}

/**
 * Insert or refresh the cache row (key = workspace + platform + post, so it never touches another
 * workspace's row). Concurrent refreshes of the same post are fine: the last write wins.
 */
export async function upsertPostContext(
  executor: PostContextExecutor,
  write: PostContextWrite,
): Promise<void> {
  await executor
    .insert(postContexts)
    .values(write)
    .onConflictDoUpdate({
      target: [
        postContexts.workspaceId,
        postContexts.platform,
        postContexts.postId,
      ],
      set: {
        socialPageId: write.socialPageId,
        caption: write.caption,
        fetchedAt: write.fetchedAt,
        updatedAt: write.fetchedAt,
      },
    });
}
