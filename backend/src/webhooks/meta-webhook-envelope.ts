import { webhookPayloadHash } from '../comments/comments.queries.js';
import type { CommentVerb } from '../db/schema/index.js';
import { commentEditHash, commentJobId } from '../queue/queue.constants.js';
import type { CommentIngestJobData } from './comment-ingest.job.js';

/**
 * Pure parser for a signed Meta webhook body (M4-T4, Module 4 D2): keeps Page `feed` comment
 * changes (`item: comment`, verbs `add`/`edited`/`remove`) and IG `comments` changes, drops own
 * comments (`from.id` = `entry.id`) and everything else, and returns one `comment-ingest` job per
 * kept change. Never throws: anything unexpected is counted as skipped (Meta retries non-200s, so
 * the receiver answers 200 for whatever it can't use).
 */

export type MetaWebhookSkipReason =
  | 'invalid_json'
  | 'invalid_envelope'
  | 'unknown_object'
  | 'invalid_entry'
  | 'unknown_field'
  | 'unknown_item'
  | 'unknown_verb'
  | 'own_comment'
  | 'missing_ids'
  | 'duplicate';

export interface CommentIngestJob {
  jobId: string;
  data: CommentIngestJobData;
}

export interface MetaWebhookParseResult {
  /** `page` / `instagram` when the envelope had one of them, else `null`. */
  object: 'page' | 'instagram' | null;
  jobs: CommentIngestJob[];
  /** Counts per reason (only reasons that occurred). */
  skipped: Partial<Record<MetaWebhookSkipReason, number>>;
}

/** Page / IG account / user ids. */
const NUMERIC_ID = /^[0-9]{1,32}$/;
/** Same as the `comments.comment_id` / `post_id` DB checks (M4-T2). */
const META_OBJECT_ID = /^[0-9]{1,32}(_[0-9]{1,32}){0,2}$/;
const FB_VERBS: readonly CommentVerb[] = ['add', 'edited', 'remove'];

type JsonObject = Record<string, unknown>;

const isObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const str = (value: unknown): string | null =>
  typeof value === 'string' ? value : null;

const matching = (value: unknown, pattern: RegExp): string | null => {
  const s = str(value);
  return s !== null && pattern.test(s) ? s : null;
};

/** Unix seconds as a number (Meta sends integers; numeric strings tolerated). */
const unixTime = (value: unknown): number | null => {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }
  if (typeof value === 'string' && /^[0-9]{1,15}$/.test(value)) {
    return Number(value);
  }
  return null;
};

class Collector {
  readonly jobs: CommentIngestJob[] = [];
  readonly skipped: Partial<Record<MetaWebhookSkipReason, number>> = {};
  private readonly seen = new Set<string>();

  skip(reason: MetaWebhookSkipReason): void {
    this.skipped[reason] = (this.skipped[reason] ?? 0) + 1;
  }

  add(job: CommentIngestJob): void {
    if (this.seen.has(job.jobId)) return this.skip('duplicate');
    this.seen.add(job.jobId);
    this.jobs.push(job);
  }
}

interface EntryContext {
  accountId: string;
  entryTime: number | null;
}

/** Fields shared by both platforms once the platform-specific bits are read. */
interface ChangeFields {
  verb: CommentVerb;
  commentId: unknown;
  postId: unknown;
  parentId: unknown;
  from: unknown;
  authorNameKey: 'name' | 'username';
  message: unknown;
  createdTime: number | null;
}

function buildJob(
  platform: CommentIngestJobData['platform'],
  entry: EntryContext,
  value: JsonObject,
  fields: ChangeFields,
  out: Collector,
): void {
  const from = isObject(fields.from) ? fields.from : null;
  const fromId = from ? str(from.id) : null;
  // D2: comments written by the Page / IG account itself are never moderated.
  if (fromId !== null && fromId === entry.accountId)
    return out.skip('own_comment');

  const commentId = matching(fields.commentId, META_OBJECT_ID);
  const postId = matching(fields.postId, META_OBJECT_ID);
  if (!commentId || !postId) return out.skip('missing_ids');

  const message = str(fields.message);
  const eventId =
    fields.verb === 'edited'
      ? commentJobId(platform, commentId, 'edited', commentEditHash(message))
      : commentJobId(platform, commentId, fields.verb);
  const base = {
    eventId,
    verb: fields.verb,
    commentId,
    postId,
    parentId: matching(fields.parentId, META_OBJECT_ID),
    authorId: matching(fromId, NUMERIC_ID),
    authorName: from ? str(from[fields.authorNameKey]) : null,
    message,
    createdTime: fields.createdTime,
    entryTime: entry.entryTime,
    payloadHash: webhookPayloadHash(value),
    rawPayload: value,
  };
  const data: CommentIngestJobData =
    platform === 'FACEBOOK'
      ? { ...base, platform, pageId: entry.accountId }
      : { ...base, platform, igBusinessId: entry.accountId };
  out.add({ jobId: eventId, data });
}

/** Page `feed` change: only `item: comment` with a D2 verb. */
function facebookChange(
  entry: EntryContext,
  field: unknown,
  value: JsonObject,
  out: Collector,
): void {
  if (field !== 'feed') return out.skip('unknown_field');
  if (value.item !== 'comment') return out.skip('unknown_item');
  const verb = FB_VERBS.find((v) => v === value.verb);
  if (!verb) return out.skip('unknown_verb');
  buildJob(
    'FACEBOOK',
    entry,
    value,
    {
      verb,
      commentId: value.comment_id,
      postId: value.post_id,
      parentId: value.parent_id,
      from: value.from,
      authorNameKey: 'name',
      message: value.message,
      createdTime: unixTime(value.created_time),
    },
    out,
  );
}

/**
 * IG `comments` change. IG sends no verb (only new comments are delivered), so it is `add`.
 * Shape: `{ id, text, from: { id, username }, media: { id }, parent_id? }`.
 */
function instagramChange(
  entry: EntryContext,
  field: unknown,
  value: JsonObject,
  out: Collector,
): void {
  if (field !== 'comments') return out.skip('unknown_field');
  const media = isObject(value.media) ? value.media : null;
  buildJob(
    'INSTAGRAM',
    entry,
    value,
    {
      verb: 'add',
      commentId: value.id,
      postId: media?.id,
      parentId: value.parent_id,
      from: value.from,
      authorNameKey: 'username',
      message: value.text,
      createdTime: null,
    },
    out,
  );
}

export function parseMetaWebhookEnvelope(
  rawBody: Buffer | string,
): MetaWebhookParseResult {
  const out = new Collector();
  let envelope: unknown;
  try {
    envelope = JSON.parse(
      typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8'),
    );
  } catch {
    out.skip('invalid_json');
    return { object: null, jobs: [], skipped: out.skipped };
  }
  if (!isObject(envelope) || !Array.isArray(envelope.entry)) {
    out.skip('invalid_envelope');
    return { object: null, jobs: [], skipped: out.skipped };
  }
  const object = envelope.object;
  if (object !== 'page' && object !== 'instagram') {
    out.skip('unknown_object');
    return { object: null, jobs: [], skipped: out.skipped };
  }
  const handleChange = object === 'page' ? facebookChange : instagramChange;

  for (const rawEntry of envelope.entry) {
    const accountId = isObject(rawEntry)
      ? matching(rawEntry.id, NUMERIC_ID)
      : null;
    if (!isObject(rawEntry) || !accountId || !Array.isArray(rawEntry.changes)) {
      out.skip('invalid_entry');
      continue;
    }
    const entry: EntryContext = {
      accountId,
      entryTime: unixTime(rawEntry.time),
    };
    for (const change of rawEntry.changes) {
      if (!isObject(change) || !isObject(change.value)) {
        out.skip('unknown_field');
        continue;
      }
      handleChange(entry, change.field, change.value, out);
    }
  }
  return { object, jobs: out.jobs, skipped: out.skipped };
}
