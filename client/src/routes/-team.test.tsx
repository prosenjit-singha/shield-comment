import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  dashboardApi,
  IMPERSONATED,
  invitation,
  member,
  ORG,
  renderAppRoute,
  SESSION,
  stubAppGlobals,
  summaryApi,
  team,
  TEAM,
  teamApi,
  type TeamApiOptions,
} from '@/test/app-routes'
import { callsTo, fetchMock, json, mockApi } from '@/test/auth-routes'
import type { Team } from '@/lib/team'

// The server-render session function needs the Start compiler; the browser path never calls it.
vi.mock('@/server/session', () => ({ getServerSession: vi.fn() }))

// M7-T13: C11 `/settings/team` (Module 7 D2, D7, D9, D10, D11).

const copy = {
  en: {
    members: 'Members',
    invite: 'Invite member',
    inviteTitle: 'Invite a member',
    email: 'Email',
    role: 'Role',
    send: 'Send invite',
    enterEmail: 'Enter an email address.',
    badEmail: 'Enter a valid email address.',
    owner: 'Owner',
    admin: 'Admin',
    moderator: 'Moderator',
    makeAdmin: 'Make admin',
    makeMod: 'Make moderator',
    remove: 'Remove',
    resend: 'Resend',
    cancelInvite: 'Cancel invite',
    changeRole: 'Change role',
    yesRemove: 'Yes, remove',
    cancel: 'Cancel',
    leave: 'Leave workspace',
    yesLeave: 'Yes, leave',
    you: '(you)',
    count: (used: string, limit: string) => `${used} / ${limit}`,
    noPlanCount: '0 / no plan',
    under: '6 seats left.',
    full: 'All seats are in use.',
    over: 'You’re using 4 seats but your plan has 3.',
    noPlan: 'Your workspace has no active plan',
    seePlans: 'See plans',
    impersonated: 'You can see the team, but invites and member changes are off',
    moderatorNote: 'Only the owner and admins can invite people or change the team.',
    seatLimit: 'Your plan has 3 seats and 3 are used',
    noActivePlan: 'Your plan has ended, so you can’t invite people.',
    roleRefused: 'You can’t invite someone with this role.',
    alreadyMember: 'This person is already a member of the workspace.',
    ownerProtected: 'The workspace owner can’t be removed, change role or leave.',
    readOnlyError: 'so you can see the team but not change it.',
    inviteGone: 'This invite no longer exists.',
    server: 'The server is unavailable right now.',
    invited: 'Invite sent to new.admin@shop.bd.',
    resent: 'Invite sent again to new.mod@shop.bd.',
    cancelled: 'Invite to new.mod@shop.bd cancelled.',
    nowAdmin: 'Mina is now admin.',
    removed: 'Mina was removed from the workspace.',
    removeTitle: 'Remove Mina?',
    roleTitle: 'Make Mina admin?',
    noInvites: 'No pending invites.',
    loadFailed: 'Couldn’t load your team',
    retry: 'Try again',
  },
  bn: {
    members: 'সদস্য',
    invite: 'সদস্য আমন্ত্রণ',
    inviteTitle: 'সদস্য আমন্ত্রণ জানান',
    email: 'ইমেইল',
    role: 'রোল',
    send: 'আমন্ত্রণ পাঠান',
    enterEmail: 'একটি ইমেইল ঠিকানা লিখুন।',
    badEmail: 'একটি সঠিক ইমেইল ঠিকানা লিখুন।',
    owner: 'মালিক',
    admin: 'অ্যাডমিন',
    moderator: 'মডারেটর',
    makeAdmin: 'অ্যাডমিন করুন',
    makeMod: 'মডারেটর করুন',
    remove: 'সরান',
    resend: 'আবার পাঠান',
    cancelInvite: 'আমন্ত্রণ বাতিল',
    changeRole: 'রোল বদলান',
    yesRemove: 'হ্যাঁ, সরান',
    cancel: 'বাতিল',
    leave: 'ওয়ার্কস্পেস ছেড়ে দিন',
    yesLeave: 'হ্যাঁ, ছেড়ে দিন',
    you: '(আপনি)',
    count: (used: string, limit: string) => `${used} / ${limit}`,
    noPlanCount: '০ / প্ল্যান নেই',
    under: 'আরও ৬টি সিট বাকি।',
    full: 'সব সিট ব্যবহার হয়ে গেছে।',
    over: 'আপনি ৪টি সিট ব্যবহার করছেন কিন্তু আপনার প্ল্যানে আছে ৩টি।',
    noPlan: 'আপনার ওয়ার্কস্পেসে কোনো সক্রিয় প্ল্যান নেই',
    seePlans: 'প্ল্যান দেখুন',
    impersonated: 'টিম দেখতে পারবেন, কিন্তু ক্লায়েন্টের নামে কিছু যেন না হয় তাই আমন্ত্রণ ও সদস্য পরিবর্তন বন্ধ।',
    moderatorNote: 'শুধু মালিক ও অ্যাডমিন কাউকে আমন্ত্রণ জানাতে বা টিম বদলাতে পারেন।',
    seatLimit: 'আপনার প্ল্যানে ৩টি সিট আছে এবং ৩টি ব্যবহার হয়েছে',
    noActivePlan: 'আপনার প্ল্যান শেষ হয়ে গেছে, তাই কাউকে আমন্ত্রণ জানানো যাবে না।',
    roleRefused: 'আপনি এই রোলে কাউকে আমন্ত্রণ জানাতে পারবেন না।',
    alreadyMember: 'এই ব্যক্তি আগে থেকেই ওয়ার্কস্পেসের সদস্য।',
    ownerProtected: 'ওয়ার্কস্পেসের মালিককে সরানো, তাঁর রোল বদলানো বা তাঁর চলে যাওয়া যায় না।',
    readOnlyError: 'তাই টিম দেখতে পারবেন কিন্তু বদলাতে পারবেন না।',
    inviteGone: 'এই আমন্ত্রণটি আর নেই।',
    server: 'সার্ভার এই মুহূর্তে পাওয়া যাচ্ছে না।',
    invited: 'new.admin@shop.bd-এ আমন্ত্রণ পাঠানো হয়েছে।',
    resent: 'new.mod@shop.bd-এ আবার আমন্ত্রণ পাঠানো হয়েছে।',
    cancelled: 'new.mod@shop.bd-এর আমন্ত্রণ বাতিল করা হয়েছে।',
    nowAdmin: 'Mina এখন অ্যাডমিন।',
    removed: 'Mina-কে ওয়ার্কস্পেস থেকে সরানো হয়েছে।',
    removeTitle: 'Mina-কে সরাবেন?',
    roleTitle: 'Mina-কে অ্যাডমিন করবেন?',
    noInvites: 'কোনো অপেক্ষমাণ আমন্ত্রণ নেই।',
    loadFailed: 'আপনার টিম লোড করা যায়নি',
    retry: 'আবার চেষ্টা করুন',
  },
} as const

const as = (userId: string) => ({ ...SESSION, user: { ...SESSION.user, id: userId }, session: { ...SESSION.session, userId } })
const ADMIN = as('u2')
const MODERATOR = as('u3')

const setup = (session: unknown = SESSION, data: Team = team(), options: TeamApiOptions = {}) =>
  mockApi({ '/api/auth/get-session': () => json(200, session), ...summaryApi(), ...teamApi(data, options) })

const row = (memberId: string) => document.querySelector<HTMLElement>(`[data-member="${memberId}"]`)!
const inviteRow = (id: string) => document.querySelector<HTMLElement>(`[data-invite="${id}"]`)!
const buttons = (element: HTMLElement) => within(element).queryAllByRole('button').map((button) => button.textContent)
const posts = (path: string) => callsTo(ORG(path)).filter((call) => call.method === 'POST')
const ready = (language: 'en' | 'bn') => screen.findByRole('heading', { name: copy[language].members })
const noteText = () => screen.getByTestId('seat-note').textContent

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  stubAppGlobals()
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe.each(['en', 'bn'] as const)('M7-T13 /settings/team (%s)', (language) => {
  const t = copy[language]
  const digits = (value: string) => (language === 'bn' ? value.replace(/\d/g, (d) => '০১২৩৪৫৬৭৮৯'[Number(d)]!) : value)

  it('lists members owner first with role pills, the pending invite and the seats meter', async () => {
    setup()
    renderAppRoute('/settings/team', language)
    await ready(language)

    const rows = within(screen.getByRole('table')).getAllByRole('row').slice(1)
    expect(rows.map((item) => item.dataset.member)).toEqual(['m-owner', 'm-admin', 'm-mod'])
    expect(rows.map((item) => item.querySelector('[data-role]')?.textContent)).toEqual([t.owner, t.admin, t.moderator])
    expect(row('m-owner').textContent).toContain(t.you)
    expect(row('m-admin').textContent).toContain('karim@shop.bd')
    expect(inviteRow('inv-1').textContent).toContain('new.mod@shop.bd')
    expect(inviteRow('inv-1').textContent).toContain('Rahim')
    expect(screen.getByTestId('seat-count').textContent).toBe(t.count(digits('4'), digits('10')))
    expect(screen.getByRole('meter').getAttribute('aria-valuenow')).toBe('4')
    expect(noteText()).toContain(t.under)
    expect(callsTo(TEAM)).toHaveLength(1)
  })

  it('owner: re-roles and removes admins and moderators, never the owner row; invites admin or moderator', async () => {
    setup()
    renderAppRoute('/settings/team', language)
    await ready(language)

    expect(buttons(row('m-owner'))).toEqual([])
    expect(buttons(row('m-admin'))).toEqual([t.makeMod, t.remove])
    expect(buttons(row('m-mod'))).toEqual([t.makeAdmin, t.remove])
    expect(buttons(inviteRow('inv-1'))).toEqual([t.resend, t.cancelInvite])
    expect(screen.queryByRole('button', { name: t.leave })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: t.invite }))
    const dialog = await screen.findByRole('dialog', { name: t.inviteTitle })
    const options = within(dialog).getAllByRole('option')
    expect(options.map((option) => option.textContent)).toEqual([t.admin, t.moderator])
    expect((within(dialog).getByLabelText(t.role) as HTMLSelectElement).value).toBe('moderator')
  })

  it('admin: removes moderators only, invites moderators only, manages moderator invites only, may leave', async () => {
    setup(ADMIN, team({ invitations: [invitation(), invitation({ id: 'inv-2', email: 'a2@shop.bd', role: 'admin' })] }))
    renderAppRoute('/settings/team', language)
    await ready(language)

    expect(buttons(row('m-owner'))).toEqual([])
    expect(buttons(row('m-admin'))).toEqual([])
    expect(buttons(row('m-mod'))).toEqual([t.remove])
    expect(buttons(inviteRow('inv-1'))).toEqual([t.resend, t.cancelInvite])
    expect(buttons(inviteRow('inv-2'))).toEqual([])
    expect(screen.getByRole('button', { name: t.leave })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: t.invite }))
    const dialog = await screen.findByRole('dialog', { name: t.inviteTitle })
    expect(within(dialog).getAllByRole('option').map((option) => option.textContent)).toEqual([t.moderator])
  })

  it('moderator: read-only view with a note, no invite or member actions, may leave', async () => {
    setup(MODERATOR)
    renderAppRoute('/settings/team', language)
    await ready(language)

    expect(screen.getByText(t.moderatorNote)).toBeTruthy()
    expect(screen.queryByRole('button', { name: t.invite })).toBeNull()
    for (const id of ['m-owner', 'm-admin', 'm-mod']) expect(buttons(row(id))).toEqual([])
    expect(buttons(inviteRow('inv-1'))).toEqual([])
    expect(screen.getByRole('button', { name: t.leave })).toBeTruthy()
  })

  it('D2: an impersonated session reads the team with an explanation and no actions at all', async () => {
    setup(IMPERSONATED)
    renderAppRoute('/settings/team', language)
    await ready(language)

    expect(screen.getByText((_, element) => element?.tagName === 'P' && Boolean(element.textContent?.includes(t.impersonated)))).toBeTruthy()
    expect(screen.queryByText(t.moderatorNote)).toBeNull()
    expect(screen.queryByRole('button', { name: t.invite })).toBeNull()
    expect(screen.queryByRole('button', { name: t.leave })).toBeNull()
    for (const id of ['m-owner', 'm-admin', 'm-mod']) expect(buttons(row(id))).toEqual([])
    expect(buttons(inviteRow('inv-1'))).toEqual([])
  })

  it('invite: validates the email, sends email + role + workspace, closes and shows the new invite', async () => {
    setup()
    renderAppRoute('/settings/team', language)
    await ready(language)

    fireEvent.click(screen.getByRole('button', { name: t.invite }))
    const dialog = await screen.findByRole('dialog', { name: t.inviteTitle })
    fireEvent.click(within(dialog).getByRole('button', { name: t.send }))
    expect(await within(dialog).findByText(t.enterEmail)).toBeTruthy()
    fireEvent.change(within(dialog).getByLabelText(t.email), { target: { value: 'not-an-email' } })
    expect(within(dialog).getByText(t.badEmail)).toBeTruthy()
    expect(posts('invite-member')).toHaveLength(0)

    fireEvent.change(within(dialog).getByLabelText(t.email), { target: { value: ' New.Admin@shop.bd ' } })
    fireEvent.change(within(dialog).getByLabelText(t.role), { target: { value: 'admin' } })
    fireEvent.click(within(dialog).getByRole('button', { name: t.send }))

    expect(await screen.findByText(t.invited)).toBeTruthy()
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(posts('invite-member').map((call) => call.body)).toEqual([{ email: 'new.admin@shop.bd', role: 'admin', organizationId: 'w1' }])
    await waitFor(() => expect(inviteRow('inv-3')?.textContent).toContain('new.admin@shop.bd'))
    expect(screen.getByTestId('seat-count').textContent).toBe(t.count(digits('5'), digits('10')))
  })

  it.each([
    ['SEAT_LIMIT_REACHED', 409, { details: { limit: 3, used: 3 } }, 'seatLimit'],
    ['NO_ACTIVE_PLAN', 409, {}, 'noActivePlan'],
    ['YOU_ARE_NOT_ALLOWED_TO_INVITE_USER_WITH_THIS_ROLE', 403, {}, 'roleRefused'],
    ['USER_IS_ALREADY_A_MEMBER_OF_THIS_ORGANIZATION', 400, {}, 'alreadyMember'],
    ['IMPERSONATION_READ_ONLY', 403, {}, 'readOnlyError'],
  ] as const)('invite refused with %s keeps the dialog open with the reason', async (code, status, extra, key) => {
    setup(SESSION, team(), { onInvite: () => json(status, { code, message: 'server text', ...extra }) })
    renderAppRoute('/settings/team', language)
    await ready(language)

    fireEvent.click(screen.getByRole('button', { name: t.invite }))
    const dialog = await screen.findByRole('dialog', { name: t.inviteTitle })
    fireEvent.change(within(dialog).getByLabelText(t.email), { target: { value: 'x@shop.bd' } })
    fireEvent.click(within(dialog).getByRole('button', { name: t.send }))

    const alert = await within(dialog).findByRole('alert')
    expect(alert.textContent).toContain(t[key])
    expect(alert.textContent).not.toContain('server text')
    expect(screen.getByRole('dialog', { name: t.inviteTitle })).toBeTruthy()
  })

  it('pending invite: resend re-invites the same email and role; cancel removes it', async () => {
    setup()
    renderAppRoute('/settings/team', language)
    await ready(language)

    fireEvent.click(within(inviteRow('inv-1')).getByRole('button', { name: t.resend }))
    expect(await screen.findByText(t.resent)).toBeTruthy()
    expect(posts('invite-member').map((call) => call.body)).toEqual([
      { email: 'new.mod@shop.bd', role: 'moderator', resend: true, organizationId: 'w1' },
    ])

    fireEvent.click(within(inviteRow('inv-1')).getByRole('button', { name: t.cancelInvite }))
    expect(await screen.findByText(t.cancelled)).toBeTruthy()
    expect(posts('cancel-invitation').map((call) => call.body)).toEqual([{ invitationId: 'inv-1' }])
    expect(await screen.findByText(t.noInvites)).toBeTruthy()
  })

  it('pending invite: a failed cancel shows the mapped reason', async () => {
    setup(SESSION, team(), { onCancel: () => json(400, { code: 'INVITATION_NOT_FOUND', message: 'x' }) })
    renderAppRoute('/settings/team', language)
    await ready(language)

    fireEvent.click(within(inviteRow('inv-1')).getByRole('button', { name: t.cancelInvite }))
    expect((await screen.findByRole('alert')).textContent).toContain(t.inviteGone)
  })

  it('role change asks first; Cancel sends nothing, confirming updates the role', async () => {
    setup()
    renderAppRoute('/settings/team', language)
    await ready(language)

    fireEvent.click(within(row('m-mod')).getByRole('button', { name: t.makeAdmin }))
    let dialog = await screen.findByRole('dialog', { name: t.roleTitle })
    fireEvent.click(within(dialog).getByRole('button', { name: t.cancel }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(posts('update-member-role')).toHaveLength(0)

    fireEvent.click(within(row('m-mod')).getByRole('button', { name: t.makeAdmin }))
    dialog = await screen.findByRole('dialog', { name: t.roleTitle })
    fireEvent.click(within(dialog).getByRole('button', { name: t.changeRole }))
    expect(await screen.findByText(t.nowAdmin)).toBeTruthy()
    expect(posts('update-member-role').map((call) => call.body)).toEqual([{ memberId: 'm-mod', role: 'admin', organizationId: 'w1' }])
    await waitFor(() => expect(row('m-mod').querySelector('[data-role]')?.textContent).toBe(t.admin))
    await waitFor(() => expect(buttons(row('m-mod'))).toEqual([t.makeMod, t.remove])) // outside content is aria-hidden until the dialog closes
  })

  it('remove asks first and drops the member', async () => {
    setup()
    renderAppRoute('/settings/team', language)
    await ready(language)

    fireEvent.click(within(row('m-mod')).getByRole('button', { name: t.remove }))
    const dialog = await screen.findByRole('dialog', { name: t.removeTitle })
    fireEvent.click(within(dialog).getByRole('button', { name: t.yesRemove }))
    expect(await screen.findByText(t.removed)).toBeTruthy()
    expect(posts('remove-member').map((call) => call.body)).toEqual([{ memberIdOrEmail: 'm-mod', organizationId: 'w1' }])
    await waitFor(() => expect(row('m-mod')).toBeNull())
  })

  it.each([
    ['WORKSPACE_OWNER_PROTECTED', 403, 'ownerProtected'],
    ['IMPERSONATION_READ_ONLY', 403, 'readOnlyError'],
    [undefined, 503, 'server'],
  ] as const)('a refused remove (%s) stays in the dialog with the reason', async (code, status, key) => {
    setup(SESSION, team(), { onRemove: () => json(status, { code, message: 'x' }) })
    renderAppRoute('/settings/team', language)
    await ready(language)

    fireEvent.click(within(row('m-admin')).getByRole('button', { name: t.remove }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: t.yesRemove }))
    expect((await within(dialog).findByRole('alert')).textContent).toContain(t[key])
    expect(row('m-admin')).toBeTruthy()
  })

  it.each([
    ['full', { used: 10, limit: 10 }, 'full', ['10', '10']],
    ['over', { used: 4, limit: 3 }, 'over', ['4', '3']],
  ] as const)('seats %s: invite is disabled with the reason and a plans link', async (_, seats, key, [used, limit]) => {
    setup(SESSION, team({ seats }))
    renderAppRoute('/settings/team', language)
    await ready(language)

    const invite = screen.getByRole('button', { name: t.invite }) as HTMLButtonElement
    expect(invite.disabled).toBe(true)
    expect(document.getElementById(invite.getAttribute('aria-describedby')!)?.textContent).toContain(t[key])
    expect(screen.getByTestId('seat-count').textContent).toBe(t.count(digits(used), digits(limit)))
    expect(screen.getByRole('link', { name: t.seePlans }).getAttribute('href')).toBe('/plans')
  })

  it('no live plan (limit null): invite is disabled with the plan message', async () => {
    setup(SESSION, team({ members: [member()], invitations: [], seats: { used: 0, limit: null } }))
    renderAppRoute('/settings/team', language)
    await ready(language)

    expect((screen.getByRole('button', { name: t.invite }) as HTMLButtonElement).disabled).toBe(true)
    expect(noteText()).toContain(t.noPlan)
    expect(screen.getByTestId('seat-count').textContent).toBe(t.noPlanCount)
    expect(screen.getByText(t.noInvites)).toBeTruthy()
  })

  it('leave: asks first, leaves, clears the active workspace and goes to the dashboard', async () => {
    let left = false
    mockApi({
      '/api/auth/get-session': () => json(200, left ? { ...MODERATOR, session: { ...MODERATOR.session, activeOrganizationId: null } } : MODERATOR),
      ...summaryApi(),
      ...dashboardApi(),
      ...teamApi(team(), {
        onLeave: () => {
          left = true
          return json(200, { status: true })
        },
      }),
    })
    const { history } = renderAppRoute('/settings/team', language)
    await ready(language)

    fireEvent.click(screen.getByRole('button', { name: t.leave }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: t.yesLeave }))

    await waitFor(() => expect(history.location.pathname).toBe('/dashboard'))
    expect(posts('leave').map((call) => call.body)).toEqual([{ organizationId: 'w1' }])
    expect(posts('set-active').map((call) => call.body)).toEqual([{ organizationId: null }])
  })

  it('a failed load shows the error with Try again', async () => {
    let fail = true
    setup(SESSION, team(), { onGet: () => (fail ? json(503, {}) : json(200, team())) })
    renderAppRoute('/settings/team', language)

    expect(await screen.findByText(t.loadFailed)).toBeTruthy()
    fail = false
    fireEvent.click(screen.getByRole('button', { name: t.retry }))
    expect(await ready(language)).toBeTruthy()
  })
})
