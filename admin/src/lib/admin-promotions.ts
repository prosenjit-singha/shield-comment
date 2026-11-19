import { queryOptions } from '@tanstack/react-query'
import { formatDhakaDate } from '@/lib/admin-clients'
import { formatCount, formatPlanPrice, PLAN_LIMIT_MAX, PLAN_PRICE_MAX_BDT } from '@/lib/admin-plans'
import { ApiError, apiFetch } from '@/lib/api'

/**
 * Admin promotions (PR-T4 API, PR-T5b screen; PR-D1, D2, D4, D5, D15, reading 8). Mirrors the
 * backend's `src/admin/dto/promotions.dto.ts` + `src/admin/promotion-rules.ts`.
 */

export const PROMOTION_KINDS = ['TRIAL', 'DISCOUNT', 'COUPON'] as const
export type PromotionKind = (typeof PROMOTION_KINDS)[number]
export const PROMOTION_STATUSES = ['LIVE', 'ENDED', 'STOPPED', 'USED_UP'] as const
export type PromotionStatus = (typeof PROMOTION_STATUSES)[number]
export type DiscountType = 'FLAT' | 'PERCENT'
export type DiscountScope = 'TOTAL' | 'PER_MONTH'

export interface PromotionPlan {
  id: string
  slug: string
  name: string
}

export interface AdminPromotion {
  id: string
  kind: PromotionKind
  name: string
  /** COUPON only (uppercase). */
  code: string | null
  allPlans: boolean
  /** Targets (`[]` when `allPlans`), in plan order. */
  plans: PromotionPlan[]
  /** Last millisecond of the end date (Dhaka); `null` = until stopped. */
  endsAt: string | null
  /** `YYYY-MM-DD` (Dhaka) as picked; `null` = until stopped. */
  endsOn: string | null
  maxRedemptions: number | null
  redemptionCount: number
  status: PromotionStatus
  /** Money terms are read-only (first redemption made, reading 8). */
  termsLocked: boolean
  stoppedAt: string | null
  trialDays: number | null
  trialCommentLimit: number | null
  discountType: DiscountType | null
  discountValue: number | null
  discountScope: DiscountScope | null
  durationMonths: number | null
  createdByAdmin: boolean
  createdAt: string
  updatedAt: string
}

export interface AdminPromotionRedemption {
  id: string
  redeemedAt: string
  billingAccountId: string
  client: { id: string; name: string; email: string }
  workspace: { id: string; name: string } | null
  plan: PromotionPlan | null
  /** Saving on the first term, whole ৳ (0 for a trial). */
  discountBdtFirstTerm: number
  monthsUsed: number
}

/** Shared create / patch fields; `null` clears a nullable one. */
export interface PromotionFields {
  name: string
  code: string | null
  allPlans: boolean
  planIds: string[]
  endsOn: string | null
  maxRedemptions: number | null
  trialDays: number | null
  trialCommentLimit: number | null
  discountType: DiscountType | null
  discountValue: number | null
  discountScope: DiscountScope | null
  durationMonths: number | null
}
export type CreatePromotionBody = { kind: PromotionKind } & Partial<PromotionFields>
export type UpdatePromotionBody = Partial<PromotionFields>

export const PROMOTION_NAME_MAX = 60
export const PROMOTION_MAX_REDEMPTIONS_MAX = 1_000_000
export const PROMOTION_DURATION_MONTHS_MAX = 120
export const DISCOUNT_PERCENT_MAX = 100
export const TRIAL_DAY_PRESETS = [3, 7, 14, 30] as const
export const COUPON_CODE_PATTERN = /^[A-Z0-9-]{3,32}$/

/** Money terms, locked after the first redemption (backend `LOCKED_TERM_FIELDS`). */
export const LOCKED_TERM_FIELDS = [
  'trialDays',
  'trialCommentLimit',
  'discountType',
  'discountValue',
  'discountScope',
  'durationMonths',
] as const
export type LockedTermField = (typeof LOCKED_TERM_FIELDS)[number]

export const lockedFieldLabels: Record<LockedTermField, string> = {
  trialDays: 'trial length',
  trialCommentLimit: 'trial comments',
  discountType: 'discount type',
  discountValue: 'discount value',
  discountScope: 'applies to',
  durationMonths: 'months',
}

// ---------------------------------------------------------------------------------------------
// Queries

/** `/admin/promotions` URL filters; `undefined` = all. */
export interface PromotionsSearch {
  kind?: PromotionKind
  status?: PromotionStatus
}

export function validatePromotionsSearch(raw: Record<string, unknown>): PromotionsSearch {
  return {
    kind: PROMOTION_KINDS.find((k) => k === raw.kind),
    status: PROMOTION_STATUSES.find((s) => s === raw.status),
  }
}

export const adminPromotionsKey = ['admin', 'promotions'] as const

export function promotionsQueryOptions({ kind, status }: PromotionsSearch) {
  const params = new URLSearchParams()
  if (kind) params.set('kind', kind)
  if (status) params.set('status', status)
  const qs = params.size ? `?${params}` : ''
  return queryOptions({
    queryKey: [...adminPromotionsKey, 'list', { kind: kind ?? null, status: status ?? null }],
    queryFn: ({ signal }) => apiFetch<{ items: AdminPromotion[] }>(`/admin/promotions${qs}`, { signal }),
  })
}

export function redemptionsQueryOptions(promotionId: string) {
  return queryOptions({
    queryKey: [...adminPromotionsKey, 'redemptions', promotionId],
    queryFn: ({ signal }) =>
      apiFetch<{ items: AdminPromotionRedemption[] }>(
        `/admin/promotions/${encodeURIComponent(promotionId)}/redemptions`,
        { signal },
      ),
  })
}

export function createPromotion(body: CreatePromotionBody) {
  return apiFetch<{ promotion: AdminPromotion }>('/admin/promotions', { method: 'POST', body: JSON.stringify(body) })
}

export function updatePromotion({ id, body }: { id: string; body: UpdatePromotionBody }) {
  return apiFetch<{ promotion: AdminPromotion }>(`/admin/promotions/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  })
}

export function stopPromotion(id: string) {
  return apiFetch<{ promotion: AdminPromotion }>(`/admin/promotions/${encodeURIComponent(id)}/stop`, {
    method: 'POST',
  })
}

// ---------------------------------------------------------------------------------------------
// Labels

export const kindLabels: Record<PromotionKind, string> = { TRIAL: 'Trial', DISCOUNT: 'Discount', COUPON: 'Coupon' }
export const statusLabels: Record<PromotionStatus, string> = {
  LIVE: 'Live',
  ENDED: 'Ended',
  STOPPED: 'Stopped',
  USED_UP: 'Used up',
}

const plural = (n: number, one: string) => `${formatCount(n)} ${one}${n === 1 ? '' : 's'}`

/** Terms of the promotion: `৳200 off` + `each month · 3 months`, `10% off` + `total bill`, `7 days` + `300 comments`. */
export function promotionValue(
  p: Pick<
    PromotionFields,
    'trialDays' | 'trialCommentLimit' | 'discountType' | 'discountValue' | 'discountScope' | 'durationMonths'
  >,
): { main: string; detail: string } {
  if (p.trialDays !== null) {
    return {
      main: plural(p.trialDays, 'day'),
      detail: p.trialCommentLimit === null ? "plan's monthly comments" : plural(p.trialCommentLimit, 'comment'),
    }
  }
  const value = p.discountValue ?? 0
  const main = p.discountType === 'PERCENT' ? `${value}% off` : `${formatPlanPrice(value)} off`
  if (p.discountScope === 'TOTAL') return { main, detail: 'total bill' }
  return { main, detail: `each month · ${p.durationMonths === null ? 'forever' : plural(p.durationMonths, 'month')}` }
}

export function plansLabel(p: Pick<AdminPromotion, 'allPlans' | 'plans'>): string {
  return p.allPlans ? 'All plans' : p.plans.map((plan) => plan.name).join(', ')
}

export function endsLabel(p: Pick<AdminPromotion, 'endsAt'>): string {
  return p.endsAt ? formatDhakaDate(p.endsAt) : 'Until stopped'
}

export function usedLabel(p: Pick<AdminPromotion, 'redemptionCount' | 'maxRedemptions'>): string {
  return p.maxRedemptions === null
    ? `${formatCount(p.redemptionCount)} used`
    : `${formatCount(p.redemptionCount)} / ${formatCount(p.maxRedemptions)} used`
}

// ---------------------------------------------------------------------------------------------
// Form draft: inputs hold strings so a half-typed value can be shown and validated.

export interface PromotionDraft {
  kind: PromotionKind
  name: string
  code: string
  trialDays: number
  /** Empty = the plan's monthly comments. */
  trialCommentLimit: string
  discountType: DiscountType
  discountValue: string
  discountScope: DiscountScope
  forever: boolean
  durationMonths: string
  allPlans: boolean
  planIds: string[]
  untilStopped: boolean
  endsOn: string
  /** Empty = no cap. */
  maxRedemptions: string
}

export function emptyDraft(kind: PromotionKind = 'DISCOUNT'): PromotionDraft {
  return {
    kind,
    name: '',
    code: '',
    trialDays: 7,
    trialCommentLimit: '',
    discountType: 'PERCENT',
    discountValue: '',
    discountScope: 'PER_MONTH',
    forever: true,
    durationMonths: '',
    allPlans: true,
    planIds: [],
    untilStopped: true,
    endsOn: '',
    maxRedemptions: '',
  }
}

const str = (n: number | null) => (n === null ? '' : String(n))

export function draftFromPromotion(p: AdminPromotion): PromotionDraft {
  return {
    kind: p.kind,
    name: p.name,
    code: p.code ?? '',
    trialDays: p.trialDays ?? 7,
    trialCommentLimit: str(p.trialCommentLimit),
    discountType: p.discountType ?? 'PERCENT',
    discountValue: str(p.discountValue),
    discountScope: p.discountScope ?? 'PER_MONTH',
    forever: p.durationMonths === null,
    durationMonths: str(p.durationMonths),
    allPlans: p.allPlans,
    planIds: p.plans.map((plan) => plan.id),
    untilStopped: p.endsOn === null,
    endsOn: p.endsOn ?? '',
    maxRedemptions: str(p.maxRedemptions),
  }
}

/** Digits only: `"12"` → 12; `""`, `"1.5"`, `"-1"` → null. */
function whole(value: string): number | null {
  const t = value.trim()
  return /^\d+$/.test(t) && Number.isSafeInteger(Number(t)) ? Number(t) : null
}

export type DraftField =
  | 'name'
  | 'code'
  | 'trialCommentLimit'
  | 'discountValue'
  | 'durationMonths'
  | 'plans'
  | 'endsOn'
  | 'maxRedemptions'
export type DraftErrors = Partial<Record<DraftField, string>>

/**
 * The backend checks, inline. `today` = Dhaka `YYYY-MM-DD`; `storedEndsOn` (edit) may stay in the
 * past: an unchanged end date isn't sent.
 */
export function validateDraft(d: PromotionDraft, today: string, storedEndsOn: string | null = null): DraftErrors {
  const e: DraftErrors = {}
  const name = d.name.trim()
  if (!name) e.name = 'Enter a name.'
  else if (name.length > PROMOTION_NAME_MAX) e.name = `Use at most ${PROMOTION_NAME_MAX} characters.`

  if (d.kind === 'COUPON' && !COUPON_CODE_PATTERN.test(d.code.trim().toUpperCase())) {
    e.code = 'Use 3–32 letters, digits or dashes.'
  }

  if (d.kind === 'TRIAL') {
    if (d.trialCommentLimit.trim() !== '') {
      const n = whole(d.trialCommentLimit)
      if (n === null || n > PLAN_LIMIT_MAX.monthlyComments) {
        e.trialCommentLimit = `Enter a whole number up to ${formatCount(PLAN_LIMIT_MAX.monthlyComments)}, or leave it empty.`
      }
    }
  } else {
    const n = whole(d.discountValue)
    const max = d.discountType === 'PERCENT' ? DISCOUNT_PERCENT_MAX : PLAN_PRICE_MAX_BDT
    if (n === null || n < 1 || n > max) {
      e.discountValue =
        d.discountType === 'PERCENT' ? 'Enter a percentage from 1 to 100.' : `Enter ৳1 to ${formatPlanPrice(max)}.`
    }
    if (d.discountScope === 'PER_MONTH' && !d.forever) {
      const m = whole(d.durationMonths)
      if (m === null || m < 1 || m > PROMOTION_DURATION_MONTHS_MAX) {
        e.durationMonths = `Enter 1 to ${PROMOTION_DURATION_MONTHS_MAX} months.`
      }
    }
  }

  if (!d.allPlans && d.planIds.length === 0) e.plans = 'Pick at least one plan, or All plans.'

  if (!d.untilStopped) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d.endsOn) || Number.isNaN(Date.parse(d.endsOn))) e.endsOn = 'Pick an end date.'
    else if (d.endsOn < today && d.endsOn !== storedEndsOn) e.endsOn = 'Pick today or a later day.'
  }

  if (d.maxRedemptions.trim() !== '') {
    const n = whole(d.maxRedemptions)
    if (n === null || n < 1 || n > PROMOTION_MAX_REDEMPTIONS_MAX) {
      e.maxRedemptions = `Enter 1 to ${formatCount(PROMOTION_MAX_REDEMPTIONS_MAX)}, or leave it empty.`
    }
  }
  return e
}

/** What the draft stores (call after `validateDraft` passed). Fields of the other kinds are `null`. */
export function draftFields(d: PromotionDraft): PromotionFields {
  const trial = d.kind === 'TRIAL'
  const perMonth = !trial && d.discountScope === 'PER_MONTH'
  return {
    name: d.name.trim(),
    code: d.kind === 'COUPON' ? d.code.trim().toUpperCase() : null,
    allPlans: d.allPlans,
    planIds: d.allPlans ? [] : d.planIds,
    endsOn: d.untilStopped ? null : d.endsOn,
    maxRedemptions: whole(d.maxRedemptions),
    trialDays: trial ? d.trialDays : null,
    trialCommentLimit: trial ? whole(d.trialCommentLimit) : null,
    discountType: trial ? null : d.discountType,
    discountValue: trial ? null : whole(d.discountValue),
    discountScope: trial ? null : d.discountScope,
    durationMonths: perMonth && !d.forever ? whole(d.durationMonths) : null,
  }
}

/** `POST` body: the kind + its fields only (`null`s and the targets of "All plans" left out). */
export function createBody(d: PromotionDraft): CreatePromotionBody {
  const fields = draftFields(d)
  const body: CreatePromotionBody = { kind: d.kind }
  for (const [key, value] of Object.entries(fields) as [keyof PromotionFields, unknown][]) {
    if (value === null || (key === 'planIds' && fields.allPlans)) continue
    Object.assign(body, { [key]: value })
  }
  return body
}

const sameIds = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && [...a].sort().join() === [...b].sort().join()

/** `PATCH` body: only the changed fields (locked money terms never sent while `termsLocked`). */
export function patchBody(p: AdminPromotion, d: PromotionDraft): UpdatePromotionBody {
  const next = draftFields(d)
  const body: UpdatePromotionBody = {}
  if (next.name !== p.name) body.name = next.name
  if (next.code !== p.code) body.code = next.code
  if (next.endsOn !== p.endsOn) body.endsOn = next.endsOn
  if (next.maxRedemptions !== p.maxRedemptions) body.maxRedemptions = next.maxRedemptions
  if (next.allPlans !== p.allPlans) body.allPlans = next.allPlans
  const currentIds = p.plans.map((plan) => plan.id)
  if (!next.allPlans && (p.allPlans || !sameIds(next.planIds, currentIds))) body.planIds = next.planIds
  if (!p.termsLocked) {
    for (const key of LOCKED_TERM_FIELDS) {
      if (next[key] !== p[key]) Object.assign(body, { [key]: next[key] })
    }
  }
  return body
}

/** A failed save → the field it belongs to (or the whole form) and readable text. */
export function promotionSaveError(err: unknown): { field?: DraftField; message: string } {
  if (!(err instanceof ApiError)) return { message: err instanceof Error ? err.message : 'Could not save the promotion.' }
  switch (err.code) {
    case 'PROMOTION_CODE_TAKEN':
      return { field: 'code', message: 'Another promotion already uses this code.' }
    case 'PROMOTION_ENDS_IN_PAST':
      return { field: 'endsOn', message: 'The end date has passed (Bangladesh time). Pick today or later.' }
    case 'PLAN_NOT_AVAILABLE':
      return { field: 'plans', message: 'A chosen plan is no longer active. Pick the plans again.' }
    case 'PROMOTION_INVALID_TERMS':
      return { message: `These terms don't fit the promotion: ${err.message}` }
    case 'PROMOTION_TERMS_LOCKED': {
      const raw = err.details?.fields
      const fields = Array.isArray(raw) ? raw.filter((f): f is LockedTermField => f in lockedFieldLabels) : []
      const names = fields.map((f) => lockedFieldLabels[f]).join(', ')
      return {
        message: `Clients have already claimed this promotion, so its money terms are locked${names ? ` (${names})` : ''}.`,
      }
    }
  }
  if (err.status === 404) return { message: 'This promotion no longer exists.' }
  return { message: err.message }
}
