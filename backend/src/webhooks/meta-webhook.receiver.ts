import { InjectQueue } from '@nestjs/bullmq';
import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { Queue } from 'bullmq';
import { withTimeout } from '../common/async/with-timeout.js';
import { DEFAULT_JOB_OPTIONS, QUEUE_NAMES } from '../queue/queue.constants.js';
import {
  COMMENT_INGEST_JOB_NAME,
  type CommentIngestJobData,
} from './comment-ingest.job.js';
import {
  type MetaWebhookParseResult,
  parseMetaWebhookEnvelope,
} from './meta-webhook-envelope.js';

/**
 * Upper bound for enqueueing one delivery. Meta wants the 200 fast (spec: < 200 ms) and queue
 * calls wait forever while Redis is down (`maxRetriesPerRequest: null`, M4-T1).
 */
export const WEBHOOK_ENQUEUE_TIMEOUT_MS = 150;

export interface MetaWebhookReceipt {
  enqueued: number;
  skipped: MetaWebhookParseResult['skipped'];
}

/**
 * Turns a signed webhook body into `comment-ingest` jobs (M4-T4). No DB work: routing and storage
 * are the worker's (M4-T5). All jobs of a delivery go in one `addBulk` round trip; a failure or
 * timeout → 503 so Meta retries the delivery (safe: the job ids dedupe it). Logs counts only,
 * never comment text or author names.
 */
@Injectable()
export class MetaWebhookReceiver {
  private readonly logger = new Logger(MetaWebhookReceiver.name);

  constructor(
    @InjectQueue(QUEUE_NAMES.commentIngest)
    private readonly queue: Queue<CommentIngestJobData>,
  ) {}

  async receive(rawBody: Buffer): Promise<MetaWebhookReceipt> {
    const { object, jobs, skipped } = parseMetaWebhookEnvelope(rawBody);
    const summary = `object=${object ?? '-'} kept=${jobs.length} skipped=${formatCounts(skipped)}`;

    if (skipped.invalid_json) {
      // Signed by Meta but not JSON: answering non-200 would only make Meta retry it forever.
      this.logger.warn('Meta webhook body is not valid JSON; ignored');
      return { enqueued: 0, skipped };
    }
    if (jobs.length === 0) {
      this.logger.debug(`Meta webhook: nothing to enqueue (${summary})`);
      return { enqueued: 0, skipped };
    }

    try {
      await withTimeout(
        this.queue.addBulk(
          jobs.map(({ jobId, data }) => ({
            name: COMMENT_INGEST_JOB_NAME,
            data,
            opts: { ...DEFAULT_JOB_OPTIONS, jobId },
          })),
        ),
        WEBHOOK_ENQUEUE_TIMEOUT_MS,
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'unknown error';
      this.logger.error(
        `Meta webhook enqueue failed (${reason}); answering 503 so Meta retries (${summary})`,
      );
      throw new ServiceUnavailableException('Webhook queue unavailable');
    }
    this.logger.log(`Meta webhook enqueued ${jobs.length} (${summary})`);
    return { enqueued: jobs.length, skipped };
  }
}

function formatCounts(counts: MetaWebhookParseResult['skipped']): string {
  const parts = Object.entries(counts).map(([key, n]) => `${key}:${n}`);
  return parts.length ? parts.join(',') : '0';
}
