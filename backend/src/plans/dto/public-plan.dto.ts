import type { PlanFeatureConfig, PlanLimitKey } from '../../db/schema/index.js';
import type { PlanPrice } from '../plan-price.js';

/** A plan text in both languages; `bn` already falls back to `en` (and vice versa, PR-D17). */
export interface PlanText {
  en: string;
  bn: string;
}

/**
 * One plan of the public `GET /api/plans` list (PR-T2, plan doc §5.7; user decisions 2026-11-20
 * PR-D7…D9, D14, D17, D18). For the client `/plans` page (PR-T6) and the Module 8 landing. No
 * admin-only fields; coupons are never listed (PR-D11).
 */
export interface PublicPlan {
  id: string;
  slug: string;
  name: string;
  /** Card badge, e.g. "Popular"; `null` = none. */
  badge: PlanText | null;
  /** Short card description; `null` = none. */
  description: PlanText | null;
  /** The one highlighted plan (PR-D9). */
  highlighted: boolean;
  /** `planPrice(plan, 'month', liveDiscounts)`. */
  monthly: PlanPrice;
  /** `planPrice(plan, 'year', liveDiscounts)`; `null` = the plan has no yearly option. */
  yearly: PlanPrice | null;
  /** Normalised limits: `connectedPages`, `monthlyComments`, `teamSeats`, `workspaces`. */
  limits: Record<PlanLimitKey, number>;
  /** Feature flags (every key present). */
  features: PlanFeatureConfig['features'];
  /** The plan's live TRIAL promotion (PR-D10); `null` = none. */
  trial: PublicTrial | null;
}

export interface PublicTrial {
  promotionId: string;
  days: number;
  /** Comments the trial grants, resolved (`null` on the promotion → the plan's monthly comments). */
  commentLimit: number;
  /** End of the trial offer; `null` = until stopped. */
  endsAt: Date | null;
}

/** `GET /api/plans`: active plans, `sort_order` then name. */
export interface PublicPlansResponse {
  items: PublicPlan[];
  /**
   * "Save up to N%" on the Monthly/Yearly switch: max over the plans of 1 − yearly ÷ monthly
   * **shown** per-month price, rounded down; 0 = no yearly saving.
   */
  yearlySaveUpToPercent: number;
  /** Support WhatsApp number for "Contact us" (`8801…`, PR-D18); `null` = hide the button. */
  contactWhatsapp: string | null;
}
