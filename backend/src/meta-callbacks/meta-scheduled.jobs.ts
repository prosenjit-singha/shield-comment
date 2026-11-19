import type { ScheduledJob } from '../queue/job-schedulers.js';

/**
 * Scheduled jobs on the `meta-token-check` queue (M4-T7, Module 4 D3/D4/D8). BullMQ job schedulers
 * (`upsertJobScheduler`, cron in Asia/Dhaka) create one job per tick; the queue's one worker
 * (`MetaTokenCheckProcessor`) dispatches by job name. Data carries nothing: each run reads the DB.
 */
export const META_DEBUG_TOKEN_JOB_NAME = 'debug-token';
export const RAW_PAYLOAD_PURGE_JOB_NAME = 'raw-payload-purge';

export {
  isScheduledJobData,
  SCHEDULE_TIME_ZONE,
  SCHEDULED_JOB_OPTIONS,
} from '../queue/job-schedulers.js';

/** A Meta job scheduler (shape shared by every queue: `ScheduledJob`). */
export type MetaScheduledJob = ScheduledJob;

/**
 * - `debug-token` daily at 03:00 Dhaka (D8).
 * - `raw-payload-purge` daily at 03:30 Dhaka (D4; off-peak, after the token check so the two never
 *   share the single worker at the same moment).
 */
export const META_SCHEDULED_JOBS: readonly MetaScheduledJob[] = [
  {
    schedulerId: 'meta-debug-token-daily',
    name: META_DEBUG_TOKEN_JOB_NAME,
    pattern: '0 3 * * *',
  },
  {
    schedulerId: 'raw-payload-purge-daily',
    name: RAW_PAYLOAD_PURGE_JOB_NAME,
    pattern: '30 3 * * *',
  },
];
