import { describe, expect, it } from 'vitest'
import { SignInError, signInErrorFromResponse, toSignInError } from '@/lib/auth-errors'

describe('signInErrorFromResponse', () => {
  it.each([
    [{ status: 401, code: 'INVALID_EMAIL_OR_PASSWORD' }, 'invalid-credentials'],
    [{ status: 429 }, 'rate-limited'],
    [{ status: 403, code: 'BANNED_USER' }, 'banned'],
    [{ status: 403, code: 'INVALID_ORIGIN' }, 'forbidden'],
    [{ status: 400, code: 'INVALID_EMAIL' }, 'invalid-input'],
    [{ status: 502 }, 'server'],
    [{ status: 418, message: 'teapot' }, 'unknown'],
  ] as const)('%o → %s', (error, kind) => {
    expect(signInErrorFromResponse(error).kind).toBe(kind)
  })

  it('uses X-Retry-After for the rate-limit hint', () => {
    expect(signInErrorFromResponse({ status: 429 }, '42')).toMatchObject({
      retryAfterSeconds: 42,
      message: 'Too many sign-in attempts. Try again in 42 s.',
    })
    expect(signInErrorFromResponse({ status: 429 }, '125').message).toContain('Try again in 3 min.')
    expect(signInErrorFromResponse({ status: 429 }, 'nope').retryAfterSeconds).toBeUndefined()
  })

  it('does not leak the backend message for a bad password', () => {
    const error = signInErrorFromResponse({ status: 401, message: 'Invalid email or password' })
    expect(error.message).toBe('Incorrect email or password.')
  })
})

describe('toSignInError', () => {
  it('treats a thrown fetch error as a network failure', () => {
    expect(toSignInError(new TypeError('Failed to fetch')).kind).toBe('network')
  })

  it('passes a SignInError through', () => {
    const error = new SignInError('banned', 'x')
    expect(toSignInError(error)).toBe(error)
  })
})
