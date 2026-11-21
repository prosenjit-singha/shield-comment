import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { callsTo, fetchMock, json, mockApi, ONE_WORKSPACE, renderAuthRoute } from '@/test/auth-routes'

// The server-render session function needs the Start compiler; the browser path never calls it.
vi.mock('@/server/session', () => ({ getServerSession: vi.fn() }))

// M7-T14: invite link `/invite/$invitationId` (Module 7 D8 a, D9/D10, M7-D18 a, M7-D22 generic page).

const ID = '01936f3e-1d2c-7a4b-8c9d-0e1f2a3b4c5d'
const PATH = `/invite/${ID}`
const GET = '/api/auth/organization/get-invitation'
const ACCEPT = '/api/auth/organization/accept-invitation'
const SIGN_UP = '/api/auth/sign-up/email'
const USER = { id: 'u2', email: 'karim@shop.bd', name: 'Karim', emailVerified: false }
const SESSION = { session: { id: 's2', userId: 'u2', impersonatedBy: null, activeOrganizationId: null }, user: USER }
const JOINED = { ...SESSION, session: { ...SESSION.session, activeOrganizationId: 'w2' } }
const INVITE = {
  id: ID,
  email: 'karim@shop.bd',
  role: 'moderator',
  organizationId: 'w2',
  inviterId: 'u1',
  status: 'pending',
  expiresAt: '2026-11-27T00:00:00.000Z',
  organizationName: 'Karim Gadgets',
  organizationSlug: 'karim-gadgets',
  inviterEmail: 'owner@gadgets.bd',
}
const refusal = (status: number, code: string, details?: Record<string, unknown>) => () =>
  json(status, { code, message: 'server text never shown', ...(details ? { details } : {}) })

const copy = {
  en: {
    title: 'You’ve been invited to a workspace',
    name: 'Your name',
    email: 'Email',
    password: 'Password',
    create: 'Create account and join',
    logIn: 'Log in',
    loginTitle: 'Welcome back',
    accept: 'Accept invite',
    invitedBy: 'Invited by',
    role: 'Moderator',
    signedInAs: 'Signed in as',
    notFound: 'This invite has expired, was cancelled or doesn’t exist.',
    wrongEmail: 'This invite was sent to a different email address.',
    logOut: 'Log out and use another account',
    seats: 'This workspace’s plan has no free seat (3 of 3 seats used). Ask the workspace owner',
    noPlan: 'This workspace has no active plan, so nobody can join right now. Ask the workspace owner',
    member: 'You’re already a member of this workspace.',
    server: 'The server is unavailable right now.',
    network: 'Can’t reach the server.',
    retry: 'Try again',
    inbox: 'Check your inbox',
    nameRequired: 'Enter your name.',
  },
  bn: {
    title: 'আপনাকে একটি ওয়ার্কস্পেসে আমন্ত্রণ জানানো হয়েছে',
    name: 'আপনার নাম',
    email: 'ইমেইল',
    password: 'পাসওয়ার্ড',
    create: 'অ্যাকাউন্ট খুলে যোগ দিন',
    logIn: 'লগ ইন',
    loginTitle: 'আবার স্বাগতম',
    accept: 'আমন্ত্রণ গ্রহণ করুন',
    invitedBy: 'আমন্ত্রণ জানিয়েছেন',
    role: 'মডারেটর',
    signedInAs: 'লগ ইন করা আছে',
    notFound: 'এই আমন্ত্রণের মেয়াদ শেষ, এটি বাতিল করা হয়েছে বা এটি নেই।',
    wrongEmail: 'এই আমন্ত্রণটি অন্য একটি ইমেইল ঠিকানায় পাঠানো হয়েছে।',
    logOut: 'লগ আউট করে অন্য অ্যাকাউন্ট ব্যবহার করুন',
    seats: 'এই ওয়ার্কস্পেসের প্ল্যানে কোনো খালি সিট নেই (৩টির মধ্যে ৩টি সিট ব্যবহৃত)।',
    noPlan: 'এই ওয়ার্কস্পেসে কোনো সক্রিয় প্ল্যান নেই, তাই এখন কেউ যোগ দিতে পারবেন না।',
    member: 'আপনি আগে থেকেই এই ওয়ার্কস্পেসের সদস্য।',
    server: 'সার্ভার এই মুহূর্তে পাওয়া যাচ্ছে না।',
    network: 'সার্ভারে সংযোগ করা যাচ্ছে না।',
    retry: 'আবার চেষ্টা করুন',
    inbox: 'আপনার ইনবক্স দেখুন',
    nameRequired: 'আপনার নাম লিখুন।',
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

async function alertText() {
  return (await screen.findByRole('alert')).textContent ?? ''
}

describe.each(['en', 'bn'] as const)('/invite/$invitationId signed out (%s)', (language) => {
  const t = copy[language]

  async function signUp(email = ' karim@shop.bd ') {
    fireEvent.change(await screen.findByLabelText(t.name), { target: { value: ' Karim ' } })
    fireEvent.change(screen.getByLabelText(t.email), { target: { value: email } })
    fireEvent.change(screen.getByLabelText(t.password), { target: { value: 'secret-password' } })
    fireEvent.click(screen.getByRole('button', { name: t.create }))
  }

  it('signs up with invitationId (no workspaceName), shows "check your inbox" and remembers the invite (M9-T6-a)', async () => {
    mockApi({ [SIGN_UP]: () => json(200, { token: null, user: USER }) })
    const { router } = renderAuthRoute(PATH, language)
    expect(await screen.findByRole('heading', { name: t.title })).toBeTruthy()
    await signUp()

    expect(await screen.findByRole('heading', { name: t.inbox })).toBeTruthy()
    expect(router.state.location.pathname).toBe(PATH)
    expect(callsTo(SIGN_UP)[0]!.body).toEqual({
      name: 'Karim',
      email: 'karim@shop.bd',
      password: 'secret-password',
      invitationId: ID,
    })
    expect(callsTo(ACCEPT)).toHaveLength(0) // no session yet: accepted after /verify-email brings them back
    expect(JSON.parse(localStorage.getItem('shield-pending-invite')!)).toEqual({ invitationId: ID, email: 'karim@shop.bd' })
    expect(screen.getByRole('link', { name: t.logIn }).getAttribute('href')).toBe(`/login?redirect=${encodeURIComponent(PATH)}`)
  })

  it('"Log in" goes to /login and comes back to the invite after signing in', async () => {
    let signedIn = false
    mockApi({
      '/api/auth/get-session': () => json(200, signedIn ? SESSION : null),
      '/api/auth/sign-in/email': () => {
        signedIn = true
        return json(200, { redirect: false, token: 't', user: USER })
      },
      [GET]: () => json(200, INVITE),
    })
    const { router } = renderAuthRoute(PATH, language)
    fireEvent.click(await screen.findByRole('link', { name: t.logIn }))
    await screen.findByRole('heading', { name: t.loginTitle })
    expect(router.state.location.search).toEqual({ redirect: PATH })

    fireEvent.change(screen.getByLabelText(t.email), { target: { value: 'karim@shop.bd' } })
    fireEvent.change(screen.getByLabelText(t.password), { target: { value: 'secret-password' } })
    fireEvent.click(screen.getByRole('button', { name: t.logIn }))

    expect(await screen.findByText('Karim Gadgets')).toBeTruthy()
    expect(router.state.location.pathname).toBe(PATH)
    expect(screen.getByRole('button', { name: t.accept })).toBeTruthy()
    expect(callsTo(ACCEPT)).toHaveLength(0)
  })

  it.each([
    ['unknown / expired / cancelled', refusal(400, 'INVITATION_NOT_FOUND'), 'notFound'],
    ['wrong email', refusal(403, 'YOU_ARE_NOT_THE_RECIPIENT_OF_THE_INVITATION'), 'wrongEmail'],
  ] as const)('shows the sign-up refusal: %s', async (_name, respond, key) => {
    mockApi({ [SIGN_UP]: respond })
    renderAuthRoute(PATH, language)
    await signUp()
    expect(await alertText()).toContain(t[key])
    expect(callsTo(ACCEPT)).toHaveLength(0)
    expect(localStorage.getItem('shield-pending-invite')).toBeNull()
  })

  it('checks the fields before sending', async () => {
    mockApi({})
    renderAuthRoute(PATH, language)
    fireEvent.click(await screen.findByRole('button', { name: t.create }))
    expect(await screen.findByText(t.nameRequired)).toBeTruthy()
    expect(callsTo(SIGN_UP)).toHaveLength(0)
  })

  it('a malformed id never reaches sign-up', async () => {
    mockApi({})
    renderAuthRoute('/invite/not-an-id', language)
    await signUp()
    expect(await alertText()).toContain(t.notFound)
    expect(callsTo(SIGN_UP)).toHaveLength(0)
  })
})

describe.each(['en', 'bn'] as const)('/invite/$invitationId signed in (%s)', (language) => {
  const t = copy[language]

  it('shows the invite, accepts, refreshes the session and opens /dashboard', async () => {
    let joined = false
    mockApi({
      '/api/auth/get-session': () => json(200, joined ? JOINED : SESSION),
      [GET]: () => json(200, INVITE),
      [ACCEPT]: () => {
        joined = true
        return json(200, { invitation: { id: ID }, member: { id: 'm2' } })
      },
    })
    const { router, queryClient } = renderAuthRoute(PATH, language)
    expect(await screen.findByText('Karim Gadgets')).toBeTruthy()
    expect(screen.getByText('owner@gadgets.bd')).toBeTruthy()
    expect(screen.getByText(t.role)).toBeTruthy()
    expect(screen.getByText(USER.email)).toBeTruthy()
    expect(screen.getByText(t.signedInAs, { exact: false })).toBeTruthy()
    expect(callsTo(GET)[0]).toBeTruthy()
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes(`id=${ID}`))).toBe(true)
    queryClient.setQueryData(['workspace', 'w1', 'team'], { stale: true })

    const sessionCalls = callsTo('/api/auth/get-session').length
    fireEvent.click(await screen.findByRole('button', { name: t.accept }))

    await waitFor(() => expect(router.state.location.pathname).toBe('/dashboard'))
    expect(callsTo(ACCEPT)[0]!.body).toEqual({ invitationId: ID })
    expect(callsTo('/api/auth/get-session').length).toBeGreaterThan(sessionCalls)
    expect(queryClient.getQueryData(['auth', 'session'])).toEqual(JOINED)
    expect(queryClient.getQueryData(['workspace', 'w1', 'team'])).toBeUndefined()
  })

  it.each([
    ['unknown / expired / cancelled', refusal(400, 'INVITATION_NOT_FOUND'), 'notFound'],
    ['server error', refusal(500, 'INTERNAL'), 'server'],
  ] as const)('read refusal: %s', async (_name, respond, key) => {
    mockApi({ '/api/auth/get-session': () => json(200, SESSION), [GET]: respond })
    renderAuthRoute(PATH, language)
    expect(await alertText()).toContain(t[key])
    expect(screen.queryByRole('button', { name: t.accept })).toBeNull()
    expect(!!screen.queryByRole('button', { name: t.retry })).toBe(key === 'server')
  })

  it('wrong email: offers "Log out and use another account", which shows the sign-up form', async () => {
    let signedIn = true
    mockApi({
      '/api/auth/get-session': () => json(200, signedIn ? SESSION : null),
      [GET]: refusal(403, 'YOU_ARE_NOT_THE_RECIPIENT_OF_THE_INVITATION'),
      '/api/auth/sign-out': () => {
        signedIn = false
        return json(200, { success: true })
      },
    })
    renderAuthRoute(PATH, language)
    expect(await alertText()).toContain(t.wrongEmail)
    expect(screen.queryByRole('button', { name: t.accept })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: t.logOut }))
    expect(await screen.findByRole('button', { name: t.create })).toBeTruthy()
    expect(callsTo('/api/auth/sign-out')).toHaveLength(1)
  })

  it.each([
    ['seat limit', refusal(409, 'SEAT_LIMIT_REACHED', { limit: 3, used: 3 }), 'seats'],
    ['no active plan', refusal(409, 'NO_ACTIVE_PLAN'), 'noPlan'],
    ['expired meanwhile', refusal(400, 'INVITATION_NOT_FOUND'), 'notFound'],
    ['network', () => Promise.reject(new TypeError('offline')), 'network'],
  ] as const)('accept refusal: %s', async (_name, respond, key) => {
    mockApi({ '/api/auth/get-session': () => json(200, SESSION), [GET]: () => json(200, INVITE), [ACCEPT]: respond })
    const { router } = renderAuthRoute(PATH, language)
    fireEvent.click(await screen.findByRole('button', { name: t.accept }))
    expect(await alertText()).toContain(t[key])
    expect(router.state.location.pathname).toBe(PATH)
    // Seat / plan / network can be retried; a gone invite can't.
    expect(!!screen.queryByRole('button', { name: t.accept })).toBe(key !== 'notFound')
  })

  it('already a member: says so and hides Accept', async () => {
    mockApi({
      '/api/auth/get-session': () => json(200, SESSION),
      [GET]: () => json(200, INVITE),
      '/api/auth/organization/list': () => json(200, [...ONE_WORKSPACE, { id: 'w2', name: 'Karim Gadgets' }]),
    })
    renderAuthRoute(PATH, language)
    expect(await screen.findByText(t.member, { exact: false })).toBeTruthy()
    expect(screen.queryByRole('button', { name: t.accept })).toBeNull()
  })
})
