import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDrizzle } from '@nestjs/drizzle';
import { and, eq } from 'drizzle-orm';
import { DEFAULT_CLIENT_APP_URL } from '../admin/admin-impersonation.service.js';
import type { EnvironmentVariables } from '../config/env.validation.js';
import type { Database } from '../db/database.js';
import {
  type PaymentEventSource,
  paymentEvents,
  type PaymentStatus,
  paymentTransactions,
  SETTLED_PAYMENT_STATUSES,
  subscriptions,
} from '../db/schema/index.js';
import {
  SSLCOMMERZ_CONFIG,
  type SslcommerzConfig,
  SslcommerzClient,
  SslcommerzError,
  type SslcommerzValidation,
  verifySign,
} from '../payments/sslcommerz.client.js';
import { isLiveAt } from '../wallet/live-subscription.queries.js';
import { invoiceNumberSql } from './checkout.service.js';
import {
  callbackTranId,
  PAYMENT_OUTCOMES,
  type PaymentOutcome,
  paymentReturnUrl,
  type ReturnPayment,
  validationOutcome,
} from './payment-callback.js';
import {
  type BillingExecutor,
  SubscriptionService,
} from './subscription.service.js';

type CallbackBody = Record<string, unknown>;

export interface CallbackResult {
  tranId: string | null;
  outcome: PaymentOutcome;
}

const isSettled = (status: PaymentStatus) =>
  (SETTLED_PAYMENT_STATUSES as readonly PaymentStatus[]).includes(status);

/**
 * SSLCommerz IPN + browser returns (M8-T5; readings 3, 4, 6, 9; D10). No session: the row is found
 * by `tran_id`. `settle` (IPN, success return), idempotent: `verify_sign` → row → Order Validation
 * API (`val_id`) → status / tran_id / BDT / amount → row `FOR UPDATE` → PAID **once** in one
 * transaction with `activatePaidTerm` (source PAYMENT). A late valid payment on a CANCELLED / FAILED
 * row still turns PAID (reading 9; a NEW payment while a paid term is live becomes a RENEWAL);
 * `risk_level` 1 activates and is kept (D10). `close` (fail / cancel returns): PENDING → FAILED /
 * CANCELLED. Every callback writes one `payment_events` row (outcome code; no card data, no body).
 * Logs ids and outcomes only.
 */
@Injectable()
export class PaymentCallbacksService {
  private readonly logger = new Logger(PaymentCallbacksService.name);

  constructor(
    @InjectDrizzle() private readonly db: Database,
    private readonly subscriptions: SubscriptionService,
    private readonly sslcommerz: SslcommerzClient,
    @Inject(SSLCOMMERZ_CONFIG)
    private readonly sslcommerzConfig: SslcommerzConfig | null,
    private readonly config: ConfigService<EnvironmentVariables, true>,
  ) {}

  returnUrl(payment: ReturnPayment, tranId: string | null): string {
    return paymentReturnUrl(
      this.config.get('CLIENT_APP_URL', { infer: true }) ??
        DEFAULT_CLIENT_APP_URL,
      payment,
      tranId,
    );
  }

  /** IPN / success return: validate and mark PAID once. */
  async settle(
    source: Extract<PaymentEventSource, 'IPN' | 'SUCCESS'>,
    body: CallbackBody,
    now: Date = new Date(),
  ): Promise<CallbackResult> {
    const tranId = callbackTranId(body);
    const outcome = await this.settleOutcome(tranId, body, now);
    return this.record(source, tranId, outcome);
  }

  /** fail / cancel return: a PENDING row → FAILED / CANCELLED; anything else is left alone. */
  async close(
    source: Extract<PaymentEventSource, 'FAIL' | 'CANCEL'>,
    body: CallbackBody,
  ): Promise<CallbackResult> {
    const tranId = callbackTranId(body);
    const status = source === 'FAIL' ? 'FAILED' : 'CANCELLED';
    let outcome: PaymentOutcome = PAYMENT_OUTCOMES.unknownTranId;
    if (tranId) {
      const [moved] = await this.db
        .update(paymentTransactions)
        .set({ status })
        .where(
          and(
            eq(paymentTransactions.tranId, tranId),
            eq(paymentTransactions.status, 'PENDING'),
          ),
        )
        .returning({ id: paymentTransactions.id });
      if (moved) outcome = status;
      else if (await this.findRow(tranId))
        outcome = PAYMENT_OUTCOMES.notPending;
    }
    return this.record(source, tranId, outcome);
  }

  private async settleOutcome(
    tranId: string | null,
    body: CallbackBody,
    now: Date,
  ): Promise<PaymentOutcome> {
    if (!this.sslcommerzConfig) return PAYMENT_OUTCOMES.notConfigured;
    if (!verifySign(body, this.sslcommerzConfig.storePassword))
      return PAYMENT_OUTCOMES.badSignature;
    const row = tranId ? await this.findRow(tranId) : undefined;
    if (!row) return PAYMENT_OUTCOMES.unknownTranId;
    if (isSettled(row.status)) return PAYMENT_OUTCOMES.alreadyPaid;
    const valId = typeof body.val_id === 'string' ? body.val_id : '';
    if (!valId) return PAYMENT_OUTCOMES.noValId;

    let validation: SslcommerzValidation;
    try {
      validation = await this.sslcommerz.validate(valId);
    } catch (error) {
      if (error instanceof SslcommerzError)
        return PAYMENT_OUTCOMES.validationError;
      throw error;
    }
    const mismatch = validationOutcome(validation, row);
    if (mismatch || validation.status === 'INVALID_TRANSACTION')
      return mismatch ?? PAYMENT_OUTCOMES.invalid;

    try {
      return await this.db.transaction((tx) =>
        this.markPaid(tx, row.id, validation, now),
      );
    } catch (error) {
      this.logger.error(
        `payment activation failed tran_id=${row.tranId}: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
      return PAYMENT_OUTCOMES.activationFailed;
    }
  }

  /** In one transaction: lock the row, activate the term, mark it PAID with the invoice number. */
  private async markPaid(
    tx: BillingExecutor,
    id: string,
    validation: Extract<
      SslcommerzValidation,
      { status: 'VALID' | 'VALIDATED' }
    >,
    now: Date,
  ): Promise<PaymentOutcome> {
    const [row] = await tx
      .select()
      .from(paymentTransactions)
      .where(eq(paymentTransactions.id, id))
      .for('update');
    if (!row || isSettled(row.status)) return PAYMENT_OUTCOMES.alreadyPaid;

    // Reading 9: a NEW payment that lands while a paid term is live (another payment won the race,
    // a late IPN after a cancel) extends / follows that term instead of replacing it.
    const [liveActive] = await tx
      .select({ id: subscriptions.id })
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.billingAccountId, row.billingAccountId),
          eq(subscriptions.status, 'ACTIVE'),
          isLiveAt(now),
        ),
      );
    const kind = row.kind === 'NEW' && liveActive ? 'RENEWAL' : row.kind;
    const done = await this.subscriptions.activatePaidTerm(tx, {
      accountId: row.billingAccountId,
      workspaceId: row.workspaceId,
      planId: row.planId,
      interval: row.interval,
      kind,
      start: now,
      price: row.price,
      source: 'PAYMENT',
      reason: `Payment ${row.tranId}`,
      now,
    });
    await tx
      .update(paymentTransactions)
      .set({
        status: 'PAID',
        valId: validation.valId,
        bankTranId: validation.bankTranId,
        cardType: validation.cardType,
        riskLevel: validation.riskLevel,
        paidAt: now,
        subscriptionId: done.subscriptionId,
        invoiceNumber: invoiceNumberSql(now),
        price: { ...done.price, creditBdt: row.price.creditBdt },
      })
      .where(
        and(
          eq(paymentTransactions.id, row.id),
          eq(paymentTransactions.billingAccountId, row.billingAccountId),
        ),
      );
    this.logger.log(
      `payment paid tran_id=${row.tranId} account=${row.billingAccountId} kind=${kind} subscription=${done.subscriptionId} risk=${validation.riskLevel}`,
    );
    return done.duplicateClaim
      ? PAYMENT_OUTCOMES.paidDuplicateClaim
      : PAYMENT_OUTCOMES.paid;
  }

  private async findRow(tranId: string) {
    const [row] = await this.db
      .select({
        id: paymentTransactions.id,
        tranId: paymentTransactions.tranId,
        amountBdt: paymentTransactions.amountBdt,
        status: paymentTransactions.status,
      })
      .from(paymentTransactions)
      .where(eq(paymentTransactions.tranId, tranId));
    return row;
  }

  private async record(
    source: PaymentEventSource,
    tranId: string | null,
    outcome: PaymentOutcome,
  ): Promise<CallbackResult> {
    await this.db.insert(paymentEvents).values({ tranId, source, outcome });
    this.logger.log(
      `sslcommerz ${source} tran_id=${tranId ?? 'none'} outcome=${outcome}`,
    );
    return { tranId, outcome };
  }
}
