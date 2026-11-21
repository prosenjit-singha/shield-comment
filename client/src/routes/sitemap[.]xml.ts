import { createFileRoute } from '@tanstack/react-router'
import { getSiteOrigin } from '@/lib/request-context'
import { sitemapXml } from '@/lib/seo'

/** `/sitemap.xml`: `/` + `/bn` with hreflang alternates, absolute URLs from `PUBLIC_SITE_URL` (M8-T13). */
export const Route = createFileRoute('/sitemap.xml')({
  server: {
    handlers: {
      GET: () =>
        new Response(sitemapXml(getSiteOrigin()), {
          headers: { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=3600' },
        }),
    },
  },
})
