import {
  PLAN_TRIAL_DAYS_MAX,
  PLAN_TRIAL_DAYS_MIN,
} from '../db/schema/index.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The end of a trial that starts at `start` and lasts `trialDays` days (PW-D8): exactly
 * `trialDays × 24 h` later, i.e. the same Dhaka wall-clock time (Asia/Dhaka has no DST). The
 * result is stored once on the subscription (`trial_ends_at` = `current_term_end`) and never
 * recomputed, so a later `plans.trial_days` change only affects new trials.
 *
 * Throws `RangeError` for an invalid `start` or a `trialDays` outside the `plans_trial_days_check`
 * range (1–90): a programming error, the column can't hold it.
 */
export function trialEndsAt(start: Date, trialDays: number): Date {
  if (Number.isNaN(start.getTime())) {
    throw new RangeError('Trial start must be a valid date');
  }
  if (
    !Number.isInteger(trialDays) ||
    trialDays < PLAN_TRIAL_DAYS_MIN ||
    trialDays > PLAN_TRIAL_DAYS_MAX
  ) {
    throw new RangeError(
      `Trial days must be an integer between ${PLAN_TRIAL_DAYS_MIN} and ${PLAN_TRIAL_DAYS_MAX}`,
    );
  }
  return new Date(start.getTime() + trialDays * DAY_MS);
}
