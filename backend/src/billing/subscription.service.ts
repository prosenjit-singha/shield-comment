import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { and, eq, inArray, isNotNull, isNull, lte, sql } from 'drizzle-orm';
import {
  endedStatus,
  type EndedSubscription,
  MANUAL_ACTIVATION_ERROR_CODES,
  toActivationAudit,
} from '../admin/manual-activation.js';
import { normalizeFeatureConfig } from '../admin/plan-rules.js';
import type { Database } from '../db/database.js';
import { inListSql } from '../db/schema/check-sql.js';
import {
  type ActivationPrice,
  type AppliedPromotion,
  billingAccounts,
  LIVE_SUBSCRIPTION_STATUSES,
  type PaymentKind,
  type PaymentPrice,
  type PaymentPromotion,
  plans,
  promotionRedemptions,
  promotions,
  type SubscriptionAuditSource,
  subscriptionAuditLogs,
  type SubscriptionInterval,
  subscriptions,
  workspaces,
} from '../db/schema/index.js';
import {
  type PlanPriceSource,
  type PriceDiscount,
  planPrice,
} from '../plans/plan-price.js';
import {
  PROMOTION_ERROR_CODES,
  PromotionService,
} from '../promotions/promotion.service.js';
import {
  type AccountLiveSubscription,
  findAccountLiveSubscription,
  findLiveSubscription,
  isLiveAt,
  type LiveSubscription,
} from '../wallet/live-subscription.queries.js';
import {
  type WalletExecutor,
  WalletService,
} from '../wallet/wallet.service.js';
import { accountHadTrial } from './billing-summary.queries.js';
import {
  type PaidTerm,
  paidTerm,
  promotionMonths,
  type TermClaim,
  toPaymentPrice,
  upgradeCredit,
} from './paid-term.js';
import { trialEndsAt } from './trial.js';

/** The Drizzle methods the billing writes need (db or a transaction). */
export type BillingExecutor = WalletExecutor;

/** `startTrial()` 4xx codes (body `{ message, code }`); `redeem()`'s 409 codes pass through. */
export const TRIAL_ERROR_CODES = {
  /** 409: the workspace has no billing account. */
  noBillingAccount: 'NO_BILLING_ACCOUNT',
  /** 409: the account already has a live (TRIALING / ACTIVE) subscription. */
  planAlreadyActive: 'PLAN_ALREADY_ACTIVE',
  /** 400: unknown or inactive plan. */
  planNotAvailable: 'PLAN_NOT_AVAILABLE',
  /** 409: no live TRIAL promotion targets the plan (none, ended, stopped or used up). */
  trialNotAvailable: 'TRIAL_NOT_AVAILABLE',
} as const;

/** Input of `activatePaidTerm` (M8-T3). */
export interface PaidTermInput {
  accountId: string;
  /** The workspace it was started from (audit row). */
  workspaceId: string;
  planId: string;
  interval: SubscriptionInterval;
  kind: PaymentKind;
  /** Start of a new term (manual: 00:00 Dhaka of the chosen day; payment: the payment). */
  start: Date;
  /** The price fixed before (checkout snapshot or manual activation): what is claimed. */
  price: PaymentPrice;
  source: SubscriptionAuditSource;
  /** ADMIN: the super admin (wallet grant + audit); PAYMENT: none. */
  actorId?: string | null;
  /** Audit reason (1–500): the admin's text, or e.g. the payment's tran id. */
  reason: string;
  ipAddress?: string | null;
  userAgent?: string | null;
  now?: Date;
}

export interface PaidTermResult {
  subscriptionId: string;
  term: PaidTerm;
  /** The live row before (ended, or the same row when the term was extended). */
  before: EndedSubscription | null;
  plan: { id: string; slug: string; name: string };
  /** The claimed price (redemption ids filled in), as in the audit row. */
  price: ActivationPrice;
  /** The fresh wallet period; `null` when the term was extended or scheduled (the wallet runs on). */
  balances: Awaited<ReturnType<WalletService['startFreshPeriod']>> | null;
  /** PAYMENT only (reading 6): a promotion on the paid price was already claimed by the account. */
  duplicateClaim: boolean;
}

/** `status in ('TRIALING', 'ACTIVE')` as a literal list, so it matches the partial indexes. */
const LIVE_STATUS_SQL = sql.raw(
  inListSql(`"subscriptions"."status"`, LIVE_SUBSCRIPTION_STATUSES),
);

/**
 * Billing accounts and subscriptions (PW-T3; PW-D9 expiry, PW-D15; PR-T3: PR-D10 trial by choice,
 * reading 1 one trial per account ever; M8-T3 paid terms). Every paid term (manual activation
 * PW-T9, Module 8 payments) goes through `activatePaidTerm`; checkout prices through `checkoutPrice`.
 *
 * - The account is the paying "client" (one per owner user); every workspace points at the
 *   creator's account (`workspaces.billing_account_id`), so plan limits are pooled (PW-D11).
 *   Sign-up only links the workspace (no plan).
 * - A trial is started by the owner (`startTrial`) from a live TRIAL promotion: a `TRIALING`
 *   subscription whose end is stored once, plus **one** wallet period granted the redemption's
 *   comment limit (snapshot: a later promotion edit never changes a running trial).
 * - Readers treat `now ≥ current_term_end` as over (`findLiveSubscription`); `expireDue()` (the
 *   `subscription-expiry` job, every 15 min) only records it as `EXPIRED`.
 *
 * Every query is scoped by the account id (and the workspace id where it enters). Logs carry ids
 * and counts only.
 */
@Injectable()
export class SubscriptionService {
  private readonly logger = new Logger(SubscriptionService.name);

  constructor(
    @InjectDrizzle() private readonly db: Database,
    private readonly wallet: WalletService,
    private readonly promotions: PromotionService,
  ) {}

  /** The user's billing account id, created on first use (create-or-get on the owner unique key). */
  async ensureAccount(userId: string, tx?: BillingExecutor): Promise<string> {
    const ex = tx ?? this.db;
    const [created] = await ex
      .insert(billingAccounts)
      .values({ ownerUserId: userId })
      .onConflictDoNothing({ target: billingAccounts.ownerUserId })
      .returning({ id: billingAccounts.id });
    if (created) {
      this.logger.debug(
        `billing account created account=${created.id} user=${userId}`,
      );
      return created.id;
    }
    const [row] = await ex
      .select({ id: billingAccounts.id })
      .from(billingAccounts)
      .where(eq(billingAccounts.ownerUserId, userId));
    if (!row) throw new Error(`Billing account of user ${userId} not found`);
    return row.id;
  }

  /**
   * Links the workspace to the user's account (created on first use) when it has none yet; a
   * workspace keeps its account for life. Returns the user's account id. Sign-up (and its
   * session-create repair) and `/organization/create`; never starts a plan (PR-T3).
   */
  async linkWorkspace(
    userId: string,
    workspaceId: string,
    tx?: BillingExecutor,
  ): Promise<string> {
    const ex = tx ?? this.db;
    const accountId = await this.ensureAccount(userId, ex);
    await ex
      .update(workspaces)
      .set({ billingAccountId: accountId })
      .where(
        and(
          eq(workspaces.id, workspaceId),
          isNull(workspaces.billingAccountId),
        ),
      );
    return accountId;
  }

  /**
   * Starts a free trial by choice (PR-T3; PR-D10, reading 1) for the workspace's billing account
   * on `planId`, in one transaction: lock the account → no live subscription → the plan is active
   * → a live TRIAL promotion targets it → the account never had a trial → `TRIALING` subscription
   * (end = now + the promotion's days × 24 h) → the redemption (`PromotionService.redeem`, its 409
   * codes pass through) linked on the subscription → the wallet period granted the redemption's
   * comment limit (`null` = the plan's monthly comments). Concurrent calls serialise on the
   * account row: the later one sees `PLAN_ALREADY_ACTIVE`. Returns the subscription id.
   */
  async startTrial(
    workspaceId: string,
    planId: string,
    now: Date = new Date(),
  ): Promise<string> {
    const conflict = (code: string, message: string) =>
      new ConflictException({ message, code });
    return this.db.transaction(async (tx) => {
      const [ws] = await tx
        .select({ billingAccountId: workspaces.billingAccountId })
        .from(workspaces)
        .where(eq(workspaces.id, workspaceId));
      const accountId = ws?.billingAccountId;
      if (!accountId)
        throw conflict(
          TRIAL_ERROR_CODES.noBillingAccount,
          'This workspace has no billing account',
        );
      await tx
        .select({ id: billingAccounts.id })
        .from(billingAccounts)
        .where(eq(billingAccounts.id, accountId))
        .for('update');
      if (await findAccountLiveSubscription(tx, accountId, now))
        throw conflict(
          TRIAL_ERROR_CODES.planAlreadyActive,
          'This account already has a plan',
        );
      const [plan] = await tx
        .select({ id: plans.id })
        .from(plans)
        .where(and(eq(plans.id, planId), eq(plans.isActive, true)));
      if (!plan)
        throw new BadRequestException({
          message: 'This plan is not available',
          code: TRIAL_ERROR_CODES.planNotAvailable,
        });
      const trial = await this.promotions.liveTrialFor(planId, now);
      if (!trial)
        throw conflict(
          TRIAL_ERROR_CODES.trialNotAvailable,
          'No free trial is available for this plan',
        );
      // Also counts sign-up trials from before PR-T3 (no redemption row).
      if (await accountHadTrial(tx, accountId))
        throw conflict(
          PROMOTION_ERROR_CODES.trialAlreadyUsed,
          'This account already had a free trial',
        );

      // A live-status row past its term still holds `subscriptions_one_live_per_account` until
      // the expiry job runs: record it as EXPIRED first.
      await tx
        .update(subscriptions)
        .set({ status: 'EXPIRED' })
        .where(
          and(
            eq(subscriptions.billingAccountId, accountId),
            LIVE_STATUS_SQL,
            lte(subscriptions.currentTermEnd, now),
          ),
        );
      const end = trialEndsAt(now, trial.days);
      const [created] = await tx
        .insert(subscriptions)
        .values({
          billingAccountId: accountId,
          planId,
          interval: 'month',
          status: 'TRIALING',
          startedAt: now,
          trialEndsAt: end,
          currentTermStart: now,
          currentTermEnd: end,
        })
        .returning({ id: subscriptions.id });
      const subscriptionId = created!.id;
      const redemption = await this.promotions.redeem(
        tx,
        { promotionId: trial.promotionId, accountId, planId, subscriptionId },
        now,
      );
      await tx
        .update(subscriptions)
        .set({ promotionRedemptionId: redemption.id })
        .where(eq(subscriptions.id, subscriptionId));
      // Re-read: the grant comes from the redemption snapshot (`findAccountLiveSubscription`).
      const live = await findAccountLiveSubscription(tx, accountId, now);
      await this.wallet.openSubscriptionPeriod(live!, now, tx);
      this.logger.log(
        `trial started account=${accountId} workspace=${workspaceId} subscription=${subscriptionId} promotion=${trial.promotionId} days=${trial.days}`,
      );
      return subscriptionId;
    });
  }

  /**
   * Starts or moves a paid term (M8-T3; D4, D6, D7; Module 8 readings 5, 10), shared by the admin
   * manual activation (`source` ADMIN, PW-T9) and validated payments (`source` PAYMENT, M8-T5), in
   * the caller's transaction: lock the account → lock the live-status row → `paidTerm()`:
   * - **extend** (a RENEWAL of the live ACTIVE row, same plan + interval): only `current_term_end`
   *   + the price snapshot move; the wallet keeps its period (no fresh grant);
   * - **new**: the live row ends (`CANCELED`, or `EXPIRED` when its term was over; a trial ends at
   *   once, D6), a new `ACTIVE` row `[start, end)` with the price snapshot, a fresh wallet period;
   * - **scheduled** (M8-D7b: a RENEWAL on another plan / interval while the term runs): the live
   *   row keeps its plan, links and wallet and stores the next term (`scheduled_*`, claimed
   *   price); the M8-T6 renewal job switches to it at `current_term_end`.
   *
   * Then the price's promotions are claimed (`redeem()`, or `months_used` advanced for a claimed
   * one; the row links both) and one `subscription_audit_logs` row is written. `redeem()`'s 409s
   * pass through (the caller's transaction rolls back).
   */
  async activatePaidTerm(
    tx: BillingExecutor,
    input: PaidTermInput,
  ): Promise<PaidTermResult> {
    const now = input.now ?? new Date();
    const { accountId, planId, interval } = input;
    await tx
      .select({ id: billingAccounts.id })
      .from(billingAccounts)
      .where(eq(billingAccounts.id, accountId))
      .for('update');
    const [plan] = await tx
      .select({
        id: plans.id,
        slug: plans.slug,
        name: plans.name,
        featureConfig: plans.featureConfig,
      })
      .from(plans)
      .where(eq(plans.id, planId));
    if (!plan) throw new Error(`Plan ${planId} not found`);

    // The live row by status (also a stale one past its term: the partial unique index
    // `subscriptions_one_live_per_account` counts it until the expiry job runs).
    const [old] = await tx
      .select({
        id: subscriptions.id,
        planId: subscriptions.planId,
        interval: subscriptions.interval,
        status: subscriptions.status,
        currentTermStart: subscriptions.currentTermStart,
        currentTermEnd: subscriptions.currentTermEnd,
      })
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.billingAccountId, accountId),
          inArray(subscriptions.status, [...LIVE_SUBSCRIPTION_STATUSES]),
        ),
      )
      .for('update');
    const term = paidTerm(
      input.kind,
      old ?? null,
      { planId, interval },
      input.start,
      now,
    );
    const snapshot = {
      pricePerMonthBdt: input.price.perMonthBdt,
      chargedBdt: input.price.chargedBdt,
    };

    let subscriptionId: string;
    if (term.scheduled) {
      subscriptionId = old!.id;
    } else if (term.extend) {
      subscriptionId = old!.id;
      await tx
        .update(subscriptions)
        .set({ currentTermEnd: term.end, ...snapshot })
        .where(
          and(
            eq(subscriptions.id, subscriptionId),
            eq(subscriptions.billingAccountId, accountId),
          ),
        );
    } else {
      if (old) {
        await tx
          .update(subscriptions)
          .set(endedStatus(old, now))
          .where(
            and(
              eq(subscriptions.id, old.id),
              eq(subscriptions.billingAccountId, accountId),
            ),
          );
      }
      const [created] = await tx
        .insert(subscriptions)
        .values({
          billingAccountId: accountId,
          planId,
          interval,
          status: 'ACTIVE',
          startedAt: term.start,
          currentTermStart: term.start,
          currentTermEnd: term.end,
          ...snapshot,
        })
        .returning({ id: subscriptions.id });
      subscriptionId = created!.id;
    }

    const { price, duplicateClaim } = await this.claimPromotions(tx, {
      accountId,
      planId,
      subscriptionId,
      interval,
      price: input.price,
      link: term.scheduled ? 'never' : term.extend ? 'always' : 'claimed',
      paid: input.source === 'PAYMENT',
      now,
    });
    if (term.scheduled) {
      await tx
        .update(subscriptions)
        .set({
          scheduledPlanId: planId,
          scheduledInterval: interval,
          scheduledPrice: price,
        })
        .where(
          and(
            eq(subscriptions.id, subscriptionId),
            eq(subscriptions.billingAccountId, accountId),
          ),
        );
    }

    let balances: PaidTermResult['balances'] = null;
    if (!term.extend && !term.scheduled) {
      const live: AccountLiveSubscription = {
        billingAccountId: accountId,
        subscriptionId,
        status: 'ACTIVE',
        interval,
        startedAt: term.start,
        trialEndsAt: null,
        currentTermStart: term.start,
        currentTermEnd: term.end,
        plan: {
          id: plan.id,
          slug: plan.slug,
          featureConfig: normalizeFeatureConfig(plan.featureConfig),
          trialCommentLimit: null,
        },
      };
      balances = await this.wallet.startFreshPeriod(
        live,
        now,
        tx,
        input.actorId ?? null,
      );
    }

    await tx.insert(subscriptionAuditLogs).values(
      toActivationAudit({
        source: input.source,
        adminId: input.actorId ?? null,
        billingAccountId: accountId,
        workspaceId: input.workspaceId,
        before: old ?? null,
        after: { id: subscriptionId, planId, interval, status: 'ACTIVE' },
        reason: input.reason,
        price,
        ipAddress: input.ipAddress ?? null,
        userAgent: input.userAgent ?? null,
      }),
    );
    this.logger.log(
      `paid term ${term.scheduled ? 'scheduled' : term.extend ? 'extended' : 'started'} account=${accountId} workspace=${input.workspaceId} subscription=${subscriptionId} plan=${plan.slug} interval=${interval} kind=${input.kind} source=${input.source} actor=${input.actorId ?? 'none'} replaced=${old && !term.extend && !term.scheduled ? old.id : 'none'}`,
    );
    return {
      subscriptionId,
      term,
      before: old ?? null,
      plan: { id: plan.id, slug: plan.slug, name: plan.name },
      price,
      balances,
      duplicateClaim,
    };
  }

  /**
   * Records the term's promotions (PR-D12, reading 9; PR-D19): a promotion not yet claimed is
   * redeemed (`discount_bdt_first_term` = its saving, `months_used` = the months this term uses),
   * a claimed one gets `months_used` advanced by them. `link`: `claimed` links both on the
   * subscription when any was claimed, `always` too (an extended row: the ids describe its latest
   * term), `never` for a scheduled term (the row's links describe its running term).
   * `paid` (a payment, reading 6: the paid price wins): `redeem()` skips its live / plan / cap
   * checks, and a promotion the account claimed meanwhile (once per account) is used as claimed
   * and reported as `duplicateClaim` (logged for A4) instead of failing the activation.
   */
  private async claimPromotions(
    tx: BillingExecutor,
    input: {
      accountId: string;
      planId: string;
      subscriptionId: string;
      interval: SubscriptionInterval;
      price: PaymentPrice;
      link: 'claimed' | 'always' | 'never';
      paid: boolean;
      now: Date;
    },
  ): Promise<{ price: ActivationPrice; duplicateClaim: boolean }> {
    const { accountId, planId, subscriptionId, interval, price, now } = input;
    let duplicateClaim = false;
    const claim = async (
      p: PaymentPromotion | null,
    ): Promise<AppliedPromotion | null> => {
      if (!p) return null;
      const months = promotionMonths(p, interval);
      let redemptionId = p.redemptionId;
      if (!redemptionId && input.paid) {
        const [claimed] = await tx
          .select({ id: promotionRedemptions.id })
          .from(promotionRedemptions)
          .where(
            and(
              eq(promotionRedemptions.promotionId, p.promotionId),
              eq(promotionRedemptions.billingAccountId, accountId),
            ),
          );
        if (claimed) {
          duplicateClaim = true;
          redemptionId = claimed.id;
        }
      }
      if (redemptionId) {
        await tx
          .update(promotionRedemptions)
          .set({
            monthsUsed: sql`${promotionRedemptions.monthsUsed} + ${months}`,
          })
          .where(
            and(
              eq(promotionRedemptions.id, redemptionId),
              eq(promotionRedemptions.billingAccountId, accountId),
            ),
          );
        return { ...p, redemptionId };
      }
      const row = await this.promotions.redeem(
        tx,
        {
          promotionId: p.promotionId,
          accountId,
          planId,
          subscriptionId,
          discountBdtFirstTerm: p.amountBdt,
          monthsUsed: months,
        },
        now,
        { paid: input.paid },
      );
      return { ...p, redemptionId: row.id };
    };
    const discount = await claim(price.discount);
    const coupon = await claim(price.coupon);
    if (
      input.link === 'always' ||
      (input.link === 'claimed' && (discount || coupon))
    ) {
      await tx
        .update(subscriptions)
        .set({
          promotionRedemptionId: discount?.redemptionId ?? null,
          couponRedemptionId: coupon?.redemptionId ?? null,
        })
        .where(eq(subscriptions.id, subscriptionId));
    }
    return {
      price: {
        listChargedBdt: price.listChargedBdt,
        chargedBdt: price.chargedBdt,
        perMonthBdt: price.perMonthBdt,
        discount,
        coupon,
      },
      duplicateClaim,
    };
  }

  /**
   * The price of a term for the account (readings 6, 7, 9; PR-D6, D12, D16, D19): its automatic
   * discount (`accountDiscount`: claimed with months left, or the best live one), then a typed
   * coupon (`validateCoupon`, 400 `COUPON_*`) or, with `carryCoupon` and no code, its claimed
   * coupon that still has months (`accountCoupon`). 400 `YEARLY_PRICE_MISSING` without a price.
   * Read-only; `creditBdt` 0.
   */
  async priceTerm(
    ex: BillingExecutor,
    input: {
      accountId: string;
      plan: PlanPriceSource & { id: string };
      interval: SubscriptionInterval;
      couponCode?: string | null;
      carryCoupon: boolean;
      now: Date;
    },
  ): Promise<PaymentPrice> {
    const { accountId, plan, interval, now } = input;
    if (!planPrice(plan, interval)) {
      throw new BadRequestException({
        message: 'This plan has no yearly price',
        code: MANUAL_ACTIVATION_ERROR_CODES.yearlyPriceMissing,
      });
    }
    const auto = await this.promotions.accountDiscount(
      accountId,
      plan.id,
      plan,
      interval,
      now,
      ex,
    );
    let coupon: (TermClaim & { discount: PriceDiscount }) | null = null;
    if (input.couponCode) {
      const check = await this.promotions.validateCoupon(
        input.couponCode,
        accountId,
        plan.id,
        interval,
        now,
      );
      if (!check.ok) {
        throw new BadRequestException({
          message: 'This coupon cannot be used',
          code: check.error,
        });
      }
      coupon = {
        discount: check.discount,
        terms: check.discount,
        monthsUsed: 0,
        redemptionId: null,
      };
    } else if (input.carryCoupon) {
      coupon = await this.promotions.accountCoupon(
        accountId,
        plan.id,
        plan,
        interval,
        ex,
      );
    }
    const price = planPrice(
      plan,
      interval,
      auto ? [auto.discount] : [],
      coupon?.discount,
    )!;
    const ids = [price.saving?.promotionId, price.coupon?.promotionId].filter(
      (id): id is string => id !== undefined,
    );
    const names = new Map(
      (ids.length
        ? await ex
            .select({
              id: promotions.id,
              name: promotions.name,
              code: promotions.code,
            })
            .from(promotions)
            .where(inArray(promotions.id, ids))
        : []
      ).map((p) => [p.id, p]),
    );
    return toPaymentPrice(price, interval, { discount: auto, coupon }, names);
  }

  /**
   * The checkout price snapshot (M8-T3, for M8-T4): `priceTerm` with the claimed coupon carried
   * (PR-D19) + the D7 `creditBdt` for an UPGRADE (`upgradeCredit` of the live paid term). The
   * amount to charge is `paymentAmount(price)`. Errors as `priceTerm`.
   */
  async checkoutPrice(
    accountId: string,
    plan: PlanPriceSource & { id: string },
    interval: SubscriptionInterval,
    couponCode: string | null | undefined,
    kind: PaymentKind,
    now: Date = new Date(),
  ): Promise<PaymentPrice> {
    const price = await this.priceTerm(this.db, {
      accountId,
      plan,
      interval,
      couponCode,
      carryCoupon: true,
      now,
    });
    if (kind !== 'UPGRADE') return price;
    const [current] = await this.db
      .select({
        status: subscriptions.status,
        planId: subscriptions.planId,
        interval: subscriptions.interval,
        currentTermStart: subscriptions.currentTermStart,
        currentTermEnd: subscriptions.currentTermEnd,
        chargedBdt: subscriptions.chargedBdt,
      })
      .from(subscriptions)
      .where(and(eq(subscriptions.billingAccountId, accountId), isLiveAt(now)));
    return {
      ...price,
      creditBdt: current ? upgradeCredit(current, price.chargedBdt, now) : 0,
    };
  }

  /**
   * `true` when the workspace is linked to a billing account: nothing for the session-create
   * repair (`linkWorkspace`) to do. One query.
   */
  async isSetUp(workspaceId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(
        and(
          eq(workspaces.id, workspaceId),
          isNotNull(workspaces.billingAccountId),
        ),
      );
    return row !== undefined;
  }

  /** The workspace's live plan at `now` (`findLiveSubscription`), or `null`. */
  activePlan(
    workspaceId: string,
    now: Date = new Date(),
  ): Promise<LiveSubscription | null> {
    return findLiveSubscription(this.db, workspaceId, now);
  }

  /**
   * Marks every live subscription whose term ended (`current_term_end <= now`) as `EXPIRED` in one
   * guarded UPDATE (partial index `subscriptions_live_term_end_index`). Readers already treat
   * those as over, so a late run never extends a plan. Returns the number of rows changed.
   */
  async expireDue(now: Date = new Date()): Promise<number> {
    if (Number.isNaN(now.getTime())) {
      throw new RangeError('expireDue needs a valid date');
    }
    const rows = await this.db
      .update(subscriptions)
      .set({ status: 'EXPIRED' })
      .where(and(LIVE_STATUS_SQL, lte(subscriptions.currentTermEnd, now)))
      .returning({
        id: subscriptions.id,
        billingAccountId: subscriptions.billingAccountId,
      });
    if (rows.length > 0) {
      this.logger.log(`subscriptions expired: ${rows.length}`);
      this.logger.debug(
        `expired ${rows.map((r) => `${r.id}@${r.billingAccountId}`).join(', ')}`,
      );
    }
    return rows.length;
  }
}
