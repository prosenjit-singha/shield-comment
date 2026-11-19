import type { ScheduledJob } from '../queue/job-schedulers.js';

/**
 * Scheduled jobs on the `billing` queue (PW-T3). BullMQ job schedulers (`upsertJobScheduler`, cron
 * in Asia/Dhaka) create one job per tick; the queue's one worker (`BillingProcessor`) dispatches by
 * job name. Data carries nothing: each run reads the DB.
 */
export const SUBSCRIPTION_EXPIRY_JOB_NAME = 'subscription-expiry';

/**
 * - `subscription-expiry` every 15 min (plan §3.3): ended trials/terms → `EXPIRED`. Readers already
 *   treat `now ≥ current_term_end` as over, so the interval only bounds how stale the status is.
 */
export const BILLING_SCHEDULED_JOBS: readonly ScheduledJob[] = [
  {
    schedulerId: 'subscription-expiry-15min',
    name: SUBSCRIPTION_EXPIRY_JOB_NAME,
    pattern: '*/15 * * * *',
  },
];
