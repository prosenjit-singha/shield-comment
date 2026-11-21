// @vitest-environment node
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { serve, type Server } from 'srvx'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  appFetch,
  appMiddleware,
  appResponseHeaders,
  COMPRESS_MIN_BYTES,
  contentSecurityPolicy,
  pickEncoding,
} from '../../server-http.ts'

// A real srvx server with server.mjs's middleware chain; a fake Start answers what static files don't.
const BIG_HTML = `<!doctype html><html><head></head><body>${'<p>shield</p>'.repeat(300)}</body></html>`
const seenNonces: (string | undefined)[] = []

function fakeStart(request: Request, opts: { context: { nonce?: string } }): Response {
  const { pathname } = new URL(request.url)
  seenNonces.push(opts.context.nonce)
  const html = { 'content-type': 'text/html; charset=utf-8' }
  if (pathname === '/') {
    // Streamed like Start's SSR: no Content-Length, several chunks.
    const chunks = [BIG_HTML.slice(0, 600), BIG_HTML.slice(600, 1500), BIG_HTML.slice(1500)]
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk))
        controller.close()
      },
    })
    return new Response(body, { headers: { ...html, 'set-cookie': 'a=1; Path=/' } })
  }
  if (pathname === '/missing') return new Response(BIG_HTML, { status: 404, headers: html })
  if (pathname === '/robots.txt') return new Response('User-agent: *\nAllow: /\n', { headers: { 'content-type': 'text/plain' } })
  if (pathname === '/api/health/live') {
    return Response.json(
      { status: 'ok', pad: 'x'.repeat(4000) },
      { headers: { 'referrer-policy': 'no-referrer', 'x-frame-options': 'SAMEORIGIN', 'cache-control': 'no-store' } },
    )
  }
  throw new Error(`unexpected request to the fake Start: ${request.method} ${pathname}`)
}

let server: Server
let dir: string
const get = (path: string, encoding = 'identity', extra: Record<string, string> = {}) =>
  fetch(new URL(path, server.url), { headers: { 'accept-encoding': encoding, ...extra } })

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'server-http-'))
  mkdirSync(join(dir, 'assets'))
  writeFileSync(join(dir, 'assets', 'app-abc123.js'), `console.log(${JSON.stringify('x'.repeat(5000))})`)
  writeFileSync(join(dir, 'assets', 'logo-abc123.png'), Buffer.alloc(5000, 7))
  server = serve({
    port: 0,
    hostname: '127.0.0.1',
    silent: true,
    middleware: appMiddleware(dir),
    fetch: appFetch({ fetch: fakeStart }),
  })
  await server.ready()
})

afterAll(async () => {
  await server.close(true)
  rmSync(dir, { recursive: true, force: true })
})

function expectSecurityHeaders(res: Response) {
  expect(res.headers.get('x-content-type-options')).toBe('nosniff')
  expect(res.headers.get('x-frame-options')).toBe('DENY')
  expect(res.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin')
  expect(res.headers.get('permissions-policy')).toContain('camera=()')
  expect(res.headers.get('content-security-policy-report-only')).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9+/=]{24}'/)
  expect(res.headers.get('content-security-policy')).toBeNull()
  // Plain http, no X-Forwarded-Proto, no https PUBLIC_SITE_URL.
  expect(res.headers.get('strict-transport-security')).toBeNull()
}

describe('server-http (client server.mjs middleware)', () => {
  it('SSR HTML: security headers, the nonce handed to Start matches the CSP, cookies kept', async () => {
    const res = await get('/')
    expect(res.status).toBe(200)
    expectSecurityHeaders(res)
    const nonce = seenNonces.at(-1)
    expect(nonce).toMatch(/^[A-Za-z0-9+/=]{24}$/)
    expect(res.headers.get('content-security-policy-report-only')).toContain(`'nonce-${nonce}'`)
    expect(res.headers.getSetCookie()).toEqual(['a=1; Path=/'])
    expect(res.headers.get('vary')).toBe('Accept-Encoding')
    expect(res.headers.get('content-encoding')).toBeNull()
    expect(await res.text()).toBe(BIG_HTML)
  })

  it('a new nonce on every request', async () => {
    await get('/')
    await get('/')
    const [a, b] = seenNonces.slice(-2)
    expect(a).not.toBe(b)
  })

  it.each([
    ['gzip, deflate, br', 'br'],
    ['gzip, deflate', 'gzip'],
    ['br;q=0, gzip', 'gzip'],
  ])('streamed HTML is compressed per Accept-Encoding %s → %s', async (accept, expected) => {
    const res = await get('/', accept)
    expect(res.headers.get('content-encoding')).toBe(expected)
    expect(res.headers.get('content-length')).toBeNull()
    expect(res.headers.get('vary')).toBe('Accept-Encoding')
    expect(await res.text()).toBe(BIG_HTML) // fetch decodes it
  })

  it('404 HTML gets the headers and compression', async () => {
    const res = await get('/missing', 'gzip')
    expect(res.status).toBe(404)
    expectSecurityHeaders(res)
    expect(res.headers.get('content-encoding')).toBe('gzip')
    expect(await res.text()).toBe(BIG_HTML)
  })

  it('a body below the size floor is sent as is (with Vary and a correct Content-Length)', async () => {
    const res = await get('/robots.txt', 'gzip, br')
    expectSecurityHeaders(res)
    expect(res.headers.get('content-encoding')).toBeNull()
    expect(res.headers.get('vary')).toBe('Accept-Encoding')
    const body = await res.text()
    expect(body).toBe('User-agent: *\nAllow: /\n')
    expect(body.length).toBeLessThan(COMPRESS_MIN_BYTES)
    const length = res.headers.get('content-length')
    if (length !== null) expect(Number(length)).toBe(body.length)
  })

  it('static JS: headers added, srvx/static compression kept (not compressed twice)', async () => {
    const res = await get('/assets/app-abc123.js', 'gzip, br')
    expectSecurityHeaders(res)
    expect(res.headers.get('content-encoding')).toBe('br')
    expect(res.headers.get('vary')).toBe('Accept-Encoding')
    expect(res.headers.get('cache-control')).toContain('immutable')
    expect(await res.text()).toContain('console.log')
  })

  it('png is never compressed and has no Vary', async () => {
    const res = await get('/assets/logo-abc123.png', 'gzip, br')
    expectSecurityHeaders(res)
    expect(res.headers.get('content-encoding')).toBeNull()
    expect(res.headers.get('vary')).toBeNull()
    expect(res.headers.get('content-length')).toBe('5000')
  })

  it('/healthz is unchanged', async () => {
    const res = await get('/healthz', 'gzip, br')
    expect(await res.text()).toBe('ok\n')
    expect([...res.headers.keys()].filter((k) => !['date', 'connection', 'keep-alive', 'content-length', 'transfer-encoding'].includes(k)).sort()).toEqual([
      'cache-control',
      'content-type',
    ])
  })

  it('/api/* passes the backend headers through, untouched and uncompressed', async () => {
    const res = await get('/api/health/live', 'gzip, br')
    expect(res.headers.get('referrer-policy')).toBe('no-referrer')
    expect(res.headers.get('x-frame-options')).toBe('SAMEORIGIN')
    expect(res.headers.get('content-security-policy-report-only')).toBeNull()
    expect(res.headers.get('x-content-type-options')).toBeNull()
    expect(res.headers.get('content-encoding')).toBeNull()
    expect(res.headers.get('vary')).toBeNull()
    expect(((await res.json()) as { status: string }).status).toBe('ok')
  })
})

describe('HSTS', () => {
  const html = () => new Response('<p>hi</p>', { headers: { 'content-type': 'text/html' } })
  const run = (siteUrl: string | undefined, headers: Record<string, string> = {}) =>
    appResponseHeaders(siteUrl)(new Request('http://app.localhost/', { headers }), html)

  it('only when the request came over https or the public site is https', async () => {
    expect((await run(undefined)).headers.get('strict-transport-security')).toBeNull()
    expect((await run('http://app.localhost:5174')).headers.get('strict-transport-security')).toBeNull()
    expect((await run(undefined, { 'x-forwarded-proto': 'http' })).headers.get('strict-transport-security')).toBeNull()
    expect((await run(undefined, { 'x-forwarded-proto': 'https' })).headers.get('strict-transport-security')).toBe(
      'max-age=31536000; includeSubDomains',
    )
    expect((await run('https://app.example.com')).headers.get('strict-transport-security')).toContain('max-age=31536000')
  })
})

describe('pickEncoding / contentSecurityPolicy', () => {
  it.each([
    [null, undefined],
    ['', undefined],
    ['identity', undefined],
    ['gzip', 'gzip'],
    ['br', 'br'],
    ['gzip;q=1.0, br;q=0.5', 'br'],
    ['BR;Q=0, GZIP;q=0', undefined],
    ['deflate', undefined],
  ])('%s → %s', (header, expected) => {
    expect(pickEncoding(header)).toBe(expected)
  })

  it('policy: nonce scripts, same-origin fetches, no framing, no base/form hijack', () => {
    const csp = contentSecurityPolicy('abc')
    for (const directive of [
      "default-src 'self'",
      "script-src 'self' 'nonce-abc'",
      "connect-src 'self'",
      "font-src 'self' data:",
      "img-src 'self' data: blob: https://*.aws.neon.tech",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "object-src 'none'",
    ]) {
      expect(csp).toContain(directive)
    }
    expect(csp).not.toContain('unsafe-eval')
    expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/)
  })
})
