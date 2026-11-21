// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchDataDeletionStatusUpstream } from './data-deletion-upstream'

const CODE = 'Ab3_-xYz0123456789_-QW'
const UPSTREAM = 'http://backend:3000'
const STATUS = { status: 'PENDING', requestedAt: '2026-11-19T04:05:00.000Z', completedAt: null }

const fetchMock = vi.fn<typeof fetch>()

function pageRequest(headers: Record<string, string> = {}): Request {
  return new Request(`http://app.localhost:5174/data-deletion?code=${CODE}`, {
    headers: {
      cookie: 'better-auth.session_token=secret',
      'user-agent': 'Mozilla/5.0 test',
      'accept-language': 'bn-BD',
      ...headers,
    },
  })
}

function lastCall(): { url: string; headers: Headers; init: RequestInit | undefined } {
  const [input, init] = fetchMock.mock.calls.at(-1) ?? []
  return { url: String(input), headers: new Headers(init?.headers), init }
}

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('fetchDataDeletionStatusUpstream', () => {
  it('calls the backend status route once with the forwarded visitor IP and no cookie', async () => {
    fetchMock.mockResolvedValue(Response.json(STATUS))
    const result = await fetchDataDeletionStatusUpstream(CODE, pageRequest(), '203.0.113.9', UPSTREAM)

    expect(result).toEqual({ kind: 'found', request: STATUS })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const { url, headers, init } = lastCall()
    expect(url).toBe(`${UPSTREAM}/api/meta/data-deletion/${CODE}`)
    expect(init?.method ?? 'GET').toBe('GET')
    expect(init?.redirect).toBe('manual')
    expect(headers.get('x-forwarded-for')).toBe('203.0.113.9')
    expect(headers.get('x-forwarded-host')).toBe('app.localhost:5174')
    expect(headers.get('x-forwarded-proto')).toBe('http')
    expect(headers.get('user-agent')).toBe('Mozilla/5.0 test')
    expect(headers.get('accept')).toBe('application/json')
    expect(headers.get('cookie')).toBeNull()
    expect(headers.get('host')).toBeNull()
  })

  it('extends an X-Forwarded-For chain a front proxy set and keeps its host/proto', async () => {
    fetchMock.mockResolvedValue(Response.json(STATUS))
    await fetchDataDeletionStatusUpstream(
      CODE,
      pageRequest({
        'x-forwarded-for': '198.51.100.4',
        'x-forwarded-host': 'app.example.com',
        'x-forwarded-proto': 'https',
        'fly-client-ip': '198.51.100.4',
      }),
      '10.0.0.2',
      UPSTREAM,
    )
    const { headers } = lastCall()
    expect(headers.get('fly-client-ip')).toBe('198.51.100.4') // the backend's client IP on Fly (M9-T14a)
    expect(headers.get('x-forwarded-for')).toBe('198.51.100.4, 10.0.0.2')
    expect(headers.get('x-forwarded-host')).toBe('app.example.com')
    expect(headers.get('x-forwarded-proto')).toBe('https')
  })

  it('URL-encodes the code in the path', async () => {
    fetchMock.mockResolvedValue(Response.json(STATUS))
    await fetchDataDeletionStatusUpstream('a/b?c', pageRequest(), undefined, UPSTREAM)
    expect(lastCall().url).toBe(`${UPSTREAM}/api/meta/data-deletion/a%2Fb%3Fc`)
  })

  it('answers 404 as an unknown code', async () => {
    fetchMock.mockResolvedValue(Response.json({ statusCode: 404, message: 'Unknown confirmation code' }, { status: 404 }))
    await expect(fetchDataDeletionStatusUpstream(CODE, pageRequest(), undefined, UPSTREAM)).resolves.toEqual({
      kind: 'unknown',
    })
  })

  it.each([429, 500, 503])('throws ApiError(%i) for other failures', async (status) => {
    fetchMock.mockResolvedValue(Response.json({ statusCode: status }, { status }))
    await expect(fetchDataDeletionStatusUpstream(CODE, pageRequest(), undefined, UPSTREAM)).rejects.toMatchObject({
      name: 'ApiError',
      status,
    })
  })

  it('throws ApiError(0) when the backend is unreachable', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'))
    await expect(fetchDataDeletionStatusUpstream(CODE, pageRequest(), undefined, UPSTREAM)).rejects.toMatchObject({
      status: 0,
    })
  })

  it('treats a non-JSON or wrongly shaped 200 as a server failure (502)', async () => {
    fetchMock.mockResolvedValueOnce(new Response('<html>', { status: 200 }))
    await expect(fetchDataDeletionStatusUpstream(CODE, pageRequest(), undefined, UPSTREAM)).rejects.toMatchObject({
      status: 502,
    })
    fetchMock.mockResolvedValueOnce(Response.json({ status: 'DONE' }))
    await expect(fetchDataDeletionStatusUpstream(CODE, pageRequest(), undefined, UPSTREAM)).rejects.toMatchObject({
      status: 502,
    })
  })
})
