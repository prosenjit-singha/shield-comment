// Middleware for `server.mjs` (srvx). Plain erasable TS: Node 24 runs it directly (type stripping),
// `tsc -b` checks it through tsconfig.node.json, `src/server/server-http.test.ts` runs it in a real srvx.
// - /healthz: container healthcheck, untouched
// - security headers on everything this server answers itself (SSR HTML, server fns, static files, 404s,
//   robots.txt / sitemap.xml); `/api/*` is the backend proxy and keeps the backend's own (Helmet) headers
// - CSP ships as Report-Only (D12) with a per-request nonce; Start puts it on its inline scripts
//   (router `ssr.nonce`, see `getCspNonce` in src/lib/request-context.ts)
// - gzip / br for compressible bodies Start renders (static files are already compressed by srvx/static)
import { randomBytes } from 'node:crypto'
import { Duplex } from 'node:stream'
import { constants, createBrotliCompress, createGzip } from 'node:zlib'
import type { ServerMiddleware, ServerRequest } from 'srvx'
import { staticMiddleware } from 'srvx/static'

type StartFetch = (request: Request, opts: { context: { nonce?: string } }) => Response | Promise<Response>

/** healthz → headers + compression → static files (`dir` = dist/client); the rest falls through to Start. */
export function appMiddleware(dir: string): ServerMiddleware[] {
  const hashedAssets = staticMiddleware({ dir, maxAge: 31_536_000, immutable: true })
  const publicFiles = staticMiddleware({ dir, maxAge: 3_600 })
  const healthz: ServerMiddleware = (request, next) => {
    if (new URL(request.url).pathname !== '/healthz') return next()
    return new Response('ok\n', { headers: { 'content-type': 'text/plain', 'cache-control': 'no-store' } })
  }
  const assets: ServerMiddleware = (request, next) => {
    const { pathname } = new URL(request.url)
    if (pathname.startsWith('/api/')) return next() // never shadow the API proxy
    return (pathname.startsWith('/assets/') ? hashedAssets : publicFiles)(request, next)
  }
  return [healthz, appResponseHeaders(), assets]
}

/** Start's fetch with the request's CSP nonce in its context (read back by `getCspNonce`). */
export function appFetch(start: { fetch: StartFetch }): (request: ServerRequest) => Response | Promise<Response> {
  return (request) => {
    const nonce = request.context?.cspNonce
    return start.fetch(request, { context: { nonce: typeof nonce === 'string' ? nonce : undefined } })
  }
}

/** Bodies smaller than this go out uncompressed (not worth the bytes or the CPU). */
export const COMPRESS_MIN_BYTES = 1024
const COMPRESSIBLE = /^(text\/|application\/(javascript|json|xml|ld\+json|manifest\+json)|image\/svg\+xml)/i

export function contentSecurityPolicy(nonce: string): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}'`,
    // SSR'd `style` attributes (Recharts, motion) need it; no inline <style> blocks are emitted.
    "style-src 'self' 'unsafe-inline'",
    // blob: = picked-image previews; Neon object storage = presigned support-ticket attachments.
    "img-src 'self' data: blob: https://*.aws.neon.tech",
    // Vite inlines small font subsets (< 4 KiB) as data: URLs.
    "font-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    // Checkout leaves for SSLCommerz with `location.assign`, not a form post.
    "form-action 'self'",
  ].join('; ')
}

/** `br` over `gzip`, honouring `q=0`; `undefined` = send identity. */
export function pickEncoding(acceptEncoding: string | null): 'br' | 'gzip' | undefined {
  const q = new Map<string, number>()
  for (const part of (acceptEncoding ?? '').toLowerCase().split(',')) {
    const [name = '', ...params] = part.split(';').map((s) => s.trim())
    const qParam = params.find((p) => p.startsWith('q='))
    q.set(name, qParam ? Number(qParam.slice(2)) : 1)
  }
  return (['br', 'gzip'] as const).find((name) => (q.get(name) ?? 0) > 0)
}

/** Sets `request.context.cspNonce`, which `appFetch` hands to Start. */
export function appResponseHeaders(siteUrl = process.env.PUBLIC_SITE_URL): ServerMiddleware {
  const httpsSite = siteUrl?.startsWith('https://') ?? false
  return async (request, next) => {
    if (new URL(request.url).pathname.startsWith('/api/')) return next()

    const nonce = randomBytes(16).toString('base64')
    request.context = { ...request.context, cspNonce: nonce }
    // Headers are set in place and the response goes back as is unless it is compressed here. Never read
    // `response.body` just to copy it: srvx/static bodies are Node streams, and reading it wraps them in undici's
    // ReadableStreamFrom, whose queued close() throws uncaught (process exit) when a browser leaves as the stream
    // ends (M9-T13a, `ERR_INVALID_STATE: ReadableStream is already closed`).
    let response = await next()
    try {
      response.headers.set('X-Content-Type-Options', 'nosniff')
    } catch {
      // Immutable headers (Start's `Response.redirect`): copy. Such bodies are web streams or null.
      response = new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: new Headers(response.headers),
      })
    }
    const headers = response.headers
    headers.set('X-Content-Type-Options', 'nosniff')
    headers.set('X-Frame-Options', 'DENY')
    // Never `no-referrer`: same-origin POSTs would send `Origin: null` and Better Auth answers 403.
    headers.set('Referrer-Policy', 'strict-origin-when-cross-origin')
    headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()')
    headers.set('Content-Security-Policy-Report-Only', contentSecurityPolicy(nonce))
    const forwardedProto = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim()
    if (httpsSite || forwardedProto === 'https') {
      headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
    }
    return compress(request, response)
  }
}

async function compress(request: Request, response: Response): Promise<Response> {
  const headers = response.headers
  if (!COMPRESSIBLE.test(headers.get('content-type') ?? '')) return response

  if (!/(^|,)\s*accept-encoding\s*(,|$)/i.test(headers.get('vary') ?? '')) headers.append('Vary', 'Accept-Encoding')
  const encoding = pickEncoding(request.headers.get('accept-encoding'))
  const length = headers.get('content-length')
  if (
    !encoding ||
    request.method === 'HEAD' ||
    headers.has('content-encoding') ||
    // Byte ranges refer to the identity body; srvx/static marks every file it sends unencoded this way.
    headers.has('accept-ranges') ||
    response.status === 206 ||
    (length !== null && Number(length) < COMPRESS_MIN_BYTES) ||
    !response.body
  ) {
    return response
  }

  const init = { status: response.status, statusText: response.statusText, headers }
  // Streamed bodies (SSR) have no length: read up to the floor; a body that ends first goes out as is.
  const reader = response.body.getReader()
  const head: Uint8Array[] = []
  let size = 0
  while (size < COMPRESS_MIN_BYTES) {
    const { done, value } = await reader.read()
    if (done) return new Response(replay(head, reader), init)
    head.push(value)
    size += value.byteLength
  }

  // Flush per chunk so the SSR stream keeps streaming. Brotli 4: dynamic content, not max ratio.
  const zlib =
    encoding === 'br'
      ? createBrotliCompress({
          flush: constants.BROTLI_OPERATION_FLUSH,
          params: { [constants.BROTLI_PARAM_QUALITY]: 4 },
        })
      : createGzip({ flush: constants.Z_SYNC_FLUSH })
  headers.set('Content-Encoding', encoding)
  headers.delete('Content-Length')
  const etag = headers.get('etag')
  if (etag?.startsWith('"')) headers.set('ETag', `W/${etag}`)
  const pair = Duplex.toWeb(zlib) as unknown as ReadableWritablePair<Uint8Array, Uint8Array>
  return new Response(replay(head, reader).pipeThrough(pair), init)
}

function replay(head: Uint8Array[], reader: ReadableStreamDefaultReader<Uint8Array>): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of head) controller.enqueue(chunk)
    },
    async pull(controller) {
      const { done, value } = await reader.read()
      if (done) controller.close()
      else controller.enqueue(value)
    },
    cancel(reason) {
      return reader.cancel(reason)
    },
  })
}
