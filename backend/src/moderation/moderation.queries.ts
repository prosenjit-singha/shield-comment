import { and, asc, eq, sql } from 'drizzle-orm';
import type { AiProvider } from '../ai-gateway/ai-provider.js';
import type { Database } from '../db/database.js';
import {
  AI_MODEL_MAX_LENGTH,
  comments,
  dailyAiUsage,
  moderationActions,
  moderationPolicies,
} from '../db/schema/index.js';
import {
  type ContextLevel,
  DEFAULT_CATEGORY_ACTIONS,
  DEFAULT_CONFIDENCE_THRESHOLD,
  DEFAULT_CONTEXT_LEVEL,
  DEFAULT_MODERATION_MODE,
  isMachineCode,
  MODERATION_CATEGORIES,
  MODERATION_CATEGORY_KEYS,
  type ModerationActionType,
  type ModerationCategory,
  type ModerationMode,
  type PolicyAction,
} from './moderation.constants.js';

/**
 * Storage helpers for moderation (M5-T7). Policy, actions and their writes are scoped by
 * `workspace_id`; `daily_ai_usage` is the one platform-wide table (no tenant data, D14).
 * Callers (M5-T8 policy, M5-T9 executor, M5-T12 worker) pass a database or a transaction.
 */

/** A database or a transaction. */
export type ModerationExecutor = Pick<Database, 'select' | 'insert' | 'update'>;

export type ModerationPolicyRow = typeof moderationPolicies.$inferSelect;
export type ModerationActionRow = typeof moderationActions.$inferSelect;
export type DailyAiUsageRow = typeof dailyAiUsage.$inferSelect;

/** One category's rule in a policy (D3 action, D6 auto-reply + its texts). */
export interface CategoryRule {
  action: PolicyAction;
  autoReply: boolean;
  replyEn: string | null;
  replyBn: string | null;
}

/** A policy as the decision code reads it (M5-T8). */
export interface ModerationPolicy {
  workspaceId: string;
  mode: ModerationMode;
  confidenceThreshold: number;
  aiContextLevel: ContextLevel;
  categories: Record<ModerationCategory, CategoryRule>;
}

/** The D3/D4/D6/D8 defaults a lazily created policy row has (= the column defaults). */
export function defaultModerationPolicy(workspaceId: string): ModerationPolicy {
  const categories = {} as Record<ModerationCategory, CategoryRule>;
  for (const category of MODERATION_CATEGORIES) {
    categories[category] = {
      action: DEFAULT_CATEGORY_ACTIONS[category],
      autoReply: false,
      replyEn: null,
      replyBn: null,
    };
  }
  return {
    workspaceId,
    mode: DEFAULT_MODERATION_MODE,
    confidenceThreshold: DEFAULT_CONFIDENCE_THRESHOLD,
    aiContextLevel: DEFAULT_CONTEXT_LEVEL,
    categories,
  };
}

/** Flat policy row → `ModerationPolicy` (per-category columns grouped). Pure. */
export function toModerationPolicy(row: ModerationPolicyRow): ModerationPolicy {
  const categories = {} as Record<ModerationCategory, CategoryRule>;
  for (const category of MODERATION_CATEGORIES) {
    const key = MODERATION_CATEGORY_KEYS[category];
    categories[category] = {
      action: row[`${key}Action`],
      autoReply: row[`${key}AutoReply`],
      replyEn: row[`${key}ReplyEn`],
      replyBn: row[`${key}ReplyBn`],
    };
  }
  return {
    workspaceId: row.workspaceId,
    mode: row.mode,
    confidenceThreshold: row.confidenceThreshold,
    aiContextLevel: row.aiContextLevel,
    categories,
  };
}

/** The workspace's policy row, `undefined` when none was created yet. */
export async function findModerationPolicy(
  executor: ModerationExecutor,
  workspaceId: string,
): Promise<ModerationPolicyRow | undefined> {
  const [row] = await executor
    .select()
    .from(moderationPolicies)
    .where(eq(moderationPolicies.workspaceId, workspaceId));
  return row;
}

/**
 * The workspace's policy, created with the defaults on first use (D5). Concurrent first calls
 * are safe: the insert is `ON CONFLICT DO NOTHING` on the workspace key, then the row is read.
 */
export async function getOrCreateModerationPolicy(
  executor: ModerationExecutor,
  workspaceId: string,
): Promise<ModerationPolicyRow> {
  const [created] = await executor
    .insert(moderationPolicies)
    .values({ workspaceId })
    .onConflictDoNothing({ target: moderationPolicies.workspaceId })
    .returning();
  if (created) return created;
  const row = await findModerationPolicy(executor, workspaceId);
  if (!row) throw new Error('Moderation policy vanished after insert');
  return row;
}

/** The workspace's policy row under `FOR UPDATE` (M5-T8 PATCH; call inside a transaction). */
export async function lockModerationPolicy(
  executor: ModerationExecutor,
  workspaceId: string,
): Promise<ModerationPolicyRow | undefined> {
  const [row] = await executor
    .select()
    .from(moderationPolicies)
    .where(eq(moderationPolicies.workspaceId, workspaceId))
    .for('update');
  return row;
}

/** Writes the given policy columns (`updated_at` bumped by `$onUpdate`); `undefined` = no row. */
export async function updateModerationPolicy(
  executor: ModerationExecutor,
  workspaceId: string,
  values: Partial<ModerationPolicyRow>,
): Promise<ModerationPolicyRow | undefined> {
  const {
    workspaceId: _key,
    createdAt: _c,
    updatedAt: _u,
    ...columns
  } = values;
  const [row] = await executor
    .update(moderationPolicies)
    .set(columns)
    .where(eq(moderationPolicies.workspaceId, workspaceId))
    .returning();
  return row;
}

export type NewModerationAction = {
  workspaceId: string;
  /** The `comments` row id. */
  commentId: string;
  action: ModerationActionType;
} & ({ source: 'AUTO' } | { source: 'USER'; userId: string });

/**
 * Logs a `PENDING` action (D10) for a comment of **this** workspace. `undefined` = no such
 * comment in the workspace (nothing written). A second auto-reply for the same comment violates
 * `moderation_actions_one_auto_reply` (23505): read it with `findAutoReplyAction` instead.
 */
export async function insertModerationAction(
  executor: ModerationExecutor,
  values: NewModerationAction,
): Promise<ModerationActionRow | undefined> {
  const [comment] = await executor
    .select({ id: comments.id })
    .from(comments)
    .where(
      and(
        eq(comments.workspaceId, values.workspaceId),
        eq(comments.id, values.commentId),
      ),
    );
  if (!comment) return undefined;
  const [row] = await executor
    .insert(moderationActions)
    .values({
      workspaceId: values.workspaceId,
      commentId: values.commentId,
      action: values.action,
      source: values.source,
      userId: values.source === 'USER' ? values.userId : null,
      state: 'PENDING',
    })
    .returning();
  return row;
}

export type ModerationActionOutcome =
  | { state: 'SUCCEEDED'; replyCommentId?: string }
  | { state: 'FAILED'; errorKind: string };

/**
 * `PENDING` → `SUCCEEDED` / `FAILED` (once: a finished action is never rewritten). `undefined`
 * = no pending action with that id in the workspace.
 */
export async function completeModerationAction(
  executor: ModerationExecutor,
  workspaceId: string,
  actionId: string,
  outcome: ModerationActionOutcome,
  at: Date = new Date(),
): Promise<ModerationActionRow | undefined> {
  if (outcome.state === 'FAILED' && !isMachineCode(outcome.errorKind)) {
    throw new Error('errorKind must be a machine code');
  }
  const [row] = await executor
    .update(moderationActions)
    .set({
      state: outcome.state,
      errorKind: outcome.state === 'FAILED' ? outcome.errorKind : null,
      replyCommentId:
        outcome.state === 'SUCCEEDED' ? (outcome.replyCommentId ?? null) : null,
      completedAt: at,
      updatedAt: at,
    })
    .where(
      and(
        eq(moderationActions.workspaceId, workspaceId),
        eq(moderationActions.id, actionId),
        eq(moderationActions.state, 'PENDING'),
      ),
    )
    .returning();
  return row;
}

/**
 * `FAILED` → `PENDING` for a retry of the same action (the auto-reply row is unique per comment,
 * so a retried reply reuses it). `undefined` = no failed action with that id in the workspace.
 */
export async function reopenModerationAction(
  executor: ModerationExecutor,
  workspaceId: string,
  actionId: string,
  at: Date = new Date(),
): Promise<ModerationActionRow | undefined> {
  const [row] = await executor
    .update(moderationActions)
    .set({
      state: 'PENDING',
      errorKind: null,
      completedAt: null,
      updatedAt: at,
    })
    .where(
      and(
        eq(moderationActions.workspaceId, workspaceId),
        eq(moderationActions.id, actionId),
        eq(moderationActions.state, 'FAILED'),
      ),
    )
    .returning();
  return row;
}

/** The comment's auto-reply action (at most one, D6), if any. */
export async function findAutoReplyAction(
  executor: ModerationExecutor,
  workspaceId: string,
  commentId: string,
): Promise<ModerationActionRow | undefined> {
  const [row] = await executor
    .select()
    .from(moderationActions)
    .where(
      and(
        eq(moderationActions.workspaceId, workspaceId),
        eq(moderationActions.commentId, commentId),
        eq(moderationActions.action, 'REPLY'),
        eq(moderationActions.source, 'AUTO'),
      ),
    );
  return row;
}

/** The comment's actions, oldest first (`created_at`, then `id`). */
export function listCommentModerationActions(
  executor: ModerationExecutor,
  workspaceId: string,
  commentId: string,
): Promise<ModerationActionRow[]> {
  return executor
    .select()
    .from(moderationActions)
    .where(
      and(
        eq(moderationActions.workspaceId, workspaceId),
        eq(moderationActions.commentId, commentId),
      ),
    )
    .orderBy(asc(moderationActions.createdAt), asc(moderationActions.id));
}

/** One AI usage observation (or a batch) for `daily_ai_usage` (D14). */
export interface DailyAiUsageDelta {
  /** Dhaka day (`dhakaDayKey()`). */
  day: string;
  provider: AiProvider;
  model: string;
  calls?: number;
  inputTokens?: number;
  outputTokens?: number;
  credits?: number;
  /** Latency of one call: added to the sum, raises the max. */
  latencyMs?: number;
  /** Failed calls by machine-code kind (`ClassificationFailureKind`); counted in `failed_calls`. */
  failures?: Readonly<Record<string, number>>;
}

export interface DailyAiUsageIncrements {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  credits: number;
  failedCalls: number;
  failuresByKind: Record<string, number>;
  latencyMs: number;
}

/**
 * Validates a usage delta and returns what it adds (pure; throws before any SQL on a bad value):
 * integers ≥ 0, model 1–100 chars, failure kinds are machine codes, failures ≤ calls.
 */
export function dailyAiUsageIncrements(
  delta: DailyAiUsageDelta,
): DailyAiUsageIncrements {
  const count = (value: number | undefined, name: string) => {
    const n = value ?? 0;
    if (!Number.isInteger(n) || n < 0) {
      throw new Error(`AI usage ${name} must be an integer ≥ 0`);
    }
    return n;
  };
  if (delta.model.length < 1 || delta.model.length > AI_MODEL_MAX_LENGTH) {
    throw new Error('AI usage model must be 1–100 characters');
  }
  const failuresByKind: Record<string, number> = {};
  let failedCalls = 0;
  for (const [kind, value] of Object.entries(delta.failures ?? {})) {
    if (!isMachineCode(kind)) {
      throw new Error('AI usage failure kinds must be machine codes');
    }
    const n = count(value, 'failure count');
    if (n > 0) {
      failuresByKind[kind] = n;
      failedCalls += n;
    }
  }
  const calls = count(delta.calls, 'calls');
  if (failedCalls > calls) {
    throw new Error('AI usage failures cannot exceed calls');
  }
  return {
    calls,
    inputTokens: count(delta.inputTokens, 'inputTokens'),
    outputTokens: count(delta.outputTokens, 'outputTokens'),
    credits: count(delta.credits, 'credits'),
    failedCalls,
    failuresByKind,
    latencyMs: count(delta.latencyMs, 'latencyMs'),
  };
}

/**
 * Adds to the day + provider + model aggregate, creating the row on first use (one atomic
 * upsert; failure kinds are merged key by key). Returns the new totals.
 */
export async function recordDailyAiUsage(
  executor: ModerationExecutor,
  delta: DailyAiUsageDelta,
): Promise<DailyAiUsageRow> {
  const inc = dailyAiUsageIncrements(delta);
  const t = dailyAiUsage;
  const [row] = await executor
    .insert(dailyAiUsage)
    .values({
      day: delta.day,
      provider: delta.provider,
      model: delta.model,
      calls: inc.calls,
      inputTokens: inc.inputTokens,
      outputTokens: inc.outputTokens,
      credits: inc.credits,
      failedCalls: inc.failedCalls,
      failuresByKind: inc.failuresByKind,
      latencyMsSum: inc.latencyMs,
      latencyMsMax: inc.latencyMs,
    })
    .onConflictDoUpdate({
      target: [t.day, t.provider, t.model],
      set: {
        calls: sql`${t.calls} + ${inc.calls}`,
        inputTokens: sql`${t.inputTokens} + ${inc.inputTokens}`,
        outputTokens: sql`${t.outputTokens} + ${inc.outputTokens}`,
        credits: sql`${t.credits} + ${inc.credits}`,
        failedCalls: sql`${t.failedCalls} + ${inc.failedCalls}`,
        failuresByKind: sql`(
          select coalesce(jsonb_object_agg(e.key, e.total), '{}'::jsonb)
          from (
            select key, sum(value::integer)::integer as total
            from (
              select * from jsonb_each_text(${t.failuresByKind})
              union all
              select * from jsonb_each_text(excluded.failures_by_kind)
            ) as kinds
            group by key
          ) as e
        )`,
        latencyMsSum: sql`${t.latencyMsSum} + ${inc.latencyMs}`,
        latencyMsMax: sql`greatest(${t.latencyMsMax}, ${inc.latencyMs})`,
        updatedAt: sql`now()`,
      },
    })
    .returning();
  return row!;
}

/** Usage rows for an inclusive Dhaka day range (platform-wide), oldest first. */
export function listDailyAiUsage(
  executor: ModerationExecutor,
  range: { from: string; to: string },
): Promise<DailyAiUsageRow[]> {
  return executor
    .select()
    .from(dailyAiUsage)
    .where(sql`${dailyAiUsage.day} between ${range.from} and ${range.to}`)
    .orderBy(dailyAiUsage.day, dailyAiUsage.provider, dailyAiUsage.model);
}
