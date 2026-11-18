import { describe, expect, it } from 'vitest'
import {
  AuthError,
  authErrorFromResponse,
  authErrorMessage,
  parseRetryAfter,
  toAuthError,
  type ContentFn,
} from '@/lib/auth-errors'

const en: ContentFn = (english) => english
const bn: ContentFn = (_english, bangla) => bangla

describe('authErrorFromResponse', () => {
  it.each([
    [{ status: 401, code: 'INVALID_EMAIL_OR_PASSWORD' }, 'invalid-credentials'],
    [{ status: 401 }, 'invalid-credentials'],
    [{ status: 429 }, 'rate-limited'],
    [{ status: 403, code: 'BANNED_USER' }, 'banned'],
    [{ status: 403, code: 'INVALID_ORIGIN' }, 'forbidden'],
    [{ status: 422, code: 'USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL' }, 'user-exists'],
    [{ status: 422, code: 'USER_ALREADY_EXISTS' }, 'user-exists'],
    [{ status: 400, code: 'PASSWORD_TOO_SHORT' }, 'weak-password'],
    [{ status: 400, code: 'PASSWORD_TOO_LONG' }, 'weak-password'],
    [{ status: 400, code: 'INVALID_EMAIL' }, 'invalid-email'],
    [{ status: 400, message: 'workspaceName must be 1-80 characters' }, 'invalid-business-name'],
    [{ status: 400, code: 'VALIDATION_ERROR' }, 'invalid-input'],
    [{ status: 422, code: 'FAILED_TO_CREATE_USER' }, 'invalid-input'],
    [{ status: 500 }, 'server'],
    [{ status: 502 }, 'server'],
    [{ status: 418, message: 'teapot' }, 'unknown'],
  ] as const)('%o → %s', (error, kind) => {
    expect(authErrorFromResponse(error).kind).toBe(kind)
  })

  it('keeps the status and reads X-Retry-After for 429', () => {
    expect(authErrorFromResponse({ status: 429 }, '42')).toMatchObject({ status: 429, retryAfterSeconds: 42 })
    expect(authErrorFromResponse({ status: 429 }, 'nope').retryAfterSeconds).toBeUndefined()
    expect(authErrorFromResponse({ status: 429 }).retryAfterSeconds).toBeUndefined()
  })
})

describe('parseRetryAfter', () => {
  it('accepts positive whole seconds only', () => {
    expect(parseRetryAfter('42')).toBe(42)
    expect(parseRetryAfter('0')).toBeUndefined()
    expect(parseRetryAfter('-3')).toBeUndefined()
    expect(parseRetryAfter('')).toBeUndefined()
    expect(parseRetryAfter(null)).toBeUndefined()
  })
})

describe('toAuthError', () => {
  it('treats a thrown fetch error as a network failure', () => {
    expect(toAuthError(new TypeError('Failed to fetch')).kind).toBe('network')
  })

  it('passes an AuthError through', () => {
    const error = new AuthError('banned', { status: 403 })
    expect(toAuthError(error)).toBe(error)
  })
})

describe('authErrorMessage', () => {
  it('has English and Bangla copy for every kind', () => {
    const kinds = [
      'invalid-credentials',
      'rate-limited',
      'banned',
      'forbidden',
      'user-exists',
      'weak-password',
      'invalid-email',
      'invalid-business-name',
      'invalid-input',
      'server',
      'network',
      'unknown',
    ] as const
    for (const kind of kinds) {
      const error = new AuthError(kind)
      const english = authErrorMessage(error, en)
      const bangla = authErrorMessage(error, bn)
      expect(english, kind).not.toBe('')
      expect(bangla, kind).toMatch(/[ঀ-৿]/) // Bengali script
      expect(bangla, kind).not.toBe(english)
    }
  })

  it('formats the rate-limit wait in seconds, minutes, or a generic hint', () => {
    const wait = (seconds?: number) => new AuthError('rate-limited', { status: 429, retryAfterSeconds: seconds })
    expect(authErrorMessage(wait(42), en)).toBe('Too many attempts. Try again in 42 s.')
    expect(authErrorMessage(wait(125), en)).toBe('Too many attempts. Try again in 3 min.')
    expect(authErrorMessage(wait(), en)).toBe('Too many attempts. Wait a minute, then try again.')
    expect(authErrorMessage(wait(42), bn)).toBe('অনেকবার চেষ্টা করা হয়েছে। ৪২ সেকেন্ড পরে আবার চেষ্টা করুন।')
    expect(authErrorMessage(wait(125), bn)).toBe('অনেকবার চেষ্টা করা হয়েছে। ৩ মিনিট পরে আবার চেষ্টা করুন।')
  })

  it('never echoes the backend message', () => {
    const error = authErrorFromResponse({ status: 401, message: 'Invalid email or password' })
    expect(authErrorMessage(error, en)).toBe('Incorrect email or password.')
    expect(authErrorMessage(authErrorFromResponse({ status: 418, message: 'secret detail' }), en)).not.toContain(
      'secret detail',
    )
  })
})
