import { keepPreviousData, queryOptions } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'

/** `GET /api/admin/clients` item (M1-T1 / M2-T3 / M2-T12b / PW-T6b plan, subscription + comments). */
export type ClientStatus = 'ACTIVE' | 'SUSPENDED'
export interface ClientOwner {
  id: string
  email: string
  name: string
}
/** The account's **live** plan (a trial counts as Starter); `null` = no live plan. */
export interface ClientPlan {
  id: string
  slug: string
  name: string
}
export type SubscriptionStatus = 'TRIALING' | 'ACTIVE' | 'EXPIRED' | 'CANCELED'
export type SubscriptionInterval = 'month' | 'year'
/**
 * The account's subscription (backend `ClientSubscription`, PW-T6b): live TRIALING / ACTIVE, or
 * the latest one's EXPIRED / CANCELED. `null` = never subscribed or no billing account.
 */
export interface ClientSubscription {
  status: SubscriptionStatus
  interval: SubscriptionInterval
  /** Set for a trial (kept after it ended). */
  trialEndsAt: string | null
  /** End of the current (or ended) term. */
  termEndsAt: string
}
/**
 * Monthly comments of the account's wallet this period (pooled across its workspaces, PW-D1):
 * `used` may pass `limit` after an admin lowers it. No live plan → `{ used: 0, limit: 0, resetsAt: null }`.
 */
export interface ClientComments {
  used: number
  limit: number
  /** Next reset (a trial: its end); `null` without a live plan. */
  resetsAt: string | null
}
export interface AdminClient {
  id: string
  name: string
  slug: string
  status: ClientStatus
  createdAt: string
  plan: ClientPlan | null
  subscription: ClientSubscription | null
  /** `null` when the backend couldn't read the wallet ("Usage unavailable"). */
  comments: ClientComments | null
  owner: ClientOwner | null
  memberCount: number
}
export interface ClientList {
  items: AdminClient[]
  total: number
  skip: number
  take: number
}

export const CLIENT_SORTS = ['newest', 'oldest', 'name'] as const
export type ClientSort = (typeof CLIENT_SORTS)[number]
export const CLIENT_STATUSES: readonly ClientStatus[] = ['ACTIVE', 'SUSPENDED']
export const CLIENTS_PAGE_SIZE = 20
export const REASON_MAX = 500

/** `?plan=` value for clients without a live plan (the backend's `plan=none`: none, ended or no account). */
export const NO_PLAN = 'none'
/** A plan slug (backend `plans_slug_format`, ≤ 40) or `none`. */
const PLAN_FILTER = /^[a-z0-9]+(-[a-z0-9]+)*$/

/**
 * `/admin/clients` URL search params. Defaults are left out of the URL (`undefined`):
 * no search, all statuses, any plan, newest first, page 1. `from`/`to` are Dhaka calendar days
 * (`YYYY-MM-DD`); `plan` is a plan slug or `none`.
 */
export interface ClientsSearch {
  q?: string
  status?: ClientStatus
  plan?: string
  from?: string
  to?: string
  sort?: Exclude<ClientSort, 'newest'>
  page?: number
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/

function isPlanFilter(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 40 && PLAN_FILTER.test(value)
}

function isValidDay(value: unknown): value is string {
  return typeof value === 'string' && DATE_ONLY.test(value) && !Number.isNaN(Date.parse(value))
}

/**
 * `validateSearch` for the route: drops anything malformed instead of throwing. Every key is
 * returned (`undefined` when missing or malformed): TanStack Router merges the raw search under
 * this result, so an omitted key would let a malformed value through (router gotcha, MEMORY).
 */
export function validateClientsSearch(raw: Record<string, unknown>): ClientsSearch {
  const page = typeof raw.page === 'number' ? raw.page : Number(raw.page)
  // The router JSON-parses search values, so a hand-typed `?q=123` arrives as a number.
  const q = typeof raw.q === 'number' && Number.isFinite(raw.q) ? String(raw.q) : raw.q
  return {
    q: typeof q === 'string' && q.trim() ? q.trim().slice(0, 100) : undefined,
    status: raw.status === 'ACTIVE' || raw.status === 'SUSPENDED' ? raw.status : undefined,
    plan: isPlanFilter(raw.plan) ? raw.plan : undefined,
    from: isValidDay(raw.from) ? raw.from : undefined,
    to: isValidDay(raw.to) ? raw.to : undefined,
    sort: raw.sort === 'oldest' || raw.sort === 'name' ? raw.sort : undefined,
    page: Number.isInteger(page) && page > 1 ? page : undefined,
  }
}

/** Bangladesh has no DST: a Dhaka day is always `+06:00`. */
const DHAKA_OFFSET = '+06:00'

/**
 * Query string for the API. Date filters are whole Dhaka days: the backend reads offset date-times
 * as instants and treats `createdTo` as inclusive (`< createdTo + 1 ms`).
 */
export function clientListParams(search: ClientsSearch): URLSearchParams {
  const params = new URLSearchParams()
  if (search.q) params.set('q', search.q)
  if (search.status) params.set('status', search.status)
  if (search.plan) params.set('plan', search.plan)
  if (search.from) params.set('createdFrom', `${search.from}T00:00:00${DHAKA_OFFSET}`)
  if (search.to) params.set('createdTo', `${search.to}T23:59:59.999${DHAKA_OFFSET}`)
  params.set('sort', search.sort ?? 'newest')
  params.set('skip', String(((search.page ?? 1) - 1) * CLIENTS_PAGE_SIZE))
  params.set('take', String(CLIENTS_PAGE_SIZE))
  return params
}

export const adminClientsKey = ['admin', 'clients'] as const

export function clientsQueryOptions(search: ClientsSearch) {
  const params = clientListParams(search)
  return queryOptions({
    queryKey: [...adminClientsKey, 'list', params.toString()] as const,
    queryFn: ({ signal }) => apiFetch<ClientList>(`/admin/clients?${params.toString()}`, { signal }),
    // Keep the previous page on screen while the next filter/page loads.
    placeholderData: keepPreviousData,
  })
}

export function updateClientStatus(input: { id: string; status: ClientStatus; reason: string }) {
  return apiFetch<{ client: AdminClient; changed: boolean }>(
    `/admin/clients/${encodeURIComponent(input.id)}/status`,
    { method: 'PATCH', body: JSON.stringify({ status: input.status, reason: input.reason }) },
  )
}

export function impersonateClient(workspaceId: string) {
  return apiFetch<{ token: string; redirectUrl: string }>(
    `/admin/clients/${encodeURIComponent(workspaceId)}/impersonate`,
    { method: 'POST' },
  )
}

/** Trimmed reason → error text, or `null` when valid (backend: required, trimmed, 1–500). */
export function reasonError(reason: string): string | null {
  const trimmed = reason.trim()
  if (!trimmed) return 'A reason is required.'
  if (trimmed.length > REASON_MAX) return `Keep the reason to ${REASON_MAX} characters or fewer.`
  return null
}

const dhakaDate = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Dhaka',
  day: 'numeric',
  month: 'short',
  year: 'numeric',
})

export function formatDhakaDate(iso: string): string {
  return dhakaDate.format(new Date(iso))
}

const dhakaDayMonth = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Dhaka',
  day: 'numeric',
  month: 'short',
})

/** `2026-11-26T18:30:00Z` → `27 Nov` (the Dhaka calendar day, no year). */
export function formatDhakaDayMonth(iso: string): string {
  return dhakaDayMonth.format(new Date(iso))
}

export const subscriptionIntervalLabels: Record<SubscriptionInterval, string> = {
  month: 'Monthly',
  year: 'Yearly',
}

export type SubscriptionTone = 'trial' | 'active' | 'ended' | 'none'

export interface SubscriptionBadge {
  label: string
  tone: SubscriptionTone
}

/**
 * Status badge of the clients list (plan §3.7): `Trial ends 26 Nov` (Dhaka day), `Active`,
 * `Expired`, `Canceled`, or `No plan` when the account never subscribed.
 */
export function subscriptionBadge(subscription: ClientSubscription | null): SubscriptionBadge {
  if (!subscription) return { label: 'No plan', tone: 'none' }
  switch (subscription.status) {
    case 'TRIALING':
      return {
        label: `Trial ends ${formatDhakaDayMonth(subscription.trialEndsAt ?? subscription.termEndsAt)}`,
        tone: 'trial',
      }
    case 'ACTIVE':
      return { label: 'Active', tone: 'active' }
    case 'EXPIRED':
      return { label: 'Expired', tone: 'ended' }
    case 'CANCELED':
      return { label: 'Canceled', tone: 'ended' }
  }
}

/** Bar fill 0–100 (%): `used / limit`, capped at 100; limit 0 → 100 when anything was used, else 0. */
export function commentPercent({ used, limit }: Pick<ClientComments, 'used' | 'limit'>): number {
  if (limit <= 0) return used > 0 ? 100 : 0
  return Math.min(100, Math.max(0, (used / limit) * 100))
}

const commentCount = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 })

export type CommentUsage =
  | { kind: 'unavailable'; label: string }
  | { kind: 'no-plan'; label: string }
  | { kind: 'bar'; label: string; resets: string | null; percent: number; over: boolean }

/**
 * Comments column (plan §3.7): `1,234 / 2,500` + `resets 15 Dec` (Dhaka day) with the bar percent;
 * `null` → "Usage unavailable"; limit 0 (no live plan) → "No active plan" instead of a bar.
 */
export function commentUsage(comments: ClientComments | null): CommentUsage {
  if (!comments) return { kind: 'unavailable', label: 'Usage unavailable' }
  if (comments.limit <= 0) return { kind: 'no-plan', label: 'No active plan' }
  return {
    kind: 'bar',
    label: `${commentCount.format(comments.used)} / ${commentCount.format(comments.limit)}`,
    resets: comments.resetsAt ? `resets ${formatDhakaDayMonth(comments.resetsAt)}` : null,
    percent: commentPercent(comments),
    over: comments.used >= comments.limit,
  }
}
