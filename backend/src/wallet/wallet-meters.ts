import type { PlanFeatureConfig, PlanLimitKey } from '../db/schema/index.js';

/** How a wallet meter is granted each period. */
export interface WalletMeterConfig {
  /** The plan limit (`feature_config.limits`) granted per period. */
  planLimit: PlanLimitKey;
  /**
   * The field that overrides the grant of a trial period (PW-D12; since PR-T3 the redemption
   * snapshot, see `LiveSubscription.plan.trialCommentLimit`); `null` = the plan limit. Meters
   * without one grant the plan limit to trials too.
   */
  trialLimit?: 'trialCommentLimit';
}

/**
 * Meter registry (PW-D3): a new meter (auto-reply, lead capture, …) is one entry here, one plan
 * limit key and one call site; no schema change. Keys must match `WALLET_METER_PATTERN`
 * (checked by the unit test and by the `wallet_*_meter_format` SQL checks).
 */
export const WALLET_METERS = {
  monthlyComments: {
    planLimit: 'monthlyComments',
    trialLimit: 'trialCommentLimit',
  },
} as const satisfies Record<string, WalletMeterConfig>;

export type WalletMeter = keyof typeof WALLET_METERS;

/** Every registered meter, in registry order. */
export const WALLET_METER_KEYS = Object.keys(WALLET_METERS) as WalletMeter[];

export function isWalletMeter(value: unknown): value is WalletMeter {
  return typeof value === 'string' && Object.hasOwn(WALLET_METERS, value);
}

/** The plan fields a grant reads (`trialCommentLimit`: the trial's limit, PR-T3). */
export interface WalletGrantPlan {
  featureConfig: PlanFeatureConfig;
  trialCommentLimit: number | null;
}

/**
 * The amount one period of `meter` grants (read at period start, PW-D14): a trial period takes
 * the meter's trial limit when set (the trial's comment limit ?? `limits.monthlyComments`),
 * anything else the plan limit. `featureConfig` must be normalised (`normalizeFeatureConfig`).
 */
export function meterGrant(
  meter: WalletMeter,
  plan: WalletGrantPlan,
  trialing: boolean,
): number {
  const config: WalletMeterConfig = WALLET_METERS[meter];
  if (trialing && config.trialLimit) {
    const trialLimit = plan[config.trialLimit];
    if (trialLimit !== null) return trialLimit;
  }
  return plan.featureConfig.limits[config.planLimit];
}
