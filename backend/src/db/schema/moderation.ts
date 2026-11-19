import { relations, sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { AI_PROVIDERS, type AiProvider } from '../../ai-gateway/ai-provider.js';
import {
  AUTO_REPLY_TEXT_MAX_CHARS,
  CONTEXT_LEVELS,
  type ContextLevel,
  DEFAULT_CATEGORY_ACTIONS,
  DEFAULT_CONFIDENCE_THRESHOLD,
  DEFAULT_CONTEXT_LEVEL,
  DEFAULT_MODERATION_MODE,
  MACHINE_CODE_PATTERN,
  MODERATION_ACTION_SOURCES,
  MODERATION_ACTION_STATES,
  MODERATION_ACTION_TYPES,
  MODERATION_CATEGORIES,
  MODERATION_CATEGORY_KEYS,
  MODERATION_MODES,
  type ModerationActionSource,
  type ModerationActionState,
  type ModerationActionType,
  type ModerationMode,
  POLICY_ACTIONS,
  type PolicyAction,
} from '../../moderation/moderation.constants.js';
import { AI_MODEL_MAX_LENGTH } from './ai-settings.js';
import { users } from './auth.js';
import {
  inListSql,
  lengthSql,
  nonNegativeSql,
  patternSql,
  snakeCase,
} from './check-sql.js';
import { id, timestamps, timestamptz } from './columns.js';
import { comments } from './comments.js';
import { workspaces } from './workspaces.js';

/**
 * Moderation storage (Module 5, M5-T7; user decisions 2026-11-19 D3/D4/D5/D6/D8/D10/D14, see
 * docs/progress/TASKS.md).
 *
 * - `moderation_actions`: one row per Meta action on a comment (D10 log): the executor (M5-T9)
 *   inserts it `PENDING`, calls Graph outside any transaction, then marks it `SUCCEEDED`/`FAILED`.
 *   Tenant data: workspace + comment FKs `restrict`, so Data Deletion / `cleanup()` delete these
 *   rows **first** (before comments). The acting user is `set null` (a log never blocks deleting
 *   an account; `source` still says it was a human).
 * - `moderation_policies`: one row per workspace (D5), created lazily with the D3/D4/D6/D8
 *   defaults; per category an action, an auto-reply switch and its en + bn texts (D6).
 * - `daily_ai_usage`: platform-wide AI aggregate per Asia/Dhaka day + provider + model (D14, for
 *   the admin "AI moderation" card). No workspace, no personal data, never purged.
 */

const providerCheck = inListSql('provider', AI_PROVIDERS);

export const moderationActions = pgTable(
  'moderation_actions',
  {
    id: id(),
    workspaceId: uuid()
      .notNull()
      .references(() => workspaces.id, { onDelete: 'restrict' }),
    /** The `comments` row (not the Meta comment id). */
    commentId: uuid()
      .notNull()
      .references(() => comments.id, { onDelete: 'restrict' }),
    action: text().$type<ModerationActionType>().notNull(),
    source: text().$type<ModerationActionSource>().notNull(),
    /** The member who acted (`source = USER`); `null` for `AUTO` or once the user is deleted. */
    userId: uuid().references(() => users.id, { onDelete: 'set null' }),
    state: text().$type<ModerationActionState>().notNull().default('PENDING'),
    /** Machine code of a `FAILED` action (a `MetaGraphError.kind`, `not_found`, …). */
    errorKind: text(),
    /** Meta id of the reply we posted (`REPLY` only, once it succeeded). */
    replyCommentId: text(),
    /** When the action reached `SUCCEEDED` / `FAILED`. */
    completedAt: timestamptz(),
    ...timestamps,
  },
  (t) => [
    // Workspace activity lists (newest first).
    index().on(t.workspaceId, t.createdAt.desc()),
    // Per-comment history + the FK lookups of Data Deletion / cleanup.
    index().on(t.commentId, t.createdAt),
    // FK `on delete set null` lookups (deleting a user).
    index('moderation_actions_user_id_index')
      .on(t.userId)
      .where(sql`${t.userId} is not null`),
    // D6: at most one auto-reply per comment (a retry updates the same row, never sends again).
    uniqueIndex('moderation_actions_one_auto_reply')
      .on(t.commentId)
      .where(sql.raw(`action = 'REPLY' and source = 'AUTO'`)),
    check(
      'moderation_actions_action_check',
      sql.raw(inListSql('action', MODERATION_ACTION_TYPES)),
    ),
    check(
      'moderation_actions_source_check',
      sql.raw(inListSql('source', MODERATION_ACTION_SOURCES)),
    ),
    check(
      'moderation_actions_state_check',
      sql.raw(inListSql('state', MODERATION_ACTION_STATES)),
    ),
    check(
      'moderation_actions_auto_has_no_user',
      sql.raw(`source = 'USER' or user_id is null`),
    ),
    check(
      'moderation_actions_error_kind_check',
      sql.raw(
        `(state = 'FAILED') = (error_kind is not null) and (${patternSql('error_kind', MACHINE_CODE_PATTERN, true)})`,
      ),
    ),
    check(
      'moderation_actions_completed_at_check',
      sql.raw(`(state = 'PENDING') = (completed_at is null)`),
    ),
    check(
      'moderation_actions_reply_comment_id_check',
      sql.raw(
        `reply_comment_id is null or (action = 'REPLY' and state = 'SUCCEEDED' and ${patternSql('reply_comment_id', '^[0-9]{1,32}(_[0-9]{1,32}){0,2}$')})`,
      ),
    ),
  ],
);

/** Policy columns of one category (`<key>Action`, `<key>AutoReply`, `<key>ReplyEn`, `<key>ReplyBn`). */
const categoryChecks = MODERATION_CATEGORIES.flatMap((category) => {
  const key = MODERATION_CATEGORY_KEYS[category];
  const action = snakeCase(`${key}Action`);
  const autoReply = snakeCase(`${key}AutoReply`);
  const replyEn = snakeCase(`${key}ReplyEn`);
  const replyBn = snakeCase(`${key}ReplyBn`);
  return [
    check(
      `moderation_policies_${action}_check`,
      sql.raw(inListSql(action, POLICY_ACTIONS)),
    ),
    check(
      `moderation_policies_${snakeCase(key)}_reply_check`,
      sql.raw(
        `(not ${autoReply} or (${replyEn} is not null and ${replyBn} is not null)) and (${lengthSql(replyEn, 1, AUTO_REPLY_TEXT_MAX_CHARS, true)}) and (${lengthSql(replyBn, 1, AUTO_REPLY_TEXT_MAX_CHARS, true)})`,
      ),
    ),
  ];
});

const actionColumn = (category: keyof typeof DEFAULT_CATEGORY_ACTIONS) =>
  text()
    .$type<PolicyAction>()
    .notNull()
    .default(DEFAULT_CATEGORY_ACTIONS[category]);
const autoReplyColumn = () => boolean().notNull().default(false);

export const moderationPolicies = pgTable(
  'moderation_policies',
  {
    /** One row per workspace (D5). */
    workspaceId: uuid()
      .primaryKey()
      .references(() => workspaces.id, { onDelete: 'restrict' }),
    mode: text()
      .$type<ModerationMode>()
      .notNull()
      .default(DEFAULT_MODERATION_MODE),
    /** D4: ≥ threshold → the category's action; below → no action, `NEEDS_REVIEW`. */
    confidenceThreshold: numeric({ precision: 4, scale: 3, mode: 'number' })
      .notNull()
      .default(DEFAULT_CONFIDENCE_THRESHOLD),
    /** D8: what the LLM sees (and what a call costs). */
    aiContextLevel: text()
      .$type<ContextLevel>()
      .notNull()
      .default(DEFAULT_CONTEXT_LEVEL),
    // Per category (D3 action, D6 auto-reply off + its en/bn texts). Texts are kept when the
    // switch is turned off, so turning it back on needs no retyping.
    safeInquiryAction: actionColumn('SAFE_INQUIRY'),
    safeInquiryAutoReply: autoReplyColumn(),
    safeInquiryReplyEn: text(),
    safeInquiryReplyBn: text(),
    competitorPoachAction: actionColumn('COMPETITOR_POACH'),
    competitorPoachAutoReply: autoReplyColumn(),
    competitorPoachReplyEn: text(),
    competitorPoachReplyBn: text(),
    scamPhishingAction: actionColumn('SCAM_PHISHING'),
    scamPhishingAutoReply: autoReplyColumn(),
    scamPhishingReplyEn: text(),
    scamPhishingReplyBn: text(),
    spamIrrelevantAction: actionColumn('SPAM_IRRELEVANT'),
    spamIrrelevantAutoReply: autoReplyColumn(),
    spamIrrelevantReplyEn: text(),
    spamIrrelevantReplyBn: text(),
    abusiveToxicAction: actionColumn('ABUSIVE_TOXIC'),
    abusiveToxicAutoReply: autoReplyColumn(),
    abusiveToxicReplyEn: text(),
    abusiveToxicReplyBn: text(),
    ...timestamps,
  },
  (t) => [
    check(
      'moderation_policies_mode_check',
      sql.raw(inListSql('mode', MODERATION_MODES)),
    ),
    check(
      'moderation_policies_threshold_range',
      sql`${t.confidenceThreshold} between 0 and 1`,
    ),
    check(
      'moderation_policies_ai_context_level_check',
      sql.raw(inListSql('ai_context_level', CONTEXT_LEVELS)),
    ),
    ...categoryChecks,
  ],
);

/** Failure counts by kind (`ClassificationFailureKind` machine codes). */
export type AiFailureCounts = Record<string, number>;

export const dailyAiUsage = pgTable(
  'daily_ai_usage',
  {
    id: id(),
    /** Asia/Dhaka calendar day (`YYYY-MM-DD`). */
    day: date({ mode: 'string' }).notNull(),
    provider: text().$type<AiProvider>().notNull(),
    model: text().notNull(),
    /** Classification requests (one per `classify()`, its retries included). */
    calls: integer().notNull().default(0),
    inputTokens: bigint({ mode: 'number' }).notNull().default(0),
    outputTokens: bigint({ mode: 'number' }).notNull().default(0),
    credits: bigint({ mode: 'number' }).notNull().default(0),
    /** Failed calls in total (= sum of `failures_by_kind`). */
    failedCalls: integer().notNull().default(0),
    failuresByKind: jsonb().$type<AiFailureCounts>().notNull().default({}),
    latencyMsSum: bigint({ mode: 'number' }).notNull().default(0),
    latencyMsMax: integer().notNull().default(0),
    ...timestamps,
  },
  (t) => [
    // Upsert key; also serves the day-range reads (M5-T13).
    unique('daily_ai_usage_key_unique').on(t.day, t.provider, t.model),
    check('daily_ai_usage_provider_check', sql.raw(providerCheck)),
    check(
      'daily_ai_usage_model_length',
      sql.raw(lengthSql('model', 1, AI_MODEL_MAX_LENGTH)),
    ),
    check(
      'daily_ai_usage_counts_check',
      sql.raw(
        nonNegativeSql([
          'calls',
          'input_tokens',
          'output_tokens',
          'credits',
          'failed_calls',
          'latency_ms_sum',
          'latency_ms_max',
        ]),
      ),
    ),
    check(
      'daily_ai_usage_failed_calls_check',
      sql`${t.failedCalls} <= ${t.calls}`,
    ),
    check(
      'daily_ai_usage_failures_by_kind_check',
      sql`jsonb_typeof(${t.failuresByKind}) = 'object'`,
    ),
  ],
);

export const moderationActionsRelations = relations(
  moderationActions,
  ({ one }) => ({
    workspace: one(workspaces, {
      fields: [moderationActions.workspaceId],
      references: [workspaces.id],
    }),
    comment: one(comments, {
      fields: [moderationActions.commentId],
      references: [comments.id],
    }),
    user: one(users, {
      fields: [moderationActions.userId],
      references: [users.id],
    }),
  }),
);

export const moderationPoliciesRelations = relations(
  moderationPolicies,
  ({ one }) => ({
    workspace: one(workspaces, {
      fields: [moderationPolicies.workspaceId],
      references: [workspaces.id],
    }),
  }),
);
