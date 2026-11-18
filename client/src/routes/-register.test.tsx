import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { callsTo, fetchMock, json, mockApi, renderAuthRoute } from '@/test/auth-routes'

vi.mock('@/server/session', () => ({ getServerSession: vi.fn() }))

const USER = { id: 'u1', email: 'rahim@shop.bd', name: 'Rahim', emailVerified: false }
const SESSION = { session: { id: 's1', userId: 'u1', impersonatedBy: null, activeOrganizationId: 'w1' }, user: USER }
const PAGES = '/api/workspaces/w1/pages'

/**
 * Sign-up succeeds; get-session answers "signed out" until then (the /register guard) and the new
 * session after it; the D13 pages check answers with `pages` (default: `activeCount` active Pages).
 */
function signUpFlow(activeCount: number, pages?: () => Response) {
  let signedUp = false
  return {
    '/api/auth/sign-up/email': () => {
      signedUp = true
      return json(200, { token: 't', user: USER })
    },
    '/api/auth/get-session': () => json(200, signedUp ? SESSION : null),
    [PAGES]: pages ?? (() => json(200, { items: [], pageLimit: { limit: 1, activeCount } })),
  }
}

const copy = {
  en: {
    name: 'Your name',
    business: 'Business name',
    email: 'Email',
    password: 'Password',
    submit: 'Create account',
    pending: 'Creating account…',
    title: 'Create your account',
    login: 'Log in',
    errors: {
      name: 'Enter your name.',
      business: 'Enter your business name.',
      email: 'Enter your email address.',
      password: 'Enter your password.',
      badEmail: 'Enter a valid email address.',
      shortPassword: 'Use at least 8 characters.',
      longBusiness: 'Use at most 80 characters.',
    },
  },
  bn: {
    name: 'আপনার নাম',
    business: 'ব্যবসার নাম',
    email: 'ইমেইল',
    password: 'পাসওয়ার্ড',
    submit: 'অ্যাকাউন্ট খুলুন',
    pending: 'অ্যাকাউন্ট খোলা হচ্ছে…',
    title: 'আপনার অ্যাকাউন্ট খুলুন',
    login: 'লগ ইন',
    errors: {
      name: 'আপনার নাম লিখুন।',
      business: 'আপনার ব্যবসার নাম লিখুন।',
      email: 'আপনার ইমেইল ঠিকানা লিখুন।',
      password: 'আপনার পাসওয়ার্ড লিখুন।',
      badEmail: 'একটি সঠিক ইমেইল ঠিকানা দিন।',
      shortPassword: 'কমপক্ষে ৮ অক্ষর ব্যবহার করুন।',
      longBusiness: 'সর্বোচ্চ ৮০ অক্ষর ব্যবহার করুন।',
    },
  },
} as const

type Lang = keyof typeof copy

async function fill(
  language: Lang,
  values: { name?: string; business?: string; email?: string; password?: string } = {},
) {
  const t = copy[language]
  fireEvent.change(await screen.findByLabelText(t.name), { target: { value: values.name ?? ' Rahim Uddin ' } })
  fireEvent.change(screen.getByLabelText(t.business), { target: { value: values.business ?? '  Rahim Fashion House ' } })
  fireEvent.change(screen.getByLabelText(t.email), { target: { value: values.email ?? 'rahim@shop.bd' } })
  fireEvent.change(screen.getByLabelText(t.password), { target: { value: values.password ?? 'strong-pass-1' } })
}

const submit = (language: Lang) => fireEvent.click(screen.getByRole('button', { name: copy[language].submit }))

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  vi.stubGlobal('scrollTo', () => {})
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe.each(['en', 'bn'] as const)('/register (%s)', (language) => {
  const t = copy[language]

  it('sends the business name as workspaceName and lands on /onboarding (0 active Pages, D13)', async () => {
    mockApi(signUpFlow(0))
    const { history, queryClient } = renderAuthRoute('/register', language)
    expect(await screen.findByRole('heading', { name: t.title })).toBeTruthy()

    await fill(language)
    submit(language)

    expect(await screen.findByText('Onboarding stub')).toBeTruthy()
    expect(history.location.pathname).toBe('/onboarding')
    expect(history.length).toBe(1)
    const calls = callsTo('/api/auth/sign-up/email')
    expect(calls).toHaveLength(1)
    // The exact JSON body Better Auth's client put on the wire: trimmed values + workspaceName.
    expect(calls[0]).toEqual({
      path: '/api/auth/sign-up/email',
      method: 'POST',
      body: {
        name: 'Rahim Uddin',
        email: 'rahim@shop.bd',
        password: 'strong-pass-1',
        workspaceName: 'Rahim Fashion House',
      },
    })
    // The D13 check ran once against the new session's workspace; both answers stay cached for the
    // `_app` guard and the wizard.
    expect(callsTo('/api/auth/get-session')).toHaveLength(2) // guard (signed out) + the D13 check
    expect(callsTo(PAGES)).toHaveLength(1)
    expect(queryClient.getQueryData(['auth', 'session'])).toMatchObject({ session: { activeOrganizationId: 'w1' } })
    expect(queryClient.getQueryData(['workspace', 'w1', 'pages'])).toMatchObject({ pageLimit: { activeCount: 0 } })
  })

  it('goes to /dashboard when the workspace already has an active Page', async () => {
    mockApi(signUpFlow(1))
    const { history } = renderAuthRoute('/register', language)
    await fill(language)
    submit(language)

    expect(await screen.findByText('Dashboard stub')).toBeTruthy()
    expect(history.location.pathname).toBe('/dashboard')
    expect(history.length).toBe(1)
  })

  it('falls back to /dashboard when the pages check fails', async () => {
    mockApi(signUpFlow(0, () => new Response('<html>Bad Gateway</html>', { status: 502 })))
    const { history } = renderAuthRoute('/register', language)
    await fill(language)
    submit(language)

    expect(await screen.findByText('Dashboard stub')).toBeTruthy()
    expect(history.location.pathname).toBe('/dashboard')
    expect(callsTo(PAGES)).toHaveLength(1) // no retry before falling back
  })

  it('shows every missing field without calling the API, and focuses the first', async () => {
    mockApi({})
    renderAuthRoute('/register', language)
    fireEvent.click(await screen.findByRole('button', { name: t.submit }))

    for (const message of [t.errors.name, t.errors.business, t.errors.email, t.errors.password]) {
      expect(await screen.findByText(message)).toBeTruthy()
    }
    const name = screen.getByLabelText(t.name)
    expect(name.getAttribute('aria-invalid')).toBe('true')
    expect(name.getAttribute('aria-describedby')).toBe('name-error')
    expect(document.activeElement).toBe(name)
    expect(callsTo('/api/auth/sign-up/email')).toHaveLength(0)
  })

  it('checks email format, password length and the 80-character business name like the backend', async () => {
    mockApi({})
    renderAuthRoute('/register', language)
    await fill(language, { email: 'rahim@shop', password: 'short', business: `  ${'ব'.repeat(81)}  ` })
    submit(language)

    expect(await screen.findByText(t.errors.badEmail)).toBeTruthy()
    expect(screen.getByText(t.errors.shortPassword)).toBeTruthy()
    expect(screen.getByText(t.errors.longBusiness)).toBeTruthy()
    expect(callsTo('/api/auth/sign-up/email')).toHaveLength(0)

    // Editing a field clears its error only.
    fireEvent.change(screen.getByLabelText(t.password), { target: { value: 'long-enough-1' } })
    await waitFor(() => expect(screen.queryByText(t.errors.shortPassword)).toBeNull())
    expect(screen.getByText(t.errors.badEmail)).toBeTruthy()
  })

  it('accepts an 80-character business name (trimmed)', async () => {
    mockApi(signUpFlow(0))
    renderAuthRoute('/register', language)
    await fill(language, { business: ` ${'ক'.repeat(80)} ` })
    submit(language)
    expect(await screen.findByText('Onboarding stub')).toBeTruthy()
    expect(callsTo('/api/auth/sign-up/email')[0]?.body).toMatchObject({ workspaceName: 'ক'.repeat(80) })
  })

  it('shows the pending state while creating the account', async () => {
    mockApi({ '/api/auth/sign-up/email': () => new Promise<Response>(() => {}) })
    renderAuthRoute('/register', language)
    await fill(language)
    submit(language)
    expect(await screen.findByRole('button', { name: t.pending })).toHaveProperty('disabled', true)
    expect(screen.getByLabelText(t.business).matches(':disabled')).toBe(true)
  })

  it('links to /login', async () => {
    mockApi({})
    renderAuthRoute('/register', language)
    expect((await screen.findByRole('link', { name: t.login })).getAttribute('href')).toBe('/login')
  })
})

describe('/register error mapping', () => {
  const cases: { name: string; respond: () => Promise<Response>; kind: string; en: string; bn: string }[] = [
    {
      name: '422 user already exists',
      respond: async () =>
        json(422, { code: 'USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL', message: 'User already exists. Use another email.' }),
      kind: 'user-exists',
      en: 'An account with this email already exists.',
      bn: 'এই ইমেইলে আগে থেকেই একটি অ্যাকাউন্ট আছে।',
    },
    {
      name: '400 password too short',
      respond: async () => json(400, { code: 'PASSWORD_TOO_SHORT', message: 'Password too short' }),
      kind: 'weak-password',
      en: 'The password must be 8 to 128 characters.',
      bn: 'পাসওয়ার্ড ৮ থেকে ১২৮ অক্ষরের হতে হবে।',
    },
    {
      name: '400 invalid email',
      respond: async () => json(400, { code: 'INVALID_EMAIL', message: 'Invalid email' }),
      kind: 'invalid-email',
      en: 'Enter a valid email address.',
      bn: 'একটি সঠিক ইমেইল ঠিকানা দিন।',
    },
    {
      name: '400 workspaceName from the sign-up hook',
      respond: async () =>
        json(400, { code: 'WORKSPACENAME_MUST_BE_180_CHARACTERS', message: 'workspaceName must be 1-80 characters' }),
      kind: 'invalid-business-name',
      en: 'The business name must be 1 to 80 characters.',
      bn: 'ব্যবসার নাম ১ থেকে ৮০ অক্ষরের হতে হবে।',
    },
    {
      name: '429 with X-Retry-After',
      respond: async () => json(429, { message: 'Too many requests.' }, { 'X-Retry-After': '125' }),
      kind: 'rate-limited',
      en: 'Too many attempts. Try again in 3 min.',
      bn: 'অনেকবার চেষ্টা করা হয়েছে। ৩ মিনিট পরে আবার চেষ্টা করুন।',
    },
    {
      name: '500',
      respond: async () => json(500, { message: 'Internal Server Error' }),
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
      mockApi({ '/api/auth/sign-up/email': failure.respond })
      const { history } = renderAuthRoute('/register', language)
      await fill(language)
      submit(language)

      const alert = await screen.findByRole('alert')
      expect(alert.dataset.kind).toBe(failure.kind)
      expect(alert.textContent).toContain(failure[language])
      expect(history.location.pathname).toBe('/register')
    })
  })

  it('offers a link to /login when the email is taken', async () => {
    mockApi({ '/api/auth/sign-up/email': async () => json(422, { code: 'USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL' }) })
    const { history } = renderAuthRoute('/register')
    await fill('en')
    submit('en')
    const alert = await screen.findByRole('alert')
    fireEvent.click(alert.querySelector('a')!)
    expect(await screen.findByRole('heading', { name: 'Welcome back' })).toBeTruthy()
    expect(history.location.pathname).toBe('/login')
  })
})

describe('/register guard', () => {
  it('sends a signed-in visitor to /dashboard', async () => {
    mockApi({
      '/api/auth/get-session': async () =>
        json(200, { session: { id: 's1', userId: 'u1', impersonatedBy: null }, user: USER }),
    })
    const { history } = renderAuthRoute('/register')
    expect(await screen.findByText('Dashboard stub')).toBeTruthy()
    expect(history.location.pathname).toBe('/dashboard')
  })
})
