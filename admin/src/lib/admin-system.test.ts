import { describe, expect, it } from 'vitest'
import {
  formatBdtAmount,
  formatBytes,
  formatCallLatency,
  formatDhakaClock,
  formatDhakaDateTime,
  formatFailureKind,
  formatLatency,
  formatModelPrice,
  formatTokens,
  formatUptime,
  formatUsd,
  type MigrationStatus,
  migrationState,
  sortedFailures,
  SYSTEM_POLL_INTERVAL_MS,
  systemHealthQueryOptions,
} from '@/lib/admin-system'

describe('systemHealthQueryOptions', () => {
  it('polls every 30–60 s and never in the background', () => {
    const options = systemHealthQueryOptions()
    expect(SYSTEM_POLL_INTERVAL_MS).toBeGreaterThanOrEqual(30_000)
    expect(SYSTEM_POLL_INTERVAL_MS).toBeLessThanOrEqual(60_000)
    expect(options.refetchInterval).toBe(SYSTEM_POLL_INTERVAL_MS)
    expect(options.refetchIntervalInBackground).toBe(false)
    expect(options.staleTime).toBe(SYSTEM_POLL_INTERVAL_MS)
  })
})

describe('formatters', () => {
  it.each([
    [0, '0s'],
    [59.9, '59s'],
    [250, '4m 10s'],
    [7500, '2h 5m'],
    [3 * 86_400 + 4 * 3600 + 59, '3d 4h'],
  ])('formatUptime(%s) = %s', (s, expected) => {
    expect(formatUptime(s)).toBe(expected)
  })

  it.each([
    [512 * 1024, '512 KB'],
    [86.4 * 1024 * 1024, '86.4 MB'],
    [1.25 * 1024 ** 3, '1.25 GB'],
  ])('formatBytes(%s) = %s', (b, expected) => {
    expect(formatBytes(b)).toBe(expected)
  })

  it.each([
    [0.4231, '0.42 ms'],
    [12.34, '12.3 ms'],
    [1204.4, '1,204 ms'],
    [null, 'No response'],
  ])('formatLatency(%s) = %s', (ms, expected) => {
    expect(formatLatency(ms)).toBe(expected)
  })

  it('formats in Bangladesh time', () => {
    expect(formatDhakaClock('2026-11-18T08:05:09.000Z')).toBe('14:05:09')
    expect(formatDhakaDateTime('2026-11-17T20:30:00.000Z')).toBe('18 Nov 2026, 02:30')
  })
})

describe('migrationState', () => {
  const base: MigrationStatus = {
    known: true,
    applied: 6,
    shipped: 6,
    pending: 0,
    latest: { tag: '0005_support_tickets', hash: 'a'.repeat(64), createdAt: '2026-11-18T00:00:00.000Z' },
  }
  it.each<[string, MigrationStatus, string]>([
    ['current', base, 'current'],
    ['pending', { ...base, applied: 5, pending: 1 }, 'pending'],
    ['ahead', { ...base, latest: { ...base.latest!, tag: null } }, 'ahead'],
    ['none', { ...base, applied: 0, shipped: 0, latest: null }, 'none'],
    ['unknown', { known: false, applied: 0, shipped: 0, pending: 0, latest: null }, 'unknown'],
  ])('%s', (_label, m, expected) => {
    expect(migrationState(m)).toBe(expected)
  })
})

describe('AI usage formatters', () => {
  it.each<[number | null, string]>([
    [null, 'n/a'],
    [0, '$0.00'],
    [0.000001, '$0.000001'],
    [0.000123, '$0.000123'],
    [0.00999, '$0.00999'],
    [0.072861, '$0.0729'],
    [0.5, '$0.50'],
    [1.524, '$1.52'],
    [1234.5, '$1,234.50'],
  ])('formatUsd(%s) = %s', (v, expected) => {
    expect(formatUsd(v)).toBe(expected)
  })

  it.each<[number | null, string]>([
    [null, 'n/a'],
    [0, '৳0.00'],
    [8.89, '৳8.89'],
    [1234.5, '৳1,234.50'],
  ])('formatBdtAmount(%s) = %s', (v, expected) => {
    expect(formatBdtAmount(v)).toBe(expected)
  })

  it.each([
    [0, '0'],
    [98_765, '98,765'],
    [150_000, '150K'],
    [1_234_567, '1.2M'],
    [3_400_000_000, '3.4B'],
  ])('formatTokens(%s) = %s', (v, expected) => {
    expect(formatTokens(v)).toBe(expected)
  })

  it.each<[number | null, string]>([
    [null, '—'],
    [842.4, '842 ms'],
    [1200, '1.2 s'],
    [12_480, '12.5 s'],
  ])('formatCallLatency(%s) = %s', (v, expected) => {
    expect(formatCallLatency(v)).toBe(expected)
  })

  it('labels failure kinds and sorts them by count', () => {
    expect(formatFailureKind('rate_limited')).toBe('Rate limited')
    expect(formatFailureKind('timeout')).toBe('Timeout')
    expect(sortedFailures({ timeout: 2, auth: 2, rate_limited: 5, zero: 0 })).toEqual([
      ['rate_limited', 5],
      ['auth', 2],
      ['timeout', 2],
    ])
  })

  it('formats model prices per 1M tokens', () => {
    expect(formatModelPrice({ input: 0.4, output: 1.6 })).toBe('$0.40 / $1.60')
    expect(formatModelPrice({ input: 0.075, output: 0.3 })).toBe('$0.075 / $0.30')
    expect(formatModelPrice(null)).toBe('n/a')
  })
})
