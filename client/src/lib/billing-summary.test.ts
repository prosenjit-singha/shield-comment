import { QueryClient } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  billingSummaryQueryKey,
  billingSummaryQueryOptions,
  dhakaDaysUntil,
  planBanner,
  type BillingSummary,
  type BillingSummaryStatus,
} from '@/lib/billing-summary'
import { formatDhakaDayMonth } from '@/lib/data-deletion'

function summary(overrides: Partial<BillingSummary> = {}): BillingSummary {
  return {
    plan: { slug: 'starter', name: 'Starter' },
    interval: null,
    status: 'TRIALING',
    // 27 Nov 2026, 15:00 in Bangladesh.
    trialEndsAt: '2026-11-27T09:00:00.000Z',
    termEndsAt: '2026-11-27T09:00:00.000Z',
    comments: { used: 12, limit: 300, resetsAt: '2026-11-27T09:00:00.000Z' },
    workspaces: { used: 1, limit: 1 },
    pages: { used: 0, limit: 1 },
    ...overrides,
  }
}

const at = (iso: string) => Date.parse(iso)

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('billing summary query', () => {
  it('uses a workspace-scoped key and GETs the summary', async () => {
    expect(billingSummaryQueryKey('w 1')).toEqual(['workspace', 'w 1', 'billing', 'summary'])
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(summary()), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const options = billingSummaryQueryOptions('w 1')
    expect(options.queryKey).toEqual(['workspace', 'w 1', 'billing', 'summary'])
    await expect(new QueryClient().fetchQuery(options)).resolves.toEqual(summary())
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [path, init] = fetchMock.mock.calls[0]!
    expect(path).toBe('/api/workspaces/w%201/billing/summary')
    expect(init?.method).toBe('GET')
  })
})

describe('dhakaDaysUntil', () => {
  const end = '2026-11-27T09:00:00.000Z' // 27 Nov, 15:00 Dhaka

  it('counts Bangladesh calendar days (UTC+6), not 24-hour blocks', () => {
    expect(dhakaDaysUntil(end, at('2026-11-20T09:01:00.000Z'))).toBe(7) // 20 Nov 15:01
    expect(dhakaDaysUntil(end, at('2026-11-20T17:59:59.999Z'))).toBe(7) // 20 Nov 23:59:59 Dhaka
    expect(dhakaDaysUntil(end, at('2026-11-20T18:00:00.000Z'))).toBe(6) // 21 Nov 00:00 Dhaka: the day turned
    expect(dhakaDaysUntil(end, at('2026-11-21T00:30:00.000Z'))).toBe(6) // UTC midnight is not the boundary
    expect(dhakaDaysUntil(end, at('2026-11-26T17:59:00.000Z'))).toBe(1) // 26 Nov 23:59, ~15 h left
    expect(dhakaDaysUntil(end, at('2026-11-26T18:00:00.000Z'))).toBe(0) // the last day
  })

  it('returns null for an unreadable date', () => {
    expect(dhakaDaysUntil('soon', at('2026-11-20T09:00:00.000Z'))).toBeNull()
  })
})

describe('planBanner', () => {
  it('TRIALING → trial with the Bangladesh days left, rounded up', () => {
    expect(planBanner(summary(), at('2026-11-20T09:01:00.000Z'))).toEqual({ kind: 'trial', daysLeft: 7, endsToday: false })
    expect(planBanner(summary(), at('2026-11-21T00:00:00.000Z'))).toEqual({ kind: 'trial', daysLeft: 6, endsToday: false })
    // 15 hours left on the evening before: still "1 day", never 0.
    expect(planBanner(summary(), at('2026-11-26T17:59:00.000Z'))).toEqual({ kind: 'trial', daysLeft: 1, endsToday: false })
  })

  it('TRIALING on its last Bangladesh day → ends today, daysLeft never below 1', () => {
    expect(planBanner(summary(), at('2026-11-26T18:00:00.000Z'))).toEqual({ kind: 'trial', daysLeft: 1, endsToday: true })
    // A client clock past the end (the server still says TRIALING) stays "today".
    expect(planBanner(summary(), at('2026-11-28T09:00:00.000Z'))).toEqual({ kind: 'trial', daysLeft: 1, endsToday: true })
  })

  it('TRIALING falls back to termEndsAt, and shows nothing without a readable end', () => {
    const now = at('2026-11-20T09:01:00.000Z')
    expect(planBanner(summary({ trialEndsAt: null }), now)).toEqual({ kind: 'trial', daysLeft: 7, endsToday: false })
    expect(planBanner(summary({ trialEndsAt: null, termEndsAt: null }), now)).toBeNull()
    expect(planBanner(summary({ trialEndsAt: 'soon' }), now)).toBeNull()
  })

  it('ACTIVE with comments left → no banner', () => {
    const active = summary({
      status: 'ACTIVE',
      interval: 'month',
      trialEndsAt: null,
      comments: { used: 2499, limit: 2500, resetsAt: null },
    })
    expect(planBanner(active, at('2026-11-20T09:00:00.000Z'))).toBeNull()
  })

  it.each(['EXPIRED', 'CANCELED', 'NONE'] as const satisfies readonly BillingSummaryStatus[])('%s → paused', (status) => {
    const ended = summary({
      status,
      comments: { used: 0, limit: 0, resetsAt: null },
      plan: status === 'NONE' ? null : { slug: 'starter', name: 'Starter' },
    })
    expect(planBanner(ended, at('2026-11-30T09:00:00.000Z'))).toEqual({ kind: 'paused' })
  })

  it('a used-up comment wallet on a live plan → limit_reached (before the trial countdown)', () => {
    const now = at('2026-11-20T09:00:00.000Z')
    const resetsAt = '2026-12-14T18:00:00.000Z'
    expect(planBanner(summary({ status: 'ACTIVE', comments: { used: 2500, limit: 2500, resetsAt } }), now)).toEqual({
      kind: 'limit_reached',
      trial: false,
      resetsAt,
    })
    expect(planBanner(summary({ status: 'ACTIVE', comments: { used: 2600, limit: 2500, resetsAt: null } }), now)).toEqual({
      kind: 'limit_reached',
      trial: false,
      resetsAt: null,
    })
    expect(planBanner(summary({ comments: { used: 300, limit: 300, resetsAt: '2026-11-27T09:00:00.000Z' } }), now)).toEqual({
      kind: 'limit_reached',
      trial: true,
      resetsAt: '2026-11-27T09:00:00.000Z',
    })
    // A 0 limit is not "reached" (no wallet yet).
    expect(planBanner(summary({ status: 'ACTIVE', comments: { used: 0, limit: 0, resetsAt: null } }), now)).toBeNull()
  })
})

describe('formatDhakaDayMonth', () => {
  it('formats the Bangladesh day in en and bn (Bangla digits)', () => {
    expect(formatDhakaDayMonth('2026-12-14T18:00:00.000Z', 'en')).toBe('15 Dec')
    expect(formatDhakaDayMonth('2026-12-14T17:59:00.000Z', 'en')).toBe('14 Dec')
    expect(formatDhakaDayMonth('2026-12-14T18:00:00.000Z', 'bn')).toBe('১৫ ডিসেম্বর')
    expect(formatDhakaDayMonth('soon', 'en')).toBe('soon')
  })
})
