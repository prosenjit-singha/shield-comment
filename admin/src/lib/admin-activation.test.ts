import { describe, expect, it } from 'vitest'
import {
  activationPricePreview,
  activationTermEnd,
  addDays,
  dhakaToday,
  hasYearlyPrice,
  startDateBounds,
  startDateError,
} from '@/lib/admin-activation'

// 20 Nov 2026, 10:00 in Dhaka.
const NOW = new Date('2026-11-20T04:00:00.000Z')

describe('dhakaToday / addDays / startDateBounds', () => {
  it('uses the Dhaka calendar day (turns at 18:00 UTC)', () => {
    expect(dhakaToday(new Date('2026-11-19T17:59:59.999Z'))).toBe('2026-11-19')
    expect(dhakaToday(new Date('2026-11-19T18:00:00.000Z'))).toBe('2026-11-20')
  })

  it('adds days across months and years', () => {
    expect(addDays('2026-11-20', -31)).toBe('2026-10-20')
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28')
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
    expect(() => addDays('2026-02-30', 1)).toThrow(RangeError)
  })

  it('bounds = today − 31 … today', () => {
    expect(startDateBounds(NOW)).toEqual({ min: '2026-10-20', max: '2026-11-20' })
  })
})

describe('activationTermEnd', () => {
  it('monthly = 00:00 Dhaka + 1 month, clamped to the month end', () => {
    expect(activationTermEnd('2026-11-20', 'month')).toBe('2026-12-19T18:00:00.000Z')
    expect(activationTermEnd('2026-01-31', 'month')).toBe('2026-02-27T18:00:00.000Z')
    expect(activationTermEnd('2028-01-31', 'month')).toBe('2028-02-28T18:00:00.000Z')
    expect(activationTermEnd('2026-12-15', 'month')).toBe('2027-01-14T18:00:00.000Z')
  })

  it('yearly = + 12 months (29 Feb → 28 Feb)', () => {
    expect(activationTermEnd('2026-11-20', 'year')).toBe('2027-11-19T18:00:00.000Z')
    expect(activationTermEnd('2028-02-29', 'year')).toBe('2029-02-27T18:00:00.000Z')
  })

  it('null for a bad date', () => {
    expect(activationTermEnd('2026-02-30', 'month')).toBeNull()
    expect(activationTermEnd('', 'month')).toBeNull()
  })
})

describe('startDateError', () => {
  it('accepts today and earlier days whose term is still running', () => {
    expect(startDateError('2026-11-20', 'month', NOW)).toBeNull()
    expect(startDateError('2026-10-21', 'month', NOW)).toBeNull()
    expect(startDateError('2026-10-20', 'year', NOW)).toBeNull()
  })

  it('rejects empty, future, more than 31 days back and an already-ended term', () => {
    expect(startDateError('', 'month', NOW)).toBe('Pick a start date.')
    expect(startDateError('2026-11-21', 'month', NOW)).toMatch(/future/)
    expect(startDateError('2026-10-19', 'year', NOW)).toMatch(/at most 31 days/)
    // 20 Oct + 1 month = 20 Nov 00:00 Dhaka, already past at 10:00.
    expect(startDateError('2026-10-20', 'month', NOW)).toMatch(/already be over/)
  })
})

describe('activationPricePreview', () => {
  const starter = { monthlyPriceBdt: 999, offerPriceBdt: 499, yearlyMonthlyPriceBdt: 449 }

  it('monthly shows the offer (else the original) per month', () => {
    expect(activationPricePreview(starter, 'month')).toBe('৳499/month')
    expect(activationPricePreview({ ...starter, offerPriceBdt: null }, 'month')).toBe('৳999/month')
  })

  it('yearly shows the per-month price and the yearly charge', () => {
    expect(activationPricePreview(starter, 'year')).toBe('৳449/month · billed ৳5,388 yearly')
    expect(activationPricePreview({ ...starter, yearlyMonthlyPriceBdt: 3599 }, 'year')).toBe(
      '৳3,599/month · billed ৳43,188 yearly',
    )
  })

  it('null for yearly without a yearly price', () => {
    expect(activationPricePreview({ ...starter, yearlyMonthlyPriceBdt: null }, 'year')).toBeNull()
    expect(hasYearlyPrice({ yearlyMonthlyPriceBdt: null })).toBe(false)
    expect(hasYearlyPrice(starter)).toBe(true)
  })
})
