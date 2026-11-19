import { normalizeFeatureConfig } from '../admin/plan-rules.js';
import type { LiveTrial } from '../promotions/promotion.service.js';
import type {
  PlanText,
  PublicPlan,
  PublicPlansResponse,
} from './dto/public-plan.dto.js';
import {
  type PlanPriceSource,
  type PriceDiscount,
  planPrice,
} from './plan-price.js';

/** The `plans` columns the public list reads. */
export interface PublicPlanRow extends PlanPriceSource {
  id: string;
  slug: string;
  name: string;
  badgeEn: string | null;
  badgeBn: string | null;
  descriptionEn: string | null;
  descriptionBn: string | null;
  isHighlighted: boolean;
  /** Raw jsonb; normalised here. */
  featureConfig: unknown;
}

/** en + bn, each falling back to the other (PR-D17); `null` when both are empty. */
const planText = (en: string | null, bn: string | null): PlanText | null =>
  en === null && bn === null ? null : { en: en ?? bn!, bn: bn ?? en! };

/**
 * Pure mapping of one active plan row to its public shape (PR-T2). Prices through `planPrice`
 * with the plan's live discounts (best one only, PR-D6); the trial comment grant resolved the way
 * the wallet grants it.
 */
export function toPublicPlan(
  row: PublicPlanRow,
  discounts: readonly PriceDiscount[],
  trial: LiveTrial | null,
): PublicPlan {
  const config = normalizeFeatureConfig(row.featureConfig);
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    badge: planText(row.badgeEn, row.badgeBn),
    description: planText(row.descriptionEn, row.descriptionBn),
    highlighted: row.isHighlighted,
    // The monthly price always exists.
    monthly: planPrice(row, 'month', discounts)!,
    yearly: planPrice(row, 'year', discounts),
    limits: config.limits,
    features: config.features,
    trial: trial && {
      promotionId: trial.promotionId,
      days: trial.days,
      commentLimit: trial.commentLimit ?? config.limits.monthlyComments,
      endsAt: trial.endsAt,
    },
  };
}

/**
 * "Save up to N%" from the **shown** per-month prices (orchestrator decision 2026-11-20: since
 * 0027 the yearly list price absorbed the launch offer, so list prices would understate it).
 */
export function yearlySaveUpToPercent(items: readonly PublicPlan[]): number {
  return Math.max(
    0,
    ...items.map((p) =>
      p.yearly && p.monthly.perMonthBdt > 0
        ? Math.floor(
            ((p.monthly.perMonthBdt - p.yearly.perMonthBdt) * 100) /
              p.monthly.perMonthBdt,
          )
        : 0,
    ),
  );
}

export const toPublicPlans = (
  items: PublicPlan[],
  contactWhatsapp: string | null,
): PublicPlansResponse => ({
  items,
  yearlySaveUpToPercent: yearlySaveUpToPercent(items),
  contactWhatsapp,
});
