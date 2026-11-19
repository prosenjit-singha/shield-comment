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
import { META_SCHEDULED_JOBS } from './meta-scheduled.jobs.js';

export { SCHEDULER_REGISTRATION_TIMEOUT_MS };

/**
 * Registers the `meta-token-check` job schedulers (M4-T7) at startup. Boot never waits for it and
 * never fails: the upserts run in the background; when Redis doesn't answer within 5 s one warning
 * is logged, and the pending upserts still complete once Redis is back (queue commands wait for
 * the connection). `upsertJobScheduler` is idempotent, so every API process may register: BullMQ
 * still creates one job per tick.
 */
@Injectable()
export class MetaJobSchedulers implements OnApplicationBootstrap {
  private readonly logger = new Logger('MetaJobSchedulers');
  /** Settles when registration finished or gave up waiting (tests await it). */
  ready: Promise<void> = Promise.resolve();

  constructor(
    @InjectQueue(QUEUE_NAMES.metaTokenCheck)
    private readonly queue: SchedulerQueue,
  ) {}

  onApplicationBootstrap(): void {
    this.ready = this.register();
  }

  register(timeoutMs = SCHEDULER_REGISTRATION_TIMEOUT_MS): Promise<void> {
    return registerJobSchedulers(
      this.queue,
      META_SCHEDULED_JOBS,
      this.logger,
      timeoutMs,
    );
  }
}
