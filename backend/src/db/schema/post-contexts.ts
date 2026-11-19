import { relations, sql } from 'drizzle-orm';
import { check, index, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';
import { MAX_STORED_CAPTION_CHARS } from '../../moderation/moderation.constants.js';
import { inListSql, lengthSql, patternSql } from './check-sql.js';
import { id, timestamps, timestamptz } from './columns.js';
import {
  COMMENT_PLATFORMS,
  type CommentPlatform,
  META_OBJECT_ID,
} from './comments.js';
import { socialPages } from './meta.js';
import { workspaces } from './workspaces.js';

/**
 * Post caption cache for the D8 `post_caption` context level (Module 5, M5-T10; user decision
 * 2026-11-19 D8, see docs/progress/TASKS.md). One row per workspace + platform + post: the FB post
 * `message` / IG media `caption` (≤ 2,000 code points, `null` = the post has no text or no longer
 * exists), refreshed from Graph once `fetched_at` is older than 24 h (`POST_CONTEXT_TTL_MS`).
 *
 * - Workspace FK `restrict` (convention). The key includes `workspace_id`, so an upsert can never
 *   touch another workspace's row.
 * - Page FK **`cascade`**: the cache belongs to the Page, so every path that deletes a Page
 *   (disconnect, Data Deletion, `cleanup()`, any later one) takes its rows with it. Disconnect and
 *   Data Deletion also delete them explicitly (scoped by `workspace_id`) before the Pages.
 */
export const postContexts = pgTable(
  'post_contexts',
  {
    id: id(),
    workspaceId: uuid()
      .notNull()
      .references(() => workspaces.id, { onDelete: 'restrict' }),
    socialPageId: uuid()
      .notNull()
      .references(() => socialPages.id, { onDelete: 'cascade' }),
    platform: text().$type<CommentPlatform>().notNull(),
    /** FB post id (`<pageId>_<postId>`) / IG media id (`comments.post_id`). */
    postId: text().notNull(),
    /** Normalised post text, ≤ 2,000 code points; `null` = none. Never logged. */
    caption: text(),
    /** Last Graph read (success or "no text"); older than 24 h = stale. */
    fetchedAt: timestamptz().notNull(),
    ...timestamps,
  },
  (t) => [
    // Upsert key; also serves the per-comment lookup (leading `workspace_id`).
    unique('post_contexts_key_unique').on(t.workspaceId, t.platform, t.postId),
    // FK cascade + explicit deletes by Page.
    index().on(t.socialPageId),
    check(
      'post_contexts_platform_check',
      sql.raw(inListSql('platform', COMMENT_PLATFORMS)),
    ),
    check(
      'post_contexts_post_id_format',
      sql.raw(patternSql('post_id', META_OBJECT_ID)),
    ),
    check(
      'post_contexts_caption_length',
      sql.raw(lengthSql('caption', 1, MAX_STORED_CAPTION_CHARS, true)),
    ),
  ],
);

export const postContextsRelations = relations(postContexts, ({ one }) => ({
  workspace: one(workspaces, {
    fields: [postContexts.workspaceId],
    references: [workspaces.id],
  }),
  page: one(socialPages, {
    fields: [postContexts.socialPageId],
    references: [socialPages.id],
  }),
}));
