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
import {
  AutoRenewService,
  type AutoRenewOutcome,
} from './auto-renew.service.js';
import {
  AUTO_RENEW_CHARGE_JOB_NAME,
  PENDING_PAYMENT_EXPIRY_JOB_NAME,
  RENEWAL_REMINDERS_JOB_NAME,
  SUBSCRIPTION_EXPIRY_JOB_NAME,
} from './billing-scheduled.jobs.js';
import { CheckoutService } from './checkout.service.js';
import {
  RenewalReminderService,
  type RenewalRemindersOutcome,
} from './renewal-reminder.service.js';
import { SubscriptionService } from './subscription.service.js';

const ERROR_LOG_INTERVAL_MS = 5 * 60 * 1000;

/** What a `billing` job returned. */
export interface SubscriptionExpiryOutcome {
  kind: 'subscription_expiry';
  /** Scheduled changes started (M8-D7b). */
  switched: number;
  expired: number;
}

export interface PendingPaymentExpiryOutcome {
  kind: 'pending_payment_expiry';
  cancelled: number;
}

export type BillingJobOutcome =
  | SubscriptionExpiryOutcome
  | RenewalRemindersOutcome
  | PendingPaymentExpiryOutcome
  | AutoRenewOutcome;

const JOB_NAMES: readonly string[] = [
  SUBSCRIPTION_EXPIRY_JOB_NAME,
  RENEWAL_REMINDERS_JOB_NAME,
  PENDING_PAYMENT_EXPIRY_JOB_NAME,
  AUTO_RENEW_CHARGE_JOB_NAME,
];

/**
 * The one worker of the `billing` queue (PW-T3; in the API process). Dispatches by job name:
 * `subscription-expiry` → `SubscriptionService.switchScheduled()` + `expireDue()`,
 * `renewal-reminders` → `RenewalReminderService.run()`, `pending-payment-expiry` →
 * `CheckoutService.expirePendingPayments()` (M8-T6), `auto-renew-charge` → `AutoRenewService.chargeDue()`
 * (M8-T6b). Unknown name / invalid data /
 * permanent DB error → `UnrecoverableError` (no retries); anything else is retried (5 attempts).
 * Logs carry ids, counts and error codes only.
 *
 * E2E never opens a real BullMQ `Worker` (`FakeWorker`); specs call `process(job)`.
 */
@Processor(QUEUE_NAMES.billing)
export class BillingProcessor extends WorkerHost {
  private readonly logger = new Logger('BillingJobs');
  private lastWorkerError: { message: string; at: number } | undefined;

  constructor(
    private readonly subscriptions: SubscriptionService,
    private readonly reminders: RenewalReminderService,
    private readonly checkout: CheckoutService,
    private readonly autoRenew: AutoRenewService,
  ) {
    super();
  }

  async process(
    job: Job<unknown, BillingJobOutcome>,
  ): Promise<BillingJobOutcome> {
    if (!JOB_NAMES.includes(job.name)) {
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
      return await this.run(job.name);
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

  private async run(name: string): Promise<BillingJobOutcome> {
    if (name === RENEWAL_REMINDERS_JOB_NAME) {
      const outcome = await this.reminders.run();
      this.logger.debug(
        `renewal-reminders: ${outcome.sent} sent, ${outcome.skipped} skipped, ${outcome.failed} failed`,
      );
      return outcome;
    }
    if (name === AUTO_RENEW_CHARGE_JOB_NAME) {
      const outcome = await this.autoRenew.chargeDue();
      this.logger.debug(
        `auto-renew-charge: ${outcome.charged} charged, ${outcome.failed} failed`,
      );
      return outcome;
    }
    if (name === PENDING_PAYMENT_EXPIRY_JOB_NAME) {
      const cancelled = await this.checkout.expirePendingPayments();
      this.logger.debug(`pending-payment-expiry: ${cancelled} cancelled`);
      return { kind: 'pending_payment_expiry', cancelled };
    }
    // The switch first: `expireDue` leaves rows with a scheduled change to it.
    const switched = await this.subscriptions.switchScheduled();
    const expired = await this.subscriptions.expireDue();
    this.logger.debug(
      `subscription-expiry: ${switched} switched, ${expired} expired`,
    );
    return { kind: 'subscription_expiry', switched, expired };
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
