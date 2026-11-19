import { describe, expect, it } from 'vitest'
import {
  type ClientSubscription,
  clientListParams,
  commentPercent,
  commentUsage,
  formatDhakaDayMonth,
  subscriptionBadge,
  validateClientsSearch,
} from '@/lib/admin-clients'

describe('validateClientsSearch', () => {
  it('returns every key, undefined when missing (router merges raw search under the result)', () => {
    const search = validateClientsSearch({})
    expect(Object.keys(search).sort()).toEqual(['from', 'page', 'plan', 'q', 'sort', 'status', 'to'])
    expect(Object.values(search).every((v) => v === undefined)).toBe(true)
  })

  it('keeps valid values, including a plan slug or none', () => {
    expect(
      validateClientsSearch({
        q: '  rahim ',
        status: 'SUSPENDED',
        plan: 'growth',
        from: '2026-11-01',
        to: '2026-11-18',
        sort: 'name',
        page: '3',
      }),
    ).toStrictEqual({
      q: 'rahim',
      status: 'SUSPENDED',
      plan: 'growth',
      from: '2026-11-01',
      to: '2026-11-18',
      sort: 'name',
      page: 3,
    })
    expect(validateClientsSearch({ q: 123 }).q).toBe('123') // router JSON-parses `?q=123`
    expect(validateClientsSearch({ plan: 'none' }).plan).toBe('none')
    expect(validateClientsSearch({ plan: 'pro-annual' }).plan).toBe('pro-annual')
  })

  it.each([
    ['Growth'],
    ['growth plan'],
    [''],
    ['-growth'],
    ['x'.repeat(41)],
    [42],
    [['growth', 'pro']],
  ])('drops a malformed plan %j', (plan) => {
    const search = validateClientsSearch({ plan })
    expect('plan' in search).toBe(true)
    expect(search.plan).toBeUndefined()
  })

  it('drops a malformed page instead of letting NaN through', () => {
    for (const page of ['abc', '0', '1', '2.5', -2]) {
      expect(validateClientsSearch({ page }).page).toBeUndefined()
    }
  })
})

describe('clientListParams', () => {
  it('sends plan only when set', () => {
    expect(clientListParams({}).has('plan')).toBe(false)
    expect(clientListParams({ plan: 'none' }).get('plan')).toBe('none')
    expect(clientListParams({ plan: 'starter', page: 2 }).toString()).toBe(
      'plan=starter&sort=newest&skip=20&take=20',
    )
  })
})

describe('subscriptionBadge (PW-T7)', () => {
  const sub = (patch: Partial<ClientSubscription>): ClientSubscription => ({
    status: 'ACTIVE',
    interval: 'month',
    trialEndsAt: null,
    termEndsAt: '2026-12-15T06:00:00.000Z',
    ...patch,
  })

  it('shows the trial end as a Dhaka day', () => {
    expect(subscriptionBadge(sub({ status: 'TRIALING', trialEndsAt: '2026-11-26T06:00:00.000Z' }))).toEqual({
      label: 'Trial ends 26 Nov',
      tone: 'trial',
    })
    // 25 Nov 19:30 UTC is already 26 Nov 01:30 in Dhaka (late-evening UTC edge).
    expect(subscriptionBadge(sub({ status: 'TRIALING', trialEndsAt: '2026-11-25T19:30:00.000Z' })).label).toBe(
      'Trial ends 26 Nov',
    )
    expect(subscriptionBadge(sub({ status: 'TRIALING', trialEndsAt: '2026-11-25T17:59:59.999Z' })).label).toBe(
      'Trial ends 25 Nov',
    )
    // A trial without trialEndsAt falls back to its term end.
    expect(subscriptionBadge(sub({ status: 'TRIALING' })).label).toBe('Trial ends 15 Dec')
  })

  it.each([
    ['ACTIVE', 'Active', 'active'],
    ['EXPIRED', 'Expired', 'ended'],
    ['CANCELED', 'Canceled', 'ended'],
  ] as const)('%s → %s', (status, label, tone) => {
    expect(subscriptionBadge(sub({ status }))).toEqual({ label, tone })
  })

  it('reads No plan without any subscription', () => {
    expect(subscriptionBadge(null)).toEqual({ label: 'No plan', tone: 'none' })
  })

  it('formats Dhaka day + short month', () => {
    expect(formatDhakaDayMonth('2026-12-14T18:00:00.000Z')).toBe('15 Dec')
    expect(formatDhakaDayMonth('2026-12-31T17:59:59.000Z')).toBe('31 Dec')
  })
})

describe('comment usage (PW-T7)', () => {
  it.each([
    [{ used: 0, limit: 500 }, 0],
    [{ used: 125, limit: 500 }, 25],
    [{ used: 500, limit: 500 }, 100],
    [{ used: 900, limit: 500 }, 100],
    [{ used: 0, limit: 0 }, 0],
    [{ used: 3, limit: 0 }, 100],
  ])('commentPercent(%o) = %s', (comments, expected) => {
    expect(commentPercent(comments)).toBe(expected)
  })

  it('labels used / limit and the Dhaka reset day', () => {
    expect(commentUsage({ used: 1234, limit: 2500, resetsAt: '2026-12-14T18:00:00.000Z' })).toEqual({
      kind: 'bar',
      label: '1,234 / 2,500',
      resets: 'resets 15 Dec',
      percent: 49.36,
      over: false,
    })
  })

  it('caps an over-limit bar at 100 % and flags it', () => {
    expect(commentUsage({ used: 2600, limit: 2500, resetsAt: null })).toEqual({
      kind: 'bar',
      label: '2,600 / 2,500',
      resets: null,
      percent: 100,
      over: true,
    })
  })

  it('shows "No active plan" for a 0 limit and "Usage unavailable" for null', () => {
    expect(commentUsage({ used: 0, limit: 0, resetsAt: null })).toEqual({ kind: 'no-plan', label: 'No active plan' })
    expect(commentUsage(null)).toEqual({ kind: 'unavailable', label: 'Usage unavailable' })
  })
})
