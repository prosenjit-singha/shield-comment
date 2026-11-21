import { createFileRoute } from '@tanstack/react-router'
import { LegalPage } from '@/components/legal/legal-page'
import { getSiteOrigin } from '@/lib/request-context'
import { legalHead } from '@/lib/seo'

/** Refund Policy (English, M9-T7): public, server-rendered, indexable. */
export const Route = createFileRoute('/refund-policy')({
  loader: () => ({ origin: getSiteOrigin() }),
  head: ({ loaderData }) => legalHead('refund', 'en', loaderData?.origin ?? ''),
  component: () => <LegalPage page="refund" />,
})
