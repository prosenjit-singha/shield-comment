/** What went wrong on `/admin/login`; each kind gets its own message on the A1 screen. */
export type SignInFailure =
  | 'invalid-credentials'
  | 'rate-limited'
  | 'banned'
  | 'forbidden'
  | 'invalid-input'
  | 'network'
  | 'server'
  | 'unknown'

/** Error shape Better Auth's client (better-fetch) returns in `{ error }`. */
export interface AuthClientError {
  status: number
  code?: string
  message?: string
}

export class SignInError extends Error {
  readonly kind: SignInFailure
  /** Seconds until the rate limit resets (from Better Auth's `X-Retry-After`), when known. */
  readonly retryAfterSeconds: number | undefined

  constructor(kind: SignInFailure, message: string, retryAfterSeconds?: number) {
    super(message)
    this.name = 'SignInError'
    this.kind = kind
    this.retryAfterSeconds = retryAfterSeconds
  }
}

function parseRetryAfter(value: string | null | undefined): number | undefined {
  if (!value) return undefined
  const seconds = Number.parseInt(value, 10)
  return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined
}

function waitHint(seconds: number | undefined): string {
  if (!seconds) return 'Wait a minute, then try again.'
  if (seconds < 60) return `Try again in ${seconds} s.`
  return `Try again in ${Math.ceil(seconds / 60)} min.`
}

/** Maps a Better Auth error response to a user-facing `SignInError`. */
export function signInErrorFromResponse(
  error: AuthClientError,
  retryAfterHeader?: string | null,
): SignInError {
  const { status, code } = error
  if (status === 401 || code === 'INVALID_EMAIL_OR_PASSWORD') {
    return new SignInError('invalid-credentials', 'Incorrect email or password.')
  }
  if (status === 429) {
    const retryAfter = parseRetryAfter(retryAfterHeader)
    return new SignInError(
      'rate-limited',
      `Too many sign-in attempts. ${waitHint(retryAfter)}`,
      retryAfter,
    )
  }
  if (code === 'BANNED_USER') {
    return new SignInError(
      'banned',
      'This account has been banned. Contact the platform owner if you think this is a mistake.',
    )
  }
  if (status === 403) {
    return new SignInError('forbidden', 'Sign-in was refused from this address. Reload the page and try again.')
  }
  if (status === 400 || status === 422) {
    return new SignInError('invalid-input', 'Enter a valid email address and password.')
  }
  if (status >= 500) {
    return new SignInError('server', 'The server is unavailable right now. Try again shortly.')
  }
  return new SignInError('unknown', error.message || `Sign-in failed (${status}).`)
}

/** Anything thrown before a response arrived (offline, DNS, proxy down) is a network failure. */
export function toSignInError(thrown: unknown): SignInError {
  if (thrown instanceof SignInError) return thrown
  return new SignInError('network', "Can't reach the server. Check your connection and try again.")
}
