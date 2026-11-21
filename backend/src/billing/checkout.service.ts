import { randomBytes } from 'node:crypto';
import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDrizzle } from '@nestjs/drizzle';
import { and, eq, isNotNull, type SQL, sql } from 'drizzle-orm';
import { DEFAULT_CLIENT_APP_URL } from '../admin/admin-impersonation.service.js';
import { MANUAL_ACTIVATION_ERROR_CODES } from '../admin/manual-activation.js';
import type { EnvironmentVariables } from '../config/env.validation.js';
import type { Database } from '../db/database.js';
import {
  type PaymentKind,
  type PaymentPrice,
  type PaymentStatus,
  paymentTransactions,
  plans,
  subscriptions,
  type SubscriptionInterval,
  workspaces,
} from '../db/schema/index.js';
import {
  SSLCOMMERZ_CONFIG,
  type SslcommerzConfig,
  SslcommerzClient,
  sslcommerzCallbackUrls,
  SslcommerzError,
} from '../payments/sslcommerz.client.js';
import { isLiveAt } from '../wallet/live-subscription.queries.js';
import { paymentAmount, paymentKind } from './paid-term.js';
import { SubscriptionService } from './subscription.service.js';

/** Checkout 4xx/5xx codes (body `{ message, code }`); `COUPON_*`, `YEARLY_PRICE_MISSING` and the `paymentKind` codes pass through. */
export const CHECKOUT_ERROR_CODES = {
  /** 409 */
  noBillingAccount: MANUAL_ACTIVATION_ERROR_CODES.noBillingAccount,
  /** 400: unknown or inactive plan. */
  planNotAvailable: MANUAL_ACTIVATION_ERROR_CODES.planNotAvailable,
  /** 400: 0 < amount < ৳10 (SSLCommerz minimum, reading 8). */
  amountTooLow: 'AMOUNT_TOO_LOW',
  /** 503: SSLCommerz env unset (D1); no row is written. */
  paymentsNotConfigured: 'PAYMENTS_NOT_CONFIGURED',
  /** 502: the session API failed; the row is FAILED. */
  gatewayError: 'PAYMENT_GATEWAY_ERROR',
} as const;

/** SSLCommerz's minimum charge in whole ৳ (reading 8). */
export const MIN_GATEWAY_AMOUNT_BDT = 10;

export interface CheckoutInput {
  planId: string;
  interval: SubscriptionInterval;
  couponCode?: string | null;
}

export type CheckoutResult =
  { tranId: string; gatewayUrl: string } | { tranId: string; paid: true };

/** `GET …/billing/payments/:tranId` (M8-T5): the return page polls it. */
export interface PaymentStatusView {
  tranId: string;
  status: PaymentStatus;
  amountBdt: number;
  kind: PaymentKind;
  planId: string;
  interval: SubscriptionInterval;
  paidAt: Date | null;
  invoiceNumber: string | null;
}

/** D8 invoice number `SC-<Dhaka year>-<5+ digits>` from `payment_invoice_number_seq` (M8-T5 reuses it). */
export const invoiceNumberSql = (paidAt: Date): SQL =>
  sql`(select 'SC-' || to_char(${paidAt.toISOString()}::timestamptz at time zone 'Asia/Dhaka', 'YYYY') || '-' || lpad(n::text, greatest(5, length(n::text)), '0') from (select nextval('payment_invoice_number_seq') as n) s)`;

/** Our `tran_id` (`TRAN_ID_PATTERN`): `SC` + 16 base64url chars. */
const newTranId = () => `SC${randomBytes(12).toString('base64url')}`;

/**
 * Client checkout (M8-T4; D2, D6, D7, M8-D7b; readings 6, 7, 8). The workspace's billing account
 * pays; every query is scoped by it. Checks in order: account (409) → active plan (400) →
 * `paymentKind` (409) → `checkoutPrice` (400 `COUPON_*` / `YEARLY_PRICE_MISSING`) → amount.
 * - ৳0 → one transaction: `activatePaidTerm` (source PAYMENT) + a PAID `PROMOTION` row with an
 *   invoice number; no SSLCommerz.
 * - otherwise → 503 when SSLCommerz is unset (no row), a PENDING row with the price snapshot,
 *   then the session API; its failure marks the row FAILED (502). The term is activated by the
 *   validated IPN / return (M8-T5).
 * Logs ids and amounts only.
 */
@Injectable()
export class CheckoutService {
  private readonly logger = new Logger(CheckoutService.name);

  constructor(
    @InjectDrizzle() private readonly db: Database,
    private readonly subscriptions: SubscriptionService,
    private readonly sslcommerz: SslcommerzClient,
    @Inject(SSLCOMMERZ_CONFIG)
    private readonly sslcommerzConfig: SslcommerzConfig | null,
    private readonly config: ConfigService<EnvironmentVariables, true>,
  ) {}

  /** Coupon preview (reading 7): the checkout price with `code` applied. */
  async previewCoupon(
    workspaceId: string,
    input: CheckoutInput & { couponCode: string },
    now: Date = new Date(),
  ): Promise<{ price: PaymentPrice; amountBdt: number }> {
    const { price } = await this.prepare(workspaceId, input, now);
    return { price, amountBdt: paymentAmount(price) };
  }

  async checkout(
    workspaceId: string,
    customer: { userId: string; name: string; email: string },
    input: CheckoutInput,
    now: Date = new Date(),
  ): Promise<CheckoutResult> {
    const { accountId, plan, kind, price } = await this.prepare(
      workspaceId,
      input,
      now,
    );
    const amountBdt = paymentAmount(price);
    if (amountBdt > 0 && amountBdt < MIN_GATEWAY_AMOUNT_BDT)
      throw new BadRequestException({
        message: `Online payments start at ৳${MIN_GATEWAY_AMOUNT_BDT}`,
        code: CHECKOUT_ERROR_CODES.amountTooLow,
      });
    const tranId = newTranId();
    const row = {
      billingAccountId: accountId,
      workspaceId,
      userId: customer.userId,
      planId: plan.id,
      interval: input.interval,
      kind,
      tranId,
      amountBdt,
    };

    if (amountBdt === 0) {
      await this.db.transaction(async (tx) => {
        const done = await this.subscriptions.activatePaidTerm(tx, {
          accountId,
          workspaceId,
          planId: plan.id,
          interval: input.interval,
          kind,
          start: now,
          price,
          source: 'PAYMENT',
          reason: `Payment ${tranId}`,
          now,
        });
        await tx.insert(paymentTransactions).values({
          ...row,
          status: 'PAID',
          gateway: 'PROMOTION',
          paidAt: now,
          subscriptionId: done.subscriptionId,
          invoiceNumber: invoiceNumberSql(now),
          price: { ...done.price, creditBdt: price.creditBdt },
        });
      });
      this.logger.log(
        `checkout paid by promotion tran_id=${tranId} account=${accountId} workspace=${workspaceId} kind=${kind}`,
      );
      return { tranId, paid: true };
    }

    if (!this.sslcommerzConfig)
      throw new ServiceUnavailableException({
        message: 'Online payments are not available right now',
        code: CHECKOUT_ERROR_CODES.paymentsNotConfigured,
      });
    await this.db.insert(paymentTransactions).values({
      ...row,
      gateway: 'SSLCOMMERZ',
      price,
    });
    try {
      const session = await this.sslcommerz.createSession({
        tranId,
        amountBdt,
        productName: `ShieldComment ${plan.name} (${input.interval === 'year' ? 'yearly' : 'monthly'})`,
        customer: {
          name: customer.name || customer.email,
          email: customer.email,
        },
        urls: sslcommerzCallbackUrls(
          this.config.get('CLIENT_APP_URL', { infer: true }) ??
            DEFAULT_CLIENT_APP_URL,
        ),
      });
      this.logger.log(
        `checkout started tran_id=${tranId} account=${accountId} workspace=${workspaceId} kind=${kind} amount=${amountBdt}`,
      );
      return { tranId, gatewayUrl: session.gatewayUrl };
    } catch (error) {
      if (!(error instanceof SslcommerzError)) throw error;
      await this.db
        .update(paymentTransactions)
        .set({ status: 'FAILED' })
        .where(
          and(
            eq(paymentTransactions.tranId, tranId),
            eq(paymentTransactions.billingAccountId, accountId),
          ),
        );
      throw new BadGatewayException({
        message: 'The payment gateway could not start the payment. Try again.',
        code: CHECKOUT_ERROR_CODES.gatewayError,
      });
    }
  }

  /** One payment of the workspace's billing account (another account's tran id → 404). */
  async paymentStatus(
    workspaceId: string,
    tranId: string,
  ): Promise<PaymentStatusView> {
    const [row] = await this.db
      .select({
        tranId: paymentTransactions.tranId,
        status: paymentTransactions.status,
        amountBdt: paymentTransactions.amountBdt,
        kind: paymentTransactions.kind,
        planId: paymentTransactions.planId,
        interval: paymentTransactions.interval,
        paidAt: paymentTransactions.paidAt,
        invoiceNumber: paymentTransactions.invoiceNumber,
      })
      .from(paymentTransactions)
      .innerJoin(
        workspaces,
        eq(workspaces.billingAccountId, paymentTransactions.billingAccountId),
      )
      .where(
        and(
          eq(workspaces.id, workspaceId),
          eq(paymentTransactions.tranId, tranId),
        ),
      );
    if (!row) throw new NotFoundException('Payment not found');
    return row;
  }

  /** Account → active plan → `paymentKind` → `checkoutPrice`. */
  private async prepare(
    workspaceId: string,
    input: CheckoutInput,
    now: Date,
  ): Promise<{
    accountId: string;
    plan: { id: string; name: string };
    kind: PaymentKind;
    price: PaymentPrice;
  }> {
    const [ws] = await this.db
      .select({ accountId: workspaces.billingAccountId })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId));
    const accountId = ws?.accountId;
    if (!accountId)
      throw new ConflictException({
        message: 'This workspace has no billing account',
        code: CHECKOUT_ERROR_CODES.noBillingAccount,
      });
    const [plan] = await this.db
      .select({
        id: plans.id,
        name: plans.name,
        monthlyPriceBdt: plans.monthlyPriceBdt,
        yearlyMonthlyPriceBdt: plans.yearlyMonthlyPriceBdt,
      })
      .from(plans)
      .where(and(eq(plans.id, input.planId), eq(plans.isActive, true)));
    if (!plan)
      throw new BadRequestException({
        message: 'This plan is not available',
        code: CHECKOUT_ERROR_CODES.planNotAvailable,
      });

    const [current] = await this.db
      .select({
        status: subscriptions.status,
        planId: subscriptions.planId,
        interval: subscriptions.interval,
        currentTermStart: subscriptions.currentTermStart,
        currentTermEnd: subscriptions.currentTermEnd,
        monthlyPriceBdt: plans.monthlyPriceBdt,
        scheduledPlanId: subscriptions.scheduledPlanId,
      })
      .from(subscriptions)
      .innerJoin(plans, eq(plans.id, subscriptions.planId))
      .where(and(eq(subscriptions.billingAccountId, accountId), isLiveAt(now)));
    const [paidBefore] = await this.db
      .select({ id: subscriptions.id })
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.billingAccountId, accountId),
          isNotNull(subscriptions.chargedBdt),
        ),
      )
      .limit(1);
    const decided = paymentKind(
      current
        ? { ...current, hasScheduledChange: current.scheduledPlanId !== null }
        : null,
      {
        planId: plan.id,
        interval: input.interval,
        monthlyPriceBdt: plan.monthlyPriceBdt,
      },
      paidBefore !== undefined,
      now,
    );
    if ('error' in decided)
      throw new ConflictException({
        message:
          'This plan change is not possible right now. Check the renewal date.',
        code: decided.error,
      });
    const price = await this.subscriptions.checkoutPrice(
      accountId,
      plan,
      input.interval,
      input.couponCode,
      decided.kind,
      now,
    );
    return { accountId, plan, kind: decided.kind, price };
  }
}
