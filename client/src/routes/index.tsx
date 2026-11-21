import { createFileRoute } from '@tanstack/react-router'
import { LandingPage } from '@/components/landing/landing-page'
import { landingHeaders, loadLanding } from '@/lib/landing'
import { landingHead } from '@/lib/seo'

/** English landing page (C1), server-rendered with live pricing for SEO and Meta link previews. */
export const Route = createFileRoute('/')({
  loader: ({ context }) => loadLanding(context.queryClient),
  head: ({ loaderData }) => landingHead('en', loaderData?.origin ?? '', loaderData?.lowestPriceBdt ?? null),
  headers: ({ loaderData }) => landingHeaders(loaderData),
  component: LandingPage,
})
