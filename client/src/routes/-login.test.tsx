import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { callsTo, fetchMock, json, mockApi, renderAuthRoute } from '@/test/auth-routes'

// The server-render session function needs the Start compiler; the browser path never calls it.
vi.mock('@/server/session', () => ({ getServerSession: vi.fn() }))

const USER = { id: 'u1', email: 'rahim@shop.bd', name: 'Rahim', emailVerified: false }
const SESSION = { session: { id: 's1', userId: 'u1', impersonatedBy: null }, user: USER }
const WORKSPACE_SESSION = { session: { ...SESSION.session, activeOrganizationId: 'w1' }, user: USER }
const PAGES = '/api/workspaces/w1/pages'
const SUMMARY = '/api/workspaces/w1/billing/summary'
type Respond = () => Response | Promise<Response>
const pagesWith = (activeCount: number): Respond => () => json(200, { items: [], pageLimit: { limit: 3, activeCount } })

/**
 * Sign-in succeeds; get-session answers "signed out" until then (the /login guard) and `session` after
 * it; the D13 pages check answers with `pages`.
 */
function signInFlow(
  pages: Respond,
  session: Respond = () => json(200, WORKSPACE_SESSION),
  summary: Respond = () => json(200, { status: 'ACTIVE' }),
) {
  let signedIn = false
  return {
    '/api/auth/sign-in/email': () => {
      signedIn = true
      return json(200, { redirect: false, token: 't', user: USER })
    },
    '/api/auth/get-session': () => (signedIn ? session() : json(200, null)),
    [PAGES]: pages,
    [SUMMARY]: summary,
  }
}

const copy = {
  en: {
    email: 'Email',
    password: 'Password',
    submit: 'Log in',
    pending: 'Logging in…',
    title: 'Welcome back',
    register: 'Create an account',
    required: 'Enter your email address.',
    badEmail: 'Enter a valid email address.',
    forgot: 'Forgot password?',
    resetNotice: 'Your password was changed. Log in with the new password.',
    inbox: 'Check your inbox',
    verifyFirst: 'Verify your email before you log in. We can send the link to rahim@shop.bd again.',
    resend: 'Resend verification email',
    resent: 'We sent a new link. Check your inbox.',
    tooMany: 'Too many attempts.',
    back: 'Back to log in',
  },
  bn: {
    email: 'ইমেইল',
    password: 'পাসওয়ার্ড',
    submit: 'লগ ইন',
    pending: 'লগ ইন হচ্ছে…',
    title: 'আবার স্বাগতম',
    register: 'অ্যাকাউন্ট খুলুন',
    required: 'আপনার ইমেইল ঠিকানা লিখুন।',
    badEmail: 'একটি সঠিক ইমেইল ঠিকানা দিন।',
    forgot: 'পাসওয়ার্ড ভুলে গেছেন?',
    resetNotice: 'আপনার পাসওয়ার্ড বদলানো হয়েছে। নতুন পাসওয়ার্ড দিয়ে লগ ইন করুন।',
    inbox: 'আপনার ইনবক্স দেখুন',
    verifyFirst: 'লগ ইন করার আগে আপনার ইমেইল যাচাই করুন। rahim@shop.bd ঠিকানায় লিংকটি আবার পাঠাতে পারি।',
    resend: 'যাচাই ইমেইল আবার পাঠান',
    resent: 'নতুন একটি লিংক পাঠিয়েছি। আপনার ইনবক্স দেখুন।',
    tooMany: 'অনেকবার চেষ্টা করা হয়েছে।',
    back: 'লগ ইনে ফিরে যান',
  },
} as const

async function fillAndSubmit(language: 'en' | 'bn', email = ' rahim@shop.bd ', password = 'secret-password') {
  const t = copy[language]
  fireEvent.change(await screen.findByLabelText(t.email), { target: { value: email } })
  fireEvent.change(screen.getByLabelText(t.password), { target: { value: password } })
  fireEvent.click(screen.getByRole('button', { name: t.submit }))
}

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  vi.stubGlobal('scrollTo', () => {})
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe.each(['en', 'bn'] as const)('/login (%s)', (language) => {
  const t = copy[language]

  it('signs in, clears the cached session and goes to ?redirect', async () => {
    mockApi({ '/api/auth/sign-in/email': () => json(200, { redirect: false, token: 't', user: USER }) })
    const { history, queryClient } = renderAuthRoute('/login?redirect=%2Forders%3Fpage%3D2', language)
    expect(await screen.findByRole('heading', { name: t.title })).toBeTruthy()
    queryClient.setQueryData(['workspace', 'stats'], { scanned: 1 }) // cached under someone else

    await fillAndSubmit(language)

    expect(await screen.findByText('Orders stub')).toBeTruthy()
    expect(history.location.href).toBe('/orders?page=2')
    expect(history.length).toBe(1) // replace: Back doesn't return to the form
    const [signIn] = callsTo('/api/auth/sign-in/email')
    expect(signIn).toMatchObject({ method: 'POST', body: { email: 'rahim@shop.bd', password: 'secret-password' } })
    expect(queryClient.getQueryData(['auth', 'session'])).toBeUndefined()
    expect(queryClient.getQueryData(['workspace', 'stats'])).toBeUndefined()
    expect(callsTo(PAGES)).toHaveLength(0) // explicit ?redirect: no D13 check
  })

  it('D11: ?plan=&interval= (existing account) goes to that checkout; an explicit ?redirect still wins', async () => {
    mockApi(signInFlow(pagesWith(0)))
    const { history } = renderAuthRoute('/login?plan=growth&interval=year', language)
    await fillAndSubmit(language)
    expect(await screen.findByText('Billing stub')).toBeTruthy()
    expect(history.location.href).toBe('/billing?plan=growth&interval=year')
    expect(callsTo(PAGES)).toHaveLength(0)
    expect(callsTo(SUMMARY)).toHaveLength(0)
    cleanup()

    mockApi(signInFlow(pagesWith(0)))
    const second = renderAuthRoute('/login?redirect=%2Forders&plan=growth&interval=year', language)
    await fillAndSubmit(language)
    expect(await screen.findByText('Orders stub')).toBeTruthy()
    expect(second.history.location.pathname).toBe('/orders')
  })

  it('keeps ?plan=&interval= on the "Create an account" link', async () => {
    mockApi({})
    renderAuthRoute('/login?plan=pro&interval=month', language)
    const link = await screen.findByRole('link', { name: t.register })
    expect(link.getAttribute('href')).toBe('/register?plan=pro&interval=month')
  })

  describe('without ?redirect (D13 entry point)', () => {
    it('goes to /onboarding when the active workspace has 0 active Pages', async () => {
      mockApi(signInFlow(pagesWith(0)))
      const { history, queryClient } = renderAuthRoute('/login', language)
      await fillAndSubmit(language)

      expect(await screen.findByText('Onboarding stub')).toBeTruthy()
      expect(history.location.pathname).toBe('/onboarding')
      expect(history.length).toBe(1)
      expect(callsTo(PAGES)).toHaveLength(1)
      expect(callsTo(PAGES)[0]!.method).toBe('GET')
      // Cached for the `_app` guard and the wizard.
      expect(queryClient.getQueryData(['workspace', 'w1', 'pages'])).toMatchObject({ pageLimit: { activeCount: 0 } })
    })

    it.each(['NONE', 'EXPIRED'] as const)('goes to /plans only when the account never had a plan (summary %s)', async (status) => {
      mockApi(signInFlow(pagesWith(0), undefined, () => json(200, { status })))
      const { history } = renderAuthRoute('/login', language)
      await fillAndSubmit(language)

      const target = status === 'NONE' ? '/plans' : '/onboarding'
      expect(await screen.findByText(status === 'NONE' ? 'Plans stub' : 'Onboarding stub')).toBeTruthy()
      expect(history.location.pathname).toBe(target)
      expect(callsTo(SUMMARY)).toHaveLength(1)
      expect(callsTo(PAGES)).toHaveLength(status === 'NONE' ? 0 : 1)
    })

    it('goes to /dashboard when at least one Page is active', async () => {
      mockApi(signInFlow(pagesWith(2)))
      const { history } = renderAuthRoute('/login', language)
      await fillAndSubmit(language)

      expect(await screen.findByText('Dashboard stub')).toBeTruthy()
      expect(history.location.pathname).toBe('/dashboard')
    })

    it.each<[string, Respond]>([
      ['pages 503', () => json(503, { statusCode: 503, message: 'down' })],
      ['pages 403 (moderator)', () => json(403, { statusCode: 403, message: 'Forbidden' })],
      ['pages network failure', () => Promise.reject(new TypeError('Failed to fetch'))],
    ])('falls back to /dashboard when the check fails (%s)', async (_name, pages) => {
      mockApi(signInFlow(pages))
      const { history } = renderAuthRoute('/login', language)
      await fillAndSubmit(language)

      expect(await screen.findByText('Dashboard stub')).toBeTruthy()
      expect(history.location.pathname).toBe('/dashboard')
      expect(callsTo(PAGES)).toHaveLength(1) // no retry
    })

    it('falls back to /dashboard when the session has no active workspace or get-session fails', async () => {
      mockApi(signInFlow(pagesWith(0), () => json(200, SESSION)))
      const first = renderAuthRoute('/login', language)
      await fillAndSubmit(language)
      expect(await screen.findByText('Dashboard stub')).toBeTruthy()
      expect(first.history.location.pathname).toBe('/dashboard')
      expect(callsTo(PAGES)).toHaveLength(0)
      cleanup()

      mockApi(signInFlow(pagesWith(0), () => new Response('down', { status: 503 })))
      const second = renderAuthRoute('/login', language)
      await fillAndSubmit(language)
      expect(await screen.findByText('Dashboard stub')).toBeTruthy()
      expect(second.history.location.pathname).toBe('/dashboard')
      expect(callsTo(PAGES)).toHaveLength(0)
    })

    it('honours an explicit ?redirect even with 0 active Pages, without the check', async () => {
      mockApi(signInFlow(pagesWith(0)))
      const { history } = renderAuthRoute('/login?redirect=%2Fdashboard', language)
      await fillAndSubmit(language)

      expect(await screen.findByText('Dashboard stub')).toBeTruthy()
      expect(history.location.pathname).toBe('/dashboard')
      expect(callsTo(PAGES)).toHaveLength(0)
    })

    it('treats an unsafe ?redirect as none and applies the check', async () => {
      mockApi(signInFlow(pagesWith(0)))
      const { history } = renderAuthRoute('/login?redirect=%2F%2Fevil.example', language)
      await fillAndSubmit(language)

      expect(await screen.findByText('Onboarding stub')).toBeTruthy()
      expect(history.location.pathname).toBe('/onboarding')
    })
  })

  it('shows the pending state while signing in', async () => {
    mockApi({ '/api/auth/sign-in/email': () => new Promise<Response>(() => {}) })
    renderAuthRoute('/login', language)
    await fillAndSubmit(language)
    const button = await screen.findByRole('button', { name: t.pending })
    expect(button).toHaveProperty('disabled', true)
    expect(screen.getByLabelText(t.email).matches(':disabled')).toBe(true)
  })

  it('validates before calling the API', async () => {
    mockApi({})
    renderAuthRoute('/login', language)
    fireEvent.click(await screen.findByRole('button', { name: t.submit }))
    expect(await screen.findByText(t.required)).toBeTruthy()
    expect(screen.getByLabelText(t.email).getAttribute('aria-invalid')).toBe('true')

    fireEvent.change(screen.getByLabelText(t.email), { target: { value: 'not-an-email' } })
    fireEvent.change(screen.getByLabelText(t.password), { target: { value: 'x' } })
    fireEvent.click(screen.getByRole('button', { name: t.submit }))
    expect(await screen.findByText(t.badEmail)).toBeTruthy()
    expect(callsTo('/api/auth/sign-in/email')).toHaveLength(0)
  })

  it('links to /register', async () => {
    mockApi({})
    renderAuthRoute('/login', language)
    expect((await screen.findByRole('link', { name: t.register })).getAttribute('href')).toBe('/register')
  })

  it('links to /forgot-password (M9-T6)', async () => {
    mockApi({})
    renderAuthRoute('/login', language)
    expect((await screen.findByRole('link', { name: t.forgot })).getAttribute('href')).toBe('/forgot-password')
  })

  it('shows the "password changed" notice only with ?reset=1', async () => {
    mockApi({})
    renderAuthRoute('/login?reset=1', language)
    expect((await screen.findByRole('status')).textContent).toBe(t.resetNotice)
    cleanup()
    mockApi({})
    renderAuthRoute('/login', language)
    await screen.findByRole('heading', { name: t.title })
    expect(screen.queryByText(t.resetNotice)).toBeNull()
  })

  it('403 EMAIL_NOT_VERIFIED → "check your inbox" and resends to the typed email', async () => {
    mockApi({
      '/api/auth/sign-in/email': () => json(403, { code: 'EMAIL_NOT_VERIFIED', message: 'Email not verified' }),
      '/api/auth/send-verification-email': () => json(200, { status: true }),
    })
    const { history } = renderAuthRoute('/login', language)
    await fillAndSubmit(language)

    expect(await screen.findByRole('heading', { name: t.inbox })).toBeTruthy()
    expect(screen.getByText(t.verifyFirst)).toBeTruthy()
    expect(history.location.pathname).toBe('/login')
    expect(callsTo('/api/auth/send-verification-email')).toHaveLength(0) // sign-in sends nothing

    fireEvent.click(screen.getByRole('button', { name: t.resend }))
    expect(await screen.findByText(t.resent)).toBeTruthy()
    expect(callsTo('/api/auth/send-verification-email')).toEqual([
      { path: '/api/auth/send-verification-email', method: 'POST', body: { email: 'rahim@shop.bd' } },
    ])

    // Back to the form, the typed email kept.
    fireEvent.click(screen.getByRole('button', { name: t.back }))
    expect(await screen.findByRole('heading', { name: t.title })).toBeTruthy()
    expect((screen.getByLabelText(t.email) as HTMLInputElement).value).toBe('rahim@shop.bd')
  })

  it('403 EMAIL_NOT_VERIFIED → resend 429 shows the rate-limit message', async () => {
    mockApi({
      '/api/auth/sign-in/email': () => json(403, { code: 'EMAIL_NOT_VERIFIED' }),
      '/api/auth/send-verification-email': () => json(429, { message: 'Too many requests.' }),
    })
    renderAuthRoute('/login', language)
    await fillAndSubmit(language)
    fireEvent.click(await screen.findByRole('button', { name: t.resend }))
    const alert = await screen.findByRole('alert')
    expect(alert.dataset.kind).toBe('rate-limited')
    expect(alert.textContent).toContain(t.tooMany)
    expect(screen.getByRole('button', { name: t.resend })).toHaveProperty('disabled', false) // no X-Retry-After
  })
})

describe('/login error mapping', () => {
  const cases: {
    name: string
    respond: () => Promise<Response>
    kind: string
    en: string
    bn: string
  }[] = [
    {
      name: '401 invalid credentials',
      respond: async () => json(401, { code: 'INVALID_EMAIL_OR_PASSWORD', message: 'Invalid email or password' }),
      kind: 'invalid-credentials',
      en: 'Incorrect email or password.',
      bn: 'ইমেইল বা পাসওয়ার্ড সঠিক নয়।',
    },
    {
      name: '429 with X-Retry-After',
      respond: async () => json(429, { message: 'Too many requests.' }, { 'X-Retry-After': '42' }),
      kind: 'rate-limited',
      en: 'Too many attempts. Try again in 42 s.',
      bn: 'অনেকবার চেষ্টা করা হয়েছে। ৪২ সেকেন্ড পরে আবার চেষ্টা করুন।',
    },
    {
      name: '403 BANNED_USER',
      respond: async () => json(403, { code: 'BANNED_USER', message: 'You have been banned from this application' }),
      kind: 'banned',
      en: 'This account has been banned.',
      bn: 'এই অ্যাকাউন্টটি নিষিদ্ধ করা হয়েছে।',
    },
    {
      name: 'other 403',
      respond: async () => json(403, { code: 'INVALID_ORIGIN', message: 'Invalid origin' }),
      kind: 'forbidden',
      en: 'The request was refused.',
      bn: 'অনুরোধটি প্রত্যাখ্যান করা হয়েছে।',
    },
    {
      name: '400',
      respond: async () => json(400, { code: 'VALIDATION_ERROR', message: 'Invalid body' }),
      kind: 'invalid-input',
      en: 'Check the details you entered',
      bn: 'আপনার দেওয়া তথ্য দেখে আবার চেষ্টা করুন।',
    },
    {
      name: '502 from the proxy',
      respond: async () => new Response('<html>Bad Gateway</html>', { status: 502 }),
      kind: 'server',
      en: 'The server is unavailable right now.',
      bn: 'সার্ভার এই মুহূর্তে পাওয়া যাচ্ছে না।',
    },
    {
      name: 'network failure',
      respond: () => Promise.reject(new TypeError('Failed to fetch')),
      kind: 'network',
      en: 'Can’t reach the server.',
      bn: 'সার্ভারে সংযোগ করা যাচ্ছে না।',
    },
  ]

  describe.each(['en', 'bn'] as const)('%s', (language) => {
    it.each(cases)('$name', async (failure) => {
      mockApi({ '/api/auth/sign-in/email': failure.respond })
      const { history } = renderAuthRoute('/login?redirect=%2Forders', language)
      await fillAndSubmit(language)

      const alert = await screen.findByRole('alert')
      expect(alert.dataset.kind).toBe(failure.kind)
      expect(alert.textContent).toContain(failure[language])
      expect(alert.textContent).not.toContain('banned from this application') // backend text never shown
      expect(history.location.pathname).toBe('/login')
    })
  })

  it('marks both fields invalid on 401 and clears the error when a field changes', async () => {
    mockApi({ '/api/auth/sign-in/email': async () => json(401, { code: 'INVALID_EMAIL_OR_PASSWORD' }) })
    renderAuthRoute('/login')
    await fillAndSubmit('en')
    await screen.findByRole('alert')
    expect(screen.getByLabelText('Email').getAttribute('aria-invalid')).toBe('true')
    expect(screen.getByLabelText('Password').getAttribute('aria-invalid')).toBe('true')

    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'another' } })
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
  })
})

describe('/login guard', () => {
  it('sends a signed-in visitor with ?plan=&interval= to that checkout (D11)', async () => {
    mockApi({ '/api/auth/get-session': async () => json(200, SESSION) })
    const { history } = renderAuthRoute('/login?plan=growth&interval=month')
    expect(await screen.findByText('Billing stub')).toBeTruthy()
    expect(history.location.href).toBe('/billing?plan=growth&interval=month')
  })

  it('sends a signed-in visitor to the safe ?redirect target', async () => {
    mockApi({ '/api/auth/get-session': async () => json(200, SESSION) })
    const { history } = renderAuthRoute('/login?redirect=%2Forders')
    expect(await screen.findByText('Orders stub')).toBeTruthy()
    expect(history.location.pathname).toBe('/orders')
  })

  it('ignores an off-site ?redirect', async () => {
    mockApi({ '/api/auth/get-session': async () => json(200, SESSION) })
    const { history } = renderAuthRoute('/login?redirect=%2F%2Fevil.example')
    expect(await screen.findByText('Dashboard stub')).toBeTruthy()
    expect(history.location.pathname).toBe('/dashboard')
  })

  it('still shows the form when the session check fails', async () => {
    mockApi({ '/api/auth/get-session': async () => new Response('down', { status: 503 }) })
    renderAuthRoute('/login')
    expect(await screen.findByRole('button', { name: 'Log in' })).toBeTruthy()
  })

  it('switches the page to Bangla', async () => {
    mockApi({})
    const { languageStore } = renderAuthRoute('/login')
    fireEvent.click(await screen.findByRole('button', { name: 'Switch to Bangla' }))
    expect(await screen.findByRole('heading', { name: 'আবার স্বাগতম' })).toBeTruthy()
    expect(languageStore.getState().language).toBe('bn')
  })
})
