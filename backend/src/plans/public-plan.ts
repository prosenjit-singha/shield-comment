import { normalizeFeatureConfig } from '../admin/plan-rules.js';
import { TRIAL_PLAN_SLUG } from '../db/schema/index.js';
import type { PublicPlan } from './dto/public-plan.dto.js';
import { type PlanPriceSource, planPrice } from './plan-price.js';

/** The `plans` columns the public list reads. */
export interface PublicPlanRow extends PlanPriceSource {
  id: string;
  slug: string;
  name: string;
  trialDays: number | null;
  trialCommentLimit: number | null;
  /** Raw jsonb; normalised here. */
  featureConfig: unknown;
}

/**
 * Pure mapping of one active plan row to its public shape (PW-T6). Prices through `planPrice`
 * (one rule for every screen); trial fields only on the trial plan (Starter), with the trial
 * comment grant resolved the way the wallet grants it (`meterGrant`).
 */
export function toPublicPlan(row: PublicPlanRow): PublicPlan {
  const config = normalizeFeatureConfig(row.featureConfig);
  // `planPrice(…, 'month')` is never null: the monthly price always exists.
  const monthly = planPrice(row, 'month')!;
  const trialDays = row.slug === TRIAL_PLAN_SLUG ? row.trialDays : null;
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    monthly,
    yearly: planPrice(row, 'year'),
    limits: config.limits,
    features: config.features,
    trialDays,
    trialCommentLimit:
      trialDays === null
        ? null
        : (row.trialCommentLimit ?? config.limits.monthlyComments),
  };
}
