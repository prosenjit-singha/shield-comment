/**
 * Same-origin `/api/*` proxy for the Start server (tech-stack.md §4). The browser only ever talks to
 * app.<domain>; this forwards to the backend so Better Auth cookies stay host-only to the client app.
 * Mirrors admin/nginx.conf.template: Host becomes the upstream's, X-Forwarded-For/Host/Proto are set.
 */

/** Read per call (not at module scope) so the runtime env wins over anything seen at build time. */
export function apiUpstream(): string {
  return process.env.API_UPSTREAM ?? 'http://localhost:3000'
}

// RFC 9110 §7.6.1 connection-specific headers, plus Host (fetch sets the upstream's).
const HOP_BY_HOP = [
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
]

export interface ForwardInfo {
  /** Peer address of the browser (or of the front proxy in prod). */
  clientIp?: string
  /** Host the browser asked for, e.g. `app.localhost:5174`. */
  host: string
  /** `http` or `https`, as seen by this server. */
  proto: string
}

/**
 * Copies request headers for the upstream call and appends this hop to X-Forwarded-*.
 * `FORWARDED_FOR_MODE=pass` (Fly.io, read per call): X-Forwarded-For goes on as the edge sent it, so the
 * backend counts the same TRUST_PROXY_HOPS here and on the direct api.<domain> path (deploy.md "Client IP").
 */
export function buildForwardHeaders(source: Headers, info: ForwardInfo): Headers {
  const headers = new Headers(source)
  for (const name of HOP_BY_HOP) headers.delete(name)

  const prior = source.get('x-forwarded-for')
  if (info.clientIp && process.env.FORWARDED_FOR_MODE !== 'pass') {
    headers.set('x-forwarded-for', prior ? `${prior}, ${info.clientIp}` : info.clientIp)
  }
  // Keep values a front proxy (TLS terminator) already set; otherwise use what this server saw.
  headers.set('x-forwarded-host', source.get('x-forwarded-host') ?? info.host)
  headers.set('x-forwarded-proto', source.get('x-forwarded-proto') ?? info.proto)
  return headers
}

/** Response headers that must not be copied: fetch already decoded the body and re-frames it. */
const STRIP_FROM_RESPONSE = [...HOP_BY_HOP, 'content-encoding', 'content-length']

// Node's fetch needs `duplex: 'half'` to stream a request body; the DOM RequestInit type lacks it.
type StreamingRequestInit = RequestInit & { duplex?: 'half' }

export async function proxyToApi(
  request: Request,
  clientIp: string | undefined,
  upstream: string = apiUpstream(),
): Promise<Response> {
  const url = new URL(request.url)
  const target = new URL(`${url.pathname}${url.search}`, upstream)
  const hasBody = request.method !== 'GET' && request.method !== 'HEAD'

  const init: StreamingRequestInit = {
    method: request.method,
    headers: buildForwardHeaders(request.headers, {
      clientIp,
      host: url.host,
      proto: url.protocol.replace(/:$/, ''),
    }),
    body: hasBody ? request.body : undefined,
    duplex: hasBody ? 'half' : undefined,
    redirect: 'manual', // 3xx (e.g. OAuth later) goes back to the browser untouched
    signal: request.signal,
  }

  let upstreamResponse: Response
  try {
    upstreamResponse = await fetch(target, init)
  } catch {
    // Same error shape as the backend's AllExceptionsFilter.
    return Response.json(
      {
        statusCode: 502,
        error: 'Bad Gateway',
        message: 'The API is unreachable',
        path: url.pathname,
        timestamp: new Date().toISOString(),
      },
      { status: 502 },
    )
  }

  const headers = new Headers(upstreamResponse.headers) // keeps every Set-Cookie as its own entry
  for (const name of STRIP_FROM_RESPONSE) headers.delete(name)
  return new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers,
  })
}
