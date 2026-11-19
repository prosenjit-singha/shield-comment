import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Language } from '@/lib/language'
import type { MetaOAuthErrorReason, WorkspacePage } from '@/lib/meta-pages'
import {
  DISCONNECT,
  IMPERSONATED,
  META_DIALOG,
  OAUTH_URL,
  PAGES,
  SECOND,
  SESSION,
  connection,
  page,
  pagesApi,
  renderAppRoute,
  stubAppGlobals,
  summaryApi,
  policyApi,
  toggleUrl,
} from '@/test/app-routes'
import { callsTo, fetchMock, json, mockApi } from '@/test/auth-routes'

// The server-render session function needs the Start compiler; the browser path never calls it.
vi.mock('@/server/session', () => ({ getServerSession: vi.fn() }))

/** C6 `/pages` (M3-T11): real `_app` + `/pages` + `/onboarding` (harness `src/test/app-routes.tsx`). */
const renderPages = (path: string, language: Language) => renderAppRoute(path, language)

const bnDigits = (n: number) => new Intl.NumberFormat('bn-BD').format(n)

function deferred() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

const NO_TOKEN = page({ id: 'p3', pageId: '1003', pageName: 'Old Page', hasToken: false, igBusinessId: null, igUsername: null })

const copy = {
  en: {
    title: 'Connected Pages',
    protect: (name: string) => `Protect ${name}`,
    limit: (active: number, limit: number) => `${active} / ${limit} Pages on`,
    on: 'Protected',
    off: 'Off',
    needsReconnect: 'Reconnect needed',
    igLinked: 'Instagram linked',
    igNone: 'No Instagram',
    noInstagram: 'No Instagram account linked',
    reconnect: 'Reconnect Facebook',
    reconnectHint: 'Facebook no longer gives us access to this Page. Reconnect Facebook and include this Page, then switch it on.',
    subscribeFailed:
      'Facebook didn’t confirm the connection for this Page, so protection is still off. Try again in a moment. If it keeps failing, reconnect Facebook.',
    impersonated: 'Connecting Facebook is turned off during Admin Impersonation',
    connectedNotice: 'Facebook connected. Switch on protection for the Pages you want below.',
    skipped: '2 Pages were skipped because they are already connected to another ShieldComment workspace.',
    errorPrefix: 'Facebook wasn’t connected.',
    limitReached:
      'Your plan allows 2 active Pages and 2 are already on. Switch another Page off or upgrade your plan to protect more.',
    toggleOnFailed: 'Couldn’t switch protection on.',
    toggleOffFailed: 'Couldn’t switch protection off.',
    server: 'The server is unavailable right now.',
    network: 'Can’t reach the server.',
    connect503: 'Facebook connection isn’t set up on our server yet.',
    empty: 'No Pages connected yet',
    emptyCta: 'Connect Facebook',
    onboarding: 'Connect your Facebook Page and Instagram',
    loadFailed: 'Couldn’t load your Pages.',
    retry: 'Try again',
    noWorkspace: 'Your account has no active workspace yet',
    bannerReauth: 'Your Facebook connection needs to be renewed.',
    bannerRevoked: 'ShieldComment was removed from your Facebook account',
    reauthToggle:
      'Facebook needs to be reconnected before protection can be switched on. Reconnect Facebook, then try again.',
    impersonatedEmpty: 'The workspace owner has to connect Facebook before Pages show up here.',
    disconnect: 'Disconnect Facebook',
    dialogTitle: 'Disconnect Facebook?',
    effects: [
      'Your Pages and their linked Instagram accounts are removed from this workspace.',
      'Comments ShieldComment already collected are kept.',
      'unless another ShieldComment workspace still uses the same Facebook account',
    ],
    cancel: 'Cancel',
    confirm: 'Yes, disconnect',
    disconnecting: 'Disconnecting…',
    disconnected: 'Facebook disconnected. 2 Pages were removed and 15 comments were kept.',
    disconnectedOne: 'Facebook disconnected. 1 Page was removed and 1 comment was kept.',
    alreadyDisconnected: 'Facebook was already disconnected. Nothing was removed.',
    disconnectFailed: 'Facebook wasn’t disconnected.',
    disconnect403: 'Only workspace owners and admins can disconnect Facebook, and not during Admin Impersonation.',
    disconnect404: 'This workspace couldn’t be found.',
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
  },
  bn: {
    title: 'কানেক্টেড পেজ',
    protect: (name: string) => `${name} সুরক্ষিত রাখুন`,
    limit: (active: number, limit: number) => `${bnDigits(active)} / ${bnDigits(limit)}টি পেজ চালু`,
    on: 'সুরক্ষিত',
    off: 'বন্ধ',
    needsReconnect: 'আবার কানেক্ট দরকার',
    igLinked: 'ইনস্টাগ্রাম যুক্ত',
    igNone: 'ইনস্টাগ্রাম নেই',
    noInstagram: 'কোনো ইনস্টাগ্রাম অ্যাকাউন্ট যুক্ত নেই',
    reconnect: 'আবার ফেসবুক কানেক্ট করুন',
    reconnectHint: 'ফেসবুক এই পেজে আর অ্যাক্সেস দিচ্ছে না। ফেসবুক আবার কানেক্ট করুন এবং এই পেজটি সিলেক্ট করুন, তারপর চালু করুন।',
    subscribeFailed:
      'ফেসবুক এই পেজের সংযোগ নিশ্চিত করেনি, তাই সুরক্ষা এখনও বন্ধ আছে। একটু পরে আবার চেষ্টা করুন। বারবার ব্যর্থ হলে ফেসবুক আবার কানেক্ট করুন।',
    impersonated: 'অ্যাডমিন ইমপারসোনেশনের সময় ফেসবুক কানেক্ট করা বন্ধ থাকে',
    connectedNotice: 'ফেসবুক কানেক্ট হয়েছে। নিচে যে পেজগুলো সুরক্ষিত রাখতে চান সেগুলো চালু করুন।',
    skipped: '২টি পেজ বাদ দেওয়া হয়েছে, কারণ সেগুলো আগে থেকেই অন্য একটি ShieldComment ওয়ার্কস্পেসে কানেক্ট করা আছে।',
    errorPrefix: 'ফেসবুক কানেক্ট হয়নি।',
    limitReached:
      'আপনার প্ল্যানে ২টি পেজ চালু রাখা যায় এবং ২টি আগে থেকেই চালু আছে। আরও পেজ সুরক্ষিত রাখতে অন্য একটি পেজ বন্ধ করুন বা প্ল্যান আপগ্রেড করুন।',
    toggleOnFailed: 'সুরক্ষা চালু করা যায়নি।',
    toggleOffFailed: 'সুরক্ষা বন্ধ করা যায়নি।',
    server: 'সার্ভার এই মুহূর্তে পাওয়া যাচ্ছে না।',
    network: 'সার্ভারে সংযোগ করা যাচ্ছে না।',
    connect503: 'আমাদের সার্ভারে ফেসবুক কানেকশন এখনো সেট আপ করা হয়নি।',
    empty: 'এখনো কোনো পেজ কানেক্ট করা হয়নি',
    emptyCta: 'ফেসবুক কানেক্ট করুন',
    onboarding: 'আপনার ফেসবুক পেজ ও ইনস্টাগ্রাম কানেক্ট করুন',
    loadFailed: 'আপনার পেজগুলো লোড করা যায়নি।',
    retry: 'আবার চেষ্টা করুন',
    noWorkspace: 'আপনার অ্যাকাউন্টে এখনো কোনো সক্রিয় ওয়ার্কস্পেস নেই',
    bannerReauth: 'আপনার ফেসবুক কানেকশন নবায়ন করা দরকার।',
    bannerRevoked: 'আপনার ফেসবুক অ্যাকাউন্ট থেকে ShieldComment সরিয়ে দেওয়া হয়েছে',
    reauthToggle: 'সুরক্ষা চালু করার আগে ফেসবুক আবার কানেক্ট করতে হবে। ফেসবুক আবার কানেক্ট করুন, তারপর আবার চেষ্টা করুন।',
    impersonatedEmpty: 'এখানে পেজ দেখাতে হলে ওয়ার্কস্পেসের মালিককে ফেসবুক কানেক্ট করতে হবে।',
    disconnect: 'ফেসবুক ডিসকানেক্ট করুন',
    dialogTitle: 'ফেসবুক ডিসকানেক্ট করবেন?',
    effects: [
      'আপনার পেজ ও সেগুলোর সাথে যুক্ত ইনস্টাগ্রাম অ্যাকাউন্ট এই ওয়ার্কস্পেস থেকে সরে যাবে।',
      'ShieldComment আগে যে কমেন্টগুলো সংগ্রহ করেছে সেগুলো থেকে যাবে।',
      'যদি না একই ফেসবুক অ্যাকাউন্ট অন্য কোনো ShieldComment ওয়ার্কস্পেসে এখনো ব্যবহার হয়',
    ],
    cancel: 'বাতিল',
    confirm: 'হ্যাঁ, ডিসকানেক্ট করুন',
    disconnecting: 'ডিসকানেক্ট হচ্ছে…',
    disconnected: `ফেসবুক ডিসকানেক্ট হয়েছে। ${bnDigits(2)}টি পেজ সরানো হয়েছে এবং ${bnDigits(15)}টি কমেন্ট রাখা হয়েছে।`,
    disconnectedOne: `ফেসবুক ডিসকানেক্ট হয়েছে। ${bnDigits(1)}টি পেজ সরানো হয়েছে এবং ${bnDigits(1)}টি কমেন্ট রাখা হয়েছে।`,
    alreadyDisconnected: 'ফেসবুক আগেই ডিসকানেক্ট করা ছিল। কিছু সরানো হয়নি।',
    disconnectFailed: 'ফেসবুক ডিসকানেক্ট হয়নি।',
    disconnect403: 'শুধু ওয়ার্কস্পেসের মালিক ও অ্যাডমিন ফেসবুক ডিসকানেক্ট করতে পারেন, অ্যাডমিন ইমপারসোনেশনের সময় নয়।',
    disconnect404: 'এই ওয়ার্কস্পেসটি খুঁজে পাওয়া যায়নি।',
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
  },
} as const

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  stubAppGlobals()
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe.each(['en', 'bn'] as const)('/pages (%s)', (language) => {
  const t = copy[language]
  const switchFor = (name: string) => screen.findByRole('switch', { name: t.protect(name) })
  const checked = async (name: string) => (await switchFor(name)).getAttribute('aria-checked')
  const limitText = () => screen.getByTestId('page-limit').textContent
  const rowOf = (name: string) => screen.getByText(name).closest('li')!

  /** PATCH that waits for `gate`, then flips the stored row (success) or answers `fail()`. */
  function gatedToggle(gate: Promise<void>, fail?: () => Response | Promise<Response>) {
    return async (item: WorkspacePage) => {
      await gate
      if (fail) return fail()
      item.isActive = !item.isActive
      return json(200, { page: item, changed: true })
    }
  }

  /** Holds every list GET after the first until `gate` opens (so a rollback is seen before the refetch). */
  function holdRefetch(handlers: ReturnType<typeof pagesApi>, gate: Promise<void>) {
    const list = handlers[PAGES]!
    let calls = 0
    return {
      ...handlers,
      [PAGES]: async () => {
        calls += 1
        if (calls > 1) await gate
        return list()
      },
    }
  }

  describe('list', () => {
    it('lists Pages with Instagram + status pills, the plan limit and needs-reconnect rows', async () => {
      mockApi({
        '/api/auth/get-session': () => json(200, SESSION),
        ...pagesApi([page({ isActive: true }), SECOND, NO_TOKEN], 3),
      })
      renderPages('/pages', language)

      expect(await screen.findByRole('heading', { level: 1, name: t.title })).toBeTruthy()
      const list = await screen.findByRole('list', { name: /Your Pages|আপনার পেজসমূহ/ })
      const rows = within(list).getAllByRole('listitem')
      expect(rows).toHaveLength(3)
      expect(rows[0]!.textContent).toContain('@rahimfashion')
      expect(rows[0]!.querySelector('[data-status]')?.textContent).toBe(t.on)
      expect(rows[0]!.querySelector('[data-instagram]')?.textContent).toBe(t.igLinked)
      expect(rows[1]!.textContent).toContain(t.noInstagram)
      expect(rows[1]!.querySelector('[data-status]')?.textContent).toBe(t.off)
      expect(rows[1]!.querySelector('[data-instagram]')?.getAttribute('data-instagram')).toBe('none')
      expect(rows[1]!.querySelector('[data-instagram]')?.textContent).toBe(t.igNone)
      // No stored Page token: pill + reconnect hint, switch can't be turned on.
      expect(rows[2]!.querySelector('[data-status]')?.textContent).toBe(t.needsReconnect)
      const hint = rows[2]!.querySelector('[data-kind="needs-reconnect"]')
      expect(hint?.textContent).toBe(t.reconnectHint)
      expect((await switchFor('Old Page')).hasAttribute('disabled')).toBe(true)
      expect(rows[0]!.querySelector('[data-kind="needs-reconnect"]')).toBeNull()

      expect(limitText()).toBe(t.limit(1, 3))
      expect(await checked('Rahim Fashion')).toBe('true')
      expect(await checked('Shop Two')).toBe('false')
      expect(screen.getByRole('button', { name: t.reconnect })).toBeTruthy()
      // M4-T11 (D7): Disconnect for owners/admins · ACTIVE: no banner · D14: no boosted posts here.
      expect(screen.getByRole('button', { name: t.disconnect })).toBeTruthy()
      expect(document.querySelector('[data-kind^="connection:"]')).toBeNull()
      expect(screen.queryByText(/boost/i)).toBeNull()
    })

    it('shows an empty state that links to /onboarding', async () => {
      mockApi({ '/api/auth/get-session': () => json(200, SESSION), ...pagesApi([], 1) })
      const { history } = renderPages('/pages', language)

      const empty = await screen.findByTestId('pages-empty')
      expect(within(empty).getByRole('heading', { name: t.empty })).toBeTruthy()
      expect(limitText()).toBe(t.limit(0, 1))
      expect(screen.queryByRole('button', { name: t.reconnect })).toBeNull()

      expect(within(empty).queryByText(t.impersonatedEmpty)).toBeNull()

      fireEvent.click(within(empty).getByRole('link', { name: t.emptyCta }))
      expect(await screen.findByRole('heading', { name: t.onboarding })).toBeTruthy()
      expect(history.location.pathname).toBe('/onboarding')
    })

    it('finding (a): the impersonated empty state has no Connect CTA, only the impersonation notice', async () => {
      mockApi({ '/api/auth/get-session': () => json(200, IMPERSONATED), ...pagesApi([], 1, undefined, { connection: null }) })
      renderPages('/pages', language)

      const empty = await screen.findByTestId('pages-empty')
      expect(within(empty).getByRole('heading', { name: t.empty })).toBeTruthy()
      expect(within(empty).getByText(t.impersonatedEmpty)).toBeTruthy()
      expect(within(empty).queryByRole('link')).toBeNull()
      expect(screen.queryByRole('link', { name: t.emptyCta })).toBeNull()
      expect(screen.queryByRole('button', { name: t.reconnect })).toBeNull()
      const notice = screen.getByText((_, node) => node?.tagName === 'P' && node.textContent?.startsWith(t.impersonated) === true)
      expect(notice.closest('[data-kind]')?.getAttribute('data-kind')).toBe('impersonation-connect-blocked')
      expect(screen.queryByRole('button', { name: t.disconnect })).toBeNull()
      expect(callsTo(OAUTH_URL)).toHaveLength(0)
    })

    it('explains a failed list load and retries', async () => {
      let fail = true
      mockApi({
        '/api/auth/get-session': () => json(200, SESSION),
        ...policyApi(),
        ...summaryApi(),
        [PAGES]: () =>
          fail
            ? new Response('<html>Bad Gateway</html>', { status: 502 })
            : json(200, { items: [page()], pageLimit: { limit: 1, activeCount: 0 } }),
      })
      renderPages('/pages', language)

      const alert = await screen.findByRole('alert')
      expect(alert.dataset.kind).toBe('pages-load')
      expect(alert.textContent).toContain(t.loadFailed)
      fail = false
      fireEvent.click(within(alert).getByRole('button', { name: t.retry }))
      expect(await switchFor('Rahim Fashion')).toBeTruthy()
      expect(callsTo(PAGES)).toHaveLength(2)
      expect(screen.queryByRole('alert')).toBeNull()
    })

    it('says so when the session has no active workspace (no pages call)', async () => {
      mockApi({
        '/api/auth/get-session': () => json(200, { ...SESSION, session: { ...SESSION.session, activeOrganizationId: null } }),
      })
      renderPages('/pages', language)

      const alert = await screen.findByRole('alert')
      expect(alert.dataset.kind).toBe('no-workspace')
      expect(alert.textContent).toContain(t.noWorkspace)
      expect(callsTo(PAGES)).toHaveLength(0)
    })
  })

  describe('optimistic toggle', () => {
    it('switches on at once, then PATCHes { isActive: true } and refetches', async () => {
      const gate = deferred()
      mockApi({ '/api/auth/get-session': () => json(200, SESSION), ...pagesApi([page(), SECOND], 3, gatedToggle(gate.promise)) })
      renderPages('/pages', language)
      expect(await checked('Rahim Fashion')).toBe('false')

      fireEvent.click(await switchFor('Rahim Fashion'))

      // Before the PATCH answers: switch, pill and count already moved; the row is busy.
      await waitFor(async () => expect(await checked('Rahim Fashion')).toBe('true'))
      expect(limitText()).toBe(t.limit(1, 3))
      expect(rowOf('Rahim Fashion').querySelector('[data-status]')?.textContent).toBe(t.on)
      expect((await switchFor('Rahim Fashion')).hasAttribute('disabled')).toBe(true)
      expect((await switchFor('Shop Two')).hasAttribute('disabled')).toBe(false)
      await waitFor(() => expect(callsTo(toggleUrl('p1'))).toHaveLength(1))
      expect(callsTo(toggleUrl('p1'))[0]).toEqual({ path: toggleUrl('p1'), method: 'PATCH', body: { isActive: true } })
      expect(callsTo(PAGES)).toHaveLength(1)

      gate.release()

      await waitFor(() => expect(callsTo(PAGES)).toHaveLength(2))
      await waitFor(async () => expect((await switchFor('Rahim Fashion')).hasAttribute('disabled')).toBe(false))
      expect(await checked('Rahim Fashion')).toBe('true')
      expect(limitText()).toBe(t.limit(1, 3))
      expect(screen.queryByRole('alert')).toBeNull()
    })

    it('switches off at once, then PATCHes { isActive: false } and refetches', async () => {
      const gate = deferred()
      mockApi({
        '/api/auth/get-session': () => json(200, SESSION),
        ...pagesApi([page({ isActive: true }), SECOND], 3, gatedToggle(gate.promise)),
      })
      renderPages('/pages', language)
      expect(await checked('Rahim Fashion')).toBe('true')
      expect(limitText()).toBe(t.limit(1, 3))

      fireEvent.click(await switchFor('Rahim Fashion'))

      await waitFor(async () => expect(await checked('Rahim Fashion')).toBe('false'))
      expect(limitText()).toBe(t.limit(0, 3))
      await waitFor(() => expect(callsTo(toggleUrl('p1'))).toHaveLength(1))
      expect(callsTo(toggleUrl('p1'))[0]!.body).toEqual({ isActive: false })

      gate.release()

      await waitFor(() => expect(callsTo(PAGES)).toHaveLength(2))
      expect(await checked('Rahim Fashion')).toBe('false')
      expect(limitText()).toBe(t.limit(0, 3))
    })

    it('rolls back on 409 PAGE_LIMIT_REACHED and shows the upgrade message with the numbers', async () => {
      const gate = deferred()
      const third = page({ id: 'p4', pageId: '1004', pageName: 'Third Shop', isActive: true, igBusinessId: null, igUsername: null })
      const refetch = deferred()
      mockApi({
        '/api/auth/get-session': () => json(200, SESSION),
        ...holdRefetch(pagesApi(
          [page({ isActive: true }), SECOND, third],
          2,
          gatedToggle(gate.promise, () =>
            json(409, {
              statusCode: 409,
              error: 'Conflict',
              message: 'backend text never shown',
              code: 'PAGE_LIMIT_REACHED',
              details: { limit: 2, activeCount: 2 },
            }),
          ),
        ), refetch.promise),
      })
      renderPages('/pages', language)
      expect(await checked('Shop Two')).toBe('false')
      expect(limitText()).toBe(t.limit(2, 2))

      fireEvent.click(await switchFor('Shop Two'))
      await waitFor(async () => expect(await checked('Shop Two')).toBe('true'))

      gate.release()

      const alert = await screen.findByRole('alert')
      expect(alert.dataset.kind).toBe('limit-reached')
      expect(alert.textContent).toBe(t.limitReached)
      expect(alert.closest('li')?.textContent).toContain('Shop Two')
      // Rolled back before the refetch answers.
      expect(await checked('Shop Two')).toBe('false')
      expect(limitText()).toBe(t.limit(2, 2))
      await waitFor(() => expect(callsTo(PAGES)).toHaveLength(2)) // refetched after the error too
      refetch.release()
      await waitFor(async () => expect((await switchFor('Shop Two')).hasAttribute('disabled')).toBe(false))
      expect(await checked('Shop Two')).toBe('false')
      expect(await checked('Rahim Fashion')).toBe('true')
    })

    it('rolls back on 409 PAGE_TOKEN_MISSING and asks to reconnect', async () => {
      const gate = deferred()
      const refetch = deferred()
      mockApi({
        '/api/auth/get-session': () => json(200, SESSION),
        ...holdRefetch(
          pagesApi(
            [page()],
            3,
            gatedToggle(gate.promise, () => json(409, { statusCode: 409, message: 'Reconnect', code: 'PAGE_TOKEN_MISSING' })),
          ),
          refetch.promise,
        ),
      })
      renderPages('/pages', language)

      fireEvent.click(await switchFor('Rahim Fashion'))
      await waitFor(async () => expect(await checked('Rahim Fashion')).toBe('true'))
      gate.release()

      const alert = await screen.findByRole('alert')
      expect(alert.dataset.kind).toBe('token-missing')
      expect(alert.textContent).toBe(t.reconnectHint)
      expect(await checked('Rahim Fashion')).toBe('false')
      expect(limitText()).toBe(t.limit(0, 3))
      await waitFor(() => expect(callsTo(PAGES)).toHaveLength(2))
      refetch.release()
      expect(screen.getByRole('button', { name: t.reconnect })).toBeTruthy()
    })

    it('rolls back on 502 META_SUBSCRIBE_FAILED with the subscribe message', async () => {
      const gate = deferred()
      const refetch = deferred()
      mockApi({
        '/api/auth/get-session': () => json(200, SESSION),
        ...holdRefetch(
          pagesApi(
            [page()],
            3,
            gatedToggle(gate.promise, () =>
              json(502, { statusCode: 502, message: 'backend text never shown', code: 'META_SUBSCRIBE_FAILED' }),
            ),
          ),
          refetch.promise,
        ),
      })
      renderPages('/pages', language)

      fireEvent.click(await switchFor('Rahim Fashion'))
      await waitFor(async () => expect(await checked('Rahim Fashion')).toBe('true'))
      gate.release()

      const alert = await screen.findByRole('alert')
      expect(alert.dataset.kind).toBe('subscribe-failed')
      expect(alert.textContent).toBe(t.subscribeFailed)
      // Rolled back before the refetch answers.
      expect(await checked('Rahim Fashion')).toBe('false')
      expect(limitText()).toBe(t.limit(0, 3))
      await waitFor(() => expect(callsTo(PAGES)).toHaveLength(2))
      refetch.release()
    })

    it.each([
      [500, true],
      [0, true],
      [503, false],
      [0, false],
    ] as const)('rolls back on %s (switching %s) with a per-row message', async (status, on) => {
      const gate = deferred()
      const refetch = deferred()
      mockApi({
        '/api/auth/get-session': () => json(200, SESSION),
        ...holdRefetch(
          pagesApi(
            [page({ isActive: !on }), SECOND],
            3,
            gatedToggle(gate.promise, () =>
              status === 0
                ? Promise.reject(new TypeError('Failed to fetch'))
                : json(status, { statusCode: status, message: 'backend text never shown' }),
            ),
          ),
          refetch.promise,
        ),
      })
      renderPages('/pages', language)

      fireEvent.click(await switchFor('Rahim Fashion'))
      await waitFor(async () => expect(await checked('Rahim Fashion')).toBe(String(on)))
      gate.release()

      const alert = await screen.findByRole('alert')
      expect(alert.dataset.kind).toBe(`toggle:${status}`)
      expect(alert.textContent).toContain(on ? t.toggleOnFailed : t.toggleOffFailed)
      expect(alert.textContent).toContain(status === 0 ? t.network : t.server)
      expect(alert.textContent).not.toContain('backend text')
      expect(alert.closest('li')?.textContent).toContain('Rahim Fashion')
      expect(await checked('Rahim Fashion')).toBe(String(!on))
      expect(limitText()).toBe(t.limit(on ? 0 : 1, 3))
      await waitFor(() => expect(callsTo(PAGES)).toHaveLength(2))
      refetch.release()
      await waitFor(async () => expect((await switchFor('Rahim Fashion')).hasAttribute('disabled')).toBe(false))

      // Trying again clears the row's message.
      mockApi({ '/api/auth/get-session': () => json(200, SESSION), ...pagesApi([page({ isActive: !on }), SECOND], 3) })
      fireEvent.click(await switchFor('Rahim Fashion'))
      await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
      await waitFor(async () => expect(await checked('Rahim Fashion')).toBe(String(on)))
    })
  })

  describe('reconnect', () => {
    it('asks for the Meta dialog URL with returnTo=/pages and leaves for it', async () => {
      mockApi({
        '/api/auth/get-session': () => json(200, SESSION),
        ...pagesApi([page()]),
        [OAUTH_URL]: () => json(200, { url: META_DIALOG }),
      })
      renderPages('/pages', language)
      const button = await screen.findByRole('button', { name: t.reconnect })
      const location = { href: 'http://localhost/pages' }
      vi.stubGlobal('location', location)

      fireEvent.click(button)

      await waitFor(() => expect(location.href).toBe(META_DIALOG))
      const [call] = fetchMock.mock.calls.filter(([input]) => String(input).startsWith(OAUTH_URL))
      expect(new URL(String(call![0]), 'http://localhost').searchParams.get('returnTo')).toBe('/pages')
      expect(callsTo(OAUTH_URL)).toHaveLength(1)
    })

    it('explains a failed reconnect (503)', async () => {
      mockApi({
        '/api/auth/get-session': () => json(200, SESSION),
        ...pagesApi([page()]),
        [OAUTH_URL]: () => json(503, { statusCode: 503, message: 'backend text never shown' }),
      })
      renderPages('/pages', language)

      fireEvent.click(await screen.findByRole('button', { name: t.reconnect }))
      const alert = await screen.findByRole('alert')
      expect(alert.dataset.kind).toBe('connect:503')
      expect(alert.textContent).toContain(t.connect503)
      expect(screen.getByRole('button', { name: t.reconnect })).toHaveProperty('disabled', false)
    })

    it('shows the impersonation notice instead of the button (D5); toggling still works', async () => {
      mockApi({ '/api/auth/get-session': () => json(200, IMPERSONATED), ...pagesApi([page()]) })
      renderPages('/pages', language)

      const notice = await screen.findByText((_, node) => node?.tagName === 'P' && node.textContent?.startsWith(t.impersonated) === true)
      expect(notice.closest('[data-kind]')?.getAttribute('data-kind')).toBe('impersonation-connect-blocked')
      expect(screen.queryByRole('button', { name: t.reconnect })).toBeNull()

      fireEvent.click(await switchFor('Rahim Fashion'))
      await waitFor(() => expect(callsTo(toggleUrl('p1'))).toHaveLength(1))
      await waitFor(async () => expect(await checked('Rahim Fashion')).toBe('true'))
      expect(callsTo(OAUTH_URL)).toHaveLength(0)
    })
  })

  describe('connection banner (D9)', () => {
    const bannerText = (status: 'NEEDS_REAUTH' | 'REVOKED') => (status === 'REVOKED' ? t.bannerRevoked : t.bannerReauth)

    it.each(['NEEDS_REAUTH', 'REVOKED'] as const)('%s: banner with its own Reconnect (returnTo=/pages)', async (status) => {
      mockApi({
        '/api/auth/get-session': () => json(200, SESSION),
        ...pagesApi([page({ isActive: status === 'NEEDS_REAUTH' }), SECOND], 3, undefined, { connection: connection(status) }),
        [OAUTH_URL]: () => json(200, { url: META_DIALOG }),
      })
      renderPages('/pages', language)

      const banner = await waitFor(() => {
        const node = document.querySelector<HTMLElement>(`[data-kind="connection:${status}"]`)
        expect(node).not.toBeNull()
        return node!
      })
      expect(banner.dataset.tone).toBe(status === 'REVOKED' ? 'error' : 'warning')
      expect(banner.textContent).toContain(bannerText(status))
      expect(document.querySelector(`[data-kind="connection:${status === 'REVOKED' ? 'NEEDS_REAUTH' : 'REVOKED'}"]`)).toBeNull()
      // Exactly one Reconnect: the banner's (the header one is hidden).
      const buttons = screen.getAllByRole('button', { name: t.reconnect })
      expect(buttons).toHaveLength(1)
      expect(banner.contains(buttons[0]!)).toBe(true)
      const location = { href: 'http://localhost/pages' }
      vi.stubGlobal('location', location)

      fireEvent.click(buttons[0]!)

      await waitFor(() => expect(location.href).toBe(META_DIALOG))
      expect(callsTo(OAUTH_URL)).toHaveLength(1)
      const [call] = fetchMock.mock.calls.filter(([input]) => String(input).startsWith(OAUTH_URL))
      expect(new URL(String(call![0]), 'http://localhost').searchParams.get('returnTo')).toBe('/pages')
    })

    it.each([
      ['ACTIVE', connection('ACTIVE')],
      ['no connection', null],
    ] as const)('%s: no banner, the header Reconnect stays', async (_, value) => {
      mockApi({ '/api/auth/get-session': () => json(200, SESSION), ...pagesApi([page()], 3, undefined, { connection: value }) })
      renderPages('/pages', language)

      expect(await screen.findByRole('button', { name: t.reconnect })).toBeTruthy()
      expect(document.querySelector('[data-kind^="connection:"]')).toBeNull()
      expect(screen.queryByText(t.bannerReauth)).toBeNull()
      expect(screen.queryByText((text) => text.includes(t.bannerRevoked))).toBeNull()
    })

    it.each(['NEEDS_REAUTH', 'REVOKED'] as const)('impersonated %s: banner text without Reconnect', async (status) => {
      mockApi({
        '/api/auth/get-session': () => json(200, IMPERSONATED),
        ...pagesApi([page()], 3, undefined, { connection: connection(status) }),
      })
      renderPages('/pages', language)

      const banner = await waitFor(() => {
        const node = document.querySelector<HTMLElement>(`[data-kind="connection:${status}"]`)
        expect(node).not.toBeNull()
        return node!
      })
      expect(banner.textContent).toContain(bannerText(status))
      expect(within(banner).queryByRole('button')).toBeNull()
      expect(screen.queryByRole('button', { name: t.reconnect })).toBeNull()
      expect(document.querySelector('[data-kind="impersonation-connect-blocked"]')).not.toBeNull()
      expect(callsTo(OAUTH_URL)).toHaveLength(0)
    })

    it('rolls back on 409 CONNECTION_NEEDS_REAUTH with the reconnect message; the refetch brings the banner', async () => {
      const gate = deferred()
      const refetch = deferred()
      const handlers = pagesApi(
        [page()],
        3,
        gatedToggle(gate.promise, () =>
          json(409, { statusCode: 409, message: 'backend text never shown', code: 'CONNECTION_NEEDS_REAUTH' }),
        ),
      )
      let listCalls = 0
      mockApi({
        '/api/auth/get-session': () => json(200, SESSION),
        ...handlers,
        // First GET: ACTIVE (stale); the refetch after the 409 says NEEDS_REAUTH.
        [PAGES]: async () => {
          listCalls += 1
          if (listCalls === 1) return handlers[PAGES]!()
          await refetch.promise
          return json(200, {
            items: [page()],
            pageLimit: { limit: 3, activeCount: 0 },
            connection: connection('NEEDS_REAUTH'),
          })
        },
      })
      renderPages('/pages', language)

      fireEvent.click(await switchFor('Rahim Fashion'))
      await waitFor(async () => expect(await checked('Rahim Fashion')).toBe('true'))
      gate.release()

      const alert = await screen.findByRole('alert')
      expect(alert.dataset.kind).toBe('connection-needs-reauth')
      expect(alert.textContent).toBe(t.reauthToggle)
      expect(alert.closest('li')?.textContent).toContain('Rahim Fashion')
      // Rolled back before the refetch answers.
      expect(await checked('Rahim Fashion')).toBe('false')
      expect(limitText()).toBe(t.limit(0, 3))
      await waitFor(() => expect(callsTo(PAGES)).toHaveLength(2))
      refetch.release()

      await waitFor(() => expect(document.querySelector('[data-kind="connection:NEEDS_REAUTH"]')).not.toBeNull())
      expect(screen.getAllByRole('button', { name: t.reconnect })).toHaveLength(1)
    })
  })

  describe('disconnect (D7)', () => {
    const dialog = () => screen.findByRole('dialog', { name: t.dialogTitle })
    const disconnectBody = (body: { disconnected: boolean; pagesDeleted: number; commentsKept: number }) => () =>
      json(200, body)

    it.each([
      ['impersonated', IMPERSONATED, [page()], connection()],
      ['nothing connected', SESSION, [], null],
    ] as const)('is hidden when %s', async (_, session, items, value) => {
      mockApi({ '/api/auth/get-session': () => json(200, session), ...pagesApi([...items], 1, undefined, { connection: value }) })
      renderPages('/pages', language)

      await waitFor(() => expect(callsTo(PAGES)).toHaveLength(1))
      expect(await screen.findByRole('heading', { level: 1, name: t.title })).toBeTruthy()
      await waitFor(() => expect(document.querySelector('[aria-busy="true"]')).toBeNull())
      expect(screen.queryByRole('button', { name: t.disconnect })).toBeNull()
      expect(screen.queryByTestId('meta-connection-card')).toBeNull()
    })

    it.each([
      ['Pages without a connection row', [page()], null],
      ['a connection without Pages', [], connection('REVOKED')],
    ] as const)('is shown for %s', async (_, items, value) => {
      mockApi({ '/api/auth/get-session': () => json(200, SESSION), ...pagesApi([...items], 1, undefined, { connection: value }) })
      renderPages('/pages', language)

      expect(await screen.findByRole('button', { name: t.disconnect })).toBeTruthy()
    })

    it('opens a confirm dialog that explains the effects; Cancel sends nothing', async () => {
      mockApi({
        '/api/auth/get-session': () => json(200, SESSION),
        ...pagesApi([page()], 3, undefined, { onDisconnect: disconnectBody({ disconnected: true, pagesDeleted: 1, commentsKept: 0 }) }),
      })
      renderPages('/pages', language)

      fireEvent.click(await screen.findByRole('button', { name: t.disconnect }))
      const box = await dialog()
      for (const effect of t.effects) expect(box.textContent).toContain(effect)

      fireEvent.click(within(box).getByRole('button', { name: t.cancel }))
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
      expect(callsTo(DISCONNECT)).toHaveLength(0)
      expect(callsTo(PAGES)).toHaveLength(1)
      expect(await switchFor('Rahim Fashion')).toBeTruthy()
    })

    it('confirm → one DELETE → list refetched → success counts, empty state, no Disconnect', async () => {
      const gate = deferred()
      mockApi({
        '/api/auth/get-session': () => json(200, SESSION),
        ...pagesApi([page({ isActive: true }), SECOND], 3, undefined, {
          onDisconnect: async () => {
            await gate.promise
            return json(200, { disconnected: true, pagesDeleted: 2, commentsKept: 15 })
          },
        }),
      })
      renderPages('/pages?meta=connected', language)
      expect(await screen.findByText(t.connectedNotice)).toBeTruthy()

      fireEvent.click(await screen.findByRole('button', { name: t.disconnect }))
      const box = await dialog()
      fireEvent.click(within(box).getByRole('button', { name: t.confirm }))

      // While the DELETE runs: busy button, Cancel disabled.
      const busy = await within(box).findByRole('button', { name: t.disconnecting })
      expect(busy).toHaveProperty('disabled', true)
      expect(within(box).getByRole('button', { name: t.cancel })).toHaveProperty('disabled', true)
      await waitFor(() => expect(callsTo(DISCONNECT)).toHaveLength(1))
      expect(callsTo(DISCONNECT)[0]).toEqual({ path: DISCONNECT, method: 'DELETE', body: undefined })
      gate.release()

      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
      const notice = await screen.findByText(t.disconnected)
      expect(notice.closest('[data-kind]')?.getAttribute('data-kind')).toBe('disconnected')
      await waitFor(() => expect(callsTo(PAGES)).toHaveLength(2))
      expect(await screen.findByTestId('pages-empty')).toBeTruthy()
      expect(screen.queryByRole('button', { name: t.disconnect })).toBeNull()
      expect(screen.queryByText(t.connectedNotice)).toBeNull()
      expect(callsTo(DISCONNECT)).toHaveLength(1)
    })

    it('uses the singular and says so when nothing was connected any more', async () => {
      let body = { disconnected: true, pagesDeleted: 1, commentsKept: 1 }
      mockApi({
        '/api/auth/get-session': () => json(200, SESSION),
        ...pagesApi([page()], 3, undefined, { onDisconnect: () => json(200, body) }),
      })
      renderPages('/pages', language)

      fireEvent.click(await screen.findByRole('button', { name: t.disconnect }))
      fireEvent.click(within(await dialog()).getByRole('button', { name: t.confirm }))
      expect(await screen.findByText(t.disconnectedOne)).toBeTruthy()

      // Idempotent backend: `disconnected: false` (e.g. another tab already disconnected).
      body = { disconnected: false, pagesDeleted: 0, commentsKept: 0 }
      mockApi({
        '/api/auth/get-session': () => json(200, SESSION),
        ...pagesApi([page()], 3, undefined, { onDisconnect: () => json(200, body) }),
      })
      cleanup()
      renderPages('/pages', language)
      fireEvent.click(await screen.findByRole('button', { name: t.disconnect }))
      fireEvent.click(within(await dialog()).getByRole('button', { name: t.confirm }))
      expect(await screen.findByText(t.alreadyDisconnected)).toBeTruthy()
    })

    it.each([403, 404, 500, 0] as const)('keeps the dialog open on %s with an inline alert, then retries', async (status) => {
      let fail = true
      mockApi({
        '/api/auth/get-session': () => json(200, SESSION),
        ...pagesApi([page()], 3, undefined, {
          onDisconnect: () =>
            !fail
              ? json(200, { disconnected: true, pagesDeleted: 1, commentsKept: 1 })
              : status === 0
                ? Promise.reject(new TypeError('Failed to fetch'))
                : json(status, { statusCode: status, message: 'backend text never shown' }),
        }),
      })
      renderPages('/pages', language)

      fireEvent.click(await screen.findByRole('button', { name: t.disconnect }))
      const box = await dialog()
      fireEvent.click(within(box).getByRole('button', { name: t.confirm }))

      const alert = await within(box).findByRole('alert')
      expect(alert.dataset.kind).toBe(`disconnect:${status}`)
      expect(alert.textContent).toContain(t.disconnectFailed)
      expect(alert.textContent).toContain(
        status === 403 ? t.disconnect403 : status === 404 ? t.disconnect404 : status === 0 ? t.network : t.server,
      )
      expect(alert.textContent).not.toContain('backend text')
      expect(screen.getByRole('dialog')).toBe(box)
      expect(within(box).getByRole('button', { name: t.confirm })).toHaveProperty('disabled', false)
      expect(callsTo(DISCONNECT)).toHaveLength(1)
      expect(callsTo(PAGES)).toHaveLength(1)

      // Usable again: the retry succeeds and clears the alert.
      fail = false
      fireEvent.click(within(box).getByRole('button', { name: t.confirm }))
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
      expect(await screen.findByText(t.disconnectedOne)).toBeTruthy()
      expect(callsTo(DISCONNECT)).toHaveLength(2)
    })

    it('starts without the last error when opened again', async () => {
      mockApi({
        '/api/auth/get-session': () => json(200, SESSION),
        ...pagesApi([page()], 3, undefined, { onDisconnect: () => json(500, { statusCode: 500, message: 'x' }) }),
      })
      renderPages('/pages', language)

      fireEvent.click(await screen.findByRole('button', { name: t.disconnect }))
      let box = await dialog()
      fireEvent.click(within(box).getByRole('button', { name: t.confirm }))
      expect(await within(box).findByRole('alert')).toBeTruthy()
      fireEvent.click(within(box).getByRole('button', { name: t.cancel }))
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

      fireEvent.click(await screen.findByRole('button', { name: t.disconnect }))
      box = await dialog()
      expect(within(box).queryByRole('alert')).toBeNull()
      expect(callsTo(DISCONNECT)).toHaveLength(1)
    })
  })

  describe('return from Meta', () => {
    it('confirms ?meta=connected', async () => {
      mockApi({ '/api/auth/get-session': () => json(200, SESSION), ...pagesApi([page()]) })
      renderPages('/pages?meta=connected', language)

      const status = await screen.findByText(t.connectedNotice)
      expect(status.closest('[role="status"]')?.getAttribute('data-kind')).toBe('connected')
      expect(screen.queryByText(t.skipped)).toBeNull()
    })

    it('reports skipped Pages (&skipped=2)', async () => {
      mockApi({ '/api/auth/get-session': () => json(200, SESSION), ...pagesApi([page()]) })
      renderPages('/pages?meta=connected&skipped=2', language)

      expect(await screen.findByText(t.connectedNotice)).toBeTruthy()
      expect(screen.getByText(t.skipped).closest('[role="status"]')?.getAttribute('data-kind')).toBe('skipped')
    })

    it.each(Object.keys(copy.en.reasons) as MetaOAuthErrorReason[])('explains ?meta=error&reason=%s', async (reason) => {
      mockApi({ '/api/auth/get-session': () => json(200, SESSION), ...pagesApi([page()]) })
      renderPages(`/pages?meta=error&reason=${reason}`, language)

      const alert = await screen.findByRole('alert')
      expect(alert.dataset.kind).toBe(`error:${reason}`)
      expect(alert.textContent).toContain(t.errorPrefix)
      expect(alert.textContent).toContain(t.reasons[reason])
    })

    it('returns every search key, undefined when invalid', async () => {
      mockApi({ '/api/auth/get-session': () => json(200, SESSION), ...pagesApi([page()]) })
      const { router } = renderPages('/pages?meta=error&reason=%3Cscript%3E&skipped=abc', language)

      const alert = await screen.findByRole('alert')
      expect(alert.dataset.kind).toBe('error:unknown')
      const search: Record<string, unknown> = router.state.location.search
      expect(search.meta).toBe('error')
      expect(search.reason).toBeUndefined()
      expect(search.skipped).toBeUndefined()
    })
  })
})
