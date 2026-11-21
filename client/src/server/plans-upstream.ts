import { ApiError } from '@/lib/api'
import type { PublicPlansResponse } from '@/lib/plans'
import { apiUpstream } from '@/server/api-proxy'

/** A slow backend must not hold the landing page: give up and render the "See plans" fallback. */
const TIMEOUT_MS = 3_000

/**
 * Server-render path of the landing pricing (M8-T12, reading 12): public `GET /api/plans` straight from
 * the backend (no cookie, nothing forwarded). Non-2xx → `ApiError(status)`; no response or timeout →
 * `ApiError(0)`.
 */
export async function fetchPlansUpstream(upstream: string = apiUpstream()): Promise<PublicPlansResponse> {
  let response: Response
  try {
    response = await fetch(new URL('/api/plans', upstream), {
      headers: { accept: 'application/json' },
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch {
    throw new ApiError(0, 'Network error')
  }
  if (!response.ok) throw new ApiError(response.status, `Request failed (${response.status})`)
  try {
    return (await response.json()) as PublicPlansResponse
  } catch {
    throw new ApiError(502, 'Unexpected response body')
  }
}
