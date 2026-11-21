import { describe, expect, it } from 'vitest'
import { ApiError } from '@/lib/api'
import { autoRenewErrorMessage, checkoutErrorMessage, checkoutTarget, promotionMonths, validateBillingSearch, validateCheckoutIntent } from '@/lib/billing'

const en = (english: string) => english
const bn = (_english: string, bangla: string) => bangla
const NONE = { payment: undefined, tranId: undefined, plan: undefined, interval: undefined, invoice: undefined }

describe('validateBillingSearch', () => {
  it('keeps the four return values and a valid tran id', () => {
    for (const payment of ['success', 'failed', 'cancelled', 'pending'])
      expect(validateBillingSearch({ payment, tranId: 'SC_abc-1234' })).toEqual({ ...NONE, payment, tranId: 'SC_abc-1234' })
  })

  it('returns every key, undefined when invalid', () => {
    expect(validateBillingSearch({})).toEqual(NONE)
    expect(validateBillingSearch({ payment: 'paid', tranId: 'short' })).toEqual(NONE)
    expect(validateBillingSearch({ payment: 1, tranId: 'SC<script>12345' })).toEqual(NONE)
    expect(validateBillingSearch({ plan: 'Growth', interval: 'week', invoice: 'not-a-uuid' })).toEqual(NONE)
    expect(validateBillingSearch({ tranId: 'x'.repeat(31) }).tranId).toBeUndefined()
  })
})

describe('checkout intent (D11) + invoice id', () => {
  it('keeps a slug-shaped plan, month|year and a uuid invoice', () => {
    const invoice = '01936f2a-0000-7000-8000-000000000001'
    expect(validateBillingSearch({ plan: 'growth-plus', interval: 'year', invoice })).toEqual({ ...NONE, plan: 'growth-plus', interval: 'year', invoice })
    expect(validateCheckoutIntent({ plan: '../admin', interval: 'month' })).toEqual({ plan: undefined, interval: 'month' })
    expect(validateCheckoutIntent({ plan: 'a'.repeat(65) }).plan).toBeUndefined()
  })

  it('builds the /billing hand-off (interval defaults to month), none without a plan', () => {
    expect(checkoutTarget({ plan: 'pro', interval: 'year' })).toBe('/billing?plan=pro&interval=year')
    expect(checkoutTarget({ plan: 'pro' })).toBe('/billing?plan=pro&interval=month')
    expect(checkoutTarget({ interval: 'year' })).toBeNull()
  })

  it('says "k of N" in both languages', () => {
    expect(promotionMonths(null, en)).toBeNull()
    expect(promotionMonths({ from: 2, to: 2, of: 6 }, en)).toBe('Month 2 of 6')
    expect(promotionMonths({ from: 1, to: 3, of: 6 }, en)).toBe('Months 1–3 of 6')
    expect(promotionMonths({ from: 1, to: 3, of: 6 }, bn)).toBe('৬ মাসের মধ্যে ১–৩ নম্বর মাস')
  })
})

describe('checkoutErrorMessage', () => {
  it('names network, 403 (owner / impersonated), 429 and unknown codes', () => {
    expect(checkoutErrorMessage(new ApiError(0, 'x'), en, false)).toContain('Can’t reach the server')
    expect(checkoutErrorMessage(new ApiError(403, 'x'), en, false)).toBe('Only the workspace owner can pay.')
    expect(checkoutErrorMessage(new ApiError(403, 'x', { code: 'IMPERSONATION_READ_ONLY' }), en, true)).toContain('while impersonating')
    expect(checkoutErrorMessage(new ApiError(429, 'x'), en, false)).toContain('Too many attempts')
    expect(checkoutErrorMessage(new ApiError(500, 'x', { code: 'WHAT' }), en, false)).toBe('Something went wrong. Please try again.')
  })
})

describe('autoRenewErrorMessage', () => {
  it('explains the 409 and falls back otherwise', () => {
    expect(autoRenewErrorMessage(new ApiError(409, 'x', { code: 'AUTO_RENEW_UNAVAILABLE' }), en)).toBe('Auto-renew isn’t available right now.')
    expect(autoRenewErrorMessage(new ApiError(500, 'x'), en)).toBe('Couldn’t save auto-renew. Please try again.')
  })
})
