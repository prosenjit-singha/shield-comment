import { createFileRoute } from '@tanstack/react-router'
import { getSiteOrigin } from '@/lib/request-context'
import { robotsTxt } from '@/lib/seo'

/** `/robots.txt` with absolute URLs from `PUBLIC_SITE_URL` (M8-T13). */
export const Route = createFileRoute('/robots.txt')({
  server: {
    handlers: {
      GET: () =>
        new Response(robotsTxt(getSiteOrigin()), {
          headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=3600' },
        }),
    },
  },
})
