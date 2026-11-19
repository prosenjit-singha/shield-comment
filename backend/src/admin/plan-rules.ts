import {
  LEGACY_PLAN_LIMIT_KEYS,
  PLAN_AUDIT_USER_AGENT_MAX,
  PLAN_FEATURE_KEYS,
  PLAN_LIMIT_KEYS,
  type PlanAuditChange,
  type PlanFeatureConfig,
} from '../db/schema/index.js';
import type { AdminPlan, UpdatePlanDto } from './dto/plans.dto.js';

/** Editable plan values (the columns `PATCH /api/admin/settings/plans/:planId` may change). */
export interface PlanEditableValues {
  monthlyPriceBdt: number;
  /** Per-month price when billed yearly (PW-D5); `null` = no yearly option. */
  yearlyMonthlyPriceBdt: number | null;
  /** PR-D8 / PR-D17: optional en + bn card text. */
  badgeEn: string | null;
  badgeBn: string | null;
  descriptionEn: string | null;
  descriptionBn: string | null;
  /** PR-D9: at most one plan. */
  isHighlighted: boolean;
  featureConfig: PlanFeatureConfig;
}

/** The top-level scalar columns a PATCH may change, in audit order (`PLAN_AUDIT_FIELDS`). */
const SCALAR_FIELDS = [
  'monthlyPriceBdt',
  'yearlyMonthlyPriceBdt',
  'badgeEn',
  'badgeBn',
  'descriptionEn',
  'descriptionBn',
  'isHighlighted',
] as const;

export interface PlanRow extends PlanEditableValues {
  /** Read-only legacy columns (PR-T7 drops them). */
  offerPriceBdt: number | null;
  offerBadge: string | null;
  trialDays: number | null;
  trialCommentLimit: number | null;
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

const isLimitValue = (value: unknown): value is number =>
  Number.isInteger(value) && (value as number) >= 0;

/**
 * Complete, typed `feature_config` from whatever the jsonb holds: every known key present
 * (missing or mistyped limit → 0, flag → false), unknown keys dropped. Keeps the API shape
 * stable if a key is added later or a row was edited by hand. A limit whose key is missing is
 * read from its old name (`LEGACY_PLAN_LIMIT_KEYS`, e.g. `monthlyAiCredits` → `monthlyComments`,
 * PW-T1b); the new key wins when both are present.
 */
export function normalizeFeatureConfig(raw: unknown): PlanFeatureConfig {
  const source = isRecord(raw) ? raw : {};
  const limits = isRecord(source.limits) ? source.limits : {};
  const features = isRecord(source.features) ? source.features : {};
  return {
    limits: Object.fromEntries(
      PLAN_LIMIT_KEYS.map((key) => {
        const legacy = LEGACY_PLAN_LIMIT_KEYS[key];
        const value =
          key in limits || legacy === undefined ? limits[key] : limits[legacy];
        return [key, isLimitValue(value) ? value : 0];
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
    SCALAR_FIELDS.every((field) => patch[field] === undefined) &&
    !definedKeys(config?.limits) &&
    !definedKeys(config?.features)
  );
}

/**
 * Applies a validated partial body to the stored values (absent keys keep their value; `null`
 * clears a nullable field).
 */
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
  const pick = <K extends (typeof SCALAR_FIELDS)[number]>(
    field: K,
  ): PlanEditableValues[K] =>
    patch[field] === undefined
      ? current[field]
      : (patch[field] as PlanEditableValues[K]);
  return {
    monthlyPriceBdt: pick('monthlyPriceBdt'),
    yearlyMonthlyPriceBdt: pick('yearlyMonthlyPriceBdt'),
    badgeEn: pick('badgeEn'),
    badgeBn: pick('badgeBn'),
    descriptionEn: pick('descriptionEn'),
    descriptionBn: pick('descriptionBn'),
    isHighlighted: pick('isHighlighted'),
    featureConfig: { limits, features },
  };
}

/**
 * Yearly rule on the merged values (PW-D5): the yearly per-month list price must not be above the
 * monthly list price (PR-T1: offers moved to promotions, so an offer no longer caps it). Checked after every merge, so lowering the monthly
 * price below a stored yearly price is refused too (DB check `plans_yearly_monthly_price_check` is
 * the backstop, never reached).
 */
export function yearlyPriceError(values: PlanEditableValues): string | null {
  const monthly = values.monthlyPriceBdt;
  if (
    values.yearlyMonthlyPriceBdt !== null &&
    values.yearlyMonthlyPriceBdt > monthly
  ) {
    return `yearlyMonthlyPriceBdt (${values.yearlyMonthlyPriceBdt}) must not be greater than the monthly price (${monthly})`;
  }
  return null;
}

/**
 * Fields that differ between the stored and the merged values (M2-T15 audit log), in
 * `PLAN_AUDIT_FIELDS` order. Feature config is compared leaf by leaf on normalized configs, so a
 * PATCH that re-sends the stored values yields `[]` (no-op: no update, no audit row).
 */
export function diffPlanValues(
  before: PlanEditableValues,
  after: PlanEditableValues,
): PlanAuditChange[] {
  const changes: PlanAuditChange[] = [];
  for (const field of SCALAR_FIELDS) {
    if (before[field] !== after[field]) {
      changes.push({ field, before: before[field], after: after[field] });
    }
  }
  const from = normalizeFeatureConfig(before.featureConfig);
  const to = normalizeFeatureConfig(after.featureConfig);
  for (const key of PLAN_LIMIT_KEYS) {
    if (from.limits[key] !== to.limits[key]) {
      changes.push({
        field: `featureConfig.limits.${key}`,
        before: from.limits[key],
        after: to.limits[key],
      });
    }
  }
  for (const key of PLAN_FEATURE_KEYS) {
    if (from.features[key] !== to.features[key]) {
      changes.push({
        field: `featureConfig.features.${key}`,
        before: from.features[key],
        after: to.features[key],
      });
    }
  }
  return changes;
}

/** `User-Agent` header for the audit row: trimmed, ≤ 512 chars, `null` when absent/blank. */
export function auditUserAgent(
  header: string | string[] | undefined,
): string | null {
  const value = (Array.isArray(header) ? header[0] : header)?.trim();
  // Cut by code point (not UTF-16 unit) so a surrogate pair is never split.
  return value
    ? Array.from(value).slice(0, PLAN_AUDIT_USER_AGENT_MAX).join('')
    : null;
}

export function toAdminPlan(row: PlanRow): AdminPlan {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    sortOrder: row.sortOrder,
    isActive: row.isActive,
    monthlyPriceBdt: row.monthlyPriceBdt,
    yearlyMonthlyPriceBdt: row.yearlyMonthlyPriceBdt,
    badgeEn: row.badgeEn,
    badgeBn: row.badgeBn,
    descriptionEn: row.descriptionEn,
    descriptionBn: row.descriptionBn,
    isHighlighted: row.isHighlighted,
    offerPriceBdt: row.offerPriceBdt,
    offerBadge: row.offerBadge,
    trialDays: row.trialDays,
    trialCommentLimit: row.trialCommentLimit,
    featureConfig: normalizeFeatureConfig(row.featureConfig),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
