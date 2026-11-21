import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { callsTo, fetchMock, json, mockApi, renderAuthRoute } from '@/test/auth-routes'
import { Route as ForgotPasswordRoute } from './forgot-password'
import { Route as ResetPasswordRoute } from './reset-password'
import { Route as VerifyEmailRoute } from './verify-email'

// The server-render session function needs the Start compiler; the browser path never calls it.
vi.mock('@/server/session', () => ({ getServerSession: vi.fn() }))

// M9-T6 (D10 b, M9-T6-a): /forgot-password, /reset-password, /verify-email.

const REQUEST = '/api/auth/request-password-reset'
const RESET = '/api/auth/reset-password'
const VERIFY = '/api/auth/verify-email'
const RESEND = '/api/auth/send-verification-email'
const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.verify-token.signature'
const INVITE_ID = '01936f3e-1d2c-7a4b-8c9d-0e1f2a3b4c5d'
const USER = { id: 'u1', email: 'rahim@shop.bd', name: 'Rahim', emailVerified: true }
const OWNER_SESSION = { session: { id: 's1', userId: 'u1', impersonatedBy: null, activeOrganizationId: 'w1' }, user: USER }
const INVITEE_SESSION = { ...OWNER_SESSION, session: { ...OWNER_SESSION.session, activeOrganizationId: null } }

const copy = {
  en: {
    email: 'Email',
    forgotTitle: 'Reset your password',
    sendLink: 'Send reset link',
    sent: 'If an account exists for rahim@shop.bd, we sent it a link to reset the password.',
    badEmail: 'Enter a valid email address.',
    tooMany: 'Too many attempts. Try again in 30 s.',
    network: 'Can’t reach the server.',
    resetTitle: 'Choose a new password',
    newPassword: 'New password',
    confirm: 'Confirm new password',
    save: 'Save new password',
    short: 'Use at least 8 characters.',
    mismatch: 'The passwords don’t match.',
    expired: 'This link has expired or was already used.',
    newLink: 'Request a new link',
    incompleteReset: 'This reset link is incomplete.',
    resetNotice: 'Your password was changed. Log in with the new password.',
    verifying: 'Verifying your email…',
    verified: 'Email verified',
    logInToContinue: 'Your email address is verified. Log in to continue.',
    openInvite: 'To join the workspace you were invited to, open the invitation link from your email again.',
    badLink: 'This verification link has expired or is not valid.',
    incompleteLink: 'This verification link is incomplete.',
    resend: 'Resend verification email',
    resent: 'We sent a new link. Check your inbox.',
    server: 'The server is unavailable right now.',
    retry: 'Try again',
  },
  bn: {
    email: 'ইমেইল',
    forgotTitle: 'পাসওয়ার্ড রিসেট করুন',
    sendLink: 'রিসেট লিংক পাঠান',
    sent: 'rahim@shop.bd ঠিকানায় অ্যাকাউন্ট থাকলে পাসওয়ার্ড রিসেটের একটি লিংক পাঠিয়েছি।',
    badEmail: 'একটি সঠিক ইমেইল ঠিকানা দিন।',
    tooMany: 'অনেকবার চেষ্টা করা হয়েছে। ৩০ সেকেন্ড পরে আবার চেষ্টা করুন।',
    network: 'সার্ভারে সংযোগ করা যাচ্ছে না।',
    resetTitle: 'নতুন পাসওয়ার্ড বেছে নিন',
    newPassword: 'নতুন পাসওয়ার্ড',
    confirm: 'নতুন পাসওয়ার্ড আবার লিখুন',
    save: 'নতুন পাসওয়ার্ড সেভ করুন',
    short: 'কমপক্ষে ৮ অক্ষর ব্যবহার করুন।',
    mismatch: 'পাসওয়ার্ড দুটি মিলছে না।',
    expired: 'এই লিংকের মেয়াদ শেষ বা এটি আগেই ব্যবহার করা হয়েছে।',
    newLink: 'নতুন লিংক চান',
    incompleteReset: 'এই রিসেট লিংকটি অসম্পূর্ণ।',
    resetNotice: 'আপনার পাসওয়ার্ড বদলানো হয়েছে। নতুন পাসওয়ার্ড দিয়ে লগ ইন করুন।',
    verifying: 'ইমেইল যাচাই হচ্ছে…',
    verified: 'ইমেইল যাচাই হয়েছে',
    logInToContinue: 'আপনার ইমেইল ঠিকানা যাচাই হয়েছে। চালিয়ে যেতে লগ ইন করুন।',
    openInvite: 'যে ওয়ার্কস্পেসে আমন্ত্রণ পেয়েছেন সেখানে যোগ দিতে ইমেইলের আমন্ত্রণ লিংকটি আবার খুলুন।',
    badLink: 'এই যাচাই লিংকের মেয়াদ শেষ বা এটি সঠিক নয়।',
    incompleteLink: 'এই যাচাই লিংকটি অসম্পূর্ণ।',
    resend: 'যাচাই ইমেইল আবার পাঠান',
    resent: 'নতুন একটি লিংক পাঠিয়েছি। আপনার ইনবক্স দেখুন।',
    server: 'সার্ভার এই মুহূর্তে পাওয়া যাচ্ছে না।',
    retry: 'আবার চেষ্টা করুন',
  },
} as const

beforeEach(() => {
  localStorage.clear()
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  vi.stubGlobal('scrollTo', () => {})
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe.each(['en', 'bn'] as const)('/forgot-password (%s)', (language) => {
  const t = copy[language]

  async function request(email = ' rahim@shop.bd ') {
    fireEvent.change(await screen.findByLabelText(t.email), { target: { value: email } })
    fireEvent.click(screen.getByRole('button', { name: t.sendLink }))
  }

  it('sends the request and shows the same generic text for any email', async () => {
    mockApi({ [REQUEST]: () => json(200, { status: true, message: 'If this email exists…' }) })
    renderAuthRoute('/forgot-password', language)
    expect(await screen.findByRole('heading', { name: t.forgotTitle })).toBeTruthy()
    await request()

    expect((await screen.findByRole('status')).textContent).toContain(t.sent)
    expect(callsTo(REQUEST)).toHaveLength(1)
    expect(callsTo(REQUEST)[0]).toMatchObject({ method: 'POST', body: { email: 'rahim@shop.bd' } })
  })

  it('checks the email before sending', async () => {
    mockApi({})
    renderAuthRoute('/forgot-password', language)
    await request('rahim@shop')
    expect(await screen.findByText(t.badEmail)).toBeTruthy()
    expect(callsTo(REQUEST)).toHaveLength(0)
  })

  it.each([
    ['429', () => json(429, { message: 'Too many requests.' }, { 'X-Retry-After': '30' }), 'rate-limited', 'tooMany'],
    ['network error', () => Promise.reject(new TypeError('Failed to fetch')), 'network', 'network'],
  ] as const)('shows the %s message and keeps the form', async (_name, respond, kind, key) => {
    mockApi({ [REQUEST]: respond })
    renderAuthRoute('/forgot-password', language)
    await request()
    const alert = await screen.findByRole('alert')
    expect(alert.dataset.kind).toBe(kind)
    expect(alert.textContent).toContain(t[key])
    expect(screen.getByRole('button', { name: t.sendLink })).toBeTruthy()
  })
})

describe.each(['en', 'bn'] as const)('/reset-password (%s)', (language) => {
  const t = copy[language]

  async function choose(password = 'new-password-1', confirm = password) {
    fireEvent.change(await screen.findByLabelText(t.newPassword), { target: { value: password } })
    fireEvent.change(screen.getByLabelText(t.confirm), { target: { value: confirm } })
    fireEvent.click(screen.getByRole('button', { name: t.save }))
  }

  it('strips the token from the URL, posts it with the new password, then shows the /login notice', async () => {
    let urlAtPost = ''
    mockApi({
      [RESET]: () => {
        urlAtPost = history.location.href
        return json(200, { status: true })
      },
    })
    const { history, queryClient } = renderAuthRoute(`/reset-password?token=${TOKEN}`, language)
    queryClient.setQueryData(['auth', 'session'], OWNER_SESSION) // revoked by the reset
    await waitFor(() => expect(history.location.href).toBe('/reset-password'))
    await choose()

    expect((await screen.findByRole('status')).textContent).toBe(t.resetNotice)
    expect(history.location.href).toBe('/login?reset=1')
    expect(urlAtPost).toBe('/reset-password')
    expect(callsTo(RESET)).toEqual([{ path: RESET, method: 'POST', body: { token: TOKEN, newPassword: 'new-password-1' } }])
  })

  it('checks length and confirmation like the backend before sending', async () => {
    mockApi({})
    renderAuthRoute(`/reset-password?token=${TOKEN}`, language)
    await choose('short', 'short')
    expect(await screen.findByText(t.short)).toBeTruthy()
    await choose('new-password-1', 'new-password-2')
    expect(await screen.findByText(t.mismatch)).toBeTruthy()
    expect(callsTo(RESET)).toHaveLength(0)
  })

  it('400 INVALID_TOKEN → "expired or used" + a link to /forgot-password', async () => {
    mockApi({ [RESET]: () => json(400, { code: 'INVALID_TOKEN', message: 'Invalid token' }) })
    renderAuthRoute(`/reset-password?token=${TOKEN}`, language)
    await choose()
    const alert = await screen.findByRole('alert')
    expect(alert.dataset.kind).toBe('invalid-token')
    expect(alert.textContent).toContain(t.expired)
    expect(screen.getByRole('link', { name: t.newLink }).getAttribute('href')).toBe('/forgot-password')
  })

  it('shows the 429 message', async () => {
    mockApi({ [RESET]: () => json(429, { message: 'Too many requests.' }, { 'X-Retry-After': '30' }) })
    renderAuthRoute(`/reset-password?token=${TOKEN}`, language)
    await choose()
    expect((await screen.findByRole('alert')).textContent).toContain(t.tooMany)
  })

  it('a link without a token shows "incomplete" and no form', async () => {
    mockApi({})
    renderAuthRoute('/reset-password', language)
    expect((await screen.findByRole('alert')).textContent).toContain(t.incompleteReset)
    expect(screen.queryByLabelText(t.newPassword)).toBeNull()
  })
})

describe.each(['en', 'bn'] as const)('/verify-email (%s)', (language) => {
  const t = copy[language]

  /** `verify` answers the GET; get-session is "signed out" until it succeeds, then `session`. */
  function verifyFlow(session: unknown, verify: () => Response = () => json(200, { status: true, user: null })) {
    let verified = false
    return {
      [VERIFY]: () => {
        const response = verify()
        verified = response.ok
        return response
      },
      '/api/auth/get-session': () => json(200, verified ? session : null),
    }
  }

  it('sends the token once (StrictMode) after stripping it, then applies postAuthDestination', async () => {
    let urlAtVerify = ''
    mockApi({
      ...verifyFlow(OWNER_SESSION, () => {
        urlAtVerify = history.location.href
        return json(200, { status: true, user: null })
      }),
      '/api/workspaces/w1/billing/summary': () => json(200, { status: 'ACTIVE' }),
      '/api/workspaces/w1/pages': () => json(200, { items: [], pageLimit: { limit: 1, activeCount: 0 } }),
    })
    const { history } = renderAuthRoute(`/verify-email?token=${TOKEN}`, language, { strict: true })

    expect(await screen.findByText('Onboarding stub')).toBeTruthy()
    expect(history.location.pathname).toBe('/onboarding')
    expect(urlAtVerify).toBe('/verify-email')
    expect(callsTo(VERIFY)).toHaveLength(1)
    const [input] = fetchMock.mock.calls.find(([url]) => String(url).includes(VERIFY))!
    expect(new URL(String(input), 'http://localhost').searchParams.get('token')).toBe(TOKEN)
  })

  it('M9-T6-a: sends the invitee back to the invite this browser signed up from', async () => {
    localStorage.setItem('shield-pending-invite', JSON.stringify({ invitationId: INVITE_ID, email: 'Rahim@Shop.bd' }))
    mockApi({
      ...verifyFlow(INVITEE_SESSION),
      '/api/auth/organization/get-invitation': () => json(200, { id: INVITE_ID, organizationId: 'w2', organizationName: 'Karim Gadgets', inviterEmail: 'o@x.bd', role: 'moderator' }),
    })
    const { router } = renderAuthRoute(`/verify-email?token=${TOKEN}`, language)
    await waitFor(() => expect(router.state.location.pathname).toBe(`/invite/${INVITE_ID}`))
    expect(localStorage.getItem('shield-pending-invite')).toBeNull()
  })

  it('M9-T6-a: an invitee on another browser is told to open the invite link again', async () => {
    mockApi(verifyFlow(INVITEE_SESSION))
    const { history } = renderAuthRoute(`/verify-email?token=${TOKEN}`, language)
    expect(await screen.findByRole('heading', { name: t.verified })).toBeTruthy()
    expect(screen.getByText(t.openInvite)).toBeTruthy()
    expect(history.location.pathname).toBe('/verify-email')
  })

  it('a replayed link (no session set) says "verified, log in"', async () => {
    mockApi(verifyFlow(null))
    renderAuthRoute(`/verify-email?token=${TOKEN}`, language)
    expect(await screen.findByText(t.logInToContinue)).toBeTruthy()
    expect(screen.getAllByRole('link').some((link) => link.getAttribute('href') === '/login')).toBe(true)
  })

  it.each(['INVALID_TOKEN', 'TOKEN_EXPIRED'])('401 %s → message + resend form', async (code) => {
    mockApi({ ...verifyFlow(null, () => json(401, { code, message: 'invalid token' })), [RESEND]: () => json(200, { status: true }) })
    renderAuthRoute(`/verify-email?token=${TOKEN}`, language)
    expect((await screen.findByRole('alert')).textContent).toContain(t.badLink)

    fireEvent.change(screen.getByLabelText(t.email), { target: { value: 'rahim@shop.bd' } })
    fireEvent.click(screen.getByRole('button', { name: t.resend }))
    expect(await screen.findByText(t.resent)).toBeTruthy()
    expect(callsTo(RESEND)).toEqual([{ path: RESEND, method: 'POST', body: { email: 'rahim@shop.bd' } }])
    expect(callsTo(VERIFY)).toHaveLength(1)
  })

  it('a 5xx offers a retry with the same token', async () => {
    let attempt = 0
    mockApi({
      ...verifyFlow(null, () => (++attempt === 1 ? json(500, { message: 'down' }) : json(200, { status: true, user: null }))),
    })
    renderAuthRoute(`/verify-email?token=${TOKEN}`, language)
    expect((await screen.findByRole('alert')).textContent).toContain(t.server)
    fireEvent.click(screen.getByRole('button', { name: t.retry }))
    expect(await screen.findByText(t.logInToContinue)).toBeTruthy()
    expect(callsTo(VERIFY)).toHaveLength(2)
  })

  it('a link without a token never calls the API', async () => {
    mockApi({})
    renderAuthRoute('/verify-email', language)
    expect((await screen.findByRole('alert')).textContent).toContain(t.incompleteLink)
    expect(screen.getByRole('button', { name: t.resend })).toBeTruthy()
    expect(callsTo(VERIFY)).toHaveLength(0)
  })
})

describe('M9-T6 routes are noindex', () => {
  it.each([
    ['/forgot-password', ForgotPasswordRoute],
    ['/reset-password', ResetPasswordRoute],
    ['/verify-email', VerifyEmailRoute],
  ])('%s', (_path, route) => {
    const head = route.options.head?.({} as never) as { meta: { name?: string; content?: string }[] }
    expect(head.meta).toContainEqual({ name: 'robots', content: 'noindex' })
  })
})
