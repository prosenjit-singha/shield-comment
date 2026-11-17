import { createFileRoute } from '@tanstack/react-router'
import { getRequestIP } from '@tanstack/react-start/server'
import { proxyToApi } from '@/server/api-proxy'

/**
 * Same-origin `/api/*` → backend (`API_UPSTREAM`) for the production Start server. In `npm run dev`
 * Vite's own proxy (vite.config.ts) answers first; both add X-Forwarded-For/Host/Proto.
 */
export const Route = createFileRoute('/api/$')({
  server: {
    handlers: {
      ANY: ({ request }) => proxyToApi(request, getRequestIP()),
    },
  },
})
