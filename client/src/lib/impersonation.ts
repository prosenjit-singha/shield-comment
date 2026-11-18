/**
 * "Login as Client" hand-off (M1-T3 backend, M2-T13 client). The admin panel opens
 * `/impersonate?token=…` on this app; the page posts the one-time token to Better Auth's
 * `impersonate-exchange` endpoint on this origin, which sets the session cookie here.
 */
export const IMPERSONATE_EXCHANGE_URL = '/api/auth/impersonate-exchange'

export interface ImpersonateSearch {
  token?: string
}

/** Every key is returned (`undefined` when malformed): the router merges raw search params under this. */
export function validateImpersonateSearch(search: Record<string, unknown>): ImpersonateSearch {
  const { token } = search
  return { token: typeof token === 'string' && token.trim() !== '' ? token.trim() : undefined }
}

export type ImpersonationFailure =
  | 'missing' // no ?token= (never sent)
  | 'invalid' // 400 bad shape
  | 'expired' // 401 unknown, expired or already used
  | 'forbidden' // 403 the issuing admin is no longer a super admin
  | 'not-found' // 404 workspace gone
  | 'suspended' // 409 workspace suspended
  | 'no-owner' // 409 no unbanned owner to sign in as
  | 'rate-limited' // 429
  | 'server' // 5xx or anything unexpected
  | 'network' // fetch threw (offline, DNS, proxy down)

export class ImpersonationExchangeError extends Error {
  readonly reason: ImpersonationFailure
  readonly status: number | undefined

  constructor(reason: ImpersonationFailure, status?: number) {
    super(`Impersonation exchange failed: ${reason}${status ? ` (${status})` : ''}`)
    this.name = 'ImpersonationExchangeError'
    this.reason = reason
    this.status = status
  }
}

/** Maps the backend's status (and, for 409, its message) to what the error screen explains. */
export function failureForStatus(status: number, message = ''): ImpersonationFailure {
  switch (status) {
    case 400:
      return 'invalid'
    case 401:
      return 'expired'
    case 403:
      return 'forbidden'
    case 404:
      return 'not-found'
    case 409:
      return /suspend/i.test(message) ? 'suspended' : 'no-owner'
    case 429:
      return 'rate-limited'
    default:
      return 'server'
  }
}

/** Failures where posting the same token again can still work (the token may not have been burned). */
export function isRetryable(reason: ImpersonationFailure): boolean {
  return reason === 'network' || reason === 'server' || reason === 'rate-limited'
}

async function readMessage(response: Response): Promise<string> {
  try {
    const body: unknown = await response.json()
    if (body && typeof body === 'object' && 'message' in body && typeof body.message === 'string') {
      return body.message
    }
  } catch {
    // Not JSON (e.g. a proxy error page): the status alone decides.
  }
  return ''
}

/**
 * Posts the token once. Resolves when the session cookie is set, otherwise throws
 * `ImpersonationExchangeError`. `referrerPolicy: 'origin'` keeps the page URL out of the Referer
 * header (the page strips the token first anyway) while keeping a real `Origin`, which Better Auth checks.
 */
export async function exchangeImpersonationToken(token: string): Promise<void> {
  let response: Response
  try {
    response = await fetch(IMPERSONATE_EXCHANGE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
      credentials: 'same-origin',
      cache: 'no-store',
      referrerPolicy: 'origin',
    })
  } catch {
    throw new ImpersonationExchangeError('network')
  }
  if (response.ok) return
  throw new ImpersonationExchangeError(
    failureForStatus(response.status, await readMessage(response)),
    response.status,
  )
}
