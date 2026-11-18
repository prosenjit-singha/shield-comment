import {
  PLAN_FEATURE_KEYS,
  PLAN_LIMIT_KEYS,
  type PlanFeatureConfig,
} from '../db/schema/index.js';
import type { AdminPlan, UpdatePlanDto } from './dto/plans.dto.js';

/** Editable plan values (the columns `PATCH /api/admin/settings/plans/:planId` may change). */
export interface PlanEditableValues {
  originalPriceBdt: number;
  offerPriceBdt: number | null;
  offerBadge: string | null;
  featureConfig: PlanFeatureConfig;
}

export interface PlanRow extends PlanEditableValues {
  id: string;
  slug: string;
  name: string;
  sortOrder: number;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Complete, typed `feature_config` from whatever the jsonb holds: every known key present
 * (missing or mistyped limit → 0, flag → false), unknown keys dropped. Keeps the API shape
 * stable if a key is added later or a row was edited by hand.
 */
export function normalizeFeatureConfig(raw: unknown): PlanFeatureConfig {
  const source = isRecord(raw) ? raw : {};
  const limits = isRecord(source.limits) ? source.limits : {};
  const features = isRecord(source.features) ? source.features : {};
  return {
    limits: Object.fromEntries(
      PLAN_LIMIT_KEYS.map((key) => {
        const value = limits[key];
        return [
          key,
          Number.isInteger(value) && (value as number) >= 0 ? value : 0,
        ];
      }),
    ) as PlanFeatureConfig['limits'],
    features: Object.fromEntries(
      PLAN_FEATURE_KEYS.map((key) => [key, features[key] === true]),
    ) as PlanFeatureConfig['features'],
  };
}

/** `true` when the body would change nothing (no field, or only empty `featureConfig` groups). */
export function isEmptyPlanPatch(patch: UpdatePlanDto): boolean {
  const config = patch.featureConfig;
  const definedKeys = (o: object | undefined) =>
    o ? Object.values(o).some((v) => v !== undefined) : false;
  return (
    patch.originalPriceBdt === undefined &&
    patch.offerPriceBdt === undefined &&
    patch.offerBadge === undefined &&
    !definedKeys(config?.limits) &&
    !definedKeys(config?.features)
  );
}

/** Applies a validated partial body to the stored values (absent keys keep their value). */
export function mergePlanPatch(
  current: PlanEditableValues,
  patch: UpdatePlanDto,
): PlanEditableValues {
  const base = normalizeFeatureConfig(current.featureConfig);
  const limits = { ...base.limits };
  for (const key of PLAN_LIMIT_KEYS) {
    const value = patch.featureConfig?.limits?.[key];
    if (value !== undefined) limits[key] = value;
  }
  const features = { ...base.features };
  for (const key of PLAN_FEATURE_KEYS) {
    const value = patch.featureConfig?.features?.[key];
    if (value !== undefined) features[key] = value;
  }
  return {
    originalPriceBdt: patch.originalPriceBdt ?? current.originalPriceBdt,
    offerPriceBdt:
      patch.offerPriceBdt === undefined
        ? current.offerPriceBdt
        : patch.offerPriceBdt,
    offerBadge:
      patch.offerBadge === undefined ? current.offerBadge : patch.offerBadge,
    featureConfig: { limits, features },
  };
}

/** Offer rule on the merged values (DB check `plans_offer_price_check` is the backstop). */
export function offerPriceError(values: PlanEditableValues): string | null {
  if (
    values.offerPriceBdt !== null &&
    values.offerPriceBdt > values.originalPriceBdt
  ) {
    return `offerPriceBdt (${values.offerPriceBdt}) must not be greater than originalPriceBdt (${values.originalPriceBdt})`;
  }
  return null;
}

export function toAdminPlan(row: PlanRow): AdminPlan {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    sortOrder: row.sortOrder,
    isActive: row.isActive,
    originalPriceBdt: row.originalPriceBdt,
    offerPriceBdt: row.offerPriceBdt,
    offerBadge: row.offerBadge,
    featureConfig: normalizeFeatureConfig(row.featureConfig),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
