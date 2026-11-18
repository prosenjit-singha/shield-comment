/**
 * Same-origin JSON calls to the backend (`/api/*`, proxied; the session cookie rides along). Use only
 * inside TanStack Query (`queryFn` / `mutationFn`). Failures throw `ApiError`.
 */

/** Backend error body (`AllExceptionsFilter`): `{ statusCode, error, message, path, timestamp, code?, details? }`. */
interface ApiErrorBody {
  message?: unknown
  code?: unknown
  details?: unknown
}

export class ApiError extends Error {
  /** HTTP status; `0` = no response (offline, DNS, proxy down). */
  readonly status: number
  /** Machine-readable reason some 4xx bodies carry, e.g. `PAGE_LIMIT_REACHED`. */
  readonly code: string | undefined
  readonly details: Record<string, unknown> | undefined

  constructor(status: number, message: string, options: { code?: string; details?: Record<string, unknown> } = {}) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = options.code
    this.details = options.details
  }

  get isNetwork(): boolean {
    return this.status === 0
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function errorFromResponse(response: Response): Promise<ApiError> {
  let body: ApiErrorBody = {}
  try {
    const parsed: unknown = await response.json()
    if (isRecord(parsed)) body = parsed
  } catch {
    // non-JSON error page (proxy 502 etc.): status only
  }
  const message = Array.isArray(body.message)
    ? body.message.join('; ')
    : typeof body.message === 'string'
      ? body.message
      : `Request failed (${response.status})`
  return new ApiError(response.status, message, {
    code: typeof body.code === 'string' ? body.code : undefined,
    details: isRecord(body.details) ? body.details : undefined,
  })
}

export async function apiFetch<T>(path: string, options: { method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'; body?: unknown } = {}): Promise<T> {
  const { method = 'GET', body } = options
  let response: Response
  try {
    response = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? { accept: 'application/json' } : { accept: 'application/json', 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch {
    throw new ApiError(0, 'Network error')
  }
  if (!response.ok) throw await errorFromResponse(response)
  try {
    return (await response.json()) as T
  } catch {
    throw new ApiError(response.status, 'Unexpected response body')
  }
}

/** Anything a query/mutation threw, as an `ApiError` (unexpected throws count as network failures). */
export function toApiError(error: unknown): ApiError {
  return error instanceof ApiError ? error : new ApiError(0, 'Network error')
}
