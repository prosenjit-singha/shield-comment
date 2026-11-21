import { QueryClientProvider, type QueryClient } from '@tanstack/react-query'
import { createMemoryHistory, createRootRouteWithContext, createRoute, createRouter, Outlet, RouterProvider } from '@tanstack/react-router'
import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Language } from '@/lib/language'
import { LEGAL_FACTS } from '@/lib/legal'
import { createQueryClient } from '@/lib/query-client'
import { Route as BnPrivacyRoute } from '@/routes/bn_.privacy'
import { Route as BnRefundRoute } from '@/routes/bn_.refund-policy'
import { Route as BnTermsRoute } from '@/routes/bn_.terms'
import { Route as PrivacyRoute } from '@/routes/privacy'
import { Route as RefundRoute } from '@/routes/refund-policy'
import { Route as TermsRoute } from '@/routes/terms'
import { createLanguageStore, LanguageStoreContext } from '@/stores/language-store'
import { fetchMock, mockApi } from '@/test/auth-routes'

vi.mock('@/server/session', () => ({ getServerSession: vi.fn() }))
vi.mock('@/lib/request-context', () => ({ getSiteOrigin: () => 'http://app.test' }))

/** The real legal file routes (M9-T7) under a bare root; `/`, `/bn`, `/data-deletion` are stubs. */
function renderLegal(path: string, language: Language) {
  const rootRoute = createRootRouteWithContext<{ queryClient: QueryClient }>()({ component: Outlet })
  const stub = (p: string) => createRoute({ getParentRoute: () => rootRoute, path: p, component: () => <p>Stub {p}</p> })
  const mount = (route: { update: (options: never) => unknown }, p: string) =>
    route.update({ id: p, path: p, getParentRoute: () => rootRoute } as never) as ReturnType<typeof stub>
  const routeTree = rootRoute.addChildren([
    mount(PrivacyRoute, '/privacy'),
    mount(TermsRoute, '/terms'),
    mount(RefundRoute, '/refund-policy'),
    mount(BnPrivacyRoute, '/bn/privacy'),
    mount(BnTermsRoute, '/bn/terms'),
    mount(BnRefundRoute, '/bn/refund-policy'),
    stub('/'),
    stub('/bn'),
    stub('/data-deletion'),
  ])
  const queryClient = createQueryClient()
  const router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: [path] }), context: { queryClient } })
  render(
    <LanguageStoreContext value={createLanguageStore(language)}>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </LanguageStoreContext>,
  )
  return { router }
}

const copy = {
  en: {
    prefix: '',
    titles: { privacy: 'Privacy Policy', terms: 'Terms of Service', refund: 'Refund Policy' },
    updated: 'Last updated: 21 Nov 2026',
    contact: 'Contact us',
    email: 'Email',
    deletion: 'Data deletion status',
    legalNav: 'Legal',
    home: '/',
  },
  bn: {
    prefix: '/bn',
    titles: { privacy: 'প্রাইভেসি পলিসি', terms: 'সেবার শর্তাবলি', refund: 'রিফান্ড পলিসি' },
    updated: 'সর্বশেষ হালনাগাদ: ২১ নভেম্বর ২০২৬',
    contact: 'যোগাযোগ',
    email: 'ইমেইল',
    deletion: 'ডেটা মুছে ফেলার অবস্থা',
    legalNav: 'আইনি তথ্য',
    home: '/bn',
  },
} as const

const PAGES = [
  ['privacy', '/privacy'],
  ['terms', '/terms'],
  ['refund', '/refund-policy'],
] as const

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  vi.stubGlobal('scrollTo', () => {})
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe.each(['en', 'bn'] as const)('legal pages (%s)', (language) => {
  const t = copy[language]

  it.each(PAGES)('%s: heading, last-updated date, contact block, links, no request', async (page, path) => {
    mockApi({})
    renderLegal(`${t.prefix}${path}`, language)

    expect(await screen.findByRole('heading', { level: 1, name: t.titles[page] })).toBeTruthy()
    expect(screen.getByTestId('last-updated').textContent).toBe(t.updated)
    expect(screen.getByTestId('last-updated').querySelector('time')?.getAttribute('datetime')).toBe(LEGAL_FACTS.lastUpdated)

    expect(screen.getByRole('heading', { level: 2, name: t.contact })).toBeTruthy()
    const contact = screen.getByTestId('legal-contact')
    for (const value of [LEGAL_FACTS.legalName, LEGAL_FACTS.address, LEGAL_FACTS.phone, LEGAL_FACTS.tradeLicenceNo]) {
      expect(within(contact).getByText(value)).toBeTruthy()
    }
    expect(within(contact).getByRole('link', { name: LEGAL_FACTS.email }).getAttribute('href')).toBe(`mailto:${LEGAL_FACTS.email}`)

    // Links between the three pages stay in this page's language; the current one is marked.
    const nav = screen.getByRole('navigation', { name: t.legalNav })
    for (const [other, otherPath] of PAGES) {
      const link = within(nav).getByRole('link', { name: t.titles[other] })
      expect(link.getAttribute('href')).toBe(`${t.prefix}${otherPath}`)
      expect(link.getAttribute('aria-current')).toBe(other === page ? 'page' : null)
    }
    // EN | বাং switch points at this page's twin.
    expect(screen.getByRole('link', { name: 'EN' }).getAttribute('href')).toBe(path)
    expect(screen.getByRole('link', { name: 'বাং' }).getAttribute('href')).toBe(`/bn${path}`)
    expect(screen.getByRole('link', { name: 'ShieldComment BD' }).getAttribute('href')).toBe(t.home)

    // Every `{fact}` placeholder was filled.
    expect(document.body.textContent).not.toMatch(/\{\w+\}/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('privacy links the Meta Data Deletion page and names the 30-day raw payload purge', async () => {
    mockApi({})
    renderLegal(`${t.prefix}/privacy`, language)
    const link = await screen.findByRole('link', { name: t.deletion })
    expect(link.getAttribute('href')).toBe('/data-deletion')
    expect(document.body.textContent).toMatch(language === 'en' ? /deleted automatically after 30 days/ : /৩০ দিন পর স্বয়ংক্রিয়ভাবে মুছে যায়/)
  })

  it('terms + refund fill the business name and refund window from legal-facts.json', async () => {
    mockApi({})
    renderLegal(`${t.prefix}/terms`, language)
    await screen.findByRole('heading', { level: 1, name: t.titles.terms })
    expect(screen.getByText(new RegExp(LEGAL_FACTS.legalName.replace(/[[\].]/g, '\\$&')), { selector: 'header p' })).toBeTruthy()
    cleanup()
    renderLegal(`${t.prefix}/refund-policy`, language)
    await screen.findByRole('heading', { level: 1, name: t.titles.refund })
    expect(document.body.textContent).toContain(LEGAL_FACTS.refundWindowDays)
  })
})
