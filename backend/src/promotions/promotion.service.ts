import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { and, eq, gt, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import type { Database } from '../db/database.js';
import {
  COUPON_CODE_PATTERN,
  type DiscountScope,
  type DiscountType,
  plans,
  promotionPlans,
  promotionRedemptions,
  promotions,
  type SubscriptionInterval,
} from '../db/schema/index.js';
import {
  type PlanPrice,
  type PlanPriceSource,
  type PriceDiscount,
  planPrice,
} from '../plans/plan-price.js';
import { type DiscountMonths, monthsLeft } from './discount-months.js';

/** Runs inside the caller's transaction (or on the pool). */
export type PromotionExecutor = Pick<Database, 'select' | 'insert'>;

/** A live TRIAL promotion for a plan (PR-D10). */
export interface LiveTrial {
  promotionId: string;
  days: number;
  /** `null` = the plan's monthly comments. */
  commentLimit: number | null;
  endsAt: Date | null;
}

/** `redeem()` 409 codes (body `{ message, code }`). */
export const PROMOTION_ERROR_CODES = {
  notLive: 'PROMOTION_NOT_LIVE',
  usedUp: 'PROMOTION_USED_UP',
  notForPlan: 'PROMOTION_NOT_FOR_PLAN',
  alreadyClaimed: 'PROMOTION_ALREADY_CLAIMED',
  trialAlreadyUsed: 'TRIAL_ALREADY_USED',
} as const;

export const COUPON_ERROR_CODES = [
  'COUPON_NOT_FOUND',
  'COUPON_EXPIRED',
  'COUPON_NOT_FOR_PLAN',
  'COUPON_ALREADY_USED',
  'COUPON_USED_UP',
] as const;
export type CouponErrorCode = (typeof COUPON_ERROR_CODES)[number];

export type CouponCheck =
  | {
      ok: true;
      promotionId: string;
      code: string;
      /** The coupon's terms (what `price.coupon` was worked out from). */
      discount: PriceDiscount;
      price: PlanPrice;
    }
  | { ok: false; error: CouponErrorCode };

/**
 * The automatic discount an account gets on a plan + interval (`accountDiscount`): `discount` as
 * priced now (a claimed one: its snapshot with only the months left), its month terms as claimed
 * (`terms` + `monthsUsed`, for "k of N") and the redemption to advance, or `null` = a live
 * DISCOUNT still to `redeem()`.
 */
export interface AccountDiscount {
  discount: PriceDiscount;
  terms: DiscountMonths;
  monthsUsed: number;
  redemptionId: string | null;
}

export interface RedeemInput {
  promotionId: string;
  accountId: string;
  /** The plan the claim is for (must be targeted). */
  planId: string;
  subscriptionId?: string | null;
  /** Saving on the first term (PR-D12); 0 for a trial. */
  discountBdtFirstTerm?: number;
  /** Months the first term already uses (reading 9); default 0. */
  monthsUsed?: number;
}

const COUPON_CODE = new RegExp(COUPON_CODE_PATTERN);
const UNIQUE_VIOLATION = '23505';
const ONE_TRIAL_INDEX = 'promotion_redemptions_one_trial_per_account';

// Subqueries name `promotions.id` in plain SQL: Drizzle leaves a column unqualified in a
// one-table select, and a bare `"id"` would resolve inside the subquery.
const redemptionCount = sql<number>`(select count(*)::int from promotion_redemptions r where r.promotion_id = promotions.id)`;

/** Not stopped and not ended (Stop / end date block new claims only, PR-D15). */
const openAt = (now: Date) =>
  and(
    isNull(promotions.stoppedAt),
    or(isNull(promotions.endsAt), gt(promotions.endsAt, now)),
  );

/** Live = open and the "first N" cap not reached (plan doc §5.2). */
const liveAt = (now: Date) =>
  and(
    openAt(now),
    or(
      isNull(promotions.maxRedemptions),
      sql`${promotions.maxRedemptions} > ${redemptionCount}`,
    ),
  );

/** This billing account already claimed the promotion (PR-D3). */
const claimedBy = (accountId: string) =>
  sql<boolean>`exists (select 1 from promotion_redemptions r where r.promotion_id = promotions.id and r.billing_account_id = ${accountId})`;

/** `promotions` targets `planId` (`all_plans` or a `promotion_plans` row). */
const targets = (planId: string) =>
  sql<boolean>`(promotions.all_plans or exists (select 1 from promotion_plans pp where pp.promotion_id = promotions.id and pp.plan_id = ${planId}))`;

const discountColumns = {
  promotionId: promotions.id,
  discountType: promotions.discountType,
  discountValue: promotions.discountValue,
  discountScope: promotions.discountScope,
  durationMonths: promotions.durationMonths,
  endsAt: promotions.endsAt,
};

interface DiscountRow {
  promotionId: string;
  discountType: DiscountType | null;
  discountValue: number | null;
  discountScope: DiscountScope | null;
  durationMonths: number | null;
  endsAt: Date | null;
}

/** DISCOUNT/COUPON rows always carry type + value + scope (check constraints). */
const toDiscount = (row: DiscountRow): PriceDiscount => ({
  promotionId: row.promotionId,
  discountType: row.discountType!,
  discountValue: row.discountValue!,
  discountScope: row.discountScope!,
  durationMonths: row.durationMonths,
  endsAt: row.endsAt,
});

interface RedemptionRow extends Omit<DiscountRow, 'endsAt'> {
  redemptionId: string;
  kind: string;
  monthsUsed: number;
  targeted: boolean;
}

/**
 * Claimed redemptions of `kind` that target the plan and have months left (reading 9): `terms` =
 * the snapshot, `discount` = the snapshot with only the months left (what this bill is priced at).
 */
const claimedOf = (
  rows: readonly RedemptionRow[],
  kind: 'DISCOUNT' | 'COUPON',
): AccountDiscount[] =>
  rows.flatMap((row) => {
    if (row.kind !== kind || !row.targeted) return [];
    const d = toDiscount({ ...row, endsAt: null });
    const left = monthsLeft(d, row.monthsUsed);
    if (left === 0) return [];
    return [
      {
        discount:
          d.discountScope === 'PER_MONTH' ? { ...d, durationMonths: left } : d,
        terms: d,
        monthsUsed: row.monthsUsed,
        redemptionId: row.redemptionId,
      },
    ];
  });

/** The claim with the biggest first-bill saving (`planPrice` picks it), or `null`. */
function bestClaim(
  plan: PlanPriceSource,
  interval: SubscriptionInterval,
  claims: readonly AccountDiscount[],
): { claim: AccountDiscount; amountBdt: number } | null {
  const saving = planPrice(
    plan,
    interval,
    claims.map((c) => c.discount),
  )?.saving;
  if (!saving) return null;
  return {
    claim: claims.find((c) => c.discount.promotionId === saving.promotionId)!,
    amountBdt: saving.amountBdt,
  };
}

const pgError = (error: unknown) =>
  ((error as { cause?: unknown }).cause ?? error) as {
    code?: string;
    constraint?: string;
  };

/**
 * Promotion rules (PR-T2; user decisions 2026-11-20 PR-D2…D6, D11, D15, D16; readings 1, 9, 10;
 * plan doc §5.2, §5.5). Promotions are global (not tenant data); claims are scoped by billing
 * account. No HTTP routes here: the trial endpoint (PR-T3), manual activation (PR-T3b), the admin
 * API (PR-T4) and Module 8 checkout call it.
 */
@Injectable()
export class PromotionService {
  private readonly logger = new Logger(PromotionService.name);

  constructor(@InjectDrizzle() private readonly db: Database) {}

  /** Every live promotion of `kind` per targeted plan of `planIds` (each plan has a list). */
  private async liveRows(
    kind: 'TRIAL' | 'DISCOUNT',
    planIds: readonly string[],
    now: Date,
  ) {
    const rows = planIds.length
      ? await this.db
          .select({
            ...discountColumns,
            trialDays: promotions.trialDays,
            trialCommentLimit: promotions.trialCommentLimit,
            allPlans: promotions.allPlans,
            targetPlanId: promotionPlans.planId,
          })
          .from(promotions)
          .leftJoin(
            promotionPlans,
            and(
              eq(promotionPlans.promotionId, promotions.id),
              inArray(promotionPlans.planId, [...planIds]),
            ),
          )
          .where(
            and(
              eq(promotions.kind, kind),
              liveAt(now),
              or(
                eq(promotions.allPlans, true),
                isNotNull(promotionPlans.planId),
              ),
            ),
          )
      : [];
    const byPlan = new Map(planIds.map((id) => [id, [] as typeof rows]));
    for (const row of rows) {
      for (const id of row.allPlans ? planIds : [row.targetPlanId!]) {
        const list = byPlan.get(id)!;
        if (!list.some((r) => r.promotionId === row.promotionId))
          list.push(row);
      }
    }
    return byPlan;
  }

  /**
   * Live DISCOUNT promotions per plan (a COUPON is never automatic, PR-D11). Feed them to
   * `planPrice`, which keeps the biggest first-bill saving.
   */
  async liveDiscountsFor(
    planIds: readonly string[],
    now = new Date(),
  ): Promise<Map<string, PriceDiscount[]>> {
    const rows = await this.liveRows('DISCOUNT', planIds, now);
    return new Map([...rows].map(([id, list]) => [id, list.map(toDiscount)]));
  }

  /**
   * The live TRIAL per plan, or `null`. Several live trials for one plan: the longest wins, then
   * the one ending sooner, then the lower id.
   */
  async liveTrialsFor(
    planIds: readonly string[],
    now = new Date(),
  ): Promise<Map<string, LiveTrial | null>> {
    const rows = await this.liveRows('TRIAL', planIds, now);
    const end = (t: LiveTrial) => t.endsAt?.getTime() ?? Infinity;
    return new Map(
      [...rows].map(([id, list]) => {
        const trials: LiveTrial[] = list
          .map((t) => ({
            promotionId: t.promotionId,
            days: t.trialDays!,
            commentLimit: t.trialCommentLimit,
            endsAt: t.endsAt,
          }))
          .sort(
            (a, b) =>
              b.days - a.days ||
              end(a) - end(b) ||
              (a.promotionId < b.promotionId ? -1 : 1),
          );
        return [id, trials[0] ?? null];
      }),
    );
  }

  async liveTrialFor(planId: string, now = new Date()) {
    return (await this.liveTrialsFor([planId], now)).get(planId) ?? null;
  }

  /**
   * Claims a promotion for a billing account inside the caller's transaction (plan doc §5.2):
   * locks the promotion row (`FOR UPDATE`), re-checks live + the cap under the lock, then inserts
   * the redemption with the promotion's term snapshot. 404 unknown id; 409 `{ code }`:
   * `PROMOTION_NOT_LIVE` (stopped / ended), `PROMOTION_NOT_FOR_PLAN`, `PROMOTION_ALREADY_CLAIMED`
   * (PR-D3), `TRIAL_ALREADY_USED` (reading 1), `PROMOTION_USED_UP` (cap). A unique-violation race
   * maps to the same codes (the transaction is then aborted: the caller rolls back).
   */
  async redeem(tx: PromotionExecutor, input: RedeemInput, now = new Date()) {
    const [promo] = await tx
      .select()
      .from(promotions)
      .where(eq(promotions.id, input.promotionId))
      .for('update');
    if (!promo) throw new NotFoundException('Promotion not found');
    const conflict = (code: string, message: string) =>
      new ConflictException({ message, code });

    if (promo.stoppedAt || (promo.endsAt && promo.endsAt <= now))
      throw conflict(PROMOTION_ERROR_CODES.notLive, 'This offer has ended');
    const [state] = await tx
      .select({
        count: redemptionCount,
        targeted: targets(input.planId),
        claimed: claimedBy(input.accountId),
        hadTrial: sql<boolean>`exists (select 1 from promotion_redemptions r where r.billing_account_id = ${input.accountId} and r.kind = 'TRIAL')`,
      })
      .from(promotions)
      .where(eq(promotions.id, promo.id));
    if (!state!.targeted)
      throw conflict(
        PROMOTION_ERROR_CODES.notForPlan,
        'This offer is not for this plan',
      );
    if (state!.claimed)
      throw conflict(
        PROMOTION_ERROR_CODES.alreadyClaimed,
        'This offer was already claimed',
      );
    if (promo.kind === 'TRIAL' && state!.hadTrial)
      throw conflict(
        PROMOTION_ERROR_CODES.trialAlreadyUsed,
        'This account already had a free trial',
      );
    if (promo.maxRedemptions !== null && state!.count >= promo.maxRedemptions)
      throw conflict(PROMOTION_ERROR_CODES.usedUp, 'This offer is used up');

    try {
      const [row] = await tx
        .insert(promotionRedemptions)
        .values({
          promotionId: promo.id,
          billingAccountId: input.accountId,
          subscriptionId: input.subscriptionId ?? null,
          redeemedAt: now,
          kind: promo.kind,
          trialDays: promo.trialDays,
          trialCommentLimit: promo.trialCommentLimit,
          discountType: promo.discountType,
          discountValue: promo.discountValue,
          discountScope: promo.discountScope,
          durationMonths: promo.durationMonths,
          discountBdtFirstTerm: input.discountBdtFirstTerm ?? 0,
          monthsUsed: input.monthsUsed ?? 0,
        })
        .returning();
      this.logger.log(
        `promotion redeemed promotion=${promo.id} account=${input.accountId} redemption=${row!.id}`,
      );
      return row!;
    } catch (error) {
      const pg = pgError(error);
      if (pg.code !== UNIQUE_VIOLATION) throw error;
      throw pg.constraint === ONE_TRIAL_INDEX
        ? conflict(
            PROMOTION_ERROR_CODES.trialAlreadyUsed,
            'This account already had a free trial',
          )
        : conflict(
            PROMOTION_ERROR_CODES.alreadyClaimed,
            'This offer was already claimed',
          );
    }
  }

  /**
   * The automatic discount of `accountId` on a plan + interval (readings 9, 10; PR-D6, PR-D15):
   * the account's **claimed** DISCOUNT redemptions that target the plan and have months left
   * (snapshot terms, only the months left; a Stop / end date doesn't matter), against the plan's
   * best **live** DISCOUNT the account hasn't claimed. The bigger first-bill saving wins; a tie
   * keeps the claimed one (no new claim). `null` = no saving (or no price for the interval).
   * Read-only: the caller redeems a live winner / advances `months_used` in its transaction.
   */
  async accountDiscount(
    accountId: string,
    planId: string,
    plan: PlanPriceSource,
    interval: SubscriptionInterval,
    now = new Date(),
    db: PromotionExecutor = this.db,
  ): Promise<AccountDiscount | null> {
    const rows = await this.redemptionsOf(accountId, planId, db);
    const claimed = claimedOf(rows, 'DISCOUNT');
    const used = new Set(rows.map((r) => r.promotionId));
    const live = (await this.liveDiscountsFor([planId], now))
      .get(planId)!
      .filter((d) => !used.has(d.promotionId));

    const mine = bestClaim(plan, interval, claimed);
    const best = planPrice(plan, interval, live);
    if (!mine && !best?.saving) return null;
    if ((best?.saving?.amountBdt ?? 0) > (mine?.amountBdt ?? 0)) {
      const d = live.find((l) => l.promotionId === best!.saving!.promotionId)!;
      return { discount: d, terms: d, monthsUsed: 0, redemptionId: null };
    }
    return mine!.claim;
  }

  /**
   * The account's claimed COUPON that still has months on `planId` (Module 8 reading 7, PR-D19:
   * a coupon covers only the months the admin set, `months_used` + the term's months each bill),
   * priced like a claimed discount (snapshot terms, only the months left; Stop / end ignored). The
   * biggest saving wins; `null` = none. Checkout puts it on top of `accountDiscount` when no new
   * code is typed. Read-only: the caller advances `months_used` in its transaction.
   */
  async accountCoupon(
    accountId: string,
    planId: string,
    plan: PlanPriceSource,
    interval: SubscriptionInterval,
    db: PromotionExecutor = this.db,
  ): Promise<AccountDiscount | null> {
    const rows = await this.redemptionsOf(accountId, planId, db);
    return bestClaim(plan, interval, claimedOf(rows, 'COUPON'))?.claim ?? null;
  }

  /** The account's redemptions, each with whether its promotion targets `planId`. */
  private redemptionsOf(
    accountId: string,
    planId: string,
    db: PromotionExecutor,
  ) {
    return db
      .select({
        redemptionId: promotionRedemptions.id,
        promotionId: promotionRedemptions.promotionId,
        kind: promotionRedemptions.kind,
        discountType: promotionRedemptions.discountType,
        discountValue: promotionRedemptions.discountValue,
        discountScope: promotionRedemptions.discountScope,
        durationMonths: promotionRedemptions.durationMonths,
        monthsUsed: promotionRedemptions.monthsUsed,
        targeted: targets(planId),
      })
      .from(promotionRedemptions)
      .innerJoin(
        promotions,
        eq(promotions.id, promotionRedemptions.promotionId),
      )
      .where(eq(promotionRedemptions.billingAccountId, accountId));
  }

  /**
   * Checks a coupon code typed at checkout (PR-D11; plan doc §5.5) and previews the price: the
   * account's automatic discount (`accountDiscount`: its claimed one or the best live one,
   * reading 9), then the coupon on top (PR-D16). The code matches
   * case-insensitively. Errors in this order: `COUPON_NOT_FOUND`, `COUPON_EXPIRED` (stopped or
   * ended), `COUPON_NOT_FOR_PLAN` (also: inactive plan, no price for the interval),
   * `COUPON_ALREADY_USED` (this account, PR-D3), `COUPON_USED_UP` (cap). Read-only: the claim is
   * `redeem()` in the caller's transaction.
   */
  async validateCoupon(
    code: string,
    accountId: string,
    planId: string,
    interval: SubscriptionInterval,
    now = new Date(),
  ): Promise<CouponCheck> {
    const normalized = code.trim().toUpperCase();
    if (!COUPON_CODE.test(normalized))
      return { ok: false, error: 'COUPON_NOT_FOUND' };
    const [coupon] = await this.db
      .select({
        ...discountColumns,
        open: sql<boolean>`${openAt(now)}`,
        maxRedemptions: promotions.maxRedemptions,
        count: redemptionCount,
        targeted: targets(planId),
        used: claimedBy(accountId),
      })
      .from(promotions)
      .where(
        and(eq(promotions.kind, 'COUPON'), eq(promotions.code, normalized)),
      );
    if (!coupon) return { ok: false, error: 'COUPON_NOT_FOUND' };
    if (!coupon.open) return { ok: false, error: 'COUPON_EXPIRED' };
    if (!coupon.targeted) return { ok: false, error: 'COUPON_NOT_FOR_PLAN' };
    if (coupon.used) return { ok: false, error: 'COUPON_ALREADY_USED' };
    if (coupon.maxRedemptions !== null && coupon.count >= coupon.maxRedemptions)
      return { ok: false, error: 'COUPON_USED_UP' };

    const [plan] = await this.db
      .select({
        monthlyPriceBdt: plans.monthlyPriceBdt,
        yearlyMonthlyPriceBdt: plans.yearlyMonthlyPriceBdt,
      })
      .from(plans)
      .where(and(eq(plans.id, planId), eq(plans.isActive, true)));
    if (!plan) return { ok: false, error: 'COUPON_NOT_FOR_PLAN' };
    const auto = await this.accountDiscount(
      accountId,
      planId,
      plan,
      interval,
      now,
    );
    const discount = toDiscount(coupon);
    const price = planPrice(
      plan,
      interval,
      auto ? [auto.discount] : [],
      discount,
    );
    if (!price) return { ok: false, error: 'COUPON_NOT_FOR_PLAN' };
    return {
      ok: true,
      promotionId: coupon.promotionId,
      code: normalized,
      discount,
      price,
    };
  }
}
