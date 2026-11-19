import type { JobsOptions } from 'bullmq';
import { DEFAULT_JOB_OPTIONS } from '../queue/queue.constants.js';

/**
 * `comment-moderation` queue contract (M5-T12; Module 4 D3, Module 5 D2/D11). Pure: no Nest
 * imports, so the ingest worker (producer) and the moderation worker share it.
 *
 * - `moderate-comment`: one per comment **version** (the original text, or one applied edit).
 *   Job id `moderate:<comments.id>:<edit key>` with edit key `add` (original) or
 *   `edit-<edited_at epoch ms>`, so a retried ingest job, a duplicate hand-off or the sweeper never
 *   creates a second job for the same version (BullMQ ignores an `add` with an existing id; a `:`
 *   is only allowed in 3-part ids).
 * - `moderation-sweep`: the D2 sweeper tick (job scheduler, no data).
 */
export const MODERATE_COMMENT_JOB_NAME = 'moderate-comment';
export const MODERATION_SWEEP_JOB_NAME = 'moderation-sweep';

/** What a `moderate-comment` job carries: ids + the version. Never comment text. */
export interface ModerateCommentJobData {
  workspaceId: string;
  /** `comments.id`. */
  commentRowId: string;
  /** `comments.edited_at` (ISO) of the version to moderate; `null` = the original text. */
  editedAt: string | null;
}

/** How long the ingest worker waits for Redis when it enqueues (the sweeper catches a miss). */
export const MODERATION_ENQUEUE_TIMEOUT_MS = 2_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `add` for the original text, `edit-<epoch ms>` for an edit. */
export function moderationEditKey(editedAt: Date | null): string {
  if (editedAt === null) return 'add';
  const ms = editedAt.getTime();
  if (!Number.isSafeInteger(ms) || ms < 0) {
    throw new Error('Invalid editedAt for a moderation job id');
  }
  return `edit-${ms}`;
}

/** `moderate:<comments.id>:<edit key>` (3 parts: BullMQ accepts the `:`). */
export function moderationJobId(
  commentRowId: string,
  editedAt: Date | null,
): string {
  if (!UUID.test(commentRowId)) {
    throw new Error('Invalid comment row id for a moderation job id');
  }
  return `moderate:${commentRowId}:${moderationEditKey(editedAt)}`;
}

/** One `moderate-comment` job ready for `queue.add(name, data, opts)`. */
export function moderateCommentJob(target: {
  workspaceId: string;
  commentRowId: string;
  editedAt: Date | null;
}): { name: string; data: ModerateCommentJobData; opts: JobsOptions } {
  if (!UUID.test(target.workspaceId)) {
    throw new Error('Invalid workspace id for a moderation job');
  }
  return {
    name: MODERATE_COMMENT_JOB_NAME,
    data: {
      workspaceId: target.workspaceId,
      commentRowId: target.commentRowId,
      editedAt: target.editedAt === null ? null : target.editedAt.toISOString(),
    },
    opts: {
      ...DEFAULT_JOB_OPTIONS,
      jobId: moderationJobId(target.commentRowId, target.editedAt),
    },
  };
}

export class InvalidModerationJobError extends Error {
  constructor(readonly reason: string) {
    super(`comment-moderation: invalid job (${reason})`);
    this.name = 'InvalidModerationJobError';
  }
}

/** The parsed version of a job (`editedAt` as a Date). */
export interface ModerateCommentTarget {
  workspaceId: string;
  commentRowId: string;
  editedAt: Date | null;
}

/** Validates a `moderate-comment` job's data (`InvalidModerationJobError` → not retried). */
export function parseModerateCommentJob(data: unknown): ModerateCommentTarget {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new InvalidModerationJobError('data');
  }
  const record = data as Record<string, unknown>;
  const { workspaceId, commentRowId, editedAt } = record;
  if (typeof workspaceId !== 'string' || !UUID.test(workspaceId)) {
    throw new InvalidModerationJobError('workspaceId');
  }
  if (typeof commentRowId !== 'string' || !UUID.test(commentRowId)) {
    throw new InvalidModerationJobError('commentRowId');
  }
  if (editedAt === null || editedAt === undefined) {
    return { workspaceId, commentRowId, editedAt: null };
  }
  const at = typeof editedAt === 'string' ? new Date(editedAt) : null;
  if (at === null || Number.isNaN(at.getTime())) {
    throw new InvalidModerationJobError('editedAt');
  }
  return { workspaceId, commentRowId, editedAt: at };
}

/**
 * D2 sweeper: every 15 minutes (Asia/Dhaka cron), re-queues comments that still owe moderation
 * (`moderation_stage` set: `PENDING`, `FAILED`, an edit not re-checked yet) whose text is younger
 * than 24 h and that were not touched for 5 minutes (a job that is still retrying is left alone).
 */
export const MODERATION_SWEEP_SCHEDULER_ID = 'comment-moderation-sweep';
export const MODERATION_SWEEP_PATTERN = '*/15 * * * *';
export const MODERATION_SWEEP_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const MODERATION_SWEEP_IDLE_MS = 5 * 60 * 1000;
/** Most comments one sweep re-queues (oldest first; the next tick takes the rest). */
export const MODERATION_SWEEP_BATCH = 500;
