/**
 * Sign-in / sign-up failures on `/login` and `/register` (C2). Same mapping as the admin panel's
 * `src/lib/auth-errors.ts`, plus the sign-up cases Better Auth returns. The copy is bilingual:
 * `authErrorMessage(error, content)` picks the text for the current language.
 */
export type AuthFailure =
  | 'invalid-credentials' // 401 INVALID_EMAIL_OR_PASSWORD
  | 'rate-limited' // 429 (+ X-Retry-After)
  | 'banned' // 403 BANNED_USER
  | 'forbidden' // any other 403 (e.g. untrusted Origin)
  | 'user-exists' // 422 USER_ALREADY_EXISTS(_USE_ANOTHER_EMAIL)
  | 'weak-password' // 400 PASSWORD_TOO_SHORT / PASSWORD_TOO_LONG
  | 'invalid-email' // 400 INVALID_EMAIL
  | 'invalid-business-name' // 400 from our sign-up hook (`workspaceName must be 1-80 characters`)
  | 'invalid-input' // any other 400 / 422
  | 'server' // 5xx
  | 'network' // fetch threw: offline, DNS, proxy down
  | 'unknown'

/** Error shape Better Auth's client (better-fetch) returns in `{ error }`. */
export interface AuthClientError {
  status: number
  code?: string
  message?: string
}

/** `content(english, bangla)` from `useLanguage()`. */
export type ContentFn = (english: string, bangla: string) => string

export class AuthError extends Error {
  readonly kind: AuthFailure
  readonly status: number | undefined
  /** Seconds until the rate limit resets (Better Auth's `X-Retry-After`), when known. */
  readonly retryAfterSeconds: number | undefined

  constructor(kind: AuthFailure, options: { status?: number; retryAfterSeconds?: number } = {}) {
    super(`Auth request failed: ${kind}${options.status ? ` (${options.status})` : ''}`)
    this.name = 'AuthError'
    this.kind = kind
    this.status = options.status
    this.retryAfterSeconds = options.retryAfterSeconds
  }
}

export function parseRetryAfter(value: string | null | undefined): number | undefined {
  if (!value) return undefined
  const seconds = Number.parseInt(value, 10)
  return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined
}

/** Maps a Better Auth error response to an `AuthError`. Backend messages are never shown as-is. */
export function authErrorFromResponse(error: AuthClientError, retryAfterHeader?: string | null): AuthError {
  const { status, code = '', message = '' } = error
  const as = (kind: AuthFailure, retryAfterSeconds?: number) => new AuthError(kind, { status, retryAfterSeconds })

  if (status === 401 || code === 'INVALID_EMAIL_OR_PASSWORD') return as('invalid-credentials')
  if (status === 429) return as('rate-limited', parseRetryAfter(retryAfterHeader))
  if (code === 'BANNED_USER') return as('banned')
  if (status === 403) return as('forbidden')
  if (code === 'USER_ALREADY_EXISTS' || code === 'USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL') return as('user-exists')
  if (code === 'PASSWORD_TOO_SHORT' || code === 'PASSWORD_TOO_LONG') return as('weak-password')
  if (code === 'INVALID_EMAIL') return as('invalid-email')
  if (status === 400 && /workspaceName/i.test(`${code} ${message}`)) return as('invalid-business-name')
  if (status === 400 || status === 422) return as('invalid-input')
  if (status >= 500) return as('server')
  return as('unknown')
}

/** Anything thrown before a response arrived is a network failure. */
export function toAuthError(thrown: unknown): AuthError {
  if (thrown instanceof AuthError) return thrown
  return new AuthError('network')
}

function waitHint(seconds: number | undefined, content: ContentFn): string {
  if (!seconds) return content('Wait a minute, then try again.', 'এক মিনিট অপেক্ষা করে আবার চেষ্টা করুন।')
  const bn = (n: number) => new Intl.NumberFormat('bn-BD').format(n)
  if (seconds < 60) return content(`Try again in ${seconds} s.`, `${bn(seconds)} সেকেন্ড পরে আবার চেষ্টা করুন।`)
  const minutes = Math.ceil(seconds / 60)
  return content(`Try again in ${minutes} min.`, `${bn(minutes)} মিনিট পরে আবার চেষ্টা করুন।`)
}

/** The user-facing text for an auth failure, in the current language. */
export function authErrorMessage(error: AuthError, content: ContentFn): string {
  switch (error.kind) {
    case 'invalid-credentials':
      return content('Incorrect email or password.', 'ইমেইল বা পাসওয়ার্ড সঠিক নয়।')
    case 'rate-limited':
      return `${content('Too many attempts.', 'অনেকবার চেষ্টা করা হয়েছে।')} ${waitHint(error.retryAfterSeconds, content)}`
    case 'banned':
      return content(
        'This account has been banned. Contact support if you think this is a mistake.',
        'এই অ্যাকাউন্টটি নিষিদ্ধ করা হয়েছে। ভুল মনে হলে সাপোর্টে যোগাযোগ করুন।',
      )
    case 'forbidden':
      return content(
        'The request was refused. Reload the page and try again.',
        'অনুরোধটি প্রত্যাখ্যান করা হয়েছে। পেজটি রিলোড করে আবার চেষ্টা করুন।',
      )
    case 'user-exists':
      return content(
        'An account with this email already exists. Log in instead.',
        'এই ইমেইলে আগে থেকেই একটি অ্যাকাউন্ট আছে। লগ ইন করুন।',
      )
    case 'weak-password':
      return content(
        'The password must be 8 to 128 characters.',
        'পাসওয়ার্ড ৮ থেকে ১২৮ অক্ষরের হতে হবে।',
      )
    case 'invalid-email':
      return content('Enter a valid email address.', 'একটি সঠিক ইমেইল ঠিকানা দিন।')
    case 'invalid-business-name':
      return content(
        'The business name must be 1 to 80 characters.',
        'ব্যবসার নাম ১ থেকে ৮০ অক্ষরের হতে হবে।',
      )
    case 'invalid-input':
      return content('Check the details you entered and try again.', 'আপনার দেওয়া তথ্য দেখে আবার চেষ্টা করুন।')
    case 'server':
      return content(
        'The server is unavailable right now. Try again shortly.',
        'সার্ভার এই মুহূর্তে পাওয়া যাচ্ছে না। একটু পরে আবার চেষ্টা করুন।',
      )
    case 'network':
      return content(
        'Can’t reach the server. Check your connection and try again.',
        'সার্ভারে সংযোগ করা যাচ্ছে না। ইন্টারনেট সংযোগ দেখে আবার চেষ্টা করুন।',
      )
    case 'unknown':
      return content(
        `Something went wrong${error.status ? ` (${error.status})` : ''}. Try again.`,
        `কিছু একটা সমস্যা হয়েছে${error.status ? ` (${error.status})` : ''}। আবার চেষ্টা করুন।`,
      )
  }
}
