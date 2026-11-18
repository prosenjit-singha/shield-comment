import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Language } from '@/lib/language'
import type { MetaOAuthErrorReason } from '@/lib/meta-pages'
import {
  IMPERSONATED,
  META_DIALOG,
  OAUTH_URL,
  PAGES,
  SECOND,
  SESSION,
  page,
  pagesApi,
  renderAppRoute,
  stubAppGlobals,
  toggleUrl,
} from '@/test/app-routes'
import { apiCalls, callsTo, fetchMock, json, mockApi } from '@/test/auth-routes'

// The server-render session function needs the Start compiler; the browser path never calls it.
vi.mock('@/server/session', () => ({ getServerSession: vi.fn() }))

// Real `_app` + `/onboarding` + `/dashboard` (harness: `src/test/app-routes.tsx`).
const renderOnboarding = (path = '/onboarding', language: Language = 'en') => renderAppRoute(path, language)

const copy = {
  en: {
    title: 'Connect your Facebook Page and Instagram',
    connect: 'Continue with Facebook',
    reconnect: 'Reconnect Facebook',
    connected: 'Facebook connected',
    skip: 'Skip for now',
    finish: 'Finish setup',
    finishHint: 'Switch on at least one Page to finish.',
    empty: 'Your Pages will show up here after you connect Facebook.',
    emptyAfterConnect: 'Facebook didn’t share any Pages with us.',
    protect: (name: string) => `Protect ${name}`,
    limit: (active: number, limit: number) => `${active} / ${limit} Pages on`,
    noInstagram: 'No Instagram account linked',
    on: 'Protected',
    off: 'Off',
    needsReconnect: 'Reconnect needed',
    impersonated: 'Connecting Facebook is turned off during Admin Impersonation',
    connectedNotice: 'Facebook connected. Switch on protection for the Pages you want below.',
    skipped: '2 Pages were skipped because they are already connected to another ShieldComment workspace.',
    errorPrefix: 'Facebook wasn’t connected.',
    limitReached:
      'Your plan allows 1 active Page and 1 is already on. Switch another Page off or upgrade your plan to protect more.',
    tokenMissing: 'Reconnect Facebook and include this Page',
    loadFailed: 'Couldn’t load your Pages.',
    retry: 'Try again',
    dashboard: 'Dashboard',
    connectErrors: {
      503: 'Facebook connection isn’t set up on our server yet.',
      409: 'This workspace isn’t the one you’re currently using.',
      403: 'You don’t have permission to connect Facebook.',
      500: 'The server is unavailable right now.',
      0: 'Can’t reach the server.',
    },
    reasons: {
      access_denied: 'You cancelled the Facebook window',
      invalid_state: 'The connection link expired or was already used.',
      unauthenticated: 'You were logged out while connecting.',
      state_mismatch: 'started from another account or workspace',
      impersonation_blocked: 'Facebook can’t be connected during Admin Impersonation.',
      forbidden: 'Only workspace owners and admins can connect Facebook',
      missing_code: 'Facebook didn’t finish the connection.',
      not_configured: 'Facebook connection isn’t set up on our server yet.',
      meta_unavailable: 'Facebook is busy or unreachable right now.',
      meta_error: 'Facebook refused the connection.',
      server_error: 'Something went wrong on our side while saving the connection.',
    } satisfies Record<MetaOAuthErrorReason, string>,
    unknownReason: 'The connection didn’t finish. Try again.',
  },
  bn: {
    title: 'আপনার ফেসবুক পেজ ও ইনস্টাগ্রাম কানেক্ট করুন',
    connect: 'ফেসবুক দিয়ে চালিয়ে যান',
    reconnect: 'আবার ফেসবুক কানেক্ট করুন',
    connected: 'ফেসবুক কানেক্ট হয়েছে',
    skip: 'এখন থাক',
    finish: 'সেটআপ শেষ করুন',
    finishHint: 'শেষ করতে অন্তত একটি পেজ চালু করুন।',
    empty: 'ফেসবুক কানেক্ট করার পর আপনার পেজগুলো এখানে দেখাবে।',
    emptyAfterConnect: 'ফেসবুক আমাদের সাথে কোনো পেজ শেয়ার করেনি।',
    protect: (name: string) => `${name} সুরক্ষিত রাখুন`,
    limit: (active: number, limit: number) =>
      `${new Intl.NumberFormat('bn-BD').format(active)} / ${new Intl.NumberFormat('bn-BD').format(limit)}টি পেজ চালু`,
    noInstagram: 'কোনো ইনস্টাগ্রাম অ্যাকাউন্ট যুক্ত নেই',
    on: 'সুরক্ষিত',
    off: 'বন্ধ',
    needsReconnect: 'আবার কানেক্ট দরকার',
    impersonated: 'অ্যাডমিন ইমপারসোনেশনের সময় ফেসবুক কানেক্ট করা বন্ধ থাকে',
    connectedNotice: 'ফেসবুক কানেক্ট হয়েছে। নিচে যে পেজগুলো সুরক্ষিত রাখতে চান সেগুলো চালু করুন।',
    skipped: '২টি পেজ বাদ দেওয়া হয়েছে, কারণ সেগুলো আগে থেকেই অন্য একটি ShieldComment ওয়ার্কস্পেসে কানেক্ট করা আছে।',
    errorPrefix: 'ফেসবুক কানেক্ট হয়নি।',
    limitReached:
      'আপনার প্ল্যানে ১টি পেজ চালু রাখা যায় এবং ১টি আগে থেকেই চালু আছে। আরও পেজ সুরক্ষিত রাখতে অন্য একটি পেজ বন্ধ করুন বা প্ল্যান আপগ্রেড করুন।',
    tokenMissing: 'ফেসবুক আবার কানেক্ট করুন এবং এই পেজটি সিলেক্ট করুন',
    loadFailed: 'আপনার পেজগুলো লোড করা যায়নি।',
    retry: 'আবার চেষ্টা করুন',
    dashboard: 'ড্যাশবোর্ড',
    connectErrors: {
      503: 'আমাদের সার্ভারে ফেসবুক কানেকশন এখনো সেট আপ করা হয়নি।',
      409: 'এই ওয়ার্কস্পেসটি আপনার বর্তমানে ব্যবহৃত ওয়ার্কস্পেস নয়।',
      403: 'ফেসবুক কানেক্ট করার অনুমতি আপনার নেই।',
      500: 'সার্ভার এই মুহূর্তে পাওয়া যাচ্ছে না।',
      0: 'সার্ভারে সংযোগ করা যাচ্ছে না।',
    },
    reasons: {
      access_denied: 'আপনি ফেসবুকের উইন্ডোটি বাতিল করেছেন',
      invalid_state: 'কানেকশন লিংকের মেয়াদ শেষ হয়ে গেছে',
      unauthenticated: 'কানেক্ট করার সময় আপনি লগ আউট হয়ে গিয়েছিলেন।',
      state_mismatch: 'অন্য অ্যাকাউন্ট বা ওয়ার্কস্পেস থেকে শুরু হয়েছিল',
      impersonation_blocked: 'অ্যাডমিন ইমপারসোনেশনের সময় ফেসবুক কানেক্ট করা যায় না।',
      forbidden: 'শুধু ওয়ার্কস্পেসের মালিক ও অ্যাডমিন ফেসবুক কানেক্ট করতে পারেন',
      missing_code: 'ফেসবুক কানেকশনটি সম্পূর্ণ করেনি।',
      not_configured: 'আমাদের সার্ভারে ফেসবুক কানেকশন এখনো সেট আপ করা হয়নি।',
      meta_unavailable: 'ফেসবুক এই মুহূর্তে ব্যস্ত বা পাওয়া যাচ্ছে না।',
      meta_error: 'ফেসবুক কানেকশনটি গ্রহণ করেনি।',
      server_error: 'কানেকশন সেভ করার সময় আমাদের দিকে একটি সমস্যা হয়েছে।',
    } satisfies Record<MetaOAuthErrorReason, string>,
    unknownReason: 'কানেকশনটি সম্পূর্ণ হয়নি। আবার চেষ্টা করুন।',
  },
} as const

const switchFor = (name: string, language: Language) =>
  screen.findByRole('switch', { name: copy[language].protect(name) })

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  stubAppGlobals()
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe.each(['en', 'bn'] as const)('/onboarding (%s)', (language) => {
  const t = copy[language]

  describe('connect step', () => {
    it('asks the backend for the Meta dialog URL (returnTo=/onboarding) and leaves for it', async () => {
      mockApi({
        '/api/auth/get-session': () => json(200, SESSION),
        ...pagesApi([]),
        [OAUTH_URL]: () => json(200, { url: META_DIALOG }),
      })
      renderOnboarding('/onboarding', language)

      expect(await screen.findByRole('heading', { name: t.title })).toBeTruthy()
      expect(await screen.findByText(t.empty)).toBeTruthy()
      expect(screen.getByRole('list', { name: /Setup steps|সেটআপের ধাপ/ }).querySelector('[aria-current="step"]')?.textContent).toBe(
        language === 'en' ? 'Connect' : 'কানেক্ট',
      )
      const location = { href: 'http://localhost/onboarding' }
      vi.stubGlobal('location', location)

      fireEvent.click(screen.getByRole('button', { name: t.connect }))

      await waitFor(() => expect(location.href).toBe(META_DIALOG))
      const [call] = fetchMock.mock.calls.filter(([input]) => String(input).startsWith(OAUTH_URL))
      expect(new URL(String(call![0]), 'http://localhost').searchParams.get('returnTo')).toBe('/onboarding')
      expect(callsTo(OAUTH_URL)).toHaveLength(1)
      expect(callsTo(OAUTH_URL)[0]!.method).toBe('GET')
    })

    it.each([503, 409, 403, 500, 0] as const)('explains a failed connect (%s)', async (status) => {
      mockApi({
        '/api/auth/get-session': () => json(200, SESSION),
        ...pagesApi([]),
        [OAUTH_URL]: () =>
          status === 0
            ? Promise.reject(new TypeError('Failed to fetch'))
            : json(status, { statusCode: status, message: 'backend text never shown' }),
      })
      renderOnboarding('/onboarding', language)

      fireEvent.click(await screen.findByRole('button', { name: t.connect }))
      const alert = await screen.findByRole('alert')
      expect(alert.dataset.kind).toBe(`connect:${status}`)
      expect(alert.textContent).toContain(t.connectErrors[status])
      expect(alert.textContent).not.toContain('backend text')
      // The button is usable again.
      expect(screen.getByRole('button', { name: t.connect })).toHaveProperty('disabled', false)
    })

    it('replaces the connect button with a notice while impersonating (D5), toggles still work', async () => {
      mockApi({ '/api/auth/get-session': () => json(200, IMPERSONATED), ...pagesApi([page()]) })
      renderOnboarding('/onboarding', language)

      const notice = await screen.findByText((_, node) => node?.textContent?.startsWith(t.impersonated) === true && node.tagName === 'P')
      expect(notice.closest('[data-kind]')?.getAttribute('data-kind')).toBe('impersonation-connect-blocked')
      expect(screen.queryByRole('button', { name: t.connect })).toBeNull()
      expect(screen.queryByRole('button', { name: t.reconnect })).toBeNull()

      fireEvent.click(await switchFor('Rahim Fashion', language))
      await waitFor(() => expect(callsTo(toggleUrl('p1'))).toHaveLength(1))
      expect(callsTo(OAUTH_URL)).toHaveLength(0)
    })
  })

  describe('return from Meta', () => {
    it('confirms ?meta=connected', async () => {
      mockApi({ '/api/auth/get-session': () => json(200, SESSION), ...pagesApi([page()]) })
      renderOnboarding('/onboarding?meta=connected', language)

      const status = await screen.findByText(t.connectedNotice)
      expect(status.closest('[role="status"]')?.getAttribute('data-kind')).toBe('connected')
      expect(screen.queryByText(t.skipped)).toBeNull()
      expect(await screen.findByRole('heading', { name: t.connected })).toBeTruthy()
      expect(screen.getByRole('button', { name: t.reconnect })).toBeTruthy()
    })

    it('reports Pages skipped because another workspace holds them (?skipped=2)', async () => {
      mockApi({ '/api/auth/get-session': () => json(200, SESSION), ...pagesApi([page()]) })
      renderOnboarding('/onboarding?meta=connected&skipped=2', language)

      expect(await screen.findByText(t.connectedNotice)).toBeTruthy()
      const skipped = screen.getByText(t.skipped)
      expect(skipped.closest('[role="status"]')?.getAttribute('data-kind')).toBe('skipped')
    })

    it('says no Pages were shared when the connect returned none', async () => {
      mockApi({ '/api/auth/get-session': () => json(200, SESSION), ...pagesApi([]) })
      renderOnboarding('/onboarding?meta=connected', language)
      expect(await screen.findByText((text) => text.startsWith(t.emptyAfterConnect))).toBeTruthy()
    })

    it.each(Object.keys(copy.en.reasons) as MetaOAuthErrorReason[])('explains ?meta=error&reason=%s', async (reason) => {
      mockApi({ '/api/auth/get-session': () => json(200, SESSION), ...pagesApi([]) })
      renderOnboarding(`/onboarding?meta=error&reason=${reason}`, language)

      const alert = await screen.findByRole('alert')
      expect(alert.dataset.kind).toBe(`error:${reason}`)
      expect(alert.textContent).toContain(t.errorPrefix)
      expect(alert.textContent).toContain(t.reasons[reason])
    })

    it('falls back to a generic message for an unknown reason and ignores junk params', async () => {
      mockApi({ '/api/auth/get-session': () => json(200, SESSION), ...pagesApi([]) })
      const { router } = renderOnboarding('/onboarding?meta=error&reason=%3Cscript%3E&skipped=abc', language)

      const alert = await screen.findByRole('alert')
      expect(alert.dataset.kind).toBe('error:unknown')
      expect(alert.textContent).toContain(t.unknownReason)
      // validateSearch returned every key; the invalid ones are undefined (the raw values didn't leak).
      const search: Record<string, unknown> = router.state.location.search
      expect(search.meta).toBe('error')
      expect(search.reason).toBeUndefined()
      expect(search.skipped).toBeUndefined()
    })
  })

  describe('page list', () => {
    it('lists Pages with their Instagram account, status and the plan limit', async () => {
      mockApi({
        '/api/auth/get-session': () => json(200, SESSION),
        ...pagesApi([page({ isActive: true }), SECOND, page({ id: 'p3', pageId: '1003', pageName: 'Old Page', hasToken: false, igBusinessId: null, igUsername: null })]),
      })
      renderOnboarding('/onboarding', language)

      const list = await screen.findByRole('list', { name: /Your Pages|আপনার পেজসমূহ/ })
      const rows = within(list).getAllByRole('listitem')
      expect(rows).toHaveLength(3)
      expect(rows[0]!.textContent).toContain('Rahim Fashion')
      expect(rows[0]!.textContent).toContain('@rahimfashion')
      expect(rows[0]!.querySelector('[data-status]')?.textContent).toBe(t.on)
      expect(rows[1]!.textContent).toContain(t.noInstagram)
      expect(rows[1]!.querySelector('[data-status]')?.textContent).toBe(t.off)
      expect(rows[2]!.querySelector('[data-status]')?.textContent).toBe(t.needsReconnect)
      expect(screen.getByTestId('page-limit').textContent).toBe(t.limit(1, 3))
      expect((await switchFor('Rahim Fashion', language)).getAttribute('aria-checked')).toBe('true')
      expect((await switchFor('Shop Two', language)).getAttribute('aria-checked')).toBe('false')
      // Step 3 (finish) is current once a Page is on.
      expect(document.querySelector('[aria-current="step"]')?.textContent).toBe(language === 'en' ? 'Finish' : 'শেষ')
    })

    it('switches a Page on: PATCH { isActive: true }, then refetches the list and count', async () => {
      mockApi({ '/api/auth/get-session': () => json(200, SESSION), ...pagesApi([page(), SECOND]) })
      renderOnboarding('/onboarding', language)
      expect((await screen.findByTestId('page-limit')).textContent).toBe(t.limit(0, 3))
      expect(callsTo(PAGES)).toHaveLength(1)

      fireEvent.click(await switchFor('Rahim Fashion', language))

      await waitFor(async () => expect((await switchFor('Rahim Fashion', language)).getAttribute('aria-checked')).toBe('true'))
      expect(callsTo(toggleUrl('p1'))).toEqual([{ path: toggleUrl('p1'), method: 'PATCH', body: { isActive: true } }])
      expect(callsTo(PAGES)).toHaveLength(2)
      expect(screen.getByTestId('page-limit').textContent).toBe(t.limit(1, 3))
      expect(screen.queryByRole('alert')).toBeNull()
    })

    it('switches a Page off: PATCH { isActive: false }, then refetches', async () => {
      mockApi({ '/api/auth/get-session': () => json(200, SESSION), ...pagesApi([page({ isActive: true })]) })
      renderOnboarding('/onboarding', language)

      fireEvent.click(await switchFor('Rahim Fashion', language))

      await waitFor(async () => expect((await switchFor('Rahim Fashion', language)).getAttribute('aria-checked')).toBe('false'))
      expect(callsTo(toggleUrl('p1'))[0]!.body).toEqual({ isActive: false })
      expect(callsTo(PAGES)).toHaveLength(2)
      expect(screen.getByTestId('page-limit').textContent).toBe(t.limit(0, 3))
    })

    it('shows the upgrade message with the numbers on 409 PAGE_LIMIT_REACHED', async () => {
      mockApi({
        '/api/auth/get-session': () => json(200, SESSION),
        ...pagesApi([page({ isActive: true }), SECOND], 1, () =>
          json(409, {
            statusCode: 409,
            error: 'Conflict',
            message: 'Plan limit reached',
            code: 'PAGE_LIMIT_REACHED',
            details: { limit: 1, activeCount: 1 },
          }),
        ),
      })
      renderOnboarding('/onboarding', language)

      fireEvent.click(await switchFor('Shop Two', language))

      const alert = await screen.findByRole('alert')
      expect(alert.dataset.kind).toBe('limit-reached')
      expect(alert.textContent).toBe(t.limitReached)
      expect(alert.closest('li')?.textContent).toContain('Shop Two')
      await waitFor(() => expect(callsTo(PAGES)).toHaveLength(2)) // refetched after the error too
      expect((await switchFor('Shop Two', language)).getAttribute('aria-checked')).toBe('false')
    })

    it('asks to reconnect on 409 PAGE_TOKEN_MISSING', async () => {
      mockApi({
        '/api/auth/get-session': () => json(200, SESSION),
        ...pagesApi([page({ hasToken: false })], 3, () =>
          json(409, { statusCode: 409, message: 'Reconnect', code: 'PAGE_TOKEN_MISSING' }),
        ),
      })
      renderOnboarding('/onboarding', language)

      fireEvent.click(await switchFor('Rahim Fashion', language))

      const alert = await screen.findByRole('alert')
      expect(alert.dataset.kind).toBe('token-missing')
      expect(alert.textContent).toContain(t.tokenMissing)
      expect(screen.getByRole('button', { name: t.reconnect })).toBeTruthy()
    })

    it('explains a failed list load and retries', async () => {
      let fail = true
      mockApi({
        '/api/auth/get-session': () => json(200, SESSION),
        [PAGES]: () => (fail ? new Response('<html>Bad Gateway</html>', { status: 502 }) : json(200, { items: [page()], pageLimit: { limit: 1, activeCount: 0 } })),
      })
      renderOnboarding('/onboarding', language)

      const alert = await screen.findByRole('alert')
      expect(alert.dataset.kind).toBe('pages-load')
      expect(alert.textContent).toContain(t.loadFailed)
      fail = false
      fireEvent.click(within(alert).getByRole('button', { name: t.retry }))
      expect(await switchFor('Rahim Fashion', language)).toBeTruthy()
    })
  })

  describe('leaving', () => {
    it('Skip for now goes to /dashboard, which never bounces back (D13: entry points only)', async () => {
      mockApi({ '/api/auth/get-session': () => json(200, SESSION), ...pagesApi([]) })
      const { history } = renderOnboarding('/onboarding', language)

      const finish = await screen.findByRole('button', { name: t.finish })
      expect(finish).toHaveProperty('disabled', true)
      expect(screen.getByText(t.finishHint)).toBeTruthy()

      fireEvent.click(screen.getByRole('link', { name: t.skip }))
      expect(await screen.findByRole('heading', { name: t.dashboard })).toBeTruthy()
      expect(history.location.pathname).toBe('/dashboard')
      // Still there after the page settled, and nothing was stored to remember the skip.
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(history.location.pathname).toBe('/dashboard')
      expect(document.cookie).not.toMatch(/onboarding|skip/i)
      expect(localStorage.length === 0 || !Object.keys(localStorage).some((key) => /onboarding|skip/i.test(key))).toBe(true)
    })

    it('Finish goes to /dashboard once a Page is on', async () => {
      mockApi({ '/api/auth/get-session': () => json(200, SESSION), ...pagesApi([page({ isActive: true })]) })
      const { history } = renderOnboarding('/onboarding', language)

      fireEvent.click(await screen.findByRole('link', { name: t.finish }))
      expect(await screen.findByRole('heading', { name: t.dashboard })).toBeTruthy()
      expect(history.location.pathname).toBe('/dashboard')
    })
  })
})

describe('/dashboard with 0 active Pages', () => {
  it('renders without checking Pages or redirecting to /onboarding', async () => {
    mockApi({ '/api/auth/get-session': () => json(200, SESSION), ...pagesApi([]) })
    const { history } = renderOnboarding('/dashboard')

    expect(await screen.findByRole('heading', { name: 'Dashboard' })).toBeTruthy()
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(history.location.pathname).toBe('/dashboard')
    expect(apiCalls().map((call) => call.path)).toEqual(['/api/auth/get-session'])
  })
})
