// Production Node server for the TanStack Start build (`npm run build && npm start`).
// - /healthz            container healthcheck (no SSR, no backend call)
// - dist/client/*       static assets (hashed files under /assets/ are cached for a year)
// - everything else     the Start handler: SSR pages, server functions, the /api/* proxy route
import { fileURLToPath } from 'node:url'
import { serve } from 'srvx'
import { staticMiddleware } from 'srvx/static'
import start from './dist/server/server.js'

const dir = fileURLToPath(new URL('./dist/client', import.meta.url))
const hashedAssets = staticMiddleware({ dir, maxAge: 31_536_000, immutable: true })
const publicFiles = staticMiddleware({ dir, maxAge: 3_600 })

/** @type {import('srvx').ServerMiddleware} */
function healthz(request, next) {
  if (new URL(request.url).pathname !== '/healthz') return next()
  return new Response('ok\n', { headers: { 'content-type': 'text/plain', 'cache-control': 'no-store' } })
}

/** @type {import('srvx').ServerMiddleware} */
function assets(request, next) {
  const { pathname } = new URL(request.url)
  if (pathname.startsWith('/api/')) return next() // never shadow the API proxy
  return (pathname.startsWith('/assets/') ? hashedAssets : publicFiles)(request, next)
}

serve({
  port: Number(process.env.PORT ?? 5174),
  hostname: process.env.HOST ?? '0.0.0.0',
  middleware: [healthz, assets],
  fetch: start.fetch,
  gracefulShutdown: true,
})
