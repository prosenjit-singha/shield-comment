import { createFileRoute } from '@tanstack/react-router'
import { LandingPlaceholder } from '@/components/landing-placeholder'
import { getSiteOrigin } from '@/lib/request-context'
import { landingHead } from '@/lib/seo'

/** Bangla landing page (fixed URL for hreflang), server-rendered like `/`. */
export const Route = createFileRoute('/bn')({
  loader: () => ({ origin: getSiteOrigin() }),
  head: ({ loaderData }) => landingHead('bn', loaderData?.origin ?? ''),
  component: LandingPlaceholder,
})
