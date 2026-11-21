import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDrizzle } from '@nestjs/drizzle';
import { and, eq, gt, isNotNull, isNull, lte, sql } from 'drizzle-orm';
import { DEFAULT_CLIENT_APP_URL } from '../admin/admin-impersonation.service.js';
import type { EnvironmentVariables } from '../config/env.validation.js';
import type { Database } from '../db/database.js';
import {
  billingAccounts,
  type PaymentPrice,
  paymentTransactions,
  plans,
  subscriptions,
  users,
} from '../db/schema/index.js';
import { EmailService } from '../email/email.service.js';
import {
  SslcommerzClient,
  sslcommerzCallbackUrls,
  SslcommerzError,
} from '../payments/sslcommerz.client.js';
import { AutoRenewState } from './auto-renew.js';
import {
  MIN_GATEWAY_AMOUNT_BDT,
  newTranId,
  PENDING_PAYMENT_TTL_MS,
} from './checkout.service.js';
import { paymentAmount } from './paid-term.js';
import { PAYMENT_OUTCOMES } from './payment-callback.js';
import { PaymentCallbacksService } from './payment-callbacks.service.js';
import { autoRenewFailedEmail } from './renewal-reminders.js';
import { SubscriptionService } from './subscription.service.js';

const HOUR_MS = 3_600_000;
/** M8-D14 (a): the first try once ≤ 24 h are left ("1 day before")… */
export const AUTO_RENEW_FIRST_TRY_MS = 24 * HOUR_MS;
/** …and the one retry once ≤ 12 h are left ("the last day"); then manual + email. */
export const AUTO_RENEW_RETRY_MS = 12 * HOUR_MS;

/** The charge attempt due for a term ending at `termEnd` (1 = first, 2 = retry), or `null`. Pure. */
export function autoRenewAttempt(termEnd: Date, now: Date): 1 | 2 | null {
  const left = termEnd.getTime() - now.getTime();
  if (left <= 0 || left > AUTO_RENEW_FIRST_TRY_MS) return null;
  return left <= AUTO_RENEW_RETRY_MS ? 2 : 1;
}

export interface AutoRenewOutcome {
  kind: 'auto_renew';
  charged: number;
  failed: number;
}

const PAID_OUTCOMES: readonly string[] = [
  PAYMENT_OUTCOMES.paid,
  PAYMENT_OUTCOMES.paidDuplicateClaim,
  PAYMENT_OUTCOMES.alreadyPaid,
];

/**
 * `auto-renew-charge` (M8-T6b; D4 tokenized auto-renew behind `SSLCOMMERZ_TOKENIZATION`, M8-D14 (a)
 * timing). Hourly; registered only while auto-renew is available (and a no-op otherwise). For each
 * opted-in account with a saved token whose paid ACTIVE term (no scheduled change) ends within 24 h:
 * claim the attempt on the account's marker (guarded UPDATE: once per attempt per term, so repeated
 * or parallel runs charge once) → RENEWAL price (`checkoutPrice`, no new coupon) → PENDING row →
 * token charge → the IPN path's validation + `activatePaidTerm` (`settleCharge`: the term moves, so
 * the account is no longer due). Skipped while the account has a PENDING payment (a checkout or an
 * unanswered charge in flight). A failed retry → owner email; reminders keep going (M8-T6).
 * Logs ids only (never the token).
 */
@Injectable()
export class AutoRenewService {
  private readonly logger = new Logger(AutoRenewService.name);
  private readonly clientAppUrl: string;

  constructor(
    @InjectDrizzle() private readonly db: Database,
    private readonly state: AutoRenewState,
    private readonly subscriptions: SubscriptionService,
    private readonly sslcommerz: SslcommerzClient,
    private readonly callbacks: PaymentCallbacksService,
    private readonly email: EmailService,
    config: ConfigService<EnvironmentVariables, true>,
  ) {
    this.clientAppUrl =
      config.get('CLIENT_APP_URL', { infer: true }) ?? DEFAULT_CLIENT_APP_URL;
  }

  async chargeDue(now: Date = new Date()): Promise<AutoRenewOutcome> {
    const outcome: AutoRenewOutcome = {
      kind: 'auto_renew',
      charged: 0,
      failed: 0,
    };
    if (!this.state.available) return outcome;
    // A due scheduled term starts first (M8-D7b); rows with a scheduled change are already paid.
    await this.subscriptions.switchScheduled(now);

    const s = subscriptions;
    const ba = billingAccounts;
    const rows = await this.db
      .select({
        subscriptionId: s.id,
        accountId: s.billingAccountId,
        planId: s.planId,
        interval: s.interval,
        termEnd: s.currentTermEnd,
        plan: {
          id: plans.id,
          name: plans.name,
          isActive: plans.isActive,
          monthlyPriceBdt: plans.monthlyPriceBdt,
          yearlyMonthlyPriceBdt: plans.yearlyMonthlyPriceBdt,
        },
        ownerId: users.id,
        email: users.email,
        token: ba.autoRenewToken,
        markerEnd: ba.autoRenewTermEnd,
        markerAttempts: ba.autoRenewAttempts,
        workspaceId: sql<
          string | null
        >`(select w.id from workspaces w where w.billing_account_id = ${s.billingAccountId} order by w.created_at, w.id limit 1)`,
        pending: sql<boolean>`exists (select 1 from payment_transactions p where p.billing_account_id = ${s.billingAccountId} and p.status = 'PENDING' and p.created_at > ${new Date(now.getTime() - PENDING_PAYMENT_TTL_MS)})`,
      })
      .from(s)
      .innerJoin(plans, eq(plans.id, s.planId))
      .innerJoin(ba, eq(ba.id, s.billingAccountId))
      .innerJoin(users, eq(users.id, ba.ownerUserId))
      .where(
        and(
          eq(s.status, 'ACTIVE'),
          isNotNull(s.chargedBdt),
          isNull(s.scheduledPlanId),
          gt(s.currentTermEnd, now),
          lte(
            s.currentTermEnd,
            new Date(now.getTime() + AUTO_RENEW_FIRST_TRY_MS),
          ),
          eq(ba.autoRenewEnabled, true),
          isNotNull(ba.autoRenewToken),
        ),
      );

    for (const row of rows) {
      const attempt = autoRenewAttempt(row.termEnd, now);
      if (attempt === null || row.pending || !row.token || !row.workspaceId)
        continue;
      if (
        row.markerEnd?.getTime() === row.termEnd.getTime() &&
        (row.markerAttempts ?? 0) >= attempt
      )
        continue;
      if (!(await this.claim(row.accountId, row.termEnd, attempt))) continue;
      const ref = `account=${row.accountId} subscription=${row.subscriptionId} attempt=${attempt}`;
      const paid = await this.charge(
        { ...row, token: row.token, workspaceId: row.workspaceId },
        ref,
        now,
      );
      if (paid) {
        outcome.charged += 1;
        continue;
      }
      outcome.failed += 1;
      if (attempt === 2) await this.notifyFailed(row, ref);
    }
    return outcome;
  }

  /** One charge; `true` = the term was extended (PAID). Every failure leaves manual renewal. */
  private async charge(
    row: {
      accountId: string;
      workspaceId: string;
      ownerId: string;
      interval: 'month' | 'year';
      token: string;
      plan: {
        id: string;
        name: string;
        isActive: boolean;
        monthlyPriceBdt: number;
        yearlyMonthlyPriceBdt: number | null;
      };
    },
    ref: string,
    now: Date,
  ): Promise<boolean> {
    if (!row.plan.isActive) {
      this.logger.warn(`auto-renew skipped ${ref}: plan not available`);
      return false;
    }
    let price: PaymentPrice;
    let token: string;
    try {
      price = await this.subscriptions.checkoutPrice(
        row.accountId,
        row.plan,
        row.interval,
        null,
        'RENEWAL',
        now,
      );
      token = this.state.decryptToken(row.accountId, row.token);
    } catch (error) {
      this.logger.warn(
        `auto-renew skipped ${ref}: ${error instanceof Error ? error.name : 'error'}`,
      );
      return false;
    }
    const amountBdt = paymentAmount(price);
    if (amountBdt < MIN_GATEWAY_AMOUNT_BDT) {
      this.logger.warn(`auto-renew skipped ${ref}: amount ${amountBdt}`);
      return false;
    }
    const tranId = newTranId();
    await this.db.insert(paymentTransactions).values({
      billingAccountId: row.accountId,
      workspaceId: row.workspaceId,
      userId: row.ownerId,
      planId: row.plan.id,
      interval: row.interval,
      kind: 'RENEWAL',
      tranId,
      amountBdt,
      gateway: 'SSLCOMMERZ',
      price,
    });
    let valId: string;
    try {
      ({ valId } = await this.sslcommerz.chargeToken({
        token,
        tranId,
        amountBdt,
        ipnUrl: sslcommerzCallbackUrls(this.clientAppUrl).ipn,
      }));
    } catch (error) {
      if (!(error instanceof SslcommerzError)) throw error;
      // A decline is final; a timeout / network error stays PENDING (its IPN may still pay it,
      // else the pending expiry cancels it).
      if (error.kind === 'failed')
        await this.db
          .update(paymentTransactions)
          .set({ status: 'FAILED' })
          .where(
            and(
              eq(paymentTransactions.tranId, tranId),
              eq(paymentTransactions.billingAccountId, row.accountId),
            ),
          );
      this.logger.warn(
        `auto-renew charge failed ${ref} tran_id=${tranId}: ${error.kind}`,
      );
      return false;
    }
    const result = await this.callbacks.settleCharge(tranId, valId, now);
    this.logger.log(`auto-renew ${ref} tran_id=${tranId} outcome=${result}`);
    return PAID_OUTCOMES.includes(result);
  }

  /** Claims attempt `attempt` for this term on the account marker; `false` = already made. */
  private async claim(
    accountId: string,
    termEnd: Date,
    attempt: 1 | 2,
  ): Promise<boolean> {
    const ba = billingAccounts;
    const rows = await this.db
      .update(ba)
      .set({ autoRenewTermEnd: termEnd, autoRenewAttempts: attempt })
      .where(
        and(
          eq(ba.id, accountId),
          sql`(${ba.autoRenewTermEnd} is distinct from ${termEnd} or ${ba.autoRenewAttempts} < ${attempt})`,
        ),
      )
      .returning({ id: ba.id });
    return rows.length > 0;
  }

  private async notifyFailed(
    row: {
      subscriptionId: string;
      email: string;
      termEnd: Date;
      plan: { name: string };
    },
    ref: string,
  ): Promise<void> {
    try {
      const result = await this.email.send({
        to: row.email,
        ...autoRenewFailedEmail(
          { termEnd: row.termEnd, planName: row.plan.name },
          this.clientAppUrl,
        ),
        idempotencyKey: `auto-renew-failed:${row.subscriptionId}:${row.termEnd.toISOString()}`,
      });
      if (!result.delivered)
        this.logger.warn(`auto-renew failure email not sent ${ref}`);
    } catch (error) {
      // ponytail: no resend; the reminders (M8-T6) still warn the owner.
      this.logger.warn(
        `auto-renew failure email failed ${ref}: ${error instanceof Error ? error.name : 'error'}`,
      );
    }
  }
}
