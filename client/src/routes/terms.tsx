import { createFileRoute } from '@tanstack/react-router'
import { LegalPage } from '@/components/legal/legal-page'
import { getSiteOrigin } from '@/lib/request-context'
import { legalHead } from '@/lib/seo'

/** Terms of Service (English, M9-T7): public, server-rendered, indexable. */
export const Route = createFileRoute('/terms')({
  loader: () => ({ origin: getSiteOrigin() }),
  head: ({ loaderData }) => legalHead('terms', 'en', loaderData?.origin ?? ''),
  component: () => <LegalPage page="terms" />,
})
