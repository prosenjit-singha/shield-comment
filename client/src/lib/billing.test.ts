import { describe, expect, it } from 'vitest'
import { ApiError } from '@/lib/api'
import { autoRenewErrorMessage, checkoutErrorMessage, validateBillingSearch } from '@/lib/billing'

const en = (english: string) => english

describe('validateBillingSearch', () => {
  it('keeps the four return values and a valid tran id', () => {
    for (const payment of ['success', 'failed', 'cancelled', 'pending'])
      expect(validateBillingSearch({ payment, tranId: 'SC_abc-1234' })).toEqual({ payment, tranId: 'SC_abc-1234' })
  })

  it('returns every key, undefined when invalid', () => {
    expect(validateBillingSearch({})).toEqual({ payment: undefined, tranId: undefined })
    expect(validateBillingSearch({ payment: 'paid', tranId: 'short' })).toEqual({ payment: undefined, tranId: undefined })
    expect(validateBillingSearch({ payment: 1, tranId: 'SC<script>12345' })).toEqual({ payment: undefined, tranId: undefined })
    expect(validateBillingSearch({ tranId: 'x'.repeat(31) }).tranId).toBeUndefined()
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
