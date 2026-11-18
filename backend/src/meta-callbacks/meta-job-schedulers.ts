import { InjectQueue } from '@nestjs/bullmq';
import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import type { Queue } from 'bullmq';
import { withTimeout } from '../common/async/with-timeout.js';
import { QUEUE_NAMES } from '../queue/queue.constants.js';
import {
  META_SCHEDULED_JOBS,
  SCHEDULE_TIME_ZONE,
  SCHEDULED_JOB_OPTIONS,
} from './meta-scheduled.jobs.js';

/** How long boot-time registration waits for Redis before it logs a warning. */
export const SCHEDULER_REGISTRATION_TIMEOUT_MS = 5_000;

/** The part of a BullMQ `Queue` the registrar uses. */
type SchedulerQueue = Pick<Queue, 'upsertJobScheduler'>;

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

  async register(timeoutMs = SCHEDULER_REGISTRATION_TIMEOUT_MS): Promise<void> {
    const work = Promise.all(
      META_SCHEDULED_JOBS.map((job) =>
        this.queue.upsertJobScheduler(
          job.schedulerId,
          { pattern: job.pattern, tz: SCHEDULE_TIME_ZONE },
          { name: job.name, data: {}, opts: { ...SCHEDULED_JOB_OPTIONS } },
        ),
      ),
    );
    const names = META_SCHEDULED_JOBS.map((job) => job.schedulerId).join(', ');
    try {
      await withTimeout(work, timeoutMs);
      this.logger.log(`Job schedulers registered: ${names}`);
    } catch (error) {
      const reason =
        error instanceof Error && error.message === 'timeout'
          ? `Redis did not answer within ${timeoutMs} ms; still trying in the background`
          : error instanceof Error
            ? error.message
            : 'unknown error';
      this.logger.warn(`Job schedulers not registered yet (${reason})`);
      work.then(
        () => this.logger.log(`Job schedulers registered late: ${names}`),
        () => undefined,
      );
    }
  }
}
