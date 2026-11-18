import { queryOptions } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'

/**
 * `GET /api/admin/system/health` (M2-T10, user decision 2026-11-18). Mirrors the backend's
 * `src/admin/dto/system-health.dto.ts`. `queues` is `[]` until the BullMQ moderation queues exist.
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
