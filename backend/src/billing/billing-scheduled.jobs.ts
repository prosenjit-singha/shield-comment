import type { ScheduledJob } from '../queue/job-schedulers.js';

/**
 * Scheduled jobs on the `billing` queue (PW-T3, M8-T6). BullMQ job schedulers (`upsertJobScheduler`,
 * cron in Asia/Dhaka) create one job per tick; the queue's one worker (`BillingProcessor`)
 * dispatches by job name. Data carries nothing: each run reads the DB.
 */
export const SUBSCRIPTION_EXPIRY_JOB_NAME = 'subscription-expiry';
export const RENEWAL_REMINDERS_JOB_NAME = 'renewal-reminders';
export const PENDING_PAYMENT_EXPIRY_JOB_NAME = 'pending-payment-expiry';

/**
 * - `subscription-expiry` every 15 min (plan §3.3): due scheduled changes start (M8-D7b), then
 *   ended trials/terms → `EXPIRED`. Readers already treat `now ≥ current_term_end` as over (and a
 *   due scheduled term as live), so the interval only bounds how stale the status is.
 * - `renewal-reminders` daily 10:00 Dhaka (M8-T6, D4): 7 / 3 / 1 days before + on expiry.
 * - `pending-payment-expiry` every 15 min (reading 9): PENDING payments older than 60 min →
 *   CANCELLED.
 */
export const BILLING_SCHEDULED_JOBS: readonly ScheduledJob[] = [
  {
    schedulerId: 'subscription-expiry-15min',
    name: SUBSCRIPTION_EXPIRY_JOB_NAME,
    pattern: '*/15 * * * *',
  },
  {
    schedulerId: 'renewal-reminders-daily',
    name: RENEWAL_REMINDERS_JOB_NAME,
    pattern: '0 10 * * *',
  },
  {
    schedulerId: 'pending-payment-expiry-15min',
    name: PENDING_PAYMENT_EXPIRY_JOB_NAME,
    pattern: '*/15 * * * *',
  },
];
