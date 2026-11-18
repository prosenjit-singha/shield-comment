import { ApiError } from '@/lib/api'
import { dataDeletionStatusPath, lookupFromBody, type DataDeletionLookup } from '@/lib/data-deletion'
import { apiUpstream, buildForwardHeaders } from '@/server/api-proxy'

/** Only what the public lookup needs: no cookie, never the page request's body headers. */
const FORWARDED = ['user-agent', 'accept-language', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto']

/**
 * Server-render path of the `/data-deletion` lookup: calls the backend directly (like `getServerSession`)
 * and appends the visitor's IP to X-Forwarded-For, the same hop the `/api` proxy adds in the browser path.
 * 404 → `{ kind: 'unknown' }`; other non-2xx → `ApiError(status)`; no response → `ApiError(0)`.
 */
export async function fetchDataDeletionStatusUpstream(
  code: string,
  request: Request,
  clientIp: string | undefined,
  upstream: string = apiUpstream(),
): Promise<DataDeletionLookup> {
  const url = new URL(request.url)
  const all = buildForwardHeaders(request.headers, {
    clientIp,
    host: url.host,
    proto: url.protocol.replace(/:$/, ''),
  })
  const headers = new Headers({ accept: 'application/json' })
  for (const name of FORWARDED) {
    const value = all.get(name)
    if (value) headers.set(name, value)
  }

  let response: Response
  try {
    response = await fetch(new URL(dataDeletionStatusPath(code), upstream), { headers, redirect: 'manual' })
  } catch {
    throw new ApiError(0, 'Network error')
  }
  if (response.status === 404) return { kind: 'unknown' }
  if (!response.ok) throw new ApiError(response.status, `Request failed (${response.status})`)

  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw new ApiError(502, 'Unexpected response body')
  }
  return lookupFromBody(body)
}
