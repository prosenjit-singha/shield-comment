import type { PlanFeatureConfig, PlanLimitKey } from '../../db/schema/index.js';
import type { PlanPrice } from '../plan-price.js';

/**
 * One plan of the public `GET /api/plans` list (PW-T6, plan §3.7; user decisions 2026-11-19
 * PW-D5 monthly + yearly, PW-D6 struck list price + badge). For the Module 8 landing and
 * `/billing` cards. No admin-only fields (sort order, active flag, timestamps, audit).
 */
export interface PublicPlan {
  id: string;
  slug: string;
  name: string;
  /** `planPrice(plan, 'month')`. */
  monthly: PlanPrice;
  /** `planPrice(plan, 'year')`; `null` = the plan has no yearly option. */
  yearly: PlanPrice | null;
  /** Normalised limits: `connectedPages`, `monthlyComments`, `teamSeats`, `workspaces`. */
  limits: Record<PlanLimitKey, number>;
  /** Feature flags (every key present). */
  features: PlanFeatureConfig['features'];
  /** Sign-up trial length (PW-D8): Starter only, `null` elsewhere or when Starter has no trial. */
  trialDays: number | null;
  /**
   * Comments a trial grants (PW-D12), resolved (`trial_comment_limit ?? limits.monthlyComments`);
   * `null` whenever `trialDays` is `null`.
   */
  trialCommentLimit: number | null;
}

/** `GET /api/plans`: active plans, `sort_order` then name. */
export interface PublicPlansResponse {
  items: PublicPlan[];
}
