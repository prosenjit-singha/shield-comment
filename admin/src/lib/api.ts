/**
 * Thin JSON client for the same-origin backend (`/api/*`, proxied by Vite in dev and nginx in Docker).
 * The Better Auth session is an httpOnly cookie, so same-origin `fetch` sends it on its own.
 * Call it only from TanStack Query `queryFn`/`mutationFn`s (AGENTS.md).
 */

/**
 * A non-2xx response. `message` is the backend's `{ message }` (joined if it is a list); `code` its
 * machine-readable `{ code }` when present (e.g. 503 `KEY_ENCRYPTION_NOT_CONFIGURED`).
 */
export class ApiError extends Error {
  readonly status: number
  readonly code: string | undefined
  /** The backend's 4xx `{ details }` object (e.g. `PROMOTION_TERMS_LOCKED` → `{ fields }`). */
  readonly details: Record<string, unknown> | undefined

  constructor(status: number, message: string, code?: string, details?: Record<string, unknown>) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.details = details
  }
}

function errorCode(body: unknown): string | undefined {
  if (body && typeof body === 'object' && 'code' in body) {
    const { code } = body as { code: unknown }
    if (typeof code === 'string' && code) return code
  }
  return undefined
}

function errorDetails(body: unknown): Record<string, unknown> | undefined {
  if (body && typeof body === 'object' && 'details' in body) {
    const { details } = body as { details: unknown }
    if (details && typeof details === 'object' && !Array.isArray(details)) return details as Record<string, unknown>
  }
  return undefined
}

function errorMessage(body: unknown, status: number): string {
  if (body && typeof body === 'object' && 'message' in body) {
    const { message } = body as { message: unknown }
    if (typeof message === 'string' && message) return message
    if (Array.isArray(message) && message.length > 0) return message.join(', ')
  }
  return `Request failed (${status})`
}

export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers)
  headers.set('Accept', 'application/json')
  // FormData sets its own multipart boundary.
  if (init.body !== undefined && !(init.body instanceof FormData)) headers.set('Content-Type', 'application/json')

  const res = await fetch(`/api${path}`, { ...init, headers, credentials: 'same-origin' })
  const text = await res.text()
  let body: unknown = null
  if (text) {
    try {
      body = JSON.parse(text)
    } catch {
      body = null
    }
  }
  if (!res.ok) throw new ApiError(res.status, errorMessage(body, res.status), errorCode(body), errorDetails(body))
  return body as T
}
