import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDrizzle } from '@nestjs/drizzle';
import { and, eq, gt, inArray, isNotNull, isNull, lte, sql } from 'drizzle-orm';
import { DEFAULT_CLIENT_APP_URL } from '../admin/admin-impersonation.service.js';
import type { EnvironmentVariables } from '../config/env.validation.js';
import type { Database } from '../db/database.js';
import {
  billingAccounts,
  plans,
  subscriptions,
  users,
} from '../db/schema/index.js';
import {
  EmailNotConfiguredError,
  EmailSendError,
  EmailService,
} from '../email/email.service.js';
import {
  dueReminder,
  type ReminderDays,
  reminderSent,
  renewalReminderEmail,
} from './renewal-reminders.js';

const DAY_MS = 86_400_000;
/** Expiry emails still go out for terms that ended this long ago (missed daily runs). */
const EXPIRY_LOOKBACK_MS = 3 * DAY_MS;
/** Terms ending within this window can be due for a 7-day reminder (Dhaka calendar days). */
const LOOKAHEAD_MS = 8 * DAY_MS;

export interface RenewalRemindersOutcome {
  kind: 'renewal_reminders';
  sent: number;
  /** Email not configured (log + skip, D4). */
  skipped: number;
  failed: number;
}

/**
 * `renewal-reminders` (M8-T6, daily, D4/D5): emails the billing account's owner 7, 3 and 1 days
 * before a paid ACTIVE term ends (no scheduled change: its next term is paid) and once when it
 * ended without a live plan after it (D5: moderation paused). Once each per term: the marker
 * (`reminder_term_end` + `reminder_days`) is claimed by a guarded UPDATE before the send and put
 * back when the email was not sent, so repeated or parallel runs never send twice and a renewed
 * term (another end) gets its own reminders. Email unset → skipped; a retryable send error fails
 * the job after the other sends (BullMQ retries; the markers stop duplicates). Logs ids only.
 */
@Injectable()
export class RenewalReminderService {
  private readonly logger = new Logger(RenewalReminderService.name);
  private readonly clientAppUrl: string;

  constructor(
    @InjectDrizzle() private readonly db: Database,
    private readonly email: EmailService,
    config: ConfigService<EnvironmentVariables, true>,
  ) {
    this.clientAppUrl =
      config.get('CLIENT_APP_URL', { infer: true }) ?? DEFAULT_CLIENT_APP_URL;
  }

  async run(now: Date = new Date()): Promise<RenewalRemindersOutcome> {
    const s = subscriptions;
    const rows = await this.db
      .select({
        id: s.id,
        status: s.status,
        termEnd: s.currentTermEnd,
        markerEnd: s.reminderTermEnd,
        markerDays: s.reminderDays,
        planName: plans.name,
        email: users.email,
        accountLive: sql<boolean>`exists (select 1 from subscriptions l where l.billing_account_id = ${s.billingAccountId} and l.status in ('TRIALING', 'ACTIVE') and (l.current_term_end > ${now} or l.scheduled_plan_id is not null))`,
      })
      .from(s)
      .innerJoin(plans, eq(plans.id, s.planId))
      .innerJoin(billingAccounts, eq(billingAccounts.id, s.billingAccountId))
      .innerJoin(users, eq(users.id, billingAccounts.ownerUserId))
      .where(
        and(
          inArray(s.status, ['ACTIVE', 'EXPIRED']),
          isNotNull(s.chargedBdt),
          isNull(s.scheduledPlanId),
          gt(s.currentTermEnd, new Date(now.getTime() - EXPIRY_LOOKBACK_MS)),
          lte(s.currentTermEnd, new Date(now.getTime() + LOOKAHEAD_MS)),
        ),
      );

    const outcome: RenewalRemindersOutcome = {
      kind: 'renewal_reminders',
      sent: 0,
      skipped: 0,
      failed: 0,
    };
    let retry = false;
    for (const row of rows) {
      const days = dueReminder(row.termEnd, now);
      if (days === null) continue;
      if (days > 0 ? row.status !== 'ACTIVE' : row.accountLive) continue;
      if (
        reminderSent(
          { termEnd: row.markerEnd, days: row.markerDays },
          row.termEnd,
          days,
        )
      )
        continue;
      if (!(await this.claim(row.id, row.termEnd, days))) continue;
      const ref = `subscription=${row.id} days=${days}`;
      try {
        const result = await this.email.send({
          to: row.email,
          ...renewalReminderEmail(
            { days, termEnd: row.termEnd, planName: row.planName },
            this.clientAppUrl,
          ),
          idempotencyKey: `renewal-reminder:${row.id}:${row.termEnd.toISOString()}:${days}`,
        });
        if (result.delivered) {
          outcome.sent += 1;
          this.logger.log(`renewal reminder sent ${ref}`);
          continue;
        }
        outcome.skipped += 1;
      } catch (err) {
        if (err instanceof EmailNotConfiguredError) {
          outcome.skipped += 1;
        } else {
          outcome.failed += 1;
          retry ||= !(err instanceof EmailSendError) || err.retryable;
          this.logger.warn(
            `renewal reminder failed ${ref}: ${err instanceof Error ? err.name : 'error'}`,
          );
        }
      }
      await this.release(
        row.id,
        row.termEnd,
        days,
        row.markerEnd,
        row.markerDays,
      );
    }
    if (outcome.skipped > 0)
      this.logger.warn(
        `renewal reminders skipped: email not configured (${outcome.skipped})`,
      );
    if (retry)
      throw new Error(`renewal-reminders: ${outcome.failed} emails failed`);
    return outcome;
  }

  /** Marks the reminder sent unless this term already has it (or a later one); `false` = lost. */
  private async claim(
    id: string,
    termEnd: Date,
    days: ReminderDays,
  ): Promise<boolean> {
    const s = subscriptions;
    const rows = await this.db
      .update(s)
      .set({ reminderTermEnd: termEnd, reminderDays: days })
      .where(
        and(
          eq(s.id, id),
          eq(s.currentTermEnd, termEnd),
          sql`(${s.reminderTermEnd} is distinct from ${termEnd} or ${s.reminderDays} > ${days})`,
        ),
      )
      .returning({ id: s.id });
    return rows.length > 0;
  }

  /** Puts the marker back after an email that was not sent (only if it is still ours). */
  private async release(
    id: string,
    termEnd: Date,
    days: ReminderDays,
    previousEnd: Date | null,
    previousDays: number | null,
  ): Promise<void> {
    const s = subscriptions;
    await this.db
      .update(s)
      .set({ reminderTermEnd: previousEnd, reminderDays: previousDays })
      .where(
        and(
          eq(s.id, id),
          eq(s.reminderTermEnd, termEnd),
          eq(s.reminderDays, days),
        ),
      );
  }
}
