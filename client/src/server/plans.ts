import { createServerFn } from '@tanstack/react-start'
import type { PublicPlansResponse } from '@/lib/plans'
import { fetchPlansUpstream } from '@/server/plans-upstream'

/** Landing pricing during a server render, so the plans are in the first HTML (M8-T12). */
export const getServerPlans = createServerFn({ method: 'GET' }).handler(
  (): Promise<PublicPlansResponse> => fetchPlansUpstream(),
)
