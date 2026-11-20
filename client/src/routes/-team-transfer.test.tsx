import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  IMPERSONATED,
  member,
  renderAppRoute,
  SESSION,
  stubAppGlobals,
  SUMMARY,
  summaryApi,
  team,
  teamApi,
  type TeamApiOptions,
  TRANSFER,
  TRANSFER_CODE,
} from '@/test/app-routes'
import { callsTo, fetchMock, json, mockApi } from '@/test/auth-routes'
import type { Team } from '@/lib/team'

// The server-render session function needs the Start compiler; the browser path never calls it.
vi.mock('@/server/session', () => ({ getServerSession: vi.fn() }))

// M7-T13b: "Transfer ownership" on `/settings/team` (Module 7 D2, D11 b with verification, M7-D19 a).

const copy = {
  en: {
    members: 'Members',
    transfer: 'Transfer ownership',
    newOwner: 'New owner',
    password: 'Current password',
    passwordAgain: 'Current password again',
    code: 'Code from the email',
    sendCode: 'Send code',
    sendNew: 'Send a new code',
    sendAgain: /^Send again in \d+ s$/,
    cancel: 'Cancel',
    chooseMember: 'Choose who becomes the owner.',
    enterPassword: 'Enter your current password.',
    enterAgain: 'Enter your password again.',
    mismatch: 'The two passwords don’t match.',
    enterCode: 'Enter the 6-digit code from the email.',
    warning: 'The billing account (plan, wallet and payments) moves to Karim, and you become an admin.',
    googleNote: 'You sign in with Google',
    codeSent: 'We emailed you a 6-digit code.',
    done: 'Karim is now the owner and has the billing account. You’re an admin of this workspace now.',
    owner: 'Owner',
    admin: 'Admin',
    leave: 'Leave workspace',
    retry: 'Try again',
    passwordInvalid: 'That password isn’t right.',
    tooMany: 'Too many tries. Wait 10 minutes',
    targetHasAccount: 'Karim already has their own plan or billing history',
    otherWorkspaces: 'Your plan also pays for your other workspaces',
    readOnly: 'so you can see the team but not change it.',
    passwordRequired: 'Enter your current password in both fields.',
    targetGone: 'This person is no longer a member of the workspace.',
    targetSelf: 'You already own this workspace.',
    ownerOnly: 'Only the workspace owner can transfer ownership.',
    server: 'The server is unavailable right now.',
    codeInvalid: 'That code isn’t right.',
    codeExpired: 'This code has expired or was already used.',
    codeRequired: 'Enter the 6-digit code from the email.',
    emailFailed: 'We couldn’t send the email.',
    resendTooSoon: 'A code was sent less than a minute ago.',
    codeNotNeeded: 'Your account has a password',
  },
  bn: {
    members: 'সদস্য',
    transfer: 'মালিকানা হস্তান্তর',
    newOwner: 'নতুন মালিক',
    password: 'বর্তমান পাসওয়ার্ড',
    passwordAgain: 'বর্তমান পাসওয়ার্ড আবার',
    code: 'ইমেইলের কোড',
    sendCode: 'কোড পাঠান',
    sendNew: 'নতুন কোড পাঠান',
    sendAgain: /^[০-৯]+ সেকেন্ড পরে আবার পাঠান$/,
    cancel: 'বাতিল',
    chooseMember: 'কে মালিক হবেন তা বেছে নিন।',
    enterPassword: 'আপনার বর্তমান পাসওয়ার্ড লিখুন।',
    enterAgain: 'পাসওয়ার্ডটি আবার লিখুন।',
    mismatch: 'দুটি পাসওয়ার্ড মিলছে না।',
    enterCode: 'ইমেইলে পাওয়া ৬ সংখ্যার কোডটি লিখুন।',
    warning: 'বিলিং অ্যাকাউন্ট (প্ল্যান, ওয়ালেট ও পেমেন্ট) Karim-এর কাছে চলে যাবে, আর আপনি অ্যাডমিন হয়ে যাবেন।',
    googleNote: 'আপনি Google দিয়ে লগ ইন করেন',
    codeSent: 'আমরা আপনাকে একটি ৬ সংখ্যার কোড ইমেইল করেছি।',
    done: 'Karim এখন মালিক এবং বিলিং অ্যাকাউন্ট তাঁর কাছে গেছে। আপনি এখন এই ওয়ার্কস্পেসের অ্যাডমিন।',
    owner: 'মালিক',
    admin: 'অ্যাডমিন',
    leave: 'ওয়ার্কস্পেস ছেড়ে দিন',
    retry: 'আবার চেষ্টা করুন',
    passwordInvalid: 'পাসওয়ার্ডটি সঠিক নয়।',
    tooMany: 'অনেকবার চেষ্টা করা হয়েছে। ১০ মিনিট অপেক্ষা করে',
    targetHasAccount: 'Karim-এর নিজের প্ল্যান বা বিলিং ইতিহাস আছে',
    otherWorkspaces: 'আপনার প্ল্যান অন্য ওয়ার্কস্পেসগুলোর খরচও দেয়',
    readOnly: 'তাই টিম দেখতে পারবেন কিন্তু বদলাতে পারবেন না।',
    passwordRequired: 'দুই ঘরেই আপনার বর্তমান পাসওয়ার্ড লিখুন।',
    targetGone: 'এই ব্যক্তি আর ওয়ার্কস্পেসের সদস্য নন।',
    targetSelf: 'আপনি আগে থেকেই এই ওয়ার্কস্পেসের মালিক।',
    ownerOnly: 'শুধু ওয়ার্কস্পেসের মালিক মালিকানা হস্তান্তর করতে পারেন।',
    server: 'সার্ভার এই মুহূর্তে পাওয়া যাচ্ছে না।',
    codeInvalid: 'কোডটি সঠিক নয়।',
    codeExpired: 'এই কোডের মেয়াদ শেষ বা এটি আগেই ব্যবহার হয়েছে।',
    codeRequired: 'ইমেইলে পাওয়া ৬ সংখ্যার কোডটি লিখুন।',
    emailFailed: 'ইমেইল পাঠানো যায়নি।',
    resendTooSoon: 'এক মিনিটের কম আগে একটি কোড পাঠানো হয়েছে।',
    codeNotNeeded: 'আপনার অ্যাকাউন্টে পাসওয়ার্ড আছে',
  },
} as const

type Key = Exclude<keyof (typeof copy)['en'], 'sendAgain'>

const as = (userId: string) => ({ ...SESSION, user: { ...SESSION.user, id: userId }, session: { ...SESSION.session, userId } })
const ADMIN = as('u2')
const MODERATOR = as('u3')

const setup = (session: unknown = SESSION, data: Team = team(), options: TeamApiOptions = {}) =>
  mockApi({ '/api/auth/get-session': () => json(200, session), ...summaryApi(), ...teamApi(data, options) })

const row = (memberId: string) => document.querySelector<HTMLElement>(`[data-member="${memberId}"]`)!
const posts = (path: string) => callsTo(path).filter((call) => call.method === 'POST')
const gets = (path: string) => callsTo(path).filter((call) => call.method === 'GET')
const ready = (language: 'en' | 'bn') => screen.findByRole('heading', { name: copy[language].members })
const codeMethod = { onMethod: () => json(200, { method: 'code' }) }

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  stubAppGlobals()
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe.each(['en', 'bn'] as const)('M7-T13b transfer ownership (%s)', (language) => {
  const t = copy[language]

  async function openDialog() {
    await ready(language)
    fireEvent.click(within(row('m-owner')).getByRole('button', { name: t.transfer }))
    return screen.findByRole('dialog', { name: t.transfer })
  }
  const pick = (dialog: HTMLElement, memberId = 'm-admin') => fireEvent.change(within(dialog).getByLabelText(t.newOwner), { target: { value: memberId } })
  const submit = (dialog: HTMLElement) => fireEvent.click(within(dialog).getByRole('button', { name: t.transfer }))
  const typePasswords = (dialog: HTMLElement, first: string, second: string) => {
    fireEvent.change(within(dialog).getByLabelText(t.password), { target: { value: first } })
    fireEvent.change(within(dialog).getByLabelText(t.passwordAgain), { target: { value: second } })
  }

  it('only the owner sees the button, on their own row; not admin, moderator, impersonated or a lone owner', async () => {
    setup()
    renderAppRoute('/settings/team', language)
    await ready(language)
    expect(within(row('m-owner')).getByRole('button', { name: t.transfer })).toBeTruthy()
    expect(screen.getAllByRole('button', { name: t.transfer })).toHaveLength(1)
    cleanup()

    for (const session of [ADMIN, MODERATOR, IMPERSONATED]) {
      setup(session)
      renderAppRoute('/settings/team', language)
      await ready(language)
      expect(screen.queryByRole('button', { name: t.transfer })).toBeNull()
      cleanup()
    }

    setup(SESSION, team({ members: [member()], invitations: [], seats: { used: 1, limit: 3 } }))
    renderAppRoute('/settings/team', language)
    await ready(language)
    expect(screen.queryByRole('button', { name: t.transfer })).toBeNull()
    expect(gets(TRANSFER)).toHaveLength(0)
  })

  it('password method: picker of non-owners, warning, required fields and mismatch are checked before sending', async () => {
    setup()
    renderAppRoute('/settings/team', language)
    const dialog = await openDialog()

    const options = within(dialog).getAllByRole('option').map((option) => (option as HTMLOptionElement).value)
    expect(options).toEqual(['', 'm-admin', 'm-mod'])
    expect(await within(dialog).findByLabelText(t.password)).toBeTruthy()
    expect(gets(TRANSFER)).toHaveLength(1)
    expect(within(dialog).queryByRole('button', { name: t.sendCode })).toBeNull()

    submit(dialog)
    expect(within(dialog).getByText(t.chooseMember)).toBeTruthy()
    expect(within(dialog).getByText(t.enterPassword)).toBeTruthy()
    expect(within(dialog).getByText(t.enterAgain)).toBeTruthy()

    pick(dialog)
    expect(within(dialog).getByText((_, element) => element?.tagName === 'P' && Boolean(element.textContent?.includes(t.warning)))).toBeTruthy()
    typePasswords(dialog, 'secret-pass-1', 'secret-pass-2')
    submit(dialog)
    expect(within(dialog).getByText(t.mismatch)).toBeTruthy()
    expect(posts(TRANSFER)).toHaveLength(0)
  })

  it('password success: sends both passwords, updates the team, viewer becomes admin, billing reloads, notice', async () => {
    setup()
    renderAppRoute('/settings/team', language)
    const dialog = await openDialog()
    await within(dialog).findByLabelText(t.password)
    await waitFor(() => expect(gets(SUMMARY).length).toBeGreaterThan(0))
    const summaryLoads = gets(SUMMARY).length

    pick(dialog)
    typePasswords(dialog, 'secret-pass-1', 'secret-pass-1')
    submit(dialog)

    expect(await screen.findByText(t.done)).toBeTruthy()
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(posts(TRANSFER).map((call) => call.body)).toEqual([{ memberId: 'm-admin', password: 'secret-pass-1', passwordConfirm: 'secret-pass-1' }])
    expect(row('m-admin').querySelector('[data-role]')?.textContent).toBe(t.owner)
    expect(row('m-owner').querySelector('[data-role]')?.textContent).toBe(t.admin)
    expect(screen.queryByRole('button', { name: t.transfer })).toBeNull()
    expect(screen.getByRole('button', { name: t.leave })).toBeTruthy()
    await waitFor(() => expect(gets(SUMMARY).length).toBe(summaryLoads + 1))
    expect(gets('/api/workspaces/w1/team')).toHaveLength(1) // the answer is the new team; no refetch
  })

  it('code method: send code, resend wait, 6-digit check, then transfer with the code', async () => {
    setup(SESSION, team(), codeMethod)
    renderAppRoute('/settings/team', language)
    const dialog = await openDialog()

    expect(await within(dialog).findByText((_, element) => element?.tagName === 'P' && Boolean(element.textContent?.includes(t.googleNote)))).toBeTruthy()
    expect(within(dialog).queryByLabelText(t.password)).toBeNull()
    expect((within(dialog).getByRole('button', { name: t.transfer }) as HTMLButtonElement).disabled).toBe(true)

    fireEvent.click(within(dialog).getByRole('button', { name: t.sendCode }))
    const wait = await within(dialog).findByRole('button', { name: t.sendAgain })
    expect((wait as HTMLButtonElement).disabled).toBe(true)
    expect(within(dialog).getByText(t.codeSent, { exact: false })).toBeTruthy()
    expect(posts(TRANSFER_CODE)).toHaveLength(1)

    pick(dialog)
    const code = within(dialog).getByLabelText(t.code) as HTMLInputElement
    fireEvent.change(code, { target: { value: '12a3' } })
    expect(code.value).toBe('123')
    submit(dialog)
    expect(within(dialog).getByText(t.enterCode)).toBeTruthy()
    expect(posts(TRANSFER)).toHaveLength(0)

    fireEvent.change(code, { target: { value: '123456' } })
    submit(dialog)
    expect(await screen.findByText(t.done)).toBeTruthy()
    expect(posts(TRANSFER).map((call) => call.body)).toEqual([{ memberId: 'm-admin', code: '123456' }])
  })

  it('code method: once the wait is over a new code can be sent', async () => {
    const past = () => json(200, { expiresAt: new Date(Date.now() + 600_000).toISOString(), resendAt: new Date(Date.now() - 1000).toISOString() })
    setup(SESSION, team(), { ...codeMethod, onSendCode: past })
    renderAppRoute('/settings/team', language)
    const dialog = await openDialog()

    fireEvent.click(await within(dialog).findByRole('button', { name: t.sendCode }))
    fireEvent.click(await within(dialog).findByRole('button', { name: t.sendNew }))
    await waitFor(() => expect(posts(TRANSFER_CODE)).toHaveLength(2))
  })

  it.each([
    ['TRANSFER_PASSWORD_INVALID', 403, 'passwordInvalid'],
    ['TRANSFER_TOO_MANY_ATTEMPTS', 429, 'tooMany'],
    ['TRANSFER_TARGET_HAS_ACCOUNT', 409, 'targetHasAccount'],
    ['TRANSFER_ACCOUNT_HAS_OTHER_WORKSPACES', 409, 'otherWorkspaces'],
    ['IMPERSONATION_READ_ONLY', 403, 'readOnly'],
    ['TRANSFER_PASSWORD_REQUIRED', 400, 'passwordRequired'],
    ['TRANSFER_PASSWORD_MISMATCH', 400, 'mismatch'],
    ['TRANSFER_TARGET_NOT_FOUND', 404, 'targetGone'],
    ['TRANSFER_TARGET_IS_SELF', 400, 'targetSelf'],
    [undefined, 403, 'ownerOnly'],
    [undefined, 503, 'server'],
  ] as const)('password transfer refused with %s (%s) stays open with the reason and keeps the session', async (code, status, key) => {
    setup(SESSION, team(), { onTransfer: () => json(status, { code, message: 'server text' }) })
    const { history } = renderAppRoute('/settings/team', language)
    const dialog = await openDialog()
    await within(dialog).findByLabelText(t.password)

    pick(dialog)
    typePasswords(dialog, 'secret-pass-1', 'secret-pass-1')
    submit(dialog)

    const alert = await within(dialog).findByRole('alert')
    expect(alert.textContent).toContain(t[key as Key])
    expect(alert.textContent).not.toContain('server text')
    expect(screen.getByRole('dialog', { name: t.transfer })).toBeTruthy()
    expect(history.location.pathname).toBe('/settings/team')
    expect(callsTo('/api/auth/sign-out')).toHaveLength(0)
    expect(row('m-owner').querySelector('[data-role]')?.textContent).toBe(t.owner)
  })

  it.each([
    ['TRANSFER_CODE_EMAIL_FAILED', 503, 'emailFailed'],
    ['TRANSFER_CODE_RESEND_TOO_SOON', 429, 'resendTooSoon'],
  ] as const)('send code refused with %s shows the reason and allows another try', async (code, status, key) => {
    setup(SESSION, team(), { ...codeMethod, onSendCode: () => json(status, { code, message: 'x' }) })
    renderAppRoute('/settings/team', language)
    const dialog = await openDialog()

    fireEvent.click(await within(dialog).findByRole('button', { name: t.sendCode }))
    expect((await within(dialog).findByRole('alert')).textContent).toContain(t[key])
    expect((within(dialog).getByRole('button', { name: t.sendCode }) as HTMLButtonElement).disabled).toBe(false)
    expect(within(dialog).queryByLabelText(t.code)).toBeNull()
  })

  it('send code refused with TRANSFER_CODE_NOT_NEEDED reloads the method and shows the password fields', async () => {
    let method = 'code'
    setup(SESSION, team(), {
      onMethod: () => json(200, { method }),
      onSendCode: () => {
        method = 'password'
        return json(409, { code: 'TRANSFER_CODE_NOT_NEEDED', message: 'x' })
      },
    })
    renderAppRoute('/settings/team', language)
    const dialog = await openDialog()

    fireEvent.click(await within(dialog).findByRole('button', { name: t.sendCode }))
    expect((await within(dialog).findByRole('alert')).textContent).toContain(t.codeNotNeeded)
    expect(await within(dialog).findByLabelText(t.password)).toBeTruthy()
    expect(gets(TRANSFER)).toHaveLength(2)
  })

  it.each([
    ['TRANSFER_CODE_INVALID', 403, 'codeInvalid'],
    ['TRANSFER_CODE_EXPIRED', 403, 'codeExpired'],
    ['TRANSFER_CODE_REQUIRED', 400, 'codeRequired'],
    ['TRANSFER_TOO_MANY_ATTEMPTS', 429, 'tooMany'],
  ] as const)('code transfer refused with %s stays open with the reason', async (code, status, key) => {
    setup(SESSION, team(), { ...codeMethod, onTransfer: () => json(status, { code, message: 'x' }) })
    renderAppRoute('/settings/team', language)
    const dialog = await openDialog()

    fireEvent.click(await within(dialog).findByRole('button', { name: t.sendCode }))
    pick(dialog)
    fireEvent.change(await within(dialog).findByLabelText(t.code), { target: { value: '654321' } })
    submit(dialog)

    expect((await within(dialog).findByRole('alert')).textContent).toContain(t[key])
    expect(screen.getByRole('dialog', { name: t.transfer })).toBeTruthy()
  })

  it('a failed method load shows the reason with Try again', async () => {
    let fail = true
    setup(SESSION, team(), { onMethod: () => (fail ? json(503, {}) : json(200, { method: 'password' })) })
    renderAppRoute('/settings/team', language)
    const dialog = await openDialog()

    expect((await within(dialog).findByRole('alert')).textContent).toContain(t.server)
    fail = false
    fireEvent.click(within(dialog).getByRole('button', { name: t.retry }))
    expect(await within(dialog).findByLabelText(t.password)).toBeTruthy()
  })

  it('Cancel closes without sending', async () => {
    setup()
    renderAppRoute('/settings/team', language)
    const dialog = await openDialog()
    await within(dialog).findByLabelText(t.password)

    fireEvent.click(within(dialog).getByRole('button', { name: t.cancel }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(posts(TRANSFER)).toHaveLength(0)
  })
})
