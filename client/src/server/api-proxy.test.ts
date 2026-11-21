// @vitest-environment node
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { buildForwardHeaders, proxyToApi } from './api-proxy'

describe('buildForwardHeaders', () => {
  it('appends this hop to X-Forwarded-* and drops Host and hop-by-hop headers', () => {
    const headers = buildForwardHeaders(
      new Headers({
        host: 'app.localhost:5174',
        connection: 'keep-alive',
        cookie: 'better-auth.session_token=abc',
        origin: 'http://app.localhost:5174',
      }),
      { clientIp: '172.18.0.1', host: 'app.localhost:5174', proto: 'http' },
    )
    expect(headers.get('host')).toBeNull()
    expect(headers.get('connection')).toBeNull()
    expect(headers.get('cookie')).toBe('better-auth.session_token=abc')
    expect(headers.get('origin')).toBe('http://app.localhost:5174')
    expect(headers.get('x-forwarded-for')).toBe('172.18.0.1')
    expect(headers.get('x-forwarded-host')).toBe('app.localhost:5174')
    expect(headers.get('x-forwarded-proto')).toBe('http')
  })

  it('keeps what a front proxy already set and extends the X-Forwarded-For chain', () => {
    const headers = buildForwardHeaders(
      new Headers({
        'x-forwarded-for': '203.0.113.7',
        'x-forwarded-host': 'app.example.com',
        'x-forwarded-proto': 'https',
      }),
      { clientIp: '10.0.0.2', host: 'client:5174', proto: 'http' },
    )
    expect(headers.get('x-forwarded-for')).toBe('203.0.113.7, 10.0.0.2')
    expect(headers.get('x-forwarded-host')).toBe('app.example.com')
    expect(headers.get('x-forwarded-proto')).toBe('https')
  })

  describe('FORWARDED_FOR_MODE=pass (Fly.io, M9-T10)', () => {
    afterEach(() => vi.unstubAllEnvs())

    it("forwards the edge's X-Forwarded-For unchanged (one hop on every path)", () => {
      vi.stubEnv('FORWARDED_FOR_MODE', 'pass')
      const headers = buildForwardHeaders(
        new Headers({
          'x-forwarded-for': '198.51.100.1, 203.0.113.7',
          'x-forwarded-proto': 'https',
          'fly-client-ip': '198.51.100.1',
        }),
        { clientIp: '172.16.5.10', host: 'app.example.com', proto: 'http' },
      )
      expect(headers.get('x-forwarded-for')).toBe('198.51.100.1, 203.0.113.7')
      expect(headers.get('x-forwarded-proto')).toBe('https')
      // The backend's client IP on Fly (M9-T14a): passed on as the edge set it.
      expect(headers.get('fly-client-ip')).toBe('198.51.100.1')
    })

    it('adds no X-Forwarded-For when the edge sent none (the backend falls back to the socket)', () => {
      vi.stubEnv('FORWARDED_FOR_MODE', 'pass')
      const headers = buildForwardHeaders(new Headers(), { clientIp: '172.16.5.10', host: 'app.example.com', proto: 'http' })
      expect(headers.get('x-forwarded-for')).toBeNull()
    })

    it('any other value appends as before', () => {
      vi.stubEnv('FORWARDED_FOR_MODE', 'append')
      const headers = buildForwardHeaders(new Headers({ 'x-forwarded-for': '203.0.113.7' }), {
        clientIp: '10.0.0.2',
        host: 'app.example.com',
        proto: 'http',
      })
      expect(headers.get('x-forwarded-for')).toBe('203.0.113.7, 10.0.0.2')
    })
  })
})

describe('proxyToApi', () => {
  let server: Server
  let upstream: string
  let seen: { method?: string; url?: string; headers: IncomingHttpHeaders; body: string }

  beforeAll(async () => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => {
        seen = { method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() }
        res.setHeader('set-cookie', ['a=1; Path=/; HttpOnly', 'b=2; Path=/'])
        res.setHeader('content-type', 'application/json')
        res.statusCode = 201
        res.end('{"ok":true}')
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    upstream = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))

  it('forwards method, path, query, body and cookies, and returns every Set-Cookie', async () => {
    const request = new Request('http://app.localhost:5174/api/auth/sign-in/email?x=1', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: 'shield-lang=bn' },
      body: '{"email":"a@b.co"}',
    })
    const response = await proxyToApi(request, '127.0.0.1', upstream)

    expect(seen.method).toBe('POST')
    expect(seen.url).toBe('/api/auth/sign-in/email?x=1')
    expect(seen.body).toBe('{"email":"a@b.co"}')
    expect(seen.headers.cookie).toBe('shield-lang=bn')
    expect(seen.headers['x-forwarded-for']).toBe('127.0.0.1')
    expect(seen.headers['x-forwarded-host']).toBe('app.localhost:5174')
    expect(seen.headers.host).toBe(new URL(upstream).host)

    expect(response.status).toBe(201)
    expect(response.headers.getSetCookie()).toEqual(['a=1; Path=/; HttpOnly', 'b=2; Path=/'])
    expect(await response.json()).toEqual({ ok: true })
  })

  it('answers 502 in the backend error shape when the API is down', async () => {
    const response = await proxyToApi(new Request('http://app.localhost:5174/api/health'), undefined, 'http://127.0.0.1:1')
    expect(response.status).toBe(502)
    expect(await response.json()).toMatchObject({ statusCode: 502, error: 'Bad Gateway', path: '/api/health' })
  })
})
