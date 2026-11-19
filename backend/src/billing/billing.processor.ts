import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { type Job, UnrecoverableError } from 'bullmq';
import {
  describeIngestError,
  errorCode,
  isPermanentDbError,
} from '../comments/comment-ingest.rules.js';
import { isScheduledJobData } from '../queue/job-schedulers.js';
import { QUEUE_NAMES } from '../queue/queue.constants.js';
import { SUBSCRIPTION_EXPIRY_JOB_NAME } from './billing-scheduled.jobs.js';
import { SubscriptionService } from './subscription.service.js';

const ERROR_LOG_INTERVAL_MS = 5 * 60 * 1000;

/** What a `billing` job returned. */
export interface SubscriptionExpiryOutcome {
  kind: 'subscription_expiry';
  expired: number;
}

/**
 * The one worker of the `billing` queue (PW-T3; in the API process). Dispatches by job name:
 * `subscription-expiry` → `SubscriptionService.expireDue()`. Unknown name / invalid data /
 * permanent DB error → `UnrecoverableError` (no retries); anything else is retried (5 attempts).
 * Logs carry ids, counts and error codes only.
 *
 * E2E never opens a real BullMQ `Worker` (`FakeWorker`); specs call `process(job)`.
 */
@Processor(QUEUE_NAMES.billing)
export class BillingProcessor extends WorkerHost {
  private readonly logger = new Logger('BillingJobs');
  private lastWorkerError: { message: string; at: number } | undefined;

  constructor(private readonly subscriptions: SubscriptionService) {
    super();
  }

  async process(
    job: Job<unknown, SubscriptionExpiryOutcome>,
  ): Promise<SubscriptionExpiryOutcome> {
    if (job.name !== SUBSCRIPTION_EXPIRY_JOB_NAME) {
      this.logger.warn(`Job ${job.id ?? '?'} rejected: unknown name`);
      throw new UnrecoverableError(
        `billing: unknown job name ${JSON.stringify(job.name)}`,
      );
    }
    if (!isScheduledJobData(job.data)) {
      this.logger.warn(`Job ${job.id ?? '?'} rejected: invalid data`);
      throw new UnrecoverableError(`${job.name}: invalid job data`);
    }
    try {
      const expired = await this.subscriptions.expireDue();
      this.logger.debug(`subscription-expiry: ${expired} expired`);
      return { kind: 'subscription_expiry', expired };
    } catch (error) {
      if (isPermanentDbError(error)) {
        const code = errorCode(error) ?? 'unknown';
        this.logger.error(
          `${job.name} rejected by the database (${code}); not retried`,
        );
        throw new UnrecoverableError(
          `${job.name}: database rejected the change (${code})`,
        );
      }
      throw error;
    }
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
    this.logger.warn(`Worker ${QUEUE_NAMES.billing}: ${error.message}`);
  }
}
