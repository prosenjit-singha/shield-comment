import { createFileRoute } from '@tanstack/react-router'
import { LandingPage } from '@/components/landing/landing-page'
import { landingHeaders, loadLanding } from '@/lib/landing'
import { landingHead } from '@/lib/seo'

/** Bangla landing page (fixed URL for hreflang), server-rendered like `/`. */
export const Route = createFileRoute('/bn')({
  loader: ({ context }) => loadLanding(context.queryClient),
  head: ({ loaderData }) => landingHead('bn', loaderData?.origin ?? '', loaderData?.lowestPriceBdt ?? null),
  headers: ({ loaderData }) => landingHeaders(loaderData),
  component: LandingPage,
})
