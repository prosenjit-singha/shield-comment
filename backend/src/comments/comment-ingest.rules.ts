import {
  COMMENT_PLATFORMS,
  COMMENT_VERBS,
  type CommentPlatform,
  type CommentVerb,
  type MetaConnectionStatus,
} from '../db/schema/index.js';
import {
  COMMENT_INGEST_JOB_NAME,
  type CommentIngestJobData,
} from '../webhooks/comment-ingest.job.js';

/**
 * Pure rules of the `comment-ingest` worker (M4-T5; Module 4 decisions D2/D3/D4/D9 + the
 * out-of-order decision of 2026-11-18): job validation, routing decision, event time, and the
 * retryable/permanent error split. The worker and its tests share them.
 */

/** What routing found for a job's Page / IG account (`undefined` = no such Page anywhere). */
export interface IngestRoute {
  workspaceId: string;
  /** `social_pages.id`. */
  socialPageId: string;
  /** Meta Page id (`daily_comment_stats.page_id`; for IG the linked Page). */
  pageId: string;
  isActive: boolean;
  /** `null` = the workspace has no `meta_connections` row. */
  connectionStatus: MetaConnectionStatus | null;
}

export const INGEST_DROP_REASONS = [
  'unknown_page',
  'inactive_page',
  'no_connection',
  'connection_revoked',
] as const;
export type IngestDropReason = (typeof INGEST_DROP_REASONS)[number];

export type IngestRouteDecision =
  | { kind: 'ingest'; route: IngestRoute }
  | { kind: 'drop'; reason: IngestDropReason };

/**
 * D4/D9: unknown or inactive Pages and REVOKED connections are dropped (logged, no rows);
 * NEEDS_REAUTH still ingests. A Page without a connection row can't happen through the app
 * (disconnect deletes both, D7) and is dropped like a revoked one.
 */
export function decideIngestRoute(
  route: IngestRoute | undefined,
): IngestRouteDecision {
  if (!route) return { kind: 'drop', reason: 'unknown_page' };
  if (route.connectionStatus === null) {
    return { kind: 'drop', reason: 'no_connection' };
  }
  if (route.connectionStatus === 'REVOKED') {
    return { kind: 'drop', reason: 'connection_revoked' };
  }
  if (!route.isActive) return { kind: 'drop', reason: 'inactive_page' };
  return { kind: 'ingest', route };
}

/** The `entry.id` a job routes by: FB Page id or IG business account id. */
export function ingestRoutingId(data: CommentIngestJobData): string {
  return data.platform === 'FACEBOOK' ? data.pageId : data.igBusinessId;
}

/** Oldest Meta timestamp we trust (2004-01-01, seconds). */
const MIN_EVENT_SECONDS = 1_072_915_200;
/** Clock skew allowed for Meta timestamps. */
const MAX_FUTURE_MS = 24 * 60 * 60 * 1000;

/**
 * When the change happened: `entry.time` (Meta's time of the change, also right for `edited` /
 * `remove`), else the FB comment's `created_time`, else `now`. Values that aren't plausible unix
 * seconds (before 2004 or more than a day ahead) are skipped. Sets the Dhaka day of the daily
 * counts, `edited_at` / `deleted_at`, and orders out-of-order edits.
 */
export function ingestEventInstant(
  data: Pick<CommentIngestJobData, 'entryTime' | 'createdTime'>,
  now: Date = new Date(),
): Date {
  for (const seconds of [data.entryTime, data.createdTime]) {
    if (
      typeof seconds === 'number' &&
      Number.isFinite(seconds) &&
      seconds >= MIN_EVENT_SECONDS &&
      seconds * 1000 <= now.getTime() + MAX_FUTURE_MS
    ) {
      return new Date(Math.floor(seconds) * 1000);
    }
  }
  return now;
}

/** A job that can never be stored (bad name or data): failing it again won't help. */
export class InvalidIngestJobError extends Error {
  constructor(readonly reason: string) {
    super(`Invalid comment-ingest job: ${reason}`);
    this.name = 'InvalidIngestJobError';
  }
}

/** Same formats as the DB checks (`src/db/schema/comments.ts`). */
const NUMERIC_ID = /^[0-9]{1,32}$/;
const META_OBJECT_ID = /^[0-9]{1,32}(_[0-9]{1,32}){0,2}$/;
const EVENT_ID =
  /^(FACEBOOK|INSTAGRAM):[0-9_]+:(add|remove|edited-[0-9a-f]{16})$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isNullableString = (value: unknown): value is string | null =>
  value === null || typeof value === 'string';

const isNullableNumber = (value: unknown): value is number | null =>
  value === null || (typeof value === 'number' && Number.isFinite(value));

/**
 * Checks a job against the M4-T4 contract (`comment-ingest.job.ts`) before any DB work, so a
 * malformed job fails once instead of 5 times. Throws `InvalidIngestJobError` (reason only, never
 * the comment text).
 */
export function parseCommentIngestJob(
  name: string,
  data: unknown,
): CommentIngestJobData {
  const fail = (reason: string): never => {
    throw new InvalidIngestJobError(reason);
  };
  if (name !== COMMENT_INGEST_JOB_NAME) fail(`unknown job name ${name}`);
  if (!isRecord(data)) return fail('data is not an object');

  const platform = data.platform;
  if (!COMMENT_PLATFORMS.includes(platform as CommentPlatform)) {
    fail('platform');
  }
  const routingId = platform === 'FACEBOOK' ? data.pageId : data.igBusinessId;
  if (typeof routingId !== 'string' || !NUMERIC_ID.test(routingId)) {
    fail(platform === 'FACEBOOK' ? 'pageId' : 'igBusinessId');
  }
  const verb = data.verb;
  if (!COMMENT_VERBS.includes(verb as CommentVerb)) fail('verb');
  for (const key of ['commentId', 'postId'] as const) {
    const value = data[key];
    if (typeof value !== 'string' || !META_OBJECT_ID.test(value)) fail(key);
  }
  // `webhook_events.event_id` as is: must name this job's platform, comment and verb.
  const eventId = data.eventId;
  const prefix = `${String(platform)}:${String(data.commentId)}:`;
  if (
    typeof eventId !== 'string' ||
    !EVENT_ID.test(eventId) ||
    !eventId.startsWith(prefix) ||
    !(verb === 'edited'
      ? eventId.slice(prefix.length).startsWith('edited-')
      : eventId.slice(prefix.length) === verb)
  ) {
    fail('eventId');
  }
  for (const key of ['parentId', 'authorName', 'message'] as const) {
    if (!isNullableString(data[key])) fail(key);
  }
  const authorId = data.authorId;
  if (
    !isNullableString(authorId) ||
    (authorId !== null && !NUMERIC_ID.test(authorId))
  ) {
    fail('authorId');
  }
  for (const key of ['createdTime', 'entryTime'] as const) {
    if (!isNullableNumber(data[key])) fail(key);
  }
  if (
    typeof data.payloadHash !== 'string' ||
    !SHA256_HEX.test(data.payloadHash)
  ) {
    fail('payloadHash');
  }
  if (!isRecord(data.rawPayload)) fail('rawPayload');
  return data as unknown as CommentIngestJobData;
}

/** The first `code` in an error's `cause` chain (pg SQLSTATE or a Node system error code). */
export function errorCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && isRecord(current); depth++) {
    if (typeof current.code === 'string') return current.code;
    current = current.cause;
  }
  return undefined;
}

const SQLSTATE = /^[0-9A-Z]{5}$/;

/**
 * Database errors that no retry can fix: data exceptions (class 22), NOT NULL / CHECK violations
 * (23502 / 23514) and SQL/schema errors (class 42). Everything else (connection loss, timeouts,
 * serialization/deadlock 40xxx, a unique/FK race 23505/23503 that a retry re-routes) is retried
 * per D3.
 */
export function isPermanentDbError(error: unknown): boolean {
  const code = errorCode(error);
  if (!code || !SQLSTATE.test(code)) return false;
  return (
    code.startsWith('22') ||
    code === '23502' ||
    code === '23514' ||
    code.startsWith('42')
  );
}

/**
 * A log-safe description of a failure: name + code, never the message of a DB error (Drizzle puts
 * the query params, i.e. comment text, into it).
 */
export function describeIngestError(error: unknown): string {
  if (error instanceof InvalidIngestJobError) return error.message;
  const name = error instanceof Error ? error.name : typeof error;
  const code = errorCode(error);
  return code ? `${name} ${code}` : name;
}
