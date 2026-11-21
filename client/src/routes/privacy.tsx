import { createFileRoute } from '@tanstack/react-router'
import { LegalPage } from '@/components/legal/legal-page'
import { getSiteOrigin } from '@/lib/request-context'
import { legalHead } from '@/lib/seo'

/** Privacy Policy (English, M9-T7): public, server-rendered, indexable. */
export const Route = createFileRoute('/privacy')({
  loader: () => ({ origin: getSiteOrigin() }),
  head: ({ loaderData }) => legalHead('privacy', 'en', loaderData?.origin ?? ''),
  component: () => <LegalPage page="privacy" />,
})
