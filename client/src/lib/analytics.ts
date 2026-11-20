import { keepPreviousData, queryOptions } from '@tanstack/react-query'
import { ApiError, apiFetch, errorFromResponse } from '@/lib/api'
import type { ContentFn } from '@/lib/auth-errors'
import { UUID, validDay } from '@/lib/comments-feed'
import { type CategoryCount, formatDay } from '@/lib/dashboard-summary'
import type { Language } from '@/lib/language'
import { genericFailure } from '@/lib/meta-messages'

/*
 * C9 `/analytics` data (M6-T12; D11 a, D12 b, D13 a): `GET /api/workspaces/:workspaceId/analytics?from&to&pageId`
 * + the CSV downloads `…/analytics/export.csv` (every plan, ≤ 366 days) and `…/analytics/comments.csv`
 * (Pro `whiteLabelReports`, else 409 `PLAN_FEATURE_UNAVAILABLE`; ≤ 92 days). Every member, impersonated ok.
 * Mirrors `backend/src/comments/dto/analytics.dto.ts`.
 */

export type DailyCommentCounter =
  | 'received'
  | 'edited'
  | 'removed'
  | 'classified'
  | 'safeInquiry'
  | 'competitorPoach'
  | 'scamPhishing'
  | 'spamIrrelevant'
  | 'abusiveToxic'
  | 'ruleMatched'
  | 'hidden'
  | 'unhidden'
  | 'deleted'
  | 'replied'
  | 'skipped'
  | 'failed'

export type AnalyticsCounts = Record<DailyCommentCounter, number> & {
  /** classified + ruleMatched. */
  scanned: number
  /** AUTO hidden + deleted. */
  autoHidden: number
}

export interface AnalyticsBucket extends AnalyticsCounts {
  /** `YYYY-MM-DD` (day) or `YYYY-MM` (month), Asia/Dhaka. */
  bucket: string
}

export type Granularity = 'day' | 'month'

export interface Analytics {
  from: string
  to: string
  granularity: Granularity
  /** The filtered Page; `null` = every Page of the workspace. */
  page: { id: string; name: string } | null
  totals: AnalyticsCounts
  /** Every bucket of the range, oldest first, zero-filled. */
  series: AnalyticsBucket[]
  intents: CategoryCount[]
  flagged: CategoryCount[]
}

/** `/analytics` URL search = the API query (unset keys stay out of the URL; no range = the API's last 30 days). */
export interface AnalyticsSearch {
  /** Inclusive Asia/Dhaka days, `YYYY-MM-DD`, both or neither. */
  from?: string
  to?: string
  /** Our `social_pages.id`. */
  pageId?: string
}

/** Backend caps (`analytics.ts` / `dashboard-range.ts`). */
export const ANALYTICS_MAX_MONTHS = 12
export const MIN_ANALYTICS_DAY = '2020-01-01'
export const DEFAULT_RANGE_DAYS = 30
export type CsvKind = 'daily' | 'comments'
export const CSV_MAX_DAYS: Record<CsvKind, number> = { daily: 366, comments: 92 }

const DAY_MS = 86_400_000
/** Bangladesh is UTC+6 all year. */
const DHAKA_OFFSET_MS = 6 * 60 * 60 * 1000

export const dhakaToday = (now = Date.now()) => new Date(now + DHAKA_OFFSET_MS).toISOString().slice(0, 10)

const monthsSpanned = (from: string, to: string) =>
  (Number(to.slice(0, 4)) - Number(from.slice(0, 4))) * 12 + Number(to.slice(5, 7)) - Number(from.slice(5, 7)) + 1

/** `false` when the API would answer 400 (bad order, before 2020, after today, over 12 calendar months). */
export function isValidRange(from: string, to: string, now = Date.now()): boolean {
  return from <= to && from >= MIN_ANALYTICS_DAY && to <= dhakaToday(now) && monthsSpanned(from, to) <= ANALYTICS_MAX_MONTHS
}

/** Drops anything the API would refuse (400), so a hand-edited URL never breaks the page. */
export function validateAnalyticsSearch(raw: Record<string, unknown>, now = Date.now()): AnalyticsSearch {
  const from = validDay(raw.from)
  const to = validDay(raw.to)
  const range = from && to && isValidRange(from, to, now) ? { from, to } : { from: undefined, to: undefined }
  return { ...range, pageId: typeof raw.pageId === 'string' && UUID.test(raw.pageId) ? raw.pageId : undefined }
}

/** Days in the chosen range, both ends included (no range = the API default). */
export function rangeDays(search: AnalyticsSearch): number {
  if (!search.from || !search.to) return DEFAULT_RANGE_DAYS
  return Math.round((Date.parse(search.to) - Date.parse(search.from)) / DAY_MS) + 1
}

function queryString(search: AnalyticsSearch): string {
  const params = new URLSearchParams()
  for (const key of ['from', 'to', 'pageId'] as const) {
    const value = search[key]
    if (value) params.set(key, value)
  }
  const query = params.toString()
  return query ? `?${query}` : ''
}

const analyticsBase = (workspaceId: string) => `/api/workspaces/${encodeURIComponent(workspaceId)}/analytics`

/** Same-origin CSV link with the page's filters. */
export const csvPath = (workspaceId: string, kind: CsvKind, search: AnalyticsSearch) =>
  `${analyticsBase(workspaceId)}/${kind === 'daily' ? 'export.csv' : 'comments.csv'}${queryString(search)}`

export const analyticsQueryKey = (workspaceId: string, search: AnalyticsSearch) =>
  ['workspace', workspaceId, 'analytics', { from: search.from, to: search.to, pageId: search.pageId }] as const

export function analyticsQueryOptions(workspaceId: string, search: AnalyticsSearch) {
  return queryOptions({
    queryKey: analyticsQueryKey(workspaceId, search),
    queryFn: () => apiFetch<Analytics>(`${analyticsBase(workspaceId)}${queryString(search)}`),
    // Keep the current charts on screen (dimmed) while another range / Page loads.
    placeholderData: keepPreviousData,
  })
}

/**
 * Fetches a CSV and saves it under the server's file name. A plain `<a download>` can't show why a
 * download failed (409 plan, 400 range), so the link's click runs this instead (a `useMutation`).
 */
export async function downloadCsv(path: string): Promise<void> {
  let response: Response
  try {
    response = await fetch(path, { credentials: 'same-origin', headers: { accept: 'text/csv' } })
  } catch {
    throw new ApiError(0, 'Network error')
  }
  if (!response.ok) throw await errorFromResponse(response)
  const blob = await response.blob()
  const filename = /filename="([^"]+)"/.exec(response.headers.get('content-disposition') ?? '')?.[1] ?? 'shieldcomment.csv'
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1_000)
}

export function analyticsLoadErrorMessage(error: ApiError, pageFiltered: boolean, content: ContentFn): string {
  if (error.status === 400) return rangeErrorMessage(content)
  if (error.status === 404) {
    return pageFiltered
      ? content('This Page isn’t in this workspace any more. Pick another Page.', 'এই পেজটি আর এই ওয়ার্কস্পেসে নেই। অন্য একটি পেজ বেছে নিন।')
      : content('This workspace couldn’t be found.', 'এই ওয়ার্কস্পেসটি খুঁজে পাওয়া যায়নি।')
  }
  return genericFailure(error, content)
}

export function rangeErrorMessage(content: ContentFn): string {
  return content(
    'Pick a range of up to 12 months that ends today or earlier.',
    'আজ বা তার আগে শেষ হওয়া সর্বোচ্চ ১২ মাসের একটি সময়সীমা বেছে নিন।',
  )
}

export function csvTooLongMessage(kind: CsvKind, content: ContentFn): string {
  return kind === 'comments'
    ? content('The per-comment file covers up to 92 days. Pick a shorter range.', 'প্রতিটি কমেন্টের ফাইলে সর্বোচ্চ ৯২ দিন থাকে। ছোট সময়সীমা বেছে নিন।')
    : content('The daily file covers up to 366 days. Pick a shorter range.', 'দৈনিক ফাইলে সর্বোচ্চ ৩৬৬ দিন থাকে। ছোট সময়সীমা বেছে নিন।')
}

/** A failed CSV download; `plan` = show the Plans link (409 `PLAN_FEATURE_UNAVAILABLE`). */
export function csvErrorMessage(error: ApiError, kind: CsvKind, pageFiltered: boolean, content: ContentFn): { message: string; plan: boolean } {
  if (error.status === 409 && error.code === 'PLAN_FEATURE_UNAVAILABLE') {
    return {
      message: content(
        'Per-comment downloads are part of the Pro plan. Upgrade to Pro to download them.',
        'প্রতিটি কমেন্টের ফাইল প্রো প্ল্যানে পাওয়া যায়। ডাউনলোড করতে প্রো প্ল্যানে আপগ্রেড করুন।',
      ),
      plan: true,
    }
  }
  if (error.status === 400) return { message: csvTooLongMessage(kind, content), plan: false }
  return { message: analyticsLoadErrorMessage(error, pageFiltered, content), plan: false }
}

const DATE_FORMAT: Record<Language, Intl.DateTimeFormat> = {
  en: new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }),
  bn: new Intl.DateTimeFormat('bn-BD', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }),
}
const MONTH_FORMAT: Record<Language, Intl.DateTimeFormat> = {
  en: new Intl.DateTimeFormat('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' }),
  bn: new Intl.DateTimeFormat('bn-BD', { month: 'short', year: 'numeric', timeZone: 'UTC' }),
}

/** `2026-11-20` → `20 Nov 2026` / `২০ নভে, ২০২৬`. */
export const formatDate = (day: string, language: Language) => DATE_FORMAT[language].format(new Date(`${day}T00:00:00Z`))

/** A series bucket: `18 Nov` (day) or `Nov 2026` (month). */
export function formatBucket(bucket: string, granularity: Granularity, language: Language): string {
  return granularity === 'month' ? MONTH_FORMAT[language].format(new Date(`${bucket}-01T00:00:00Z`)) : formatDay(bucket, language)
}
