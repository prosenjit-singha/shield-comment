import { QueryClientProvider, type QueryClient } from '@tanstack/react-query'
import {
  createMemoryHistory,
  createRootRouteWithContext,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Language } from '@/lib/language'
import { createQueryClient } from '@/lib/query-client'
import { Route as DataDeletionRoute } from '@/routes/data-deletion'
import { createLanguageStore, LanguageStoreContext } from '@/stores/language-store'
import { callsTo, fetchMock, json, mockApi } from '@/test/auth-routes'

// Server-render paths need the Start compiler; the browser path never calls them.
vi.mock('@/server/session', () => ({ getServerSession: vi.fn() }))
vi.mock('@/server/data-deletion', () => ({
  getServerDataDeletionStatus: vi.fn(() => {
    throw new Error('server lookup must not run in the browser')
  }),
}))

const CODE = 'Ab3_-xYz0123456789_-QW'
const STATUS_PATH = `/api/meta/data-deletion/${CODE}`
const REQUESTED = '2026-11-19T04:05:00.000Z'
const COMPLETED = '2026-11-19T04:06:30.000Z'
const PENDING_BODY = { status: 'PENDING', requestedAt: REQUESTED, completedAt: null }
const COMPLETED_BODY = { status: 'COMPLETED', requestedAt: REQUESTED, completedAt: COMPLETED }

/** The real `/data-deletion` file route under a bare root (the generated tree pulls in Start server fns). */
function renderDataDeletion(path: string, language: Language) {
  const rootRoute = createRootRouteWithContext<{ queryClient: QueryClient }>()({ component: Outlet })
  const routeTree = rootRoute.addChildren([
    DataDeletionRoute.update({ id: '/data-deletion', path: '/data-deletion', getParentRoute: () => rootRoute } as never),
    createRoute({ getParentRoute: () => rootRoute, path: '/', component: () => <p>Landing stub</p> }),
  ])
  const queryClient = createQueryClient()
  const router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: [path] }), context: { queryClient } })
  const languageStore = createLanguageStore(language)
  render(
    <LanguageStoreContext value={languageStore}>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </LanguageStoreContext>,
  )
  return { router, languageStore }
}

const copy = {
  en: {
    title: 'Data deletion request',
    missing: /This link has no valid confirmation code.*Apps and websites → Removed/,
    pending: 'We received your request. Your data is being deleted.',
    pendingHint: /usually takes a few minutes/,
    completed: 'Your data has been deleted.',
    kept: /only keep daily comment counts per Page, which contain no personal data/,
    requested: 'Requested',
    completedLabel: 'Completed',
    requestedAt: '19 Nov 2026, 10:05 (Bangladesh time)',
    completedAt: '19 Nov 2026, 10:06 (Bangladesh time)',
    unknown: /couldn't find a request with this confirmation code/,
    rateLimited: /Too many checks in a short time/,
    unavailable: /couldn't check the status right now/,
    network: /Can't reach ShieldComment right now/,
    retry: 'Try again',
    code: 'Confirmation code',
    switchLabel: 'Switch to Bangla',
  },
  bn: {
    title: 'ডেটা মুছে ফেলার অনুরোধ',
    missing: /এই লিংকে কোনো সঠিক কনফার্মেশন কোড নেই।.*অ্যাপ ও ওয়েবসাইট → রিমুভ করা/,
    pending: 'আপনার অনুরোধ পেয়েছি। আপনার ডেটা মুছে ফেলা হচ্ছে।',
    pendingHint: /সাধারণত কয়েক মিনিট লাগে/,
    completed: 'আপনার ডেটা মুছে ফেলা হয়েছে।',
    kept: /দৈনিক কমেন্ট সংখ্যা রাখা হয়, যাতে কোনো ব্যক্তিগত তথ্য নেই/,
    requested: 'অনুরোধের সময়',
    completedLabel: 'সম্পন্ন হওয়ার সময়',
    requestedAt: '১৯ নভেম্বর ২০২৬, ১০:০৫ (বাংলাদেশ সময়)',
    completedAt: '১৯ নভেম্বর ২০২৬, ১০:০৬ (বাংলাদেশ সময়)',
    unknown: /এই কনফার্মেশন কোডে কোনো অনুরোধ পাওয়া যায়নি/,
    rateLimited: /অল্প সময়ে অনেকবার দেখা হয়েছে/,
    unavailable: /এখন অবস্থা দেখা যাচ্ছে না/,
    network: /এখন ShieldComment-এ সংযোগ করা যাচ্ছে না/,
    retry: 'আবার চেষ্টা করুন',
    code: 'কনফার্মেশন কোড',
    switchLabel: 'ইংরেজিতে দেখুন',
  },
} as const

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  vi.stubGlobal('scrollTo', () => {})
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe.each(['en', 'bn'] as const)('/data-deletion (%s)', (language) => {
  const t = copy[language]

  it.each([
    ['no code', '/data-deletion'],
    ['a malformed code', '/data-deletion?code=short'],
    ['a 23-character code', `/data-deletion?code=${CODE}x`],
    ['a code with base64 padding', `/data-deletion?code=${CODE.slice(2)}%3D%3D`],
  ])('%s: explains where the code comes from without a request', async (_name, path) => {
    mockApi({})
    renderDataDeletion(path, language)
    expect(await screen.findByRole('heading', { name: t.title })).toBeTruthy()
    expect(screen.getByText(t.missing).closest('[data-kind]')?.getAttribute('data-kind')).toBe('missing-code')
    expect(screen.queryByText(t.code)).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('PENDING: request received, requested date, code shown', async () => {
    mockApi({ [STATUS_PATH]: () => json(200, PENDING_BODY) })
    renderDataDeletion(`/data-deletion?code=${CODE}`, language)

    expect(await screen.findByText(t.pending)).toBeTruthy()
    expect(screen.getByText(t.pendingHint)).toBeTruthy()
    expect(screen.getByText(t.requested)).toBeTruthy()
    expect(screen.getByText(t.requestedAt)).toBeTruthy()
    expect(screen.queryByText(t.completedLabel)).toBeNull()
    expect(screen.queryByText(t.kept)).toBeNull()
    expect(screen.getByText(t.code)).toBeTruthy()
    expect(screen.getByTestId('confirmation-code').textContent).toBe(CODE)
    expect(callsTo(STATUS_PATH)).toEqual([{ path: STATUS_PATH, method: 'GET', body: undefined }])
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('COMPLETED: deleted, both dates and what is kept', async () => {
    mockApi({ [STATUS_PATH]: () => json(200, COMPLETED_BODY) })
    renderDataDeletion(`/data-deletion?code=${CODE}`, language)

    expect(await screen.findByText(t.completed)).toBeTruthy()
    expect(screen.getByText(t.completed).closest('[data-kind]')?.getAttribute('data-tone')).toBe('success')
    expect(screen.getByText(t.requestedAt)).toBeTruthy()
    expect(screen.getByText(t.completedLabel)).toBeTruthy()
    expect(screen.getByText(t.completedAt)).toBeTruthy()
    expect(screen.getByText(t.kept)).toBeTruthy()
    expect(screen.queryByText(t.pendingHint)).toBeNull()
    expect(callsTo(STATUS_PATH)).toHaveLength(1)
  })

  it('404: unknown code, no Try again', async () => {
    mockApi({ [STATUS_PATH]: () => json(404, { statusCode: 404, message: 'Unknown confirmation code' }) })
    renderDataDeletion(`/data-deletion?code=${CODE}`, language)

    expect(await screen.findByText(t.unknown)).toBeTruthy()
    expect(screen.getByRole('alert').getAttribute('data-kind')).toBe('unknown-code')
    expect(screen.queryByRole('button', { name: t.retry })).toBeNull()
    expect(screen.getByTestId('confirmation-code').textContent).toBe(CODE)
    expect(callsTo(STATUS_PATH)).toHaveLength(1)
  })

  it.each([
    ['429', 'rate-limited', () => json(429, { statusCode: 429, message: 'ThrottlerException: Too Many Requests' })],
    ['500', 'unavailable', () => json(500, { statusCode: 500, message: 'Internal server error' })],
    ['network', 'network', (): Response => {
      throw new TypeError('Failed to fetch')
    }],
  ] as const)('%s: message, then Try again refetches once', async (_name, kind, failure) => {
    let calls = 0
    mockApi({
      [STATUS_PATH]: () => {
        calls += 1
        return calls === 1 ? failure() : json(200, PENDING_BODY)
      },
    })
    renderDataDeletion(`/data-deletion?code=${CODE}`, language)

    const message = kind === 'rate-limited' ? t.rateLimited : kind === 'network' ? t.network : t.unavailable
    expect(await screen.findByText(message)).toBeTruthy()
    expect(screen.getByRole('alert').getAttribute('data-kind')).toBe(`lookup:${kind}`)
    expect(callsTo(STATUS_PATH)).toHaveLength(1) // no automatic retry

    fireEvent.click(screen.getByRole('button', { name: t.retry }))
    expect(await screen.findByText(t.pending)).toBeTruthy()
    expect(screen.queryByText(message)).toBeNull()
    expect(callsTo(STATUS_PATH)).toHaveLength(2)
  })

  it('switches language in place without a new request', async () => {
    mockApi({ [STATUS_PATH]: () => json(200, PENDING_BODY) })
    const { languageStore } = renderDataDeletion(`/data-deletion?code=${CODE}`, language)
    expect(await screen.findByText(t.pending)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: t.switchLabel }))
    const other = copy[language === 'en' ? 'bn' : 'en']
    await waitFor(() => expect(screen.getByText(other.pending)).toBeTruthy())
    expect(screen.getByText(other.requestedAt)).toBeTruthy()
    expect(languageStore.getState().language).toBe(language === 'en' ? 'bn' : 'en')
    expect(callsTo(STATUS_PATH)).toHaveLength(1)
  })
})
