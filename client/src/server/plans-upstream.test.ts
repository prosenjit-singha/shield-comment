// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/lib/api'
import { fetchPlansUpstream } from './plans-upstream'

const UPSTREAM = 'http://backend:3000'
const BODY = { items: [], yearlySaveUpToPercent: 10, contactWhatsapp: null }
const fetchMock = vi.fn<typeof fetch>()

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('fetchPlansUpstream', () => {
  it('GETs the public plans from the backend without a cookie', async () => {
    fetchMock.mockResolvedValue(Response.json(BODY))
    await expect(fetchPlansUpstream(UPSTREAM)).resolves.toEqual(BODY)

    const [input, init] = fetchMock.mock.calls[0] ?? []
    expect(String(input)).toBe('http://backend:3000/api/plans')
    expect(new Headers(init?.headers).get('cookie')).toBeNull()
    expect(init?.signal).toBeInstanceOf(AbortSignal)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['a 503', () => Promise.resolve(new Response('down', { status: 503 })), 503],
    ['no response', () => Promise.reject(new TypeError('fetch failed')), 0],
    ['a non-JSON body', () => Promise.resolve(new Response('<html>', { status: 200 })), 502],
  ])('%s → ApiError', async (_name, answer, status) => {
    fetchMock.mockImplementation(answer)
    const error: unknown = await fetchPlansUpstream(UPSTREAM).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ApiError)
    expect((error as ApiError).status).toBe(status)
  })
})
