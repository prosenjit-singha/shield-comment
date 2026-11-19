import type { Logger } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { withTimeout } from '../common/async/with-timeout.js';
import { DEFAULT_JOB_OPTIONS } from './queue.constants.js';

/** How long boot-time registration waits for Redis before it logs a warning. */
export const SCHEDULER_REGISTRATION_TIMEOUT_MS = 5_000;

/** Cron time zone of every schedule (Bangladesh, no DST). */
export const SCHEDULE_TIME_ZONE = 'Asia/Dhaka';

/** Template options of the scheduled jobs: the D3 defaults (5 attempts, exponential 2 s). */
export const SCHEDULED_JOB_OPTIONS = { ...DEFAULT_JOB_OPTIONS };

/** One BullMQ job scheduler (`upsertJobScheduler`). */
export interface ScheduledJob {
  /** Job scheduler id (stable: upserting the same id updates the schedule in place). */
  schedulerId: string;
  name: string;
  /** Cron pattern (minute hour day month weekday) in `SCHEDULE_TIME_ZONE`. */
  pattern: string;
}

/** The part of a BullMQ `Queue` the registrar uses. */
export type SchedulerQueue = Pick<Queue, 'upsertJobScheduler'>;

/** Scheduled jobs carry no data; anything but a plain object (or nothing) is rejected. */
export function isScheduledJobData(data: unknown): boolean {
  return (
    data === undefined ||
    data === null ||
    (typeof data === 'object' && !Array.isArray(data))
  );
}

/**
 * Upserts `jobs` on `queue` (M4-T7 pattern, shared with PW-T3). Never throws: when Redis doesn't
 * answer within `timeoutMs` (or an upsert fails) one warning is logged, and pending upserts still
 * complete once Redis is back (queue commands wait for the connection; a late success is logged).
 * `upsertJobScheduler` is idempotent, so every API process may register: BullMQ still creates one
 * job per tick.
 */
export async function registerJobSchedulers(
  queue: SchedulerQueue,
  jobs: readonly ScheduledJob[],
  logger: Pick<Logger, 'log' | 'warn'>,
  timeoutMs = SCHEDULER_REGISTRATION_TIMEOUT_MS,
): Promise<void> {
  const work = Promise.all(
    jobs.map((job) =>
      queue.upsertJobScheduler(
        job.schedulerId,
        { pattern: job.pattern, tz: SCHEDULE_TIME_ZONE },
        { name: job.name, data: {}, opts: { ...SCHEDULED_JOB_OPTIONS } },
      ),
    ),
  );
  const names = jobs.map((job) => job.schedulerId).join(', ');
  try {
    await withTimeout(work, timeoutMs);
    logger.log(`Job schedulers registered: ${names}`);
  } catch (error) {
    const reason =
      error instanceof Error && error.message === 'timeout'
        ? `Redis did not answer within ${timeoutMs} ms; still trying in the background`
        : error instanceof Error
          ? error.message
          : 'unknown error';
    logger.warn(`Job schedulers not registered yet (${reason})`);
    work.then(
      () => logger.log(`Job schedulers registered late: ${names}`),
      () => undefined,
    );
  }
}
