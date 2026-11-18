import type { CommentVerb } from '../db/schema/index.js';

/**
 * `comment-ingest` job contract (Module 4 D3): the webhook receiver (M4-T4) adds one job per kept
 * comment change; the ingestion worker (M4-T5) routes it to a workspace + Page and stores it.
 * Job id = `data.eventId` = `commentJobId()` (`<platform>:<commentId>:<verb>`, `edited-<hash>`
 * for edits), so BullMQ drops duplicate deliveries and the worker can use it as
 * `webhook_events.event_id` as is.
 */
export const COMMENT_INGEST_JOB_NAME = 'comment-change';

interface CommentIngestJobBase {
  /** = BullMQ job id = `webhook_events.event_id`. */
  eventId: string;
  /** IG has no verb in its payload: always `add`. */
  verb: CommentVerb;
  /** Meta comment id (FB `<postId>_<commentId>`, IG numeric); checked against the DB format. */
  commentId: string;
  /** FB `post_id` (`<pageId>_<postId>`) / IG `media.id`; checked against the DB format. */
  postId: string;
  /** FB `parent_id` (= the post for top-level comments) / IG `parent_id` (replies only). */
  parentId: string | null;
  /** Numeric `from.id`; `null` when Meta leaves out `from` or the id isn't numeric. */
  authorId: string | null;
  /** FB `from.name` / IG `from.username`. */
  authorName: string | null;
  /** FB `message` / IG `text`; `null` for sticker/photo-only comments and FB `remove`. */
  message: string | null;
  /** FB `value.created_time` (unix seconds); IG sends none → `null`. */
  createdTime: number | null;
  /** `entry.time` as Meta sends it (unix seconds); `null` when missing. */
  entryTime: number | null;
  /** `webhookPayloadHash(rawPayload)` for `webhook_events.payload_hash`. */
  payloadHash: string;
  /** The change `value` as received, for `comments.raw_payload` (purged after 30 days, D4). */
  rawPayload: Record<string, unknown>;
}

/**
 * Own comments (`from.id` = the Page / IG account) are already dropped by the receiver (D2), so
 * the worker never sees them.
 */
export type CommentIngestJobData =
  | (CommentIngestJobBase & {
      platform: 'FACEBOOK';
      /** `entry.id`: the Page that owns the post (routes to `social_pages.page_id`). */
      pageId: string;
    })
  | (CommentIngestJobBase & {
      platform: 'INSTAGRAM';
      /** `entry.id`: the IG business account (routes to `social_pages.ig_business_id`). */
      igBusinessId: string;
    });
