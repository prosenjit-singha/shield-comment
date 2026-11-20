import { keepPreviousData, queryOptions } from '@tanstack/react-query'
import { apiFetch, type ApiError } from '@/lib/api'
import type { ContentFn } from '@/lib/auth-errors'
import { bnNumber, type Language } from '@/lib/language'
import { genericFailure } from '@/lib/meta-messages'
import type { ModerationCategory } from '@/lib/moderation-policy'

/*
 * C4 `/dashboard` data (M6-T8): `GET /api/workspaces/:workspaceId/dashboard/summary?range=` (M6-T5,
 * every member, impersonated ok). Mirrors `backend/src/comments/dto/dashboard-summary.dto.ts`.
 */

/** D10 (a): Dhaka-day presets, default `30d`. */
export const SUMMARY_RANGES = ['7d', '30d', '90d'] as const
export type SummaryRange = (typeof SUMMARY_RANGES)[number]
export const DEFAULT_SUMMARY_RANGE: SummaryRange = '30d'

export interface SummaryDay {
  /** Asia/Dhaka day, `YYYY-MM-DD`. */
  day: string
  scanned: number
  autoHidden: number
}

export interface CategoryCount {
  category: ModerationCategory
  count: number
}

export interface DashboardSummary {
  range: SummaryRange
  kpis: { scanned: number; autoHidden: number; needsReview: number; scamsBlocked: number }
  /** Every day of the range, oldest first, zero-filled. */
  daily: SummaryDay[]
  /** All five categories (Donut). */
  intents: CategoryCount[]
  /** The four non-SAFE categories (Bar). */
  flagged: CategoryCount[]
}

/** `/dashboard` URL search: the default range stays out of the URL. */
export interface DashboardSearch {
  range?: Exclude<SummaryRange, '30d'>
}

/** Keeps `7d` / `90d` only; the key is always returned so a bad `?range=` never reaches the API. */
export function validateDashboardSearch(raw: Record<string, unknown>): DashboardSearch {
  return { range: raw.range === '7d' || raw.range === '90d' ? raw.range : undefined }
}

export function rangeSearch(range: SummaryRange): DashboardSearch {
  return { range: range === '30d' ? undefined : range }
}

export const dashboardSummaryQueryKey = (workspaceId: string, range: SummaryRange) =>
  ['workspace', workspaceId, 'dashboard', 'summary', range] as const

export function dashboardSummaryQueryOptions(workspaceId: string, range: SummaryRange) {
  return queryOptions({
    queryKey: dashboardSummaryQueryKey(workspaceId, range),
    queryFn: () =>
      apiFetch<DashboardSummary>(`/api/workspaces/${encodeURIComponent(workspaceId)}/dashboard/summary?range=${range}`),
    // Keep the current charts on screen (dimmed) while another range loads.
    placeholderData: keepPreviousData,
  })
}

export function dashboardLoadErrorMessage(error: ApiError, content: ContentFn): string {
  if (error.status === 404) return content('This workspace couldn’t be found.', 'এই ওয়ার্কস্পেসটি খুঁজে পাওয়া যায়নি।')
  return genericFailure(error, content)
}

export function categoryLabel(category: ModerationCategory, content: ContentFn): string {
  switch (category) {
    case 'SAFE_INQUIRY':
      return content('Safe inquiry', 'সাধারণ জিজ্ঞাসা')
    case 'COMPETITOR_POACH':
      return content('Competitor poaching', 'প্রতিযোগীর প্রচার')
    case 'SCAM_PHISHING':
      return content('Scam / phishing', 'স্ক্যাম / ফিশিং')
    case 'SPAM_IRRELEVANT':
      return content('Spam', 'স্প্যাম')
    case 'ABUSIVE_TOXIC':
      return content('Abusive', 'গালিগালাজ')
  }
}

const EN_NUMBER = new Intl.NumberFormat('en-BD', { maximumFractionDigits: 0 })

export function formatCount(value: number, language: Language): string {
  return language === 'bn' ? bnNumber(value) : EN_NUMBER.format(value)
}

const DAY_FORMAT: Record<Language, Intl.DateTimeFormat> = {
  en: new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }),
  bn: new Intl.DateTimeFormat('bn-BD', { day: 'numeric', month: 'short', timeZone: 'UTC' }),
}

/** `2026-11-18` → `18 Nov` / `১৮ নভে`. The key is already a Dhaka day, so it is read as UTC midnight. */
export function formatDay(day: string, language: Language): string {
  return DAY_FORMAT[language].format(new Date(`${day}T00:00:00Z`))
}
