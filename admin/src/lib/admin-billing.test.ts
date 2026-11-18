import { describe, expect, it } from 'vitest'
import { formatDhakaTime, transactionListParams, validateBillingSearch } from '@/lib/admin-billing'

describe('admin-billing', () => {
  it('keeps only a whole page > 1 and always returns the page key', () => {
    expect(validateBillingSearch({ page: 3 })).toEqual({ page: 3 })
    expect(validateBillingSearch({ page: '2' })).toEqual({ page: 2 })
    for (const page of [1, 0, -2, 1.5, 'abc', '', undefined]) {
      const search = validateBillingSearch({ page })
      expect(search).toHaveProperty('page', undefined)
    }
  })

  it('maps the page to skip/take (20 per page)', () => {
    expect(transactionListParams({}).toString()).toBe('skip=0&take=20')
    expect(transactionListParams({ page: 3 }).toString()).toBe('skip=40&take=20')
  })

  it('formats the time in Dhaka (UTC+6, 24 h)', () => {
    expect(formatDhakaTime('2026-11-17T20:30:00.000Z')).toBe('02:30')
    expect(formatDhakaTime('2026-11-18T17:59:00.000Z')).toBe('23:59')
  })
})
