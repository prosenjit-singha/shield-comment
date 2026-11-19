import type { CommentPlatform } from '../db/schema/comments.js';
import { MAX_COMMENT_CHARS, normalizeText } from './classifier-input.js';
import type { ModerationComment } from './comment-moderation.queries.js';
import type { ModerationDecision } from './moderation-decision.js';
import type { CommentStatus } from './moderation.constants.js';

/**
 * Pure rules of the moderation worker (M5-T12; D2, D11, D13 answered 2026-11-19; PW-D1/D9). No I/O.
 */

/** Why the worker did not classify a comment (machine codes, fit `comments.status_reason`). */
export const MODERATION_WORKER_SKIPS = [
  /** No such comment in the job's workspace. */
  'comment_not_found',
  /** The job is for an older version: a newer edit has its own job. */
  'stale_version',
  /** This version is already done (duplicate job, retry after success). */
  'already_moderated',
  /** D10: a human decided on this comment. */
  'human_override',
  /** D13: deleted on Meta (or by us). */
  'comment_deleted',
  /** D13: sticker/photo-only or blank text. */
  'no_text',
  /** D13: orphaned by a disconnect (`social_page_id` null). */
  'page_disconnected',
  /** D13: the Page is switched off. */
  'page_inactive',
  /** No Meta connection, or it was revoked: nothing could act on the result. */
  'connection_inactive',
  /** PW-D1: the account's monthly comment limit is used up (no AI call). */
  'comment_limit_reached',
  /** PW-D9: the account has no live plan (trial/term over): moderation pauses, no AI call. */
  'no_active_plan',
] as const;
export type ModerationWorkerSkip = (typeof MODERATION_WORKER_SKIPS)[number];

/** The skips that leave the comment `SKIPPED` (when it has no outcome yet). */
const STATUS_SKIPS: ReadonlySet<ModerationWorkerSkip> = new Set([
  'comment_deleted',
  'no_text',
  'page_disconnected',
  'page_inactive',
  'connection_inactive',
  'comment_limit_reached',
  'no_active_plan',
]);

/** Does this skip write `SKIPPED` + reason? (`human_override` never touches the status, D10.) */
export function skipSetsStatus(reason: ModerationWorkerSkip): boolean {
  return STATUS_SKIPS.has(reason);
}

/** Same version? (`edited_at` of the row vs the job; both `null` = the original text.) */
export function sameVersion(a: Date | null, b: Date | null): boolean {
  return (a?.getTime() ?? null) === (b?.getTime() ?? null);
}

/**
 * D13 + D10 rules before any AI call (first match wins). `null` = classify. A connection in
 * `NEEDS_REAUTH` is classified (the Meta action is skipped later, `connection_needs_reauth`).
 */
export function preClassifySkip(
  comment: Pick<
    ModerationComment,
    | 'overriddenAt'
    | 'deletedAt'
    | 'status'
    | 'message'
    | 'socialPageId'
    | 'page'
    | 'connectionStatus'
  >,
): ModerationWorkerSkip | null {
  if (comment.overriddenAt !== null) return 'human_override';
  if (comment.deletedAt !== null || comment.status === 'DELETED') {
    return 'comment_deleted';
  }
  if (
    comment.message === null ||
    normalizeText(comment.message, MAX_COMMENT_CHARS).length === 0
  ) {
    return 'no_text';
  }
  if (comment.socialPageId === null || comment.page === null) {
    return 'page_disconnected';
  }
  if (!comment.page.isActive) return 'page_inactive';
  if (
    comment.connectionStatus !== 'ACTIVE' &&
    comment.connectionStatus !== 'NEEDS_REAUTH'
  ) {
    return 'connection_inactive';
  }
  return null;
}

/**
 * The status a comment gets when the worker could not finish it (`SKIPPED`, `FAILED`,
 * `NEEDS_REVIEW`): a comment that is hidden or deleted on Meta keeps that status (the status
 * mirrors Meta; D2 "stays visible" is about comments that are visible).
 */
export function statusWhenUnfinished(
  current: CommentStatus,
  wanted: CommentStatus,
): CommentStatus {
  return current === 'HIDDEN' || current === 'DELETED' ? current : wanted;
}

/**
 * Meta `parent_id` from the stored webhook change: FB top-level comments carry the post id as
 * parent, replies the parent comment id; IG sends `parent_id` for replies only. `raw_payload` is
 * purged after 30 days, the sweeper only looks at the last 24 h.
 */
export function commentIsReply(
  platform: CommentPlatform,
  postId: string,
  rawPayload: Record<string, unknown> | null,
): boolean {
  const parent = rawPayload?.parent_id;
  if (typeof parent !== 'string' || parent.length === 0) return false;
  return platform === 'INSTAGRAM' ? true : parent !== postId;
}

/** The job's last try: `UnrecoverableError` or exhausted attempts (BullMQ `attemptsMade` is 0-based). */
export function isFinalAttempt(job: {
  attemptsMade: number;
  opts: { attempts?: number };
}): boolean {
  return job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
}

/** Does the decision need Meta (an action or a reply)? */
export function needsMeta(decision: ModerationDecision): boolean {
  return decision.action !== 'NONE' || decision.reply !== undefined;
}

/** `status_reason` of a finished decision: the reason for `NEEDS_REVIEW`, else none. */
export function decisionStatusReason(
  decision: ModerationDecision,
): string | null {
  return decision.status === 'NEEDS_REVIEW' ? decision.reason : null;
}

/** Worker tuning from the env (D3 limiter for LLM calls). */
export interface ModerationWorkerSettings {
  concurrency: number;
  /** BullMQ limiter: at most `max` jobs (≈ LLM calls) per `durationMs`. */
  limiter: { max: number; duration: number };
}

export const DEFAULT_MODERATION_WORKER_SETTINGS: ModerationWorkerSettings = {
  concurrency: 4,
  limiter: { max: 10, duration: 1_000 },
};

/** The part of a BullMQ `Worker` the settings touch (FakeWorker in e2e has it too). */
export interface ConfigurableWorker {
  concurrency: number;
  opts: { limiter?: { max: number; duration: number } };
  isRunning(): boolean;
  run(): Promise<void>;
}

/**
 * Applies concurrency + limiter, then starts the worker (`@Processor(…, { autorun: false })`:
 * decorators run before `.env` is loaded, so the values come from `ConfigService` at bootstrap).
 * BullMQ reads `opts.limiter` on every fetch, so setting it before `run()` is enough.
 */
export function startModerationWorker(
  worker: ConfigurableWorker,
  settings: ModerationWorkerSettings,
): Promise<void> | null {
  worker.concurrency = settings.concurrency;
  worker.opts.limiter = { ...settings.limiter };
  if (worker.isRunning()) return null;
  return worker.run();
}
