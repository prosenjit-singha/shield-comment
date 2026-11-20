import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { eq } from 'drizzle-orm';
import { SubscriptionService } from '../billing/subscription.service.js';
import type { Database } from '../db/database.js';
import { billingAccounts, plans, workspaces } from '../db/schema/index.js';
import { planPrice } from '../plans/plan-price.js';
import type {
  ActivateClientPlanDto,
  ActivateClientPlanResponse,
} from './dto/activate-client-plan.dto.js';
import {
  MANUAL_ACTIVATION_ERROR_CODES as CODES,
  manualTerm,
  startDateError,
} from './manual-activation.js';

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
 * linked to it (pooled limits, PW-D11). Payments use the same `activatePaidTerm` (Module 8).
 */
@Injectable()
export class AdminSubscriptionService {
  /** Overridable clock (tests). */
  now: () => Date = () => new Date();

  constructor(
    @InjectDrizzle() private readonly db: Database,
    private readonly subscriptions: SubscriptionService,
  ) {}

  /**
   * One transaction: checks, then the shared `SubscriptionService.activatePaidTerm` (M8-T3, kind
   * NEW, source ADMIN): lock the billing account → end its live subscription (`CANCELED` +
   * `canceled_at`; `EXPIRED` if its term was already over) → insert the new `ACTIVE` term (start
   * date 00:00 Dhaka + 1 month / 1 year, month-end clamp; `planPrice` snapshots) → fresh wallet
   * period (`used` 0, `PLAN_GRANT` by the admin) → one `subscription_audit_logs` row.
   *
   * Promotions (PR-T3b; PR-D6, D12, D15, D16, readings 7, 9, 10; priced by
   * `SubscriptionService.priceTerm`, no claimed coupon carried): the account's automatic
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
      const price = await this.subscriptions.priceTerm(tx, {
        accountId,
        plan,
        interval: input.interval,
        couponCode: input.couponCode,
        carryCoupon: false,
        now,
      });
      const done = await this.subscriptions.activatePaidTerm(tx, {
        accountId,
        workspaceId,
        planId: plan.id,
        interval: input.interval,
        kind: 'NEW',
        start: term.start,
        price,
        source: 'ADMIN',
        actorId: actor.adminId,
        reason: input.reason,
        ipAddress: actor.ipAddress,
        userAgent: actor.userAgent,
        now,
      });
      const comments = done.balances!.get('monthlyComments')!;
      return {
        subscription: {
          status: 'ACTIVE' as const,
          interval: input.interval,
          trialEndsAt: null,
          termEndsAt: done.term.end,
          plan: done.plan,
        },
        comments: {
          used: comments.used,
          limit: comments.included + comments.added,
          resetsAt: comments.resetsAt,
        },
        price: done.price,
      };
    });
    return result;
  }
}
