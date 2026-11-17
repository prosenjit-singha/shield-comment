import { keepPreviousData, queryOptions } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'

/*
 * `GET /api/admin/dashboard/stats` (M2-T5). Mirrors `DashboardStatsResponse` in
 * `backend/src/admin/dto/dashboard-stats.dto.ts`. Placeholders are `0` / `[]`, never `null`:
 * plan tiers + gateways until M2-T11 / Module 8, MRR + comments until those exist, open tickets
 * until M2-T7.
 */

export const DASHBOARD_PRESETS = ['7d', '30d', '90d', '12m'] as const
export type DashboardPreset = (typeof DASHBOARD_PRESETS)[number]
export type DashboardRangeName = DashboardPreset | 'custom'
export type Granularity = 'day' | 'month'

export interface DashboardKpis {
  activeClients: number
  mrrBdt: number
  commentsScanned: number
  openTickets: number
}
export interface GrowthPoint {
  /** `YYYY-MM-DD` (day) or `YYYY-MM` (month), Asia/Dhaka. */
  bucket: string
  newClients: number
  totalClients: number
  mrrBdt: number
}
export interface CommentsPoint {
  bucket: string
  scanned: number
  blocked: number
}
export interface PlanTierSlice {
  tier: string
  clients: number
}
export interface GatewaySlice {
  gateway: string
  amountBdt: number
  transactions: number
}
export interface DashboardStatsResponse {
  range: DashboardRangeName
  granularity: Granularity
  timezone: 'Asia/Dhaka'
  /** First Dhaka day of the range, inclusive. */
  from: string
  /** Last Dhaka day of the range, inclusive. */
  to: string
  kpis: DashboardKpis
  series: {
    growth: GrowthPoint[]
    comments: CommentsPoint[]
    planTiers: PlanTierSlice[]
    gateways: GatewaySlice[]
  }
}

// ---------------------------------------------------------------------------------------------
// Range rules (same as backend `resolveDashboardRange`).

export const DEFAULT_PRESET: DashboardPreset = '30d'
export const MIN_DASHBOARD_DATE = '2020-01-01'
export const MAX_SPAN_MONTHS = 24
const DAY_MS = 86_400_000
/** Bangladesh has no DST: Dhaka is always UTC+6. */
const DHAKA_OFFSET_MS = 6 * 3_600_000
const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/

/** Today's date in Dhaka (`YYYY-MM-DD`), whatever the browser's timezone. */
export function dhakaToday(now: Date = new Date()): string {
  return new Date(now.getTime() + DHAKA_OFFSET_MS).toISOString().slice(0, 10)
}

/** `YYYY-MM-DD` that is a real calendar date (no `2026-02-30`). */
export function isDateKey(value: unknown): value is string {
  if (typeof value !== 'string' || !DATE_KEY.test(value)) return false
  const t = Date.parse(`${value}T00:00:00Z`)
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === value
}

/** Shift a date key by whole days (UTC arithmetic on the key itself, no local timezone). */
export function addDays(key: string, days: number): string {
  return new Date(Date.parse(`${key}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10)
}

function monthsSpanned(from: string, to: string): number {
  const [fy, fm] = from.split('-').map(Number) as [number, number]
  const [ty, tm] = to.split('-').map(Number) as [number, number]
  return (ty - fy) * 12 + (tm - fm) + 1
}

/** Why a custom range would be refused by the API, or `null` when it is valid. */
export function customRangeError(from: string, to: string, today = dhakaToday()): string | null {
  if (!from || !to) return 'Pick both a start and an end date.'
  if (!isDateKey(from) || !isDateKey(to)) return 'Use real calendar dates.'
  if (from > to) return 'The start date must be on or before the end date.'
  if (from < MIN_DASHBOARD_DATE) return 'The start date can’t be before 1 Jan 2020.'
  if (to > today) return 'The end date can’t be in the future.'
  if (monthsSpanned(from, to) > MAX_SPAN_MONTHS)
    return `A custom range can cover at most ${MAX_SPAN_MONTHS} months.`
  return null
}

// ---------------------------------------------------------------------------------------------
// URL search ↔ API params.

/**
 * `/admin/dashboard` URL search. Defaults stay out of the URL: no params = last 30 days.
 * A custom range is `from` + `to` (both, Dhaka dates) and wins over `range`.
 */
export interface DashboardSearch {
  range?: Exclude<DashboardPreset, '30d'>
  from?: string
  to?: string
}

/** `validateSearch`: keeps well-formed values only. Cross-field rules are the API's (400). */
export function validateDashboardSearch(raw: Record<string, unknown>): DashboardSearch {
  if (isDateKey(raw.from) && isDateKey(raw.to)) return { from: raw.from, to: raw.to }
  if (raw.range === '7d' || raw.range === '90d' || raw.range === '12m') return { range: raw.range }
  return {}
}

export type DashboardParams = { range: DashboardPreset } | { from: string; to: string }

export function dashboardParams(search: DashboardSearch): DashboardParams {
  if (search.from && search.to) return { from: search.from, to: search.to }
  return { range: search.range ?? DEFAULT_PRESET }
}

/** Which picker option is selected for a URL search. */
export function selectedRange(search: DashboardSearch): DashboardPreset | 'custom' {
  const params = dashboardParams(search)
  return 'range' in params ? params.range : 'custom'
}

/** URL search for a preset (the default one is left out). */
export function presetSearch(preset: DashboardPreset): DashboardSearch {
  return preset === '30d' ? {} : { range: preset }
}

export const adminDashboardKey = ['admin', 'dashboard'] as const

export function dashboardQueryOptions(search: DashboardSearch) {
  const params = dashboardParams(search)
  const query = new URLSearchParams(params).toString()
  return queryOptions({
    queryKey: [...adminDashboardKey, params] as const,
    queryFn: ({ signal }) => apiFetch<DashboardStatsResponse>(`/admin/dashboard/stats?${query}`, { signal }),
    // Keep the current charts on screen (dimmed) while another range loads.
    placeholderData: keepPreviousData,
  })
}

// ---------------------------------------------------------------------------------------------
// Formatters. Bucket keys are already Dhaka dates, so they are read as strings, never through
// `new Date()` in the browser's timezone.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const MONTHS_LONG = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
]

function splitKey(key: string): { year: string; month: number; day?: number } {
  const [year = '', month = '1', day] = key.split('-')
  return { year, month: Number(month) - 1, day: day === undefined ? undefined : Number(day) }
}

/** Axis tick: `18 Nov` (day) or `Nov ’26` (month). */
export function formatBucketTick(key: string): string {
  const { year, month, day } = splitKey(key)
  if (day !== undefined) return `${day} ${MONTHS[month]}`
  return `${MONTHS[month]} ’${year.slice(2)}`
}

/** Tooltip title: `18 Nov 2026` (day) or `November 2026` (month). */
export function formatBucketLabel(key: string): string {
  const { year, month, day } = splitKey(key)
  if (day !== undefined) return `${day} ${MONTHS[month]} ${year}`
  return `${MONTHS_LONG[month]} ${year}`
}

/** `1 Nov – 18 Nov 2026`, `15 Dec 2025 – 18 Nov 2026`, or `18 Nov 2026` for one day. */
export function formatRangeLabel(from: string, to: string): string {
  if (from === to) return formatBucketLabel(to)
  const f = splitKey(from)
  const start = f.year === splitKey(to).year ? `${f.day} ${MONTHS[f.month]}` : formatBucketLabel(from)
  return `${start} – ${formatBucketLabel(to)}`
}

const countFormat = new Intl.NumberFormat('en-BD', { maximumFractionDigits: 0 })
const compactFormat = new Intl.NumberFormat('en-BD', { notation: 'compact', maximumFractionDigits: 1 })

/** Whole number with `en-BD` grouping: `12,345`. */
export function formatCount(value: number): string {
  return countFormat.format(value)
}

/** Taka amount: `৳12,345` (whole taka, `en-BD` grouping). */
export function formatBdt(value: number): string {
  const sign = value < 0 ? '-' : ''
  return `${sign}৳${countFormat.format(Math.abs(value))}`
}

/** Short taka amount for axis ticks: `৳950`, `৳12K`, `৳1.2M`. */
export function formatBdtCompact(value: number): string {
  const sign = value < 0 ? '-' : ''
  return `${sign}৳${compactFormat.format(Math.abs(value))}`
}
