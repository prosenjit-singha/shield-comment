import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { type Job, UnrecoverableError } from 'bullmq';
import { QUEUE_NAMES } from '../queue/queue.constants.js';
import {
  CommentIngestService,
  type IngestOutcome,
} from './comment-ingest.service.js';
import {
  describeIngestError,
  errorCode,
  ingestRoutingId,
  InvalidIngestJobError,
  isPermanentDbError,
  parseCommentIngestJob,
} from './comment-ingest.rules.js';

const ERROR_LOG_INTERVAL_MS = 5 * 60 * 1000;

/**
 * `comment-ingest` worker (M4-T5, D3: runs in the API process, 5 attempts with exponential
 * backoff from the queue defaults). Error split: a job that fails validation or hits a permanent
 * DB error (bad data, `isPermanentDbError`) throws `UnrecoverableError` → failed at once, no
 * retries; anything else (DB down, deadlock, a unique/FK race) is rethrown → BullMQ retries.
 * Logs carry ids, verbs, reasons and error codes only, never comment text or author names.
 *
 * E2E never opens a real BullMQ `Worker`: `createTestApp()` swaps the worker class for
 * `FakeWorker` and specs call `process(job)` directly.
 */
@Processor(QUEUE_NAMES.commentIngest)
export class CommentIngestProcessor extends WorkerHost {
  private readonly logger = new Logger('CommentIngest');
  private lastWorkerError: { message: string; at: number } | undefined;

  constructor(private readonly ingest: CommentIngestService) {
    super();
  }

  async process(job: Job<unknown, IngestOutcome>): Promise<IngestOutcome> {
    let data;
    try {
      data = parseCommentIngestJob(job.name, job.data);
    } catch (error) {
      if (error instanceof InvalidIngestJobError) {
        this.logger.warn(`Job ${job.id ?? '?'} rejected: ${error.reason}`);
        throw new UnrecoverableError(error.message);
      }
      throw error;
    }

    let outcome: IngestOutcome;
    try {
      outcome = await this.ingest.ingest(data);
    } catch (error) {
      if (isPermanentDbError(error)) {
        const code = errorCode(error) ?? 'unknown';
        this.logger.error(
          `Event ${data.eventId} rejected by the database (${code}); not retried`,
        );
        throw new UnrecoverableError(
          `comment-ingest: database rejected the change (${code})`,
        );
      }
      throw error;
    }

    switch (outcome.kind) {
      case 'dropped':
        // D4: unrouted comments leave no rows, only this line.
        this.logger.log(
          `Dropped ${data.eventId}: ${outcome.reason} (${data.platform} ${ingestRoutingId(data)})`,
        );
        break;
      case 'duplicate':
        this.logger.debug(`Duplicate ${data.eventId} ignored`);
        break;
      case 'stored':
        this.logger.debug(`Stored ${data.eventId}: ${outcome.action}`);
        this.handOffToModeration(outcome);
        break;
    }
    return outcome;
  }

  /**
   * Module 5 hand-off point (D3 `comment-moderation` queue). Runs after the ingest transaction
   * committed, for comments with new text (`moderate`: a created comment or an applied edit of a
   * comment that isn't deleted). Module 5 enqueues the moderation job here (job id from the
   * comment row id + edit, so retries of this job don't moderate twice). Nothing is enqueued yet;
   * `comments.status` stays `PENDING`.
   */
  private handOffToModeration(
    outcome: Extract<IngestOutcome, { kind: 'stored' }>,
  ): void {
    if (!outcome.moderate) return;
    // Module 5: enqueue `comment-moderation` for `outcome.commentRowId` here.
  }

  /** Last attempt failed (or an `UnrecoverableError`): the job lands in the failed set (7 d). */
  @OnWorkerEvent('failed')
  onFailed(job: Job | undefined, error: Error): void {
    const attempts = job?.opts.attempts ?? 1;
    const made = job?.attemptsMade ?? 0;
    const final =
      error instanceof UnrecoverableError ||
      error.name === 'UnrecoverableError' ||
      made >= attempts;
    const line = `Job ${job?.id ?? '?'} failed (attempt ${made}/${attempts}): ${
      error.name === 'UnrecoverableError'
        ? error.message
        : describeIngestError(error)
    }`;
    if (final) this.logger.error(line);
    else this.logger.warn(line);
  }

  /**
   * Worker connection errors (Redis down). Without a listener Node would throw on the `error`
   * event; one line per message every 5 min, like `QueueRegistry`.
   */
  @OnWorkerEvent('error')
  onError(error: Error): void {
    const now = Date.now();
    const last = this.lastWorkerError;
    if (
      last?.message === error.message &&
      now - last.at < ERROR_LOG_INTERVAL_MS
    ) {
      return;
    }
    this.lastWorkerError = { message: error.message, at: now };
    this.logger.warn(`Worker ${QUEUE_NAMES.commentIngest}: ${error.message}`);
  }
}
