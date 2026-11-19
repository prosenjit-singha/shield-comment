import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { and, eq, inArray } from 'drizzle-orm';
import type { Database } from '../db/database.js';
import {
  type ActivationPrice,
  type AppliedPromotion,
  billingAccounts,
  LIVE_SUBSCRIPTION_STATUSES,
  plans,
  promotionRedemptions,
  promotions,
  subscriptionAuditLogs,
  subscriptions,
  workspaces,
} from '../db/schema/index.js';
import {
  type PlanPrice,
  planPrice,
  type PriceSaving,
} from '../plans/plan-price.js';
import {
  type DiscountMonths,
  monthsOf,
  monthsThisTerm,
} from '../promotions/discount-months.js';
import {
  type AccountDiscount,
  PromotionService,
} from '../promotions/promotion.service.js';
import type { AccountLiveSubscription } from '../wallet/live-subscription.queries.js';
import { WalletService } from '../wallet/wallet.service.js';
import { normalizeFeatureConfig } from './plan-rules.js';
import type {
  ActivateClientPlanDto,
  ActivateClientPlanResponse,
} from './dto/activate-client-plan.dto.js';
import {
  endedStatus,
  MANUAL_ACTIVATION_ERROR_CODES as CODES,
  manualTerm,
  startDateError,
  toActivationAudit,
} from './manual-activation.js';

/** One promotion applied to this term (before its name is looked up). */
interface Claim {
  saving: PriceSaving;
  redemptionId: string;
  terms: DiscountMonths;
  monthsUsed: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Who activated the plan and from where (audit row). */
export interface ActivationActor {
  adminId: string;
  ipAddress: string | null;
  userAgent: string | null;
}

/**
 * Super admin "Activate plan" (PW-T9; user decision 2026-11-19 PW-D16, plan §3.9). The plan
 * belongs to the workspace's **billing account**, so this changes the plan of every workspace
 * linked to it (pooled limits, PW-D11). Payments and renewals stay Module 8.
 */
@Injectable()
export class AdminSubscriptionService {
  private readonly logger = new Logger(AdminSubscriptionService.name);
  /** Overridable clock (tests). */
  now: () => Date = () => new Date();

  constructor(
    @InjectDrizzle() private readonly db: Database,
    private readonly wallet: WalletService,
    private readonly promotions: PromotionService,
  ) {}

  /**
   * One transaction: lock the billing account → end its live subscription (`CANCELED` +
   * `canceled_at`; `EXPIRED` if its term was already over) → insert the new `ACTIVE` term (start
   * date 00:00 Dhaka + 1 month / 1 year, month-end clamp; `planPrice` snapshots) → fresh wallet
   * period (`used` 0, `PLAN_GRANT` by the admin) → one `subscription_audit_logs` row.
   *
   * Promotions (PR-T3b; PR-D6, D12, D15, D16, readings 7, 9, 10): the account's automatic
   * discount (`PromotionService.accountDiscount`: its claimed DISCOUNT with months left, or the
   * best live one, redeemed now) and the optional `couponCode` on top (redeemed). The snapshot is
   * the discounted price; the subscription links both redemptions; each redemption's
   * `months_used` advances by the months this term uses (`monthsThisTerm`). The price breakdown
   * goes into the response and the audit row (`price`).
   *
   * 404 unknown workspace · 409 `NO_BILLING_ACCOUNT` · 400 `START_DATE_OUT_OF_RANGE`,
   * `TERM_ALREADY_ENDED`, `PLAN_NOT_AVAILABLE` (unknown / inactive), `YEARLY_PRICE_MISSING`,
   * `COUPON_*` (`validateCoupon`) · 409 `redeem()` codes (a claim lost under the promotion lock).
   */
  async activate(
    workspaceId: string,
    input: ActivateClientPlanDto,
    actor: ActivationActor,
  ): Promise<ActivateClientPlanResponse> {
    if (!UUID.test(workspaceId))
      throw new NotFoundException('Workspace not found');
    const now = this.now();
    const dateError = startDateError(input.startDate, now);
    if (dateError) {
      throw new BadRequestException({
        message: dateError,
        code: CODES.startDateOutOfRange,
      });
    }
    const term = manualTerm(input.startDate, input.interval);
    if (term.end.getTime() <= now.getTime()) {
      throw new BadRequestException({
        message: 'This term would already be over: pick a later start date',
        code: CODES.termAlreadyEnded,
      });
    }

    const result = await this.db.transaction(async (tx) => {
      const [ws] = await tx
        .select({ billingAccountId: workspaces.billingAccountId })
        .from(workspaces)
        .where(eq(workspaces.id, workspaceId));
      if (!ws) throw new NotFoundException('Workspace not found');
      if (!ws.billingAccountId) {
        throw new ConflictException({
          message: 'This client has no billing account',
          code: CODES.noBillingAccount,
        });
      }
      const accountId = ws.billingAccountId;
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
          isActive: plans.isActive,
          monthlyPriceBdt: plans.monthlyPriceBdt,
          yearlyMonthlyPriceBdt: plans.yearlyMonthlyPriceBdt,
          featureConfig: plans.featureConfig,
        })
        .from(plans)
        .where(eq(plans.id, input.planId));
      if (!plan?.isActive) {
        throw new BadRequestException({
          message: 'This plan is not available',
          code: CODES.planNotAvailable,
        });
      }
      if (!planPrice(plan, input.interval)) {
        throw new BadRequestException({
          message: 'This plan has no yearly price',
          code: CODES.yearlyPriceMissing,
        });
      }
      const auto = await this.promotions.accountDiscount(
        accountId,
        plan.id,
        plan,
        input.interval,
        now,
        tx,
      );
      const coupon = input.couponCode
        ? await this.promotions.validateCoupon(
            input.couponCode,
            accountId,
            plan.id,
            input.interval,
            now,
          )
        : null;
      if (coupon && !coupon.ok) {
        throw new BadRequestException({
          message: 'This coupon cannot be used',
          code: coupon.error,
        });
      }
      const price = planPrice(
        plan,
        input.interval,
        auto ? [auto.discount] : [],
        coupon?.discount,
      )!;

      // The live row by status (also a stale one past its term: the partial unique index
      // `subscriptions_one_live_per_account` counts it until the expiry job runs).
      const [old] = await tx
        .select({
          id: subscriptions.id,
          planId: subscriptions.planId,
          interval: subscriptions.interval,
          status: subscriptions.status,
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
          planId: plan.id,
          interval: input.interval,
          status: 'ACTIVE',
          startedAt: term.start,
          currentTermStart: term.start,
          currentTermEnd: term.end,
          pricePerMonthBdt: price.perMonthBdt,
          chargedBdt: price.chargedBdt,
        })
        .returning({ id: subscriptions.id });
      const priced = await this.claimPromotions(tx, {
        accountId,
        planId: plan.id,
        subscriptionId: created!.id,
        termMonths: input.interval === 'year' ? 12 : 1,
        auto,
        coupon,
        price,
        now,
      });
      const live: AccountLiveSubscription = {
        billingAccountId: accountId,
        subscriptionId: created!.id,
        status: 'ACTIVE',
        interval: input.interval,
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
      const balances = await this.wallet.startFreshPeriod(
        live,
        now,
        tx,
        actor.adminId,
      );

      await tx.insert(subscriptionAuditLogs).values(
        toActivationAudit({
          adminId: actor.adminId,
          billingAccountId: accountId,
          workspaceId,
          before: old ?? null,
          after: {
            id: created!.id,
            planId: plan.id,
            interval: input.interval,
            status: 'ACTIVE',
          },
          reason: input.reason,
          price: priced,
          ipAddress: actor.ipAddress,
          userAgent: actor.userAgent,
        }),
      );
      const comments = balances.get('monthlyComments')!;
      this.logger.log(
        `manual plan activation account=${accountId} workspace=${workspaceId} subscription=${created!.id} plan=${plan.slug} interval=${input.interval} admin=${actor.adminId} replaced=${old?.id ?? 'none'}`,
      );
      return {
        subscription: {
          status: 'ACTIVE' as const,
          interval: input.interval,
          trialEndsAt: null,
          termEndsAt: term.end,
          plan: { id: plan.id, slug: plan.slug, name: plan.name },
        },
        comments: {
          used: comments.used,
          limit: comments.included + comments.added,
          resetsAt: comments.resetsAt,
        },
        price: priced,
      };
    });
    return result;
  }

  /**
   * Records this term's promotions (PR-D12, reading 9): a live automatic discount is redeemed
   * (`discount_bdt_first_term` = its saving, `months_used` = the months this term uses), a claimed
   * one gets `months_used` advanced; the coupon is redeemed. `redeem()` re-checks each claim under
   * the promotion lock (its 409s pass through). Links both on the subscription.
   */
  private async claimPromotions(
    tx: Pick<Database, 'select' | 'insert' | 'update'>,
    input: {
      accountId: string;
      planId: string;
      subscriptionId: string;
      termMonths: number;
      auto: AccountDiscount | null;
      coupon: {
        promotionId: string;
        code: string;
        discount: DiscountMonths;
      } | null;
      price: PlanPrice;
      now: Date;
    },
  ): Promise<ActivationPrice> {
    const { accountId, planId, subscriptionId, termMonths, auto, price, now } =
      input;
    const redeem = (promotionId: string, amountBdt: number, months: number) =>
      this.promotions
        .redeem(
          tx,
          {
            promotionId,
            accountId,
            planId,
            subscriptionId,
            discountBdtFirstTerm: amountBdt,
            monthsUsed: months,
          },
          now,
        )
        .then((row) => row.id);

    let discount: Claim | null = null;
    if (auto) {
      const saving = price.saving!;
      const months = monthsThisTerm(auto.terms, auto.monthsUsed, termMonths);
      let redemptionId = auto.redemptionId;
      if (redemptionId) {
        await tx
          .update(promotionRedemptions)
          .set({ monthsUsed: auto.monthsUsed + months })
          .where(
            and(
              eq(promotionRedemptions.id, redemptionId),
              eq(promotionRedemptions.billingAccountId, accountId),
            ),
          );
      } else {
        redemptionId = await redeem(
          saving.promotionId,
          saving.amountBdt,
          months,
        );
      }
      discount = {
        saving,
        redemptionId,
        terms: auto.terms,
        monthsUsed: auto.monthsUsed,
      };
    }
    let coupon: Claim | null = null;
    if (input.coupon) {
      const saving = price.coupon!;
      const months = monthsThisTerm(input.coupon.discount, 0, termMonths);
      coupon = {
        saving,
        redemptionId: await redeem(
          saving.promotionId,
          saving.amountBdt,
          months,
        ),
        terms: input.coupon.discount,
        monthsUsed: 0,
      };
    }
    if (discount || coupon) {
      await tx
        .update(subscriptions)
        .set({
          promotionRedemptionId: discount?.redemptionId ?? null,
          couponRedemptionId: coupon?.redemptionId ?? null,
        })
        .where(eq(subscriptions.id, subscriptionId));
    }

    const ids = [discount, coupon].flatMap((c) =>
      c ? [c.saving.promotionId] : [],
    );
    const names = new Map(
      (ids.length
        ? await tx
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
    const applied = (c: Claim | null): AppliedPromotion | null =>
      c && {
        promotionId: c.saving.promotionId,
        redemptionId: c.redemptionId,
        name: names.get(c.saving.promotionId)!.name,
        code: names.get(c.saving.promotionId)!.code,
        label: c.saving.label,
        labelBn: c.saving.labelBn,
        amountBdt: c.saving.amountBdt,
        months: monthsOf(c.terms, c.monthsUsed, termMonths),
      };
    return {
      listChargedBdt: price.listChargedBdt,
      chargedBdt: price.chargedBdt,
      perMonthBdt: price.perMonthBdt,
      discount: applied(discount),
      coupon: applied(coupon),
    };
  }
}
