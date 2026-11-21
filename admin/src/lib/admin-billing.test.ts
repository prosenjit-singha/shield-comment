import { describe, expect, it } from 'vitest'
import {
  eventListParams,
  formatDhakaTime,
  outcomeLabel,
  promotionMonths,
  transactionListParams,
  validateBillingSearch,
} from '@/lib/admin-billing'

const keys = ['tab', 'status', 'gateway', 'q', 'from', 'to', 'page']

describe('admin-billing', () => {
  it('keeps only a whole page > 1 and always returns every key', () => {
    expect(validateBillingSearch({ page: 3 })).toEqual({ page: 3 })
    expect(validateBillingSearch({ page: '2' })).toEqual({ page: 2 })
    for (const page of [1, 0, -2, 1.5, 'abc', '', undefined]) {
      const search = validateBillingSearch({ page })
      expect(search).toHaveProperty('page', undefined)
      expect(Object.keys(search).sort()).toEqual([...keys].sort())
    }
  })

  it('validates the filters', () => {
    expect(
      validateBillingSearch({ tab: 'failed', status: 'PAID', gateway: ' bKash ', q: 123, from: '2026-11-01', to: '2026-11-18' }),
    ).toEqual({ tab: 'failed', status: 'PAID', gateway: 'bKash', q: '123', from: '2026-11-01', to: '2026-11-18' })
    expect(
      validateBillingSearch({ tab: 'x', status: 'paid', gateway: 'x'.repeat(41), q: ' ', from: '2026-02-30', to: '2026-1-1' }),
    ).toEqual({})
    expect(validateBillingSearch({ from: '2026-11-18', to: '2026-11-01' })).toEqual({ from: '2026-11-18' })
  })

  it('maps filters and page to the API query (20 per page)', () => {
    expect(transactionListParams({}).toString()).toBe('skip=0&take=20')
    expect(transactionListParams({ page: 3, status: 'PAID', q: 'acme', tab: 'failed' }).toString()).toBe(
      'status=PAID&q=acme&skip=40&take=20',
    )
    expect(eventListParams(2).toString()).toBe('outcome=failed&skip=20&take=20')
  })

  it('labels outcomes and promotion months', () => {
    expect(outcomeLabel('PAID_DUPLICATE_CLAIM')).toBe('Paid, promotion already claimed')
    expect(outcomeLabel('ACTIVATION_FAILED')).toBe('Activation failed (retry)')
    expect(outcomeLabel('SOMETHING_NEW')).toBe('SOMETHING_NEW')
    expect(promotionMonths(null)).toBeNull()
    expect(promotionMonths({ from: 2, to: 2, of: 6 })).toBe('Month 2 of 6')
    expect(promotionMonths({ from: 1, to: 3, of: 6 })).toBe('Months 1–3 of 6')
  })

  it('formats the time in Dhaka (UTC+6, 24 h)', () => {
    expect(formatDhakaTime('2026-11-17T20:30:00.000Z')).toBe('02:30')
    expect(formatDhakaTime('2026-11-18T17:59:00.000Z')).toBe('23:59')
  })
})
