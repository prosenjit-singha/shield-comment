import { InjectQueue } from '@nestjs/bullmq';
import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import {
  registerJobSchedulers,
  SCHEDULER_REGISTRATION_TIMEOUT_MS,
  type SchedulerQueue,
} from '../queue/job-schedulers.js';
import { QUEUE_NAMES } from '../queue/queue.constants.js';
import { BILLING_SCHEDULED_JOBS } from './billing-scheduled.jobs.js';

/**
 * Registers the `billing` job schedulers (PW-T3: `subscription-expiry`) at startup, like
 * `MetaJobSchedulers`: boot never waits or fails (one warning when Redis doesn't answer within
 * 5 s, late success logged), and the idempotent upsert lets every API process register.
 */
@Injectable()
export class BillingJobSchedulers implements OnApplicationBootstrap {
  private readonly logger = new Logger('BillingJobSchedulers');
  /** Settles when registration finished or gave up waiting (tests await it). */
  ready: Promise<void> = Promise.resolve();

  constructor(
    @InjectQueue(QUEUE_NAMES.billing)
    private readonly queue: SchedulerQueue,
  ) {}

  onApplicationBootstrap(): void {
    this.ready = this.register();
  }

  register(timeoutMs = SCHEDULER_REGISTRATION_TIMEOUT_MS): Promise<void> {
    return registerJobSchedulers(
      this.queue,
      BILLING_SCHEDULED_JOBS,
      this.logger,
      timeoutMs,
    );
  }
}
