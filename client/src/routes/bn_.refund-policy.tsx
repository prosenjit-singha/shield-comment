import { createFileRoute } from '@tanstack/react-router'
import { LegalPage } from '@/components/legal/legal-page'
import { getSiteOrigin } from '@/lib/request-context'
import { legalHead } from '@/lib/seo'

/** Refund Policy (Bangla, M9-T7): public, server-rendered, indexable. */
export const Route = createFileRoute('/bn_/refund-policy')({
  loader: () => ({ origin: getSiteOrigin() }),
  head: ({ loaderData }) => legalHead('refund', 'bn', loaderData?.origin ?? ''),
  component: () => <LegalPage page="refund" />,
})
