import { keepPreviousData, queryOptions } from '@tanstack/react-query'
import {
  adminPlansKey,
  formatCount,
  formatPlanPrice,
  formatTrialDays,
  PLAN_FEATURE_KEYS,
  PLAN_LIMIT_KEYS,
  type PlanFeatureKey,
  type PlanLimitKey,
  planFeatureLabels,
  planLimitLabels,
} from '@/lib/admin-plans'
import { apiFetch } from '@/lib/api'

/**
 * Plan audit history (M2-T15 API, M2-T16 screen). Mirrors the backend's
 * `src/admin/dto/plan-audit.dto.ts`.
 *
 * `GET /api/admin/settings/plans/audit?skip&take&planId` → `{ items, total, skip, take }`, newest
 * first. `take` 1–100, `planId` a UUID (unknown plan = empty page); any other param → 400.
 */
export const PLAN_AUDIT_ACTIONS = ['UPDATE'] as const
export type PlanAuditAction = (typeof PLAN_AUDIT_ACTIONS)[number]

/** Values are whole BDT (prices), a badge string, a limit number or a feature flag; `null` = cleared. */
export type PlanAuditValue = number | string | boolean | null

export interface PlanAuditChange {
  /**
   * `originalPriceBdt`, `offerPriceBdt`, `offerBadge`, `yearlyMonthlyPriceBdt`, `trialDays`,
   * `trialCommentLimit`, `featureConfig.limits.<key>` or `featureConfig.features.<key>`.
   */
  field: string
  before: PlanAuditValue
  after: PlanAuditValue
}

export interface PlanAuditEntry {
  id: string
  plan: { id: string; slug: string; name: string }
  admin: { id: string; name: string; email: string }
  action: PlanAuditAction
  /** Only the fields that changed, in the backend's `PLAN_AUDIT_FIELDS` order. */
  changes: PlanAuditChange[]
  /** First `X-Forwarded-For` entry; `null` if unknown. */
  ip: string | null
  userAgent: string | null
  createdAt: string
}

export interface PlanAuditList {
  items: PlanAuditEntry[]
  total: number
  skip: number
  take: number
}

export const PLAN_AUDIT_PAGE_SIZE = 20

export interface PlanAuditFilter {
  /** 1-based. */
  page: number
  /** `undefined` = every plan. */
  planId?: string
}

export function planAuditParams({ page, planId }: PlanAuditFilter): URLSearchParams {
  const params = new URLSearchParams({
    skip: String((Math.max(1, page) - 1) * PLAN_AUDIT_PAGE_SIZE),
    take: String(PLAN_AUDIT_PAGE_SIZE),
  })
  if (planId) params.set('planId', planId)
  return params
}

/** Every audit query sits under `['admin','plans']`, so a plan save's invalidation refreshes it too. */
export const planAuditKey = [...adminPlansKey, 'audit'] as const

export function planAuditQueryOptions(filter: PlanAuditFilter) {
  const params = planAuditParams(filter)
  return queryOptions({
    queryKey: [
      ...planAuditKey,
      { skip: Number(params.get('skip')), take: PLAN_AUDIT_PAGE_SIZE, planId: filter.planId ?? null },
    ] as const,
    queryFn: ({ signal }) => apiFetch<PlanAuditList>(`/admin/settings/plans/audit?${params.toString()}`, { signal }),
    placeholderData: keepPreviousData,
  })
}

// ---------------------------------------------------------------------------------------------
// Formatting

export const planAuditActionLabels: Record<PlanAuditAction, string> = {
  UPDATE: 'Updated',
}

type FieldKind = 'price' | 'badge' | 'trial-days' | 'trial-limit' | 'limit' | 'legacy-limit' | 'feature' | 'unknown'

const PRICE_LABELS: Readonly<Record<string, string>> = {
  originalPriceBdt: 'Original price',
  offerPriceBdt: 'Offer price',
  yearlyMonthlyPriceBdt: 'Yearly price per month',
}

const LIMIT_PREFIX = 'featureConfig.limits.'
const FEATURE_PREFIX = 'featureConfig.features.'

/**
 * Renamed limits that only old audit rows carry (backend `LEGACY_PLAN_AUDIT_FIELDS`), shown under
 * their old label. PW-T1b: `monthlyAiCredits` (M5-T11) → `monthlyComments` (rows from before
 * M5-T11 read under the current "Monthly comments" label again).
 */
export const legacyPlanAuditFieldLabels: Readonly<Record<string, string>> = {
  'featureConfig.limits.monthlyAiCredits': 'Monthly AI credits',
}

function fieldKind(field: string): FieldKind {
  if (Object.hasOwn(PRICE_LABELS, field)) return 'price'
  if (field === 'offerBadge') return 'badge'
  if (field === 'trialDays') return 'trial-days'
  if (field === 'trialCommentLimit') return 'trial-limit'
  if (Object.hasOwn(legacyPlanAuditFieldLabels, field)) return 'legacy-limit'
  if (field.startsWith(LIMIT_PREFIX) && (PLAN_LIMIT_KEYS as readonly string[]).includes(field.slice(LIMIT_PREFIX.length)))
    return 'limit'
  if (
    field.startsWith(FEATURE_PREFIX) &&
    (PLAN_FEATURE_KEYS as readonly string[]).includes(field.slice(FEATURE_PREFIX.length))
  )
    return 'feature'
  return 'unknown'
}

/** Readable label: the editor's labels for prices/badge, the client.md §7 matrix rows for the rest. */
export function planAuditFieldLabel(field: string): string {
  switch (fieldKind(field)) {
    case 'price':
      return PRICE_LABELS[field] ?? field
    case 'badge':
      return 'Offer badge'
    case 'trial-days':
      return 'Trial length'
    case 'trial-limit':
      return 'Trial comment limit'
    case 'limit':
      return planLimitLabels[field.slice(LIMIT_PREFIX.length) as PlanLimitKey]
    case 'legacy-limit':
      return legacyPlanAuditFieldLabels[field] ?? field
    case 'feature':
      return planFeatureLabels[field.slice(FEATURE_PREFIX.length) as PlanFeatureKey]
    default:
      // A field added to the backend later still shows up, just not prettified.
      return field
  }
}

/** Shown for `null` (offer or badge cleared / not set). */
export const PLAN_AUDIT_NONE = 'None'

/** What `null` means for the PW-T7 fields (everything else reads `None`). */
const NULL_LABELS: Partial<Record<FieldKind, string>> = {
  'trial-days': 'No trial',
  'trial-limit': 'Monthly comments',
}

/**
 * `৳1,499` for prices, `On`/`Off` for features, grouped numbers for limits, `7 days` for the trial
 * length, `None` for `null` (`No trial` / `Monthly comments` for the trial fields).
 */
export function formatPlanAuditValue(field: string, value: PlanAuditValue | undefined): string {
  const kind = fieldKind(field)
  if (value === null || value === undefined) {
    if (field === 'yearlyMonthlyPriceBdt') return 'No yearly option'
    return NULL_LABELS[kind] ?? PLAN_AUDIT_NONE
  }
  if (kind === 'trial-days' && typeof value === 'number') return formatTrialDays(value)
  if (typeof value === 'boolean') return kind === 'feature' ? (value ? 'On' : 'Off') : String(value)
  if (typeof value === 'number') return kind === 'price' ? formatPlanPrice(value) : formatCount(value)
  return kind === 'badge' ? `“${value}”` : value
}
