import { createFileRoute } from '@tanstack/react-router'
import { LegalPage } from '@/components/legal/legal-page'
import { getSiteOrigin } from '@/lib/request-context'
import { legalHead } from '@/lib/seo'

/** Privacy Policy (Bangla, M9-T7): public, server-rendered, indexable. */
export const Route = createFileRoute('/bn_/privacy')({
  loader: () => ({ origin: getSiteOrigin() }),
  head: ({ loaderData }) => legalHead('privacy', 'bn', loaderData?.origin ?? ''),
  component: () => <LegalPage page="privacy" />,
})
