import { describe, expect, it } from 'vitest'
import { failureForStatus, isRetryable, validateImpersonateSearch } from './impersonation'

describe('validateImpersonateSearch', () => {
  it('keeps a token string and always returns the key', () => {
    expect(validateImpersonateSearch({ token: 'abc' })).toEqual({ token: 'abc' })
    expect(validateImpersonateSearch({})).toEqual({ token: undefined })
    expect(Object.keys(validateImpersonateSearch({}))).toEqual(['token'])
  })

  it('drops blank and non-string tokens', () => {
    for (const token of ['', '   ', 123, null, ['a'], { a: 1 }]) {
      expect(validateImpersonateSearch({ token })).toEqual({ token: undefined })
    }
  })
})

describe('failureForStatus', () => {
  it('maps every backend status the exchange can return', () => {
    expect(failureForStatus(400)).toBe('invalid')
    expect(failureForStatus(401)).toBe('expired')
    expect(failureForStatus(403)).toBe('forbidden')
    expect(failureForStatus(404)).toBe('not-found')
    expect(failureForStatus(409, 'Workspace is suspended')).toBe('suspended')
    expect(failureForStatus(409, 'Workspace has no owner that can be impersonated')).toBe('no-owner')
    expect(failureForStatus(409)).toBe('no-owner')
    expect(failureForStatus(429)).toBe('rate-limited')
    expect(failureForStatus(500)).toBe('server')
    expect(failureForStatus(502)).toBe('server')
    expect(failureForStatus(418)).toBe('server')
  })

  it('only offers a retry when the token may still be unused', () => {
    expect(isRetryable('network')).toBe(true)
    expect(isRetryable('server')).toBe(true)
    expect(isRetryable('rate-limited')).toBe(true)
    for (const reason of ['missing', 'invalid', 'expired', 'forbidden', 'not-found', 'suspended', 'no-owner'] as const) {
      expect(isRetryable(reason)).toBe(false)
    }
  })
})
