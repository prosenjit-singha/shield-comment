import { describe, expect, it } from 'vitest'
import { clientListParams, validateClientsSearch } from '@/lib/admin-clients'

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
