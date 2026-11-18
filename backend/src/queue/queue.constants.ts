import type { DefaultJobOptions, QueueOptions } from 'bullmq';

/**
 * BullMQ queues (Module 4 D3, user decision 2026-11-18). Inject one with
 * `@InjectQueue(QUEUE_NAMES.commentIngest) queue: Queue` (producers) and add a worker with
 * `@Processor(QUEUE_NAMES.commentIngest) class … extends WorkerHost` (in the API process for now).
 */
export const QUEUE_NAMES = {
  /** Webhook change → `comments` row (M4-T4 producer, M4-T5 worker). */
  commentIngest: 'comment-ingest',
  /** AI moderation (Module 5). Registered now, no worker yet. */
  commentModeration: 'comment-moderation',
  /** Scheduled Meta jobs: `debug_token`, purge (M4-T7). */
  metaTokenCheck: 'meta-token-check',
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

/** Every registered queue, in the order the admin system page lists them. */
export const ALL_QUEUE_NAMES: readonly QueueName[] = [
  QUEUE_NAMES.commentIngest,
  QUEUE_NAMES.commentModeration,
  QUEUE_NAMES.metaTokenCheck,
];

const HOUR_SECONDS = 60 * 60;

/**
 * D3 defaults for every job: 5 attempts with exponential backoff from 2 s (2, 4, 8, 16 s), and
 * bounded history so a 30 MB Redis (Redis Cloud free) never fills up.
 */
export const DEFAULT_JOB_OPTIONS = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 2000 },
  removeOnComplete: { age: HOUR_SECONDS, count: 1000 },
  removeOnFail: { age: 7 * 24 * HOUR_SECONDS, count: 1000 },
} as const satisfies DefaultJobOptions;

/**
 * Shared BullMQ root config: one connection config from `REDIS_URL` for queues **and** workers
 * (`@nestjs/bullmq` builds workers from the queue's connection), so `maxRetriesPerRequest` must be
 * `null` (BullMQ requires it for blocking worker connections). Each Queue/Worker opens its own
 * ioredis connection; commands wait while Redis is down, so callers that must answer fast (admin
 * counts, the webhook producer) put their own timeout around queue calls.
 */
export function bullRootOptions(redisUrl: string): QueueOptions {
  return {
    connection: { url: redisUrl, maxRetriesPerRequest: null },
    defaultJobOptions: { ...DEFAULT_JOB_OPTIONS },
  };
}

/**
 * Idempotent job id per D3: `<platform>:<commentId>:<verb>`, e.g. `FACEBOOK:123_456:add`.
 * BullMQ ignores an `add` whose `jobId` already exists, so webhook retries don't enqueue twice.
 * BullMQ only accepts a `:` in custom ids when there are exactly 3 parts, so no part may contain
 * one (it also rejects integer-looking ids, which this format can never be).
 */
export function commentJobId(
  platform: string,
  commentId: string,
  verb: string,
): string {
  for (const [label, part] of [
    ['platform', platform],
    ['commentId', commentId],
    ['verb', verb],
  ] as const) {
    if (!part || part.includes(':')) {
      throw new Error(`Invalid ${label} for a comment job id`);
    }
  }
  return `${platform}:${commentId}:${verb}`;
}
