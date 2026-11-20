import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apiFetch, ApiError } from '@/lib/api'

const fetchMock = vi.fn<typeof fetch>()

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => vi.unstubAllGlobals())

async function caught(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise
  } catch (error) {
    if (error instanceof ApiError) return error
    throw error
  }
  throw new Error('expected a rejection')
}

describe('apiFetch', () => {
  it('sends same-origin JSON and returns the body', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: 1 }), { status: 200 }))
    await expect(apiFetch('/api/x', { method: 'PATCH', body: { isActive: true } })).resolves.toEqual({ ok: 1 })
    const [path, init] = fetchMock.mock.calls[0]!
    expect(path).toBe('/api/x')
    expect(init).toMatchObject({ method: 'PATCH', credentials: 'same-origin', body: '{"isActive":true}' })
    expect(init?.headers).toMatchObject({ 'content-type': 'application/json' })
  })

  it('sends FormData as-is, without a JSON content type (multipart boundary set by the browser)', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: 1 }), { status: 201 }))
    const form = new FormData()
    form.set('body', 'hi')
    await apiFetch('/api/x', { method: 'POST', body: form })
    const [, init] = fetchMock.mock.calls[0]!
    expect(init?.body).toBe(form)
    expect(init?.headers).toEqual({ accept: 'application/json' })
  })

  it('keeps status, code and details from the backend error body', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ statusCode: 409, message: 'Limit', code: 'PAGE_LIMIT_REACHED', details: { limit: 1 } }), {
        status: 409,
      }),
    )
    const error = await caught(apiFetch('/api/x'))
    expect(error).toMatchObject({ status: 409, code: 'PAGE_LIMIT_REACHED', details: { limit: 1 }, message: 'Limit' })
  })

  it('handles non-JSON errors, validation arrays and network failures', async () => {
    fetchMock.mockResolvedValueOnce(new Response('<html>Bad Gateway</html>', { status: 502 }))
    expect(await caught(apiFetch('/api/x'))).toMatchObject({ status: 502, code: undefined, details: undefined })

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ message: ['a', 'b'] }), { status: 400 }))
    expect((await caught(apiFetch('/api/x'))).message).toBe('a; b')

    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    const network = await caught(apiFetch('/api/x'))
    expect(network.status).toBe(0)
    expect(network.isNetwork).toBe(true)
  })
})
