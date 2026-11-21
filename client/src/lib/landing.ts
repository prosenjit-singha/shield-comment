import { queryOptions, type QueryClient } from '@tanstack/react-query'
import { plansQueryKey, type PublicPlansResponse } from '@/lib/plans'
import { getSiteOrigin } from '@/lib/request-context'
import { getServerPlans } from '@/server/plans'
import { apiFetch } from '@/lib/api'

/**
 * Landing pricing (M8-T12, reading 12): the server render calls the backend through `getServerPlans`
 * (`API_UPSTREAM`), the browser the same-origin `/api/plans`. Same key as `/plans`. No retries: a failed
 * server fetch renders the "See plans" fallback, the browser tries once on mount.
 */
export const landingPlansQueryOptions = queryOptions({
  queryKey: plansQueryKey,
  queryFn: (): Promise<PublicPlansResponse> =>
    typeof window === 'undefined' ? getServerPlans() : apiFetch<PublicPlansResponse>('/api/plans'),
  retry: false,
})

export interface LandingLoaderData {
  origin: string
  /** `false` = the plans fetch failed: fallback link, and the page must not be cached. */
  plansLoaded: boolean
  /** Cheapest live monthly price (৳) for the JSON-LD offer; `null` = no plans. */
  lowestPriceBdt: number | null
}

/** Shared `/` + `/bn` loader. Never throws: the page renders without pricing when the API is down. */
export async function loadLanding(queryClient: QueryClient): Promise<LandingLoaderData> {
  const plans = await queryClient.fetchQuery(landingPlansQueryOptions).catch(() => null)
  const prices = plans?.items.map((plan) => plan.monthly.perMonthBdt) ?? []
  return {
    origin: getSiteOrigin(),
    plansLoaded: plans !== null,
    lowestPriceBdt: prices.length > 0 ? Math.min(...prices) : null,
  }
}

/** Response headers for the landing HTML: a page rendered without prices is never cached. */
export function landingHeaders(data: LandingLoaderData | undefined): Record<string, string> | undefined {
  return data?.plansLoaded === false ? { 'Cache-Control': 'no-store' } : undefined
}

/** ROAS calculator assumptions (client.md §3.5): ad sales = spend × ROAS, a share lost to bad comments. */
export const ROAS_ASSUMED = 3
export const SALES_LOST_PERCENT = 8
export const AD_SPEND = { min: 10_000, max: 500_000, step: 5_000, initial: 50_000 } as const

/** Monthly ad sales protected for a given monthly ad spend (৳, rounded). */
export const protectedSales = (spendBdt: number): number => Math.round((spendBdt * ROAS_ASSUMED * SALES_LOST_PERCENT) / 100)
