import { relations, sql } from 'drizzle-orm';
import {
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { AI_PROVIDERS, type AiProvider } from '../../ai-gateway/ai-provider.js';
import {
  COMMENT_LANGUAGES,
  COMMENT_STATUSES,
  type CommentLanguage,
  type CommentStatus,
  CONTEXT_LEVELS,
  type ContextLevel,
  MACHINE_CODE_PATTERN,
  MAX_REASONING_CHARS,
  MODERATION_CATEGORIES,
  MODERATION_CATEGORY_KEYS,
  type ModerationCategory,
  PROMPT_VERSION_PATTERN,
} from '../../moderation/moderation.constants.js';
import { AI_MODEL_MAX_LENGTH } from './ai-settings.js';
import {
  allOrNoneSql,
  inListSql,
  lengthSql,
  nonNegativeSql,
  patternSql,
  quoted,
  snakeCase,
} from './check-sql.js';
import { id, timestamps, timestamptz } from './columns.js';
import { socialPages } from './meta.js';
import { workspaces } from './workspaces.js';

/**
 * Webhook ingestion storage (Module 4, M4-T2; user decisions 2026-11-18 D2/D4/D6/D7, see
 * docs/progress/TASKS.md).
 *
 * - `webhook_events`: one row per processed webhook change, `event_id` =
 *   `<platform>:<commentId>:<verb>` (same format as the BullMQ job id, `commentJobId()`; verb
 *   `edited` is `edited-<16 hex edit hash>`, M4-T4), so duplicate deliveries/retries hit the
 *   unique key (`ON CONFLICT DO NOTHING`) while every different edit gets its own row.
 * - `comments`: one row per Meta comment (`comment_id` unique). Only `raw_payload` is cleared
 *   after 30 days (D4); text/author/status stay. Module 5 (M5-T7) adds the moderation outcome:
 *   `status` (`COMMENT_STATUSES`), the latest classification (all-or-nothing group, D9 reasoning)
 *   and the human stamp `overridden_at` (D10).
 *   D7: disconnect deletes the `social_pages` row, the comment stays with `social_page_id = null`
 *   (`on delete set null`) and is stamped with the connection's `facebook_user_id` (M4-T9), so
 *   D6 Data Deletion still finds it. D6 must delete the Pages' comments **before** the Pages.
 * - `daily_comment_stats`: lifetime analytics per workspace + Meta Page id + platform + Dhaka day,
 *   never purged, no personal data. Keyed by the Meta Page id (text, no FK) so the counts survive
 *   disconnect/Data Deletion and continue when the same Page is connected again.
 *
 * Workspace FKs are `restrict` (convention): delete these rows before the workspace.
 */

export const COMMENT_PLATFORMS = ['FACEBOOK', 'INSTAGRAM'] as const;
export type CommentPlatform = (typeof COMMENT_PLATFORMS)[number];

/** Moderation outcome per comment (M5-T7); defined with the other moderation constants. */
export { COMMENT_STATUSES, type CommentStatus };

/** Webhook verbs we store (D2). */
export const COMMENT_VERBS = ['add', 'edited', 'remove'] as const;
export type CommentVerb = (typeof COMMENT_VERBS)[number];

/** Numeric Meta id (Page id, user id, IG id). */
const numericId = (column: string, nullable = false) =>
  sql.raw(
    `${nullable ? `${column} is null or ` : ''}${column} ~ '^[0-9]{1,32}$'`,
  );

/**
 * Meta object id of a post/comment: numeric, or numeric parts joined by `_` (FB `feed` ids look
 * like `<pageId>_<postId>` / `<postId>_<commentId>`; IG ids are plain numbers).
 */
const META_OBJECT_ID = '^[0-9]{1,32}(_[0-9]{1,32}){0,2}$';
const objectId = (column: string) => sql.raw(`${column} ~ '${META_OBJECT_ID}'`);

export const webhookEvents = pgTable(
  'webhook_events',
  {
    id: id(),
    /** `<platform>:<commentId>:<verb>` (D4); `edited` = `edited-<hash>` (`commentJobId()`). */
    eventId: text().notNull(),
    workspaceId: uuid()
      .notNull()
      .references(() => workspaces.id, { onDelete: 'restrict' }),
    /** sha256 hex of the change payload (JSON). */
    payloadHash: text().notNull(),
    /** Set by the worker once the change is applied; `null` = recorded, not applied yet. */
    processedAt: timestamptz(),
    ...timestamps,
  },
  (t) => [
    unique('webhook_events_event_id_unique').on(t.eventId),
    index().on(t.workspaceId, t.createdAt.desc()),
    check(
      'webhook_events_event_id_format',
      sql.raw(
        `event_id ~ '^(${COMMENT_PLATFORMS.join('|')}):[0-9_]+:(add|remove|edited-[0-9a-f]{16})$'`,
      ),
    ),
    check(
      'webhook_events_payload_hash_format',
      sql`${t.payloadHash} ~ '^[0-9a-f]{64}$'`,
    ),
  ],
);

/** Columns set together by a classification (`comments_classification_complete`). */
export const CLASSIFICATION_COLUMNS = [
  'category',
  'confidence',
  'language',
  'classified_at',
  'ai_provider',
  'model',
  'prompt_version',
  'context_level',
] as const;

export const comments = pgTable(
  'comments',
  {
    id: id(),
    /** Meta comment id (globally unique: one workspace per Page, so one row per comment). */
    commentId: text().notNull(),
    workspaceId: uuid()
      .notNull()
      .references(() => workspaces.id, { onDelete: 'restrict' }),
    /** The connected Page (FB) or the Page linked to the IG account; `null` after disconnect (D7). */
    socialPageId: uuid().references(() => socialPages.id, {
      onDelete: 'set null',
    }),
    platform: text().$type<CommentPlatform>().notNull(),
    /** FB post id / IG media id. */
    postId: text().notNull(),
    /** `null` when Meta leaves out `from` (privacy rules). */
    authorId: text(),
    authorName: text(),
    /** `null` for sticker/photo-only comments. Verb `edited` replaces it. */
    message: text(),
    /** The webhook change as received; cleared after 30 days (D4). */
    rawPayload: jsonb().$type<Record<string, unknown>>(),
    status: text().$type<CommentStatus>().notNull().default('PENDING'),
    /**
     * App-scoped Facebook user id of the connection whose disconnect orphaned this comment
     * (M4-T9; decision 2026-11-19 "Keep FB user id on comments"): `null` while the Page is
     * connected. A later Data Deletion request of that user still finds and deletes it.
     */
    facebookUserId: text(),
    /** Last `edited` verb applied. */
    editedAt: timestamptz(),
    /** Verb `remove`: the comment was deleted on Meta (never hidden later, D2). */
    deletedAt: timestamptz(),
    // Latest classification (M5-T7; written by the M5-T12 worker). All-or-nothing except
    // `reasoning` (may be null even when classified); replaced when an edit is re-classified (D11).
    category: text().$type<ModerationCategory>(),
    /** 0–1, 3 decimals (the classifier rounds to 3 dp). */
    confidence: numeric({ precision: 4, scale: 3, mode: 'number' }),
    /** Short English reasoning ≤ 280 (D9); deleted with the comment. */
    reasoning: text(),
    language: text().$type<CommentLanguage>(),
    classifiedAt: timestamptz(),
    aiProvider: text().$type<AiProvider>(),
    model: text(),
    promptVersion: text(),
    /** The level actually sent (D8; a missing caption drops `post_caption` to `page_name`). */
    contextLevel: text().$type<ContextLevel>(),
    /** AI credits charged for this comment so far: every classification incl. re-checked edits (D7). */
    creditsCharged: integer().notNull().default(0),
    /** Machine code explaining `SKIPPED` / `FAILED` / `NEEDS_REVIEW` (e.g. `credits_exhausted`). */
    statusReason: text(),
    /** First human moderation action (D10): from then on the AI never changes the comment. */
    overriddenAt: timestamptz(),
    ...timestamps,
  },
  (t) => [
    unique('comments_comment_id_unique').on(t.commentId),
    // Workspace comment lists (newest first).
    index().on(t.workspaceId, t.createdAt.desc()),
    // FK `on delete set null` lookups (disconnect).
    index().on(t.socialPageId),
    // Data Deletion routing read for comments orphaned by a disconnect (M4-T9).
    index('comments_facebook_user_id_index')
      .on(t.facebookUserId)
      .where(sql`${t.facebookUserId} is not null`),
    // Daily raw_payload purge (D4): only rows that still carry a payload.
    index('comments_raw_payload_purge_index')
      .on(t.createdAt)
      .where(sql`${t.rawPayload} is not null`),
    // D2 sweeper (M5-T12): re-queue PENDING / FAILED comments younger than 24 h.
    index('comments_moderation_retry_index')
      .on(t.createdAt)
      .where(sql.raw(`status in (${quoted(['PENDING', 'FAILED'])})`)),
    check(
      'comments_platform_check',
      sql.raw(`platform in (${quoted(COMMENT_PLATFORMS)})`),
    ),
    check(
      'comments_status_check',
      sql.raw(`status in (${quoted(COMMENT_STATUSES)})`),
    ),
    check('comments_comment_id_format', objectId('comment_id')),
    check('comments_post_id_format', objectId('post_id')),
    check('comments_author_id_format', numericId('author_id', true)),
    check(
      'comments_facebook_user_id_format',
      numericId('facebook_user_id', true),
    ),
    check(
      'comments_category_check',
      sql.raw(inListSql('category', MODERATION_CATEGORIES, true)),
    ),
    check(
      'comments_confidence_range',
      sql.raw('confidence is null or confidence between 0 and 1'),
    ),
    check(
      'comments_reasoning_check',
      sql.raw(
        `reasoning is null or (category is not null and ${lengthSql('reasoning', 0, MAX_REASONING_CHARS)})`,
      ),
    ),
    check(
      'comments_language_check',
      sql.raw(inListSql('language', COMMENT_LANGUAGES, true)),
    ),
    check(
      'comments_ai_provider_check',
      sql.raw(inListSql('ai_provider', AI_PROVIDERS, true)),
    ),
    check(
      'comments_model_length',
      sql.raw(lengthSql('model', 1, AI_MODEL_MAX_LENGTH, true)),
    ),
    check(
      'comments_prompt_version_format',
      sql.raw(patternSql('prompt_version', PROMPT_VERSION_PATTERN, true)),
    ),
    check(
      'comments_context_level_check',
      sql.raw(inListSql('context_level', CONTEXT_LEVELS, true)),
    ),
    check(
      'comments_classification_complete',
      sql.raw(allOrNoneSql(CLASSIFICATION_COLUMNS)),
    ),
    check('comments_credits_charged_check', sql`${t.creditsCharged} >= 0`),
    check(
      'comments_status_reason_format',
      sql.raw(patternSql('status_reason', MACHINE_CODE_PATTERN, true)),
    ),
  ],
);

/**
 * `daily_comment_stats` counters: delta key → column `<key>Count` (M4-T2 ingest counters, then the
 * M5-T7 moderation ones; the category counters use `MODERATION_CATEGORY_KEYS`).
 */
export const DAILY_COMMENT_COUNTERS = [
  'received',
  'edited',
  'removed',
  'classified',
  ...Object.values(MODERATION_CATEGORY_KEYS),
  'hidden',
  'unhidden',
  'deleted',
  'replied',
  'skipped',
  'failed',
] as const;
export type DailyCommentCounter = (typeof DAILY_COMMENT_COUNTERS)[number];

export const dailyCommentStats = pgTable(
  'daily_comment_stats',
  {
    id: id(),
    workspaceId: uuid()
      .notNull()
      .references(() => workspaces.id, { onDelete: 'restrict' }),
    /** Meta Page id (not the `social_pages` row: aggregates outlive disconnect, D4/D7). */
    pageId: text().notNull(),
    platform: text().$type<CommentPlatform>().notNull(),
    /** Asia/Dhaka calendar day (`YYYY-MM-DD`). */
    day: date({ mode: 'string' }).notNull(),
    receivedCount: integer().notNull().default(0),
    editedCount: integer().notNull().default(0),
    removedCount: integer().notNull().default(0),
    // Moderation counters (M5-T7): one per classification (incl. re-checked edits) and per
    // category of it, then per successful Meta action, then per SKIPPED / FAILED outcome.
    classifiedCount: integer().notNull().default(0),
    safeInquiryCount: integer().notNull().default(0),
    competitorPoachCount: integer().notNull().default(0),
    scamPhishingCount: integer().notNull().default(0),
    spamIrrelevantCount: integer().notNull().default(0),
    abusiveToxicCount: integer().notNull().default(0),
    hiddenCount: integer().notNull().default(0),
    unhiddenCount: integer().notNull().default(0),
    deletedCount: integer().notNull().default(0),
    repliedCount: integer().notNull().default(0),
    skippedCount: integer().notNull().default(0),
    failedCount: integer().notNull().default(0),
    ...timestamps,
  },
  (t) => [
    // Upsert key; leads with workspace_id, so it also serves workspace range reads.
    unique('daily_comment_stats_key_unique').on(
      t.workspaceId,
      t.pageId,
      t.platform,
      t.day,
    ),
    check('daily_comment_stats_page_id_format', numericId('page_id')),
    check(
      'daily_comment_stats_platform_check',
      sql.raw(`platform in (${quoted(COMMENT_PLATFORMS)})`),
    ),
    check(
      'daily_comment_stats_counts_check',
      sql.raw(
        nonNegativeSql(
          DAILY_COMMENT_COUNTERS.map((key) => snakeCase(`${key}Count`)),
        ),
      ),
    ),
  ],
);

export const webhookEventsRelations = relations(webhookEvents, ({ one }) => ({
  workspace: one(workspaces, {
    fields: [webhookEvents.workspaceId],
    references: [workspaces.id],
  }),
}));

export const commentsRelations = relations(comments, ({ one }) => ({
  workspace: one(workspaces, {
    fields: [comments.workspaceId],
    references: [workspaces.id],
  }),
  socialPage: one(socialPages, {
    fields: [comments.socialPageId],
    references: [socialPages.id],
  }),
}));

export const dailyCommentStatsRelations = relations(
  dailyCommentStats,
  ({ one }) => ({
    workspace: one(workspaces, {
      fields: [dailyCommentStats.workspaceId],
      references: [workspaces.id],
    }),
  }),
);
