import { createFileRoute } from '@tanstack/react-router'
import { LandingPlaceholder } from '@/components/landing-placeholder'
import { getSiteOrigin } from '@/lib/request-context'
import { landingHead } from '@/lib/seo'

/** English landing page, server-rendered for SEO and Meta link previews. */
export const Route = createFileRoute('/')({
  loader: () => ({ origin: getSiteOrigin() }),
  head: ({ loaderData }) => landingHead('en', loaderData?.origin ?? ''),
  component: LandingPlaceholder,
})
