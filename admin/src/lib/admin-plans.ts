import { queryOptions } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'

/**
 * A7 plan settings (M2-T11 API, M2-T12 screen). Mirrors the backend's `src/admin/dto/plans.dto.ts`
 * and the limits in `src/db/schema/plans.ts`.
 *
 * - `GET /api/admin/settings/plans` → `{ items }` ordered by `sortOrder` (any query param → 400).
 * - `PATCH /api/admin/settings/plans/:planId` (one plan per request, partial body) → `{ plan }`.
 *   400 = invalid / unknown field / nothing to update / offer > original / yearly per-month >
 *   monthly price / trial field on a non-Starter plan; 404 = unknown plan.
 *
 * The GET lists **active** plans only: the deactivated `free` row (PW-D7) never shows up.
 */
/**
 * `monthlyComments` (PW-D1) = comments per month, each comment counts 1; it replaced the M5-T11
 * `monthlyAiCredits` (old audit rows still carry that name, see `admin-plan-audit.ts`).
 * `workspaces` (PW-D10) = workspaces a client account may own.
 */
export const PLAN_LIMIT_KEYS = ['connectedPages', 'monthlyComments', 'teamSeats', 'workspaces'] as const
export type PlanLimitKey = (typeof PLAN_LIMIT_KEYS)[number]

export const PLAN_FEATURE_KEYS = [
  'banglaAiFilter',
  'autoHideScams',
  'customBlocklist',
  'autoReplyTemplates',
  'messengerAlerts',
  'whiteLabelReports',
  'prioritySupportApi',
] as const
export type PlanFeatureKey = (typeof PLAN_FEATURE_KEYS)[number]

export interface PlanFeatureConfig {
  limits: Record<PlanLimitKey, number>
  features: Record<PlanFeatureKey, boolean>
}

export interface AdminPlan {
  id: string
  slug: string
  name: string
  sortOrder: number
  isActive: boolean
  /** Monthly list price, whole BDT (৳). */
  originalPriceBdt: number
  /** Promo price, whole BDT, ≤ `originalPriceBdt`; `null` = no offer. */
  offerPriceBdt: number | null
  /** e.g. "50% Launch Offer" (trimmed, 1–40 chars); `null` = none. */
  offerBadge: string | null
  /**
   * Per-month price when billed yearly (charged × 12), whole BDT, ≤ the monthly price
   * (`offer ?? original`); `null` = no yearly option (PW-D5).
   */
  yearlyMonthlyPriceBdt: number | null
  /** Trial length in days, 1–90, Starter only (PW-D8, seed 7); `null` = no trial. */
  trialDays: number | null
  /** Comments granted to a trial, 0–10,000,000, Starter only (PW-D12, seed 300); `null` = Starter's `monthlyComments`. */
  trialCommentLimit: number | null
  /** Always complete: every limit and feature key is present. */
  featureConfig: PlanFeatureConfig
  createdAt: string
  updatedAt: string
}

export interface AdminPlansResponse {
  items: AdminPlan[]
}

export interface AdminPlanUpdateResponse {
  plan: AdminPlan
}

/** `PATCH` body: every key optional, at least one sent. `null` clears a nullable field. */
export interface UpdatePlanBody {
  originalPriceBdt?: number
  offerPriceBdt?: number | null
  offerBadge?: string | null
  yearlyMonthlyPriceBdt?: number | null
  trialDays?: number | null
  trialCommentLimit?: number | null
  featureConfig?: {
    limits?: Partial<Record<PlanLimitKey, number>>
    features?: Partial<Record<PlanFeatureKey, boolean>>
  }
}

export const PLAN_PRICE_MAX_BDT = 1_000_000
export const PLAN_OFFER_BADGE_MAX = 40
export const PLAN_TRIAL_COMMENT_LIMIT_MAX = 10_000_000
/** The only plan that carries trial fields (backend `TRIAL_PLAN_SLUG`). */
export const TRIAL_PLAN_SLUG = 'starter'
/** Trial length presets (PW-D8); the backend accepts any whole 1–90. */
export const TRIAL_DAYS_PRESETS = [3, 7, 14, 30] as const
export const PLAN_LIMIT_MAX: Record<PlanLimitKey, number> = {
  connectedPages: 1_000,
  monthlyComments: 10_000_000,
  teamSeats: 1_000,
  workspaces: 1_000,
}

/** Row labels of the `docs/design/client.md` §7 pricing matrix (rows 1–3 and 4–10) + workspaces. */
export const planLimitLabels: Record<PlanLimitKey, string> = {
  connectedPages: 'Connected FB & IG Pages',
  monthlyComments: 'Monthly comments',
  teamSeats: 'Team / Moderator Seats',
  workspaces: 'Workspaces',
}

export const planFeatureLabels: Record<PlanFeatureKey, string> = {
  banglaAiFilter: 'Bangla/Banglish/EN AI Filter',
  autoHideScams: 'Auto-Hide Scam & Poaching Links',
  customBlocklist: 'Custom Keyword & BD Phone Blocklist',
  autoReplyTemplates: 'Brand-Voice Auto-Reply Templates',
  messengerAlerts: 'WhatsApp & Telegram Alerts',
  whiteLabelReports: 'White-Label CSV/PDF Agency Reports',
  prioritySupportApi: 'Priority Support & API Webhook Access',
}

// ---------------------------------------------------------------------------------------------
// Queries

export const adminPlansKey = ['admin', 'plans'] as const
export const plansListKey = [...adminPlansKey, 'list'] as const

export function plansQueryOptions() {
  return queryOptions({
    queryKey: plansListKey,
    queryFn: ({ signal }) => apiFetch<AdminPlansResponse>('/admin/settings/plans', { signal }),
  })
}

export function updatePlan({ id, body }: { id: string; body: UpdatePlanBody }) {
  return apiFetch<AdminPlanUpdateResponse>(`/admin/settings/plans/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  })
}

/** Puts the saved plan into the cached list (same position) so the card shows it at once. */
export function replacePlanInList(list: AdminPlansResponse | undefined, plan: AdminPlan) {
  if (!list) return list
  return { ...list, items: list.items.map((item) => (item.id === plan.id ? plan : item)) }
}

// ---------------------------------------------------------------------------------------------
// Editor draft: inputs hold strings so a half-typed value can be shown and validated.

export interface PlanDraft {
  originalPriceBdt: string
  /** Empty = no offer. */
  offerPriceBdt: string
  /** Empty (after trimming) = no badge. */
  offerBadge: string
  /** Empty = no yearly option. */
  yearlyMonthlyPriceBdt: string
  /** Picked from the presets (or the stored value); `null` = no trial. Starter only. */
  trialDays: number | null
  /** Empty = Starter's monthly comments. Starter only. */
  trialCommentLimit: string
  limits: Record<PlanLimitKey, string>
  features: Record<PlanFeatureKey, boolean>
}

export function draftFromPlan(plan: AdminPlan): PlanDraft {
  const { limits, features } = plan.featureConfig
  return {
    originalPriceBdt: String(plan.originalPriceBdt),
    offerPriceBdt: plan.offerPriceBdt === null ? '' : String(plan.offerPriceBdt),
    offerBadge: plan.offerBadge ?? '',
    yearlyMonthlyPriceBdt: plan.yearlyMonthlyPriceBdt === null ? '' : String(plan.yearlyMonthlyPriceBdt),
    trialDays: plan.trialDays,
    trialCommentLimit: plan.trialCommentLimit === null ? '' : String(plan.trialCommentLimit),
    limits: Object.fromEntries(PLAN_LIMIT_KEYS.map((key) => [key, String(limits[key])])) as Record<
      PlanLimitKey,
      string
    >,
    features: { ...features },
  }
}

/** Digits only (surrounding spaces allowed): `"1499"` → 1499; `""`, `"1.5"`, `"-1"`, `"1e3"` → null. */
export function parseWholeNumber(value: string): number | null {
  const trimmed = value.trim()
  if (!/^\d+$/.test(trimmed)) return null
  const n = Number(trimmed)
  return Number.isSafeInteger(n) ? n : null
}

export interface PlanDraftErrors {
  originalPriceBdt?: string
  offerPriceBdt?: string
  offerBadge?: string
  yearlyMonthlyPriceBdt?: string
  trialCommentLimit?: string
  limits: Partial<Record<PlanLimitKey, string>>
}

/** Trial fields (days preset + comment limit) belong to the Starter plan only. */
export function isTrialPlan(plan: Pick<AdminPlan, 'slug'>): boolean {
  return plan.slug === TRIAL_PLAN_SLUG
}

function wholeNumberError(value: string, max: number, what: string): string | undefined {
  if (value.trim() === '') return `Enter ${what}.`
  const n = parseWholeNumber(value)
  if (n === null) return 'Use a whole number (digits only).'
  if (n > max) return `Must be ${formatCount(max)} or less.`
  return undefined
}

/**
 * The monthly price a customer pays (`offer ?? original`, as the backend's yearly rule reads it);
 * `null` while the original or a typed offer is invalid or the offer is above the original.
 */
export function draftMonthlyPrice(draft: PlanDraft): number | null {
  const original = parseWholeNumber(draft.originalPriceBdt)
  if (original === null || original > PLAN_PRICE_MAX_BDT) return null
  if (draft.offerPriceBdt.trim() === '') return original
  const offer = parseWholeNumber(draft.offerPriceBdt)
  return offer === null || offer > original ? null : offer
}

/** Same rules as the backend's `UpdatePlanDto` + `planValuesError` (offer ≤ original, yearly ≤ monthly). */
export function validatePlanDraft(draft: PlanDraft): PlanDraftErrors {
  const errors: PlanDraftErrors = { limits: {} }
  const original = wholeNumberError(draft.originalPriceBdt, PLAN_PRICE_MAX_BDT, 'a price')
  if (original) errors.originalPriceBdt = original

  if (draft.offerPriceBdt.trim() !== '') {
    const offer = wholeNumberError(draft.offerPriceBdt, PLAN_PRICE_MAX_BDT, 'a price')
    if (offer) {
      errors.offerPriceBdt = offer
    } else if (!original) {
      const offerValue = parseWholeNumber(draft.offerPriceBdt) as number
      const originalValue = parseWholeNumber(draft.originalPriceBdt) as number
      if (offerValue > originalValue) errors.offerPriceBdt = "The offer can't be more than the original price."
    }
  }

  if (draft.yearlyMonthlyPriceBdt.trim() !== '') {
    const yearly = wholeNumberError(draft.yearlyMonthlyPriceBdt, PLAN_PRICE_MAX_BDT, 'a price')
    const monthly = draftMonthlyPrice(draft)
    if (yearly) {
      errors.yearlyMonthlyPriceBdt = yearly
    } else if (monthly !== null && (parseWholeNumber(draft.yearlyMonthlyPriceBdt) as number) > monthly) {
      errors.yearlyMonthlyPriceBdt = `Can't be more than the monthly price (${formatPlanPrice(monthly)}).`
    }
  }

  if (draft.trialCommentLimit.trim() !== '') {
    const trialLimit = wholeNumberError(draft.trialCommentLimit, PLAN_TRIAL_COMMENT_LIMIT_MAX, 'a limit')
    if (trialLimit) errors.trialCommentLimit = trialLimit
  }

  if (draft.offerBadge.trim().length > PLAN_OFFER_BADGE_MAX) {
    errors.offerBadge = `Up to ${PLAN_OFFER_BADGE_MAX} characters.`
  }

  for (const key of PLAN_LIMIT_KEYS) {
    const error = wholeNumberError(draft.limits[key], PLAN_LIMIT_MAX[key], 'a limit')
    if (error) errors.limits[key] = error
  }
  return errors
}

export function hasDraftErrors(errors: PlanDraftErrors): boolean {
  return (
    errors.originalPriceBdt !== undefined ||
    errors.offerPriceBdt !== undefined ||
    errors.offerBadge !== undefined ||
    errors.yearlyMonthlyPriceBdt !== undefined ||
    errors.trialCommentLimit !== undefined ||
    Object.keys(errors.limits).length > 0
  )
}

/**
 * Minimal `PATCH` body: only what differs from the stored plan. Call it on a valid draft
 * (`hasDraftErrors` false); an empty object means nothing changed.
 */
export function planPatch(plan: AdminPlan, draft: PlanDraft): UpdatePlanBody {
  const body: UpdatePlanBody = {}
  const original = parseWholeNumber(draft.originalPriceBdt)
  if (original !== null && original !== plan.originalPriceBdt) body.originalPriceBdt = original

  const offer = draft.offerPriceBdt.trim() === '' ? null : parseWholeNumber(draft.offerPriceBdt)
  if (offer !== plan.offerPriceBdt) body.offerPriceBdt = offer

  const badge = draft.offerBadge.trim() === '' ? null : draft.offerBadge.trim()
  if (badge !== plan.offerBadge) body.offerBadge = badge

  const yearly = draft.yearlyMonthlyPriceBdt.trim() === '' ? null : parseWholeNumber(draft.yearlyMonthlyPriceBdt)
  if (yearly !== plan.yearlyMonthlyPriceBdt) body.yearlyMonthlyPriceBdt = yearly

  // Trial fields are never sent for another plan (the backend refuses non-null values there).
  if (isTrialPlan(plan)) {
    if (draft.trialDays !== plan.trialDays) body.trialDays = draft.trialDays
    const trialLimit = draft.trialCommentLimit.trim() === '' ? null : parseWholeNumber(draft.trialCommentLimit)
    if (trialLimit !== plan.trialCommentLimit) body.trialCommentLimit = trialLimit
  }

  const limits: Partial<Record<PlanLimitKey, number>> = {}
  for (const key of PLAN_LIMIT_KEYS) {
    const value = parseWholeNumber(draft.limits[key])
    if (value !== null && value !== plan.featureConfig.limits[key]) limits[key] = value
  }
  const features: Partial<Record<PlanFeatureKey, boolean>> = {}
  for (const key of PLAN_FEATURE_KEYS) {
    if (draft.features[key] !== plan.featureConfig.features[key]) features[key] = draft.features[key]
  }
  if (Object.keys(limits).length > 0 || Object.keys(features).length > 0) {
    body.featureConfig = {}
    if (Object.keys(limits).length > 0) body.featureConfig.limits = limits
    if (Object.keys(features).length > 0) body.featureConfig.features = features
  }
  return body
}

/**
 * Unsaved changes? An invalid draft always counts (the stored plan is valid, so it was edited);
 * a valid one only when its `PATCH` body isn't empty (`"0499"` vs 499 is not a change).
 */
export function isDraftDirty(plan: AdminPlan, draft: PlanDraft | undefined): boolean {
  if (!draft) return false
  if (hasDraftErrors(validatePlanDraft(draft))) return true
  return Object.keys(planPatch(plan, draft)).length > 0
}

// ---------------------------------------------------------------------------------------------
// Formatters

const countFormat = new Intl.NumberFormat('en-BD', { maximumFractionDigits: 0 })

/** `en-BD` grouping, as the rest of the admin: `10,000,000` → `1,00,00,000`. */
export function formatCount(value: number): string {
  return countFormat.format(value)
}

/** `৳1,499`. */
export function formatPlanPrice(value: number): string {
  return `৳${formatCount(value)}`
}

/** Whole-percent saving of an offer: 499 of 999 → 50. `null` without a real discount. */
export function offerDiscountPercent(original: number, offer: number | null): number | null {
  if (offer === null || original <= 0 || offer >= original) return null
  return Math.round((1 - offer / original) * 100)
}

export interface PricePreview {
  /** What the customer pays; `null` while the draft's price is invalid. */
  price: number | null
  /** Struck-through list price, only when a lower offer applies. */
  struck: number | null
  badge: string | null
  discountPercent: number | null
}

/** Live preview of the draft as the pricing card would show it. */
export function pricePreview(draft: PlanDraft): PricePreview {
  const original = parseWholeNumber(draft.originalPriceBdt)
  const offerText = draft.offerPriceBdt.trim()
  const offer = offerText === '' ? null : parseWholeNumber(offerText)
  const badge = draft.offerBadge.trim() === '' ? null : draft.offerBadge.trim()
  if (original === null) return { price: null, struck: null, badge, discountPercent: null }
  if (offerText === '') return { price: original, struck: null, badge, discountPercent: null }
  if (offer === null || offer > original) return { price: null, struck: null, badge, discountPercent: null }
  const discount = offerDiscountPercent(original, offer)
  return { price: offer, struck: discount === null ? null : original, badge, discountPercent: discount }
}

/** What a yearly customer is charged: the per-month price × 12. */
export function yearlyChargeBdt(perMonth: number): number {
  return perMonth * 12
}

/** Hint under the yearly input: `Billed ৳5,388 yearly.`; `null` while the draft value is empty or invalid. */
export function yearlyBilledHint(draft: PlanDraft): string | null {
  if (draft.yearlyMonthlyPriceBdt.trim() === '') return null
  const perMonth = parseWholeNumber(draft.yearlyMonthlyPriceBdt)
  if (perMonth === null || perMonth > PLAN_PRICE_MAX_BDT) return null
  return `Billed ${formatPlanPrice(yearlyChargeBdt(perMonth))} yearly.`
}

export interface TrialDaysOption {
  /** `null` = no trial. */
  value: number | null
  label: string
}

/** `7` → `7 days`, `1` → `1 day`, `null` → `No trial`. */
export function formatTrialDays(days: number | null): string {
  if (days === null) return 'No trial'
  return `${days} ${days === 1 ? 'day' : 'days'}`
}

/**
 * Trial length choices (PW-D8): "No trial" + the presets 3 / 7 / 14 / 30, plus a stored value
 * outside the presets (set through the API, e.g. 10) so it still shows as the selected one.
 */
export function trialDaysOptions(stored: number | null): TrialDaysOption[] {
  const days: number[] = [...TRIAL_DAYS_PRESETS]
  if (stored !== null && !days.includes(stored)) days.push(stored)
  days.sort((a, b) => a - b)
  return [{ value: null, label: formatTrialDays(null) }, ...days.map((d) => ({ value: d, label: formatTrialDays(d) }))]
}
