import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { type Job, UnrecoverableError } from 'bullmq';
import {
  describeIngestError,
  errorCode,
  isPermanentDbError,
} from '../comments/comment-ingest.rules.js';
import { QUEUE_NAMES } from '../queue/queue.constants.js';
import {
  type DataDeletionOutcome,
  MetaDataDeletionService,
} from './meta-data-deletion.service.js';
import {
  META_DATA_DELETION_JOB_NAME,
  parseMetaDataDeletionJob,
} from './meta-data-deletion.job.js';

const ERROR_LOG_INTERVAL_MS = 5 * 60 * 1000;

/** What a `meta-token-check` job returned (one variant per job name). */
export type MetaTokenCheckResult = DataDeletionOutcome;

/**
 * The one worker of the `meta-token-check` queue (D3; in the API process). BullMQ runs one worker
 * per queue, so jobs are dispatched by name: M4-T6 `data-deletion` (Module 4 D6); M4-T7 adds the
 * scheduled `debug_token` check and the `raw_payload` purge **here**. Unknown name / invalid data /
 * permanent DB error → `UnrecoverableError` (no retries); anything else is retried (5 attempts).
 * Logs carry ids, counts and error codes only.
 *
 * E2E never opens a real BullMQ `Worker` (`FakeWorker`); specs call `process(job)`.
 */
@Processor(QUEUE_NAMES.metaTokenCheck)
export class MetaTokenCheckProcessor extends WorkerHost {
  private readonly logger = new Logger('MetaTokenCheck');
  private lastWorkerError: { message: string; at: number } | undefined;

  constructor(private readonly dataDeletion: MetaDataDeletionService) {
    super();
  }

  async process(
    job: Job<unknown, MetaTokenCheckResult>,
  ): Promise<MetaTokenCheckResult> {
    switch (job.name) {
      case META_DATA_DELETION_JOB_NAME:
        return this.runDataDeletion(job);
      default:
        this.logger.warn(`Job ${job.id ?? '?'} rejected: unknown name`);
        throw new UnrecoverableError(
          `meta-token-check: unknown job name ${JSON.stringify(job.name)}`,
        );
    }
  }

  private async runDataDeletion(job: Job): Promise<DataDeletionOutcome> {
    const data = parseMetaDataDeletionJob(job.data);
    if (!data) {
      this.logger.warn(`Job ${job.id ?? '?'} rejected: invalid data`);
      throw new UnrecoverableError('data-deletion: invalid job data');
    }
    let outcome: DataDeletionOutcome;
    try {
      outcome = await this.dataDeletion.execute(data.requestId);
    } catch (error) {
      if (isPermanentDbError(error)) {
        const code = errorCode(error) ?? 'unknown';
        this.logger.error(
          `Data deletion ${data.requestId} rejected by the database (${code}); not retried`,
        );
        throw new UnrecoverableError(
          `data-deletion: database rejected the change (${code})`,
        );
      }
      throw error;
    }
    switch (outcome.kind) {
      case 'completed':
        this.logger.log(
          `Data deletion ${data.requestId} completed: ${outcome.connections} connection(s), ${outcome.pages} page(s), ${outcome.comments} comment(s), ${outcome.webhookEvents} webhook event(s)`,
        );
        break;
      case 'already_completed':
        this.logger.debug(`Data deletion ${data.requestId} already completed`);
        break;
      case 'missing':
        this.logger.warn(`Data deletion ${data.requestId}: request not found`);
        break;
    }
    return outcome;
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job | undefined, error: Error): void {
    const attempts = job?.opts.attempts ?? 1;
    const made = job?.attemptsMade ?? 0;
    const final = error.name === 'UnrecoverableError' || made >= attempts;
    const line = `Job ${job?.name ?? '?'} ${job?.id ?? '?'} failed (attempt ${made}/${attempts}): ${
      error.name === 'UnrecoverableError'
        ? error.message
        : describeIngestError(error)
    }`;
    if (final) this.logger.error(line);
    else this.logger.warn(line);
  }

  /** Worker connection errors (Redis down): one line per message every 5 min. */
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
    this.logger.warn(`Worker ${QUEUE_NAMES.metaTokenCheck}: ${error.message}`);
  }
}
