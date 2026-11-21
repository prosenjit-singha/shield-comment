// Production Node server for the TanStack Start build (`npm run build && npm start`).
// - /healthz            container healthcheck (no SSR, no backend call)
// - dist/client/*       static assets (hashed files under /assets/ are cached for a year)
// - everything else     the Start handler: SSR pages, server functions, the /api/* proxy route
// Middleware + security headers + compression live in server-http.ts (unit-tested; M9-T8).
import { fileURLToPath } from 'node:url'
import { serve } from 'srvx'
import start from './dist/server/server.js'
import { appFetch, appMiddleware } from './server-http.ts'

serve({
  port: Number(process.env.PORT ?? 5174),
  hostname: process.env.HOST ?? '0.0.0.0',
  middleware: appMiddleware(fileURLToPath(new URL('./dist/client', import.meta.url))),
  fetch: appFetch(start),
  gracefulShutdown: true,
})
