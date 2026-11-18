import { describe, expect, it } from 'vitest'
import {
  addDays,
  customRangeError,
  dashboardParams,
  dashboardQueryOptions,
  dhakaToday,
  formatBdt,
  formatBdtCompact,
  formatBucketLabel,
  formatBucketTick,
  formatCount,
  formatRangeLabel,
  isDateKey,
  presetSearch,
  selectedRange,
  validateDashboardSearch,
} from './admin-dashboard'

describe('bucket label formatters (read the Dhaka key as a string)', () => {
  it('formats day keys', () => {
    expect(formatBucketTick('2026-11-01')).toBe('1 Nov')
    expect(formatBucketTick('2026-12-31')).toBe('31 Dec')
    expect(formatBucketLabel('2026-11-18')).toBe('18 Nov 2026')
    // Midnight-edge keys never shift a day, whatever the runner's timezone.
    expect(formatBucketLabel('2024-02-29')).toBe('29 Feb 2024')
    expect(formatBucketLabel('2026-01-01')).toBe('1 Jan 2026')
  })

  it('formats month keys', () => {
    expect(formatBucketTick('2026-11')).toBe('Nov ’26')
    expect(formatBucketTick('2025-01')).toBe('Jan ’25')
    expect(formatBucketLabel('2026-11')).toBe('November 2026')
    expect(formatBucketLabel('2025-12')).toBe('December 2025')
  })

  it('formats the resolved range', () => {
    expect(formatRangeLabel('2026-11-01', '2026-11-18')).toBe('1 Nov – 18 Nov 2026')
    expect(formatRangeLabel('2025-12-01', '2026-11-18')).toBe('1 Dec 2025 – 18 Nov 2026')
    expect(formatRangeLabel('2026-11-18', '2026-11-18')).toBe('18 Nov 2026')
  })
})

describe('BDT and count formatters', () => {
  it('formats taka with ৳ and en-BD grouping', () => {
    expect(formatBdt(0)).toBe('৳0')
    expect(formatBdt(999)).toBe('৳999')
    expect(formatBdt(1_234_567)).toBe(`৳${new Intl.NumberFormat('en-BD').format(1_234_567)}`)
    expect(formatBdt(12_500)).toBe('৳12,500')
    expect(formatBdt(1499.6)).toBe('৳1,500')
    expect(formatBdt(-2500)).toBe('-৳2,500')
  })

  it('formats compact taka for axis ticks', () => {
    expect(formatBdtCompact(0)).toBe('৳0')
    expect(formatBdtCompact(950)).toBe('৳950')
    expect(formatBdtCompact(12_000)).toBe('৳12K')
    expect(formatBdtCompact(1_250_000)).toBe('৳1.3M')
  })

  it('formats counts', () => {
    expect(formatCount(0)).toBe('0')
    expect(formatCount(48_210)).toBe('48,210')
  })
})

describe('Dhaka dates', () => {
  it('cuts the day at Dhaka midnight (UTC 18:00)', () => {
    expect(dhakaToday(new Date('2026-11-17T17:59:59.999Z'))).toBe('2026-11-17')
    expect(dhakaToday(new Date('2026-11-17T18:00:00.000Z'))).toBe('2026-11-18')
    expect(dhakaToday(new Date('2026-12-31T18:00:00.000Z'))).toBe('2027-01-01')
  })

  it('checks real calendar dates and shifts keys by days', () => {
    expect(isDateKey('2024-02-29')).toBe(true)
    expect(isDateKey('2026-02-29')).toBe(false)
    expect(isDateKey('2026-11-1')).toBe(false)
    expect(isDateKey('2026-11-18T00:00:00Z')).toBe(false)
    expect(addDays('2026-11-18', -29)).toBe('2026-10-20')
    expect(addDays('2024-02-28', 1)).toBe('2024-02-29')
  })
})

describe('customRangeError (same rules as the API)', () => {
  const today = '2026-11-18'
  it('accepts valid ranges', () => {
    expect(customRangeError('2026-11-01', '2026-11-18', today)).toBeNull()
    expect(customRangeError('2026-11-18', '2026-11-18', today)).toBeNull()
    expect(customRangeError('2024-12-01', '2026-11-18', today)).toBeNull() // exactly 24 months
    expect(customRangeError('2020-01-01', '2020-03-01', today)).toBeNull()
  })

  it('refuses invalid ranges', () => {
    expect(customRangeError('', '2026-11-18', today)).toMatch(/both/)
    expect(customRangeError('2026-02-30', '2026-11-18', today)).toMatch(/real calendar/)
    expect(customRangeError('2026-11-18', '2026-11-01', today)).toMatch(/on or before/)
    expect(customRangeError('2019-12-31', '2020-01-10', today)).toMatch(/2020/)
    expect(customRangeError('2026-11-01', '2026-11-19', today)).toMatch(/future/)
    expect(customRangeError('2024-11-30', '2026-11-18', today)).toMatch(/24 months/) // 25 months
  })
})

describe('URL search ↔ API params', () => {
  it('keeps well-formed search params only', () => {
    expect(validateDashboardSearch({})).toEqual({})
    expect(validateDashboardSearch({ range: '7d' })).toEqual({ range: '7d' })
    expect(validateDashboardSearch({ range: '30d' })).toEqual({}) // default stays out of the URL
    expect(validateDashboardSearch({ range: '1y' })).toEqual({})
    expect(validateDashboardSearch({ from: '2026-11-01', to: '2026-11-18', range: '7d' })).toEqual({
      from: '2026-11-01',
      to: '2026-11-18',
    })
    expect(validateDashboardSearch({ from: '2026-11-01' })).toEqual({})
    expect(validateDashboardSearch({ from: 'nope', to: '2026-11-18', range: '90d' })).toEqual({
      range: '90d',
    })
  })

  it('returns every key, undefined when unused or malformed (router merges raw search under it)', () => {
    for (const raw of [{}, { range: 'bogus' }, { range: '7d' }, { from: '2026-11-01', to: 'nope' }]) {
      expect(Object.keys(validateDashboardSearch(raw)).sort()).toEqual(['from', 'range', 'to'])
    }
    expect(validateDashboardSearch({ range: 'bogus', from: '2026-11-01' })).toStrictEqual({
      range: undefined,
      from: undefined,
      to: undefined,
    })
    expect(validateDashboardSearch({ from: '2026-11-01', to: '2026-11-18', range: '7d' })).toStrictEqual({
      range: undefined,
      from: '2026-11-01',
      to: '2026-11-18',
    })
  })

  it('maps search to API params, picker selection and query key', () => {
    expect(dashboardParams({})).toEqual({ range: '30d' })
    expect(dashboardParams({ range: '12m' })).toEqual({ range: '12m' })
    expect(dashboardParams({ from: '2026-11-01', to: '2026-11-18' })).toEqual({
      from: '2026-11-01',
      to: '2026-11-18',
    })
    expect(selectedRange({})).toBe('30d')
    expect(selectedRange({ from: '2026-11-01', to: '2026-11-18' })).toBe('custom')
    expect(presetSearch('30d')).toEqual({})
    expect(presetSearch('7d')).toEqual({ range: '7d' })
    expect(dashboardQueryOptions({ range: '7d' }).queryKey).toEqual(['admin', 'dashboard', { range: '7d' }])
  })
})
