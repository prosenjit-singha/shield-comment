/**
 * Thin JSON client for the same-origin backend (`/api/*`, proxied by Vite in dev and nginx in Docker).
 * The Better Auth session is an httpOnly cookie, so same-origin `fetch` sends it on its own.
 * Call it only from TanStack Query `queryFn`/`mutationFn`s (AGENTS.md).
 */

/** A non-2xx response. `message` is the backend's `{ message }` (joined if it is a list). */
export class ApiError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
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
  if (init.body !== undefined) headers.set('Content-Type', 'application/json')

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
  if (!res.ok) throw new ApiError(res.status, errorMessage(body, res.status))
  return body as T
}
