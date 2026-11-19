import { queryOptions } from '@tanstack/react-query'
import type { AiProvider } from '@/lib/admin-ai-settings'
import { apiFetch } from '@/lib/api'

/**
 * `GET /api/admin/system/health` (M2-T10, user decision 2026-11-18). Mirrors the backend's
 * `src/admin/dto/system-health.dto.ts` (`ai` since M5-T13).
 */
export type ProbeStatus = 'up' | 'down'

export interface DependencyProbe {
  status: ProbeStatus
  /** Round trip in ms; `null` only when the probe failed (`down`). */
  latencyMs: number | null
}

export interface SystemProcessInfo {
  uptimeSeconds: number
  startedAt: string
  version: string
  nodeVersion: string
  environment: string
  memory: { rssBytes: number; heapUsedBytes: number; heapTotalBytes: number }
}

export interface QueueStats {
  name: string
  waiting: number
  active: number
  failed: number
}

export interface LatestMigration {
  /** `null` when the DB has a migration this backend build doesn't ship. */
  tag: string | null
  hash: string
  /** Journal timestamp of the migration (Drizzle stores no apply time). */
  createdAt: string
}

export interface MigrationStatus {
  /** `false` when the DB is down or the journal table can't be read. */
  known: boolean
  applied: number
  shipped: number
  pending: number
  latest: LatestMigration | null
}

export interface SystemHealthResponse {
  status: 'ok' | 'degraded'
  checkedAt: string
  database: DependencyProbe
  redis: DependencyProbe
  process: SystemProcessInfo
  queues: QueueStats[]
  migrations: MigrationStatus
  /** AI moderation usage (M5-T13). `null` when the backend couldn't read it (rest unaffected). */
  ai: AiUsageReport | null
}

/** Usage of one provider + model, or a window's total (D14, M5-T13 `AiUsageStats`). */
export interface AiUsageStats {
  /** Classification requests, retries included. */
  calls: number
  failedCalls: number
  /** Failed calls by machine-code kind (`timeout`, `rate_limited`, …); `{}` when none. */
  failuresByKind: Record<string, number>
  inputTokens: number
  outputTokens: number
  /** `null` without calls. */
  avgLatencyMs: number | null
  maxLatencyMs: number | null
  /** List-price estimate, 6 decimals. Per model `null` = no price; total `null` = every model unpriced. */
  estimatedCostUsd: number | null
  /** `estimatedCostUsd` × `usdToBdtRate`, 2 decimals (same `null` rule). */
  estimatedCostBdt: number | null
}

/** USD per 1M tokens. */
export interface AiModelPrice {
  input: number
  output: number
}

export interface AiModelUsage extends AiUsageStats {
  provider: AiProvider
  model: string
  /** `null` = the price table doesn't know this model (its cost is `null`). */
  priceUsdPer1M: AiModelPrice | null
}

/** Dhaka days `from`…`to` (inclusive, `YYYY-MM-DD`). */
export interface AiUsageWindow {
  from: string
  to: string
  /** `unpricedModels` = models with calls but no price, left out of the cost total. */
  totals: AiUsageStats & { unpricedModels: number }
  /** Sorted by provider, then model. */
  models: AiModelUsage[]
}

/** The A6 "AI moderation" card (D14): platform-wide, today + the last 7 Dhaka days. */
export interface AiUsageReport {
  timezone: 'Asia/Dhaka'
  usdToBdtRate: number
  today: AiUsageWindow
  last7Days: AiUsageWindow
}

/**
 * The endpoint queries the DB, and every poll keeps Neon's free compute awake: poll every 30 s
 * at most, and only while the tab is visible (TanStack Query skips interval ticks while
 * `document.visibilityState` is `hidden` when `refetchIntervalInBackground` is false).
 */
export const SYSTEM_POLL_INTERVAL_MS = 30_000

export const adminSystemHealthKey = ['admin', 'system', 'health'] as const

export function systemHealthQueryOptions() {
  return queryOptions({
    queryKey: adminSystemHealthKey,
    queryFn: ({ signal }) => apiFetch<SystemHealthResponse>('/admin/system/health', { signal }),
    staleTime: SYSTEM_POLL_INTERVAL_MS,
    refetchInterval: SYSTEM_POLL_INTERVAL_MS,
    refetchIntervalInBackground: false,
    // Coming back to the tab refreshes once if the data is older than the interval.
    refetchOnWindowFocus: true,
  })
}

/** `3d 4h`, `2h 5m`, `4m 10s`, `12s`: the two largest units. */
export function formatUptime(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds))
  const days = Math.floor(s / 86_400)
  const hours = Math.floor((s % 86_400) / 3600)
  const minutes = Math.floor((s % 3600) / 60)
  const seconds = s % 60
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${minutes}m`
  if (minutes > 0) return `${minutes}m ${seconds}s`
  return `${seconds}s`
}

/** `512 KB`, `86.4 MB`, `1.25 GB` (binary units, as Node reports them). */
export function formatBytes(bytes: number): string {
  const mb = bytes / 1024 / 1024
  if (mb >= 1024) return `${(mb / 1024).toFixed(2)} GB`
  if (mb >= 1) return `${mb.toFixed(1)} MB`
  return `${Math.round(bytes / 1024)} KB`
}

/** `0.42 ms`, `12.3 ms`, `1,204 ms`; `null` (probe failed) → `No response`. */
export function formatLatency(ms: number | null): string {
  if (ms === null) return 'No response'
  if (ms < 10) return `${ms.toFixed(2)} ms`
  if (ms < 100) return `${ms.toFixed(1)} ms`
  return `${Math.round(ms).toLocaleString('en-US')} ms`
}

export type MigrationState = 'unknown' | 'none' | 'pending' | 'ahead' | 'current'

export function migrationState(m: MigrationStatus): MigrationState {
  if (!m.known) return 'unknown'
  if (m.pending > 0) return 'pending'
  if (!m.latest) return 'none'
  if (m.latest.tag === null) return 'ahead'
  return 'current'
}

const dhakaDateTime = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Dhaka',
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
})

const dhakaClock = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Dhaka',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
})

/** `18 Nov 2026, 14:05` in Bangladesh time. */
export function formatDhakaDateTime(iso: string): string {
  return dhakaDateTime.format(new Date(iso))
}

/** `14:05:09` in Bangladesh time (the "last checked" clock). */
export function formatDhakaClock(iso: string): string {
  return dhakaClock.format(new Date(iso))
}

const usdFormats = [2, 4, 6].map(
  (digits) =>
    new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: digits }),
)

/**
 * Estimated USD cost (the API sends 6 decimals): `$12.35` from $1, `$0.0123` from a cent,
 * `$0.000123` below; `null` (no price) → `n/a`.
 */
export function formatUsd(value: number | null): string {
  if (value === null) return 'n/a'
  const abs = Math.abs(value)
  const format = abs >= 1 || abs === 0 ? usdFormats[0]! : abs >= 0.01 ? usdFormats[1]! : usdFormats[2]!
  return format.format(value)
}

const bdtFormat = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

/** `৳1,234.50` (2 decimals); `null` (no price) → `n/a`. */
export function formatBdtAmount(value: number | null): string {
  if (value === null) return 'n/a'
  return `${value < 0 ? '-' : ''}৳${bdtFormat.format(Math.abs(value))}`
}

const compactCount = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 })

/** Token counts: `98,765` in full below 100,000, then `150K`, `1.2M`, `3.4B`. */
export function formatTokens(value: number): string {
  return value < 100_000 ? value.toLocaleString('en-US') : compactCount.format(value)
}

/** Call latency: `850 ms`, `1.2 s`, `12.5 s`; `null` (no calls) → `—`. */
export function formatCallLatency(ms: number | null): string {
  if (ms === null) return '—'
  if (ms < 1000) return `${Math.round(ms)} ms`
  return `${(ms / 1000).toFixed(1)} s`
}

/** Machine-code failure kind → label: `rate_limited` → `Rate limited`. */
export function formatFailureKind(kind: string): string {
  const words = kind.replace(/_/g, ' ').trim()
  return words ? words[0]!.toUpperCase() + words.slice(1) : kind
}

/** Failure kinds, most frequent first (ties by name). */
export function sortedFailures(byKind: Record<string, number>): [string, number][] {
  return Object.entries(byKind)
    .filter(([, n]) => n > 0)
    .sort(([a, x], [b, y]) => y - x || a.localeCompare(b))
}

/** `$0.15 / $0.60` (input / output per 1M tokens); `null` → `n/a`. */
export function formatModelPrice(price: AiModelPrice | null): string {
  if (price === null) return 'n/a'
  return `${formatUsd(price.input)} / ${formatUsd(price.output)}`
}
