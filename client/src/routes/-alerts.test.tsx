import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ALERT_SETTINGS, alertSettings, alertsApi, type AlertsApiOptions, TELEGRAM_LINK, telegramChatUrl, TEST_ALERT } from '@/test/alerts-api'
import { IMPERSONATED, member, renderAppRoute, SESSION, stubAppGlobals, summaryApi, team, TEAM } from '@/test/app-routes'
import { callsTo, fetchMock, json, mockApi } from '@/test/auth-routes'
import type { AlertSettings, TelegramChat } from '@/lib/alerts'
import { formatCommentTime } from '@/lib/comments-feed'
import type { Team } from '@/lib/team'

// The server-render session function needs the Start compiler; the browser path never calls it.
vi.mock('@/server/session', () => ({ getServerSession: vi.fn() }))

// M7-T15: C12 `/settings/alerts` (Module 7 D2, D12–D15, M7-D20/D21).

const copy = {
  en: {
    heading: 'Scam-spike alerts',
    threshold: 'Alert after this many scam comments in 60 minutes',
    emailSwitch: 'Email alerts',
    telegramSwitch: 'Telegram alerts',
    save: 'Save',
    saved: 'Alert settings saved.',
    discard: 'Discard',
    connect: 'Connect Telegram',
    newLink: 'Get a new link',
    openTelegram: 'Open in Telegram',
    addGroup: 'Add to a group',
    refreshChats: 'I’ve linked it, refresh chats',
    remove: (title: string) => `Remove ${title}`,
    noChat: 'No chat linked yet.',
    chatLimitNote: '3 chats are linked, the most allowed.',
    planNote: 'Telegram alerts are part of the Growth and Pro plans.',
    seePlans: 'See plans',
    notConfiguredNote: 'Telegram alerts aren’t available right now.',
    soon: 'Coming soon',
    noAlert: 'No alert sent yet.',
    lastSent: 'sent · 12 scam comments',
    lastFailed: 'failed, a chat removed the bot or was deleted · 1 scam comment',
    sendTest: 'Send test alert',
    saveFirst: 'Save your changes first.',
    testSent: (channel: string) => `${channel}: sent`,
    testFailed: 'Telegram: failed, a chat removed the bot or was deleted',
    readOnly: 'Only the owner and admins can change alert settings. You can see them here.',
    impersonated: 'You’re signed in as this client by support.',
    thresholdError: 'Enter a whole number from 1 to 1,000.',
    recipientsRequired: 'Choose at least one person to get email alerts, or switch email off.',
    recipientsLimit: 'Choose up to 10 people for email alerts.',
    notMember: 'Someone you chose is no longer in this workspace.',
    planError: 'Telegram alerts are part of the Growth and Pro plans. Upgrade to use them.',
    notConfigured: 'Telegram alerts aren’t available right now. Try again later.',
    chatLimit: 'You can link up to 3 Telegram chats. Remove one to link another.',
    noChannel: 'Nothing to send to yet.',
    rateLimited: 'You can send 5 test alerts an hour. Try again later.',
    forbidden: 'Only the owner and admins can change alert settings.',
    chatGone: 'This chat is no longer linked.',
    server: 'The server is unavailable right now.',
    network: 'Can’t reach the server.',
    loadFailed: 'Couldn’t load your alert settings',
    retry: 'Try again',
    count: (n: string) => `${n} / 10`,
  },
  bn: {
    heading: 'স্ক্যাম-স্পাইক অ্যালার্ট',
    threshold: '৬০ মিনিটে এতগুলো স্ক্যাম কমেন্ট হলে অ্যালার্ট',
    emailSwitch: 'ইমেইল অ্যালার্ট',
    telegramSwitch: 'টেলিগ্রাম অ্যালার্ট',
    save: 'সেভ করুন',
    saved: 'অ্যালার্ট সেটিংস সেভ হয়েছে।',
    discard: 'বাদ দিন',
    connect: 'টেলিগ্রাম যুক্ত করুন',
    newLink: 'নতুন লিংক নিন',
    openTelegram: 'টেলিগ্রামে খুলুন',
    addGroup: 'গ্রুপে যোগ করুন',
    refreshChats: 'যুক্ত করেছি, চ্যাট রিফ্রেশ করুন',
    remove: (title: string) => `${title} সরান`,
    noChat: 'এখনো কোনো চ্যাট যুক্ত হয়নি।',
    chatLimitNote: '৩টি চ্যাট যুক্ত আছে, এটাই সর্বোচ্চ।',
    planNote: 'টেলিগ্রাম অ্যালার্ট গ্রোথ ও প্রো প্ল্যানে আছে।',
    seePlans: 'প্ল্যান দেখুন',
    notConfiguredNote: 'টেলিগ্রাম অ্যালার্ট এই মুহূর্তে পাওয়া যাচ্ছে না।',
    soon: 'শিগগিরই আসছে',
    noAlert: 'এখনো কোনো অ্যালার্ট পাঠানো হয়নি।',
    lastSent: 'পাঠানো হয়েছে · ১২টি স্ক্যাম কমেন্ট',
    lastFailed: 'ব্যর্থ, কোনো চ্যাট বট সরিয়ে দিয়েছে বা মুছে ফেলা হয়েছে · ১টি স্ক্যাম কমেন্ট',
    sendTest: 'টেস্ট অ্যালার্ট পাঠান',
    saveFirst: 'আগে পরিবর্তন সেভ করুন।',
    testSent: (channel: string) => `${channel}: পাঠানো হয়েছে`,
    testFailed: 'টেলিগ্রাম: ব্যর্থ, কোনো চ্যাট বট সরিয়ে দিয়েছে বা মুছে ফেলা হয়েছে',
    readOnly: 'শুধু মালিক ও অ্যাডমিন অ্যালার্ট সেটিংস বদলাতে পারেন। আপনি এখানে দেখতে পারবেন।',
    impersonated: 'আপনি সাপোর্ট থেকে এই ক্লায়েন্ট হিসেবে লগ ইন করেছেন।',
    thresholdError: '১ থেকে ১,০০০-এর মধ্যে একটি পূর্ণ সংখ্যা লিখুন।',
    recipientsRequired: 'ইমেইল অ্যালার্ট পেতে অন্তত একজন বেছে নিন, অথবা ইমেইল বন্ধ করুন।',
    recipientsLimit: 'ইমেইল অ্যালার্টের জন্য সর্বোচ্চ ১০ জন বেছে নিন।',
    notMember: 'আপনার বেছে নেওয়া একজন আর এই ওয়ার্কস্পেসে নেই।',
    planError: 'টেলিগ্রাম অ্যালার্ট গ্রোথ ও প্রো প্ল্যানে আছে। ব্যবহার করতে প্ল্যান আপগ্রেড করুন।',
    notConfigured: 'টেলিগ্রাম অ্যালার্ট এই মুহূর্তে পাওয়া যাচ্ছে না। পরে আবার চেষ্টা করুন।',
    chatLimit: 'সর্বোচ্চ ৩টি টেলিগ্রাম চ্যাট যুক্ত করা যায়। আরেকটি যুক্ত করতে একটি সরান।',
    noChannel: 'পাঠানোর মতো কিছু নেই।',
    rateLimited: 'ঘণ্টায় ৫টি টেস্ট অ্যালার্ট পাঠানো যায়। পরে আবার চেষ্টা করুন।',
    forbidden: 'শুধু মালিক ও অ্যাডমিন অ্যালার্ট সেটিংস বদলাতে পারেন।',
    chatGone: 'এই চ্যাটটি আর যুক্ত নেই।',
    server: 'সার্ভার এই মুহূর্তে পাওয়া যাচ্ছে না।',
    network: 'সার্ভারে সংযোগ করা যাচ্ছে না।',
    loadFailed: 'আপনার অ্যালার্ট সেটিংস লোড করা যায়নি',
    retry: 'আবার চেষ্টা করুন',
    count: (n: string) => `${n} / ১০`,
  },
}

const MODERATOR = { ...SESSION, user: { ...SESSION.user, id: 'u3' } } // Mina in `team()`

const chat = (overrides: Partial<TelegramChat> = {}): TelegramChat => ({
  id: '0b8f6a1e-0000-4000-8000-000000000001',
  title: 'Rahim',
  type: 'private',
  linkedAt: '2026-11-19T06:00:00.000Z',
  ...overrides,
})
const CHATS = [
  chat(),
  chat({ id: '0b8f6a1e-0000-4000-8000-000000000002', title: 'Shop team', type: 'supergroup' }),
  chat({ id: '0b8f6a1e-0000-4000-8000-000000000003', title: 'Night shift', type: 'group' }),
]

const setup = (settings: AlertSettings = alertSettings(), options: AlertsApiOptions = {}, session: unknown = SESSION, data: Team = team()) =>
  mockApi({ '/api/auth/get-session': () => json(200, session), ...summaryApi(), ...alertsApi(settings, options, data) })

const error = (status: number, code?: string, details?: Record<string, unknown>) => () =>
  json(status, { statusCode: status, message: 'server text is never shown', ...(code ? { code } : {}), ...(details ? { details } : {}) })

const section = (id: string) => within(screen.getByTestId(`alerts-${id}`))
const patches = () => callsTo(ALERT_SETTINGS).filter((call) => call.method === 'PATCH')
const recipient = (memberId: string) => document.querySelector<HTMLElement>(`[data-recipient="${memberId}"] input`) as HTMLInputElement

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  stubAppGlobals()
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe.each(['en', 'bn'] as const)('M7-T15 /settings/alerts (%s)', (language) => {
  const t = copy[language]
  const digits = (value: string) => (language === 'bn' ? value.replace(/\d/g, (d) => '০১২৩৪৫৬৭৮৯'[Number(d)]!) : value)
  const ready = () => screen.findByRole('heading', { name: t.heading })
  const saveButton = () => screen.getByRole('button', { name: t.save }) as HTMLButtonElement
  const threshold = () => screen.getByLabelText(t.threshold) as HTMLInputElement

  it('shows the saved settings: threshold, ticked owner, Telegram, WhatsApp coming soon, no alert yet', async () => {
    setup()
    renderAppRoute('/settings/alerts', language)
    await ready()

    expect(threshold().value).toBe('10')
    expect((screen.getByRole('switch', { name: t.emailSwitch }) as HTMLButtonElement).getAttribute('aria-checked')).toBe('true')
    expect(recipient('m-owner').checked).toBe(true)
    expect(recipient('m-admin').checked).toBe(false)
    expect(recipient('m-mod').checked).toBe(false)
    expect(screen.getByTestId('recipient-count').textContent).toBe(t.count(digits('1')))
    expect((screen.getByRole('switch', { name: t.telegramSwitch }) as HTMLButtonElement).getAttribute('aria-checked')).toBe('false')
    expect(section('telegram').getByText(t.noChat)).toBeTruthy()
    expect(section('telegram').getByRole('button', { name: t.connect })).toBeTruthy()
    expect(section('whatsapp').getByTestId('whatsapp-soon').textContent).toBe(t.soon)
    expect(screen.getAllByTestId('last-alert').map((item) => item.textContent)).toEqual([t.noAlert, t.noAlert])
    expect(saveButton().disabled).toBe(true)
    expect(callsTo(TEAM)).toHaveLength(1)
  })

  it('shows the last alert per channel in Dhaka time with status and scam count', async () => {
    setup(
      alertSettings({
        lastAlerts: [
          { channel: 'TELEGRAM', status: 'FAILED', scamCount: 1, errorKind: 'chat_unavailable', sentAt: '2026-11-20T09:30:00.000Z' },
          { channel: 'EMAIL', status: 'SENT', scamCount: 12, errorKind: null, sentAt: '2026-11-20T09:29:00.000Z' },
        ],
      }),
    )
    renderAppRoute('/settings/alerts', language)
    await ready()
    const [email, telegram] = screen.getAllByTestId('last-alert').map((item) => item.textContent ?? '')
    expect(email).toContain(formatCommentTime('2026-11-20T09:29:00.000Z', language))
    expect(email).toContain(t.lastSent)
    expect(telegram).toContain(t.lastFailed)
    if (language === 'en') expect(telegram).toContain('15:30') // 09:30 UTC = 15:30 Dhaka (D14)
  })

  it('owner edits and saves only the changed fields; the answer replaces the cache', async () => {
    setup()
    const { queryClient } = renderAppRoute('/settings/alerts', language)
    await ready()

    fireEvent.change(threshold(), { target: { value: '25' } })
    fireEvent.click(recipient('m-admin'))
    expect(screen.getByTestId('recipient-count').textContent).toBe(t.count(digits('2')))
    expect(screen.getByText(t.saveFirst, { exact: false })).toBeTruthy()
    expect((screen.getByRole('button', { name: t.sendTest }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(saveButton())

    expect(await screen.findByText(t.saved)).toBeTruthy()
    expect(patches().map((call) => call.body)).toEqual([{ spikeThreshold: 25, emailRecipientMemberIds: ['m-owner', 'm-admin'] }])
    const cached = queryClient.getQueryData<AlertSettings>(['workspace', 'w1', 'alerts', 'settings'])
    expect(cached?.spikeThreshold).toBe(25)
    expect(cached?.email.recipients.map((item) => item.memberId)).toEqual(['m-owner', 'm-admin'])
    expect(saveButton().disabled).toBe(true)
    expect(callsTo(ALERT_SETTINGS).filter((call) => call.method === 'GET')).toHaveLength(1)

    fireEvent.click(screen.getByRole('switch', { name: t.telegramSwitch }))
    fireEvent.click(saveButton())
    await waitFor(() => expect(patches()).toHaveLength(2))
    expect(patches()[1]!.body).toEqual({ telegramEnabled: true })
  })

  it('changing a field back to its saved value leaves nothing to save; Discard drops the draft', async () => {
    setup()
    renderAppRoute('/settings/alerts', language)
    await ready()
    fireEvent.change(threshold(), { target: { value: '11' } })
    expect(saveButton().disabled).toBe(false)
    fireEvent.change(threshold(), { target: { value: '10' } })
    expect(saveButton().disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: t.discard }))
    expect(threshold().value).toBe('10')
    expect(screen.queryByRole('button', { name: t.discard })).toBeNull()
  })

  it.each(['0', '1001', '', '2.5'])('threshold %j is refused before any request', async (value) => {
    setup()
    renderAppRoute('/settings/alerts', language)
    await ready()
    fireEvent.change(threshold(), { target: { value } })
    expect(screen.getByText(t.thresholdError)).toBeTruthy()
    expect(threshold().getAttribute('aria-invalid')).toBe('true')
    expect(saveButton().disabled).toBe(true)
    fireEvent.change(threshold(), { target: { value: '1000' } })
    expect(screen.queryByText(t.thresholdError)).toBeNull()
    fireEvent.click(saveButton())
    await waitFor(() => expect(patches().map((call) => call.body)).toEqual([{ spikeThreshold: 1000 }]))
  })

  it('recipients: none ticked with email on is refused; email off saves', async () => {
    setup()
    renderAppRoute('/settings/alerts', language)
    await ready()
    fireEvent.click(recipient('m-owner'))
    expect(screen.getByText(t.recipientsRequired)).toBeTruthy()
    expect(saveButton().disabled).toBe(true)

    fireEvent.click(screen.getByRole('switch', { name: t.emailSwitch }))
    expect(screen.queryByText(t.recipientsRequired)).toBeNull()
    expect(document.querySelector('[data-recipient]')).toBeNull()
    fireEvent.click(saveButton())
    await waitFor(() => expect(patches().map((call) => call.body)).toEqual([{ emailEnabled: false, emailRecipientMemberIds: [] }]))
  })

  it('recipients: 11 ticked is refused (max 10)', async () => {
    const many = team({
      members: Array.from({ length: 12 }, (_, i) =>
        member({ memberId: `m-${i}`, userId: i === 0 ? 'u1' : `u-${i}`, name: `Person ${i}`, email: `p${i}@shop.bd`, role: i === 0 ? 'owner' : 'moderator' }),
      ),
    })
    const settings = alertSettings()
    settings.email.recipients = [{ memberId: 'm-0', userId: 'u1', name: 'Person 0', email: 'p0@shop.bd', role: 'owner' }]
    setup(settings, {}, SESSION, many)
    renderAppRoute('/settings/alerts', language)
    await ready()
    for (let i = 1; i <= 9; i++) fireEvent.click(recipient(`m-${i}`))
    expect(screen.getByTestId('recipient-count').textContent).toBe(t.count(digits('10')))
    expect(screen.queryByText(t.recipientsLimit)).toBeNull()
    fireEvent.click(recipient('m-10'))
    expect(screen.getByText(t.recipientsLimit)).toBeTruthy()
    expect(saveButton().disabled).toBe(true)
    expect(patches()).toHaveLength(0)
  })

  it('Telegram: Connect shows the person + group links and the expiry; refresh reloads the chats', async () => {
    let settings = alertSettings({ telegram: { enabled: true, available: true, configured: true, chats: [] } })
    setup(settings, { onGet: () => json(200, settings) })
    renderAppRoute('/settings/alerts', language)
    await ready()

    fireEvent.click(section('telegram').getByRole('button', { name: t.connect }))
    const panel = within(await screen.findByTestId('telegram-link'))
    expect(panel.getByRole('link', { name: t.openTelegram }).getAttribute('href')).toBe('https://t.me/ShieldBot?start=abc123')
    expect(panel.getByRole('link', { name: t.addGroup }).getAttribute('href')).toBe('https://t.me/ShieldBot?startgroup=abc123')
    expect(panel.getByRole('link', { name: t.openTelegram }).getAttribute('rel')).toBe('noopener noreferrer')
    expect(screen.getByTestId('telegram-link-expiry').textContent).toContain(formatCommentTime('2026-11-20T10:15:00.000Z', language))
    if (language === 'en') expect(screen.getByTestId('telegram-link-expiry').textContent).toContain('16:15')
    expect(callsTo(TELEGRAM_LINK).map((call) => call.method)).toEqual(['POST'])

    settings = alertSettings({ telegram: { enabled: true, available: true, configured: true, chats: [chat()] } })
    fireEvent.click(panel.getByRole('button', { name: t.refreshChats }))
    expect(await section('telegram').findByRole('button', { name: t.remove('Rahim') })).toBeTruthy()
    expect(section('telegram').getByRole('button', { name: t.newLink })).toBeTruthy()
  })

  it('Telegram: Remove deletes the chat and drops it from the list', async () => {
    setup(alertSettings({ telegram: { enabled: true, available: true, configured: true, chats: CHATS.slice(0, 2) } }))
    renderAppRoute('/settings/alerts', language)
    await ready()
    fireEvent.click(section('telegram').getByRole('button', { name: t.remove('Shop team') }))
    await waitFor(() => expect(document.querySelector(`[data-chat="${CHATS[1]!.id}"]`)).toBeNull())
    expect(callsTo(telegramChatUrl(CHATS[1]!.id)).map((call) => call.method)).toEqual(['DELETE'])
    expect(document.querySelector(`[data-chat="${CHATS[0]!.id}"]`)).toBeTruthy()
  })

  it('Telegram: a removed-elsewhere chat (404) shows a message and reloads', async () => {
    setup(alertSettings({ telegram: { enabled: true, available: true, configured: true, chats: [chat()] } }), { onRemove: error(404) })
    renderAppRoute('/settings/alerts', language)
    await ready()
    fireEvent.click(section('telegram').getByRole('button', { name: t.remove('Rahim') }))
    expect(await screen.findByText(t.chatGone)).toBeTruthy()
    await waitFor(() => expect(callsTo(ALERT_SETTINGS).filter((call) => call.method === 'GET')).toHaveLength(2))
  })

  it('Telegram: with 3 chats linked there is no Connect, only the limit note', async () => {
    setup(alertSettings({ telegram: { enabled: true, available: true, configured: true, chats: CHATS } }))
    renderAppRoute('/settings/alerts', language)
    await ready()
    expect(section('telegram').getByTestId('telegram-chat-limit').textContent).toContain(t.chatLimitNote)
    expect(section('telegram').queryByRole('button', { name: t.connect })).toBeNull()
    expect(section('telegram').getAllByRole('button', { name: new RegExp(language === 'en' ? '^Remove' : 'সরান$') })).toHaveLength(3)
  })

  it.each([
    ['TELEGRAM_CHAT_LIMIT', 409, 'chatLimit'],
    ['PLAN_FEATURE_UNAVAILABLE', 409, 'planError'],
    ['TELEGRAM_NOT_CONFIGURED', 503, 'notConfigured'],
  ] as const)('Telegram link %s shows its message', async (code, status, key) => {
    setup(alertSettings(), { onLink: error(status, code, code === 'TELEGRAM_CHAT_LIMIT' ? { max: 3 } : undefined) })
    renderAppRoute('/settings/alerts', language)
    await ready()
    fireEvent.click(section('telegram').getByRole('button', { name: t.connect }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe(t[key])
    expect(alert.textContent).not.toContain('server text')
  })

  it('plan without messengerAlerts: Telegram switch off and locked, plan note links to /plans, no Connect', async () => {
    setup(alertSettings({ telegram: { enabled: false, available: false, configured: true, chats: [] } }))
    renderAppRoute('/settings/alerts', language)
    await ready()
    expect((screen.getByRole('switch', { name: t.telegramSwitch }) as HTMLButtonElement).disabled).toBe(true)
    const note = within(screen.getByTestId('telegram-plan-note'))
    expect(note.getByText(t.planNote, { exact: false })).toBeTruthy()
    expect(note.getByRole('link', { name: t.seePlans }).getAttribute('href')).toBe('/plans')
    expect(section('telegram').queryByRole('button', { name: t.connect })).toBeNull()
  })

  it('plan dropped with Telegram still on: the switch can only be turned off', async () => {
    setup(alertSettings({ telegram: { enabled: true, available: false, configured: true, chats: [chat()] } }))
    renderAppRoute('/settings/alerts', language)
    await ready()
    const toggle = screen.getByRole('switch', { name: t.telegramSwitch }) as HTMLButtonElement
    expect(toggle.disabled).toBe(false)
    fireEvent.click(toggle)
    fireEvent.click(saveButton())
    await waitFor(() => expect(patches().map((call) => call.body)).toEqual([{ telegramEnabled: false }]))
  })

  it('Telegram not configured on the platform: note, no Connect', async () => {
    setup(alertSettings({ telegram: { enabled: false, available: true, configured: false, chats: [] } }))
    renderAppRoute('/settings/alerts', language)
    await ready()
    expect(screen.getByTestId('telegram-not-configured').textContent).toContain(t.notConfiguredNote)
    expect(section('telegram').queryByRole('button', { name: t.connect })).toBeNull()
  })

  it.each([
    ['ALERT_THRESHOLD_INVALID', 400, 'thresholdError', { min: 1, max: 1000 }],
    ['ALERT_RECIPIENTS_LIMIT', 400, 'recipientsLimit', { max: 10 }],
    ['ALERT_RECIPIENT_NOT_MEMBER', 400, 'notMember', { memberId: 'm-admin' }],
    ['ALERT_RECIPIENTS_REQUIRED', 400, 'recipientsRequired', undefined],
    ['PLAN_FEATURE_UNAVAILABLE', 409, 'planError', { feature: 'messengerAlerts' }],
    [undefined, 403, 'forbidden', undefined],
    [undefined, 500, 'server', undefined],
  ] as const)('save error %s (%i) shows its message', async (code, status, key, details) => {
    setup(alertSettings(), { onPatch: error(status, code, details) })
    renderAppRoute('/settings/alerts', language)
    await ready()
    fireEvent.click(screen.getByRole('switch', { name: t.telegramSwitch }))
    fireEvent.click(saveButton())
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain(t[key])
    expect(alert.textContent).not.toContain('server text')
    // The draft stays so the user can fix it and retry.
    expect((screen.getByRole('switch', { name: t.telegramSwitch }) as HTMLButtonElement).getAttribute('aria-checked')).toBe('true')
    if (code === 'PLAN_FEATURE_UNAVAILABLE') await waitFor(() => expect(callsTo(ALERT_SETTINGS).filter((call) => call.method === 'GET')).toHaveLength(2))
    if (code === 'ALERT_RECIPIENT_NOT_MEMBER') await waitFor(() => expect(callsTo(TEAM)).toHaveLength(2))
  })

  it('save network failure shows the offline message', async () => {
    setup(alertSettings(), {
      onPatch: () => {
        throw new TypeError('offline')
      },
    })
    renderAppRoute('/settings/alerts', language)
    await ready()
    fireEvent.change(threshold(), { target: { value: '12' } })
    fireEvent.click(saveButton())
    expect((await screen.findByRole('alert')).textContent).toContain(t.network)
  })

  it('Send test alert lists the result per channel', async () => {
    setup(alertSettings({ telegram: { enabled: true, available: true, configured: true, chats: [chat()] } }), {
      onTest: () =>
        json(200, {
          deliveries: [
            { channel: 'EMAIL', status: 'SENT', errorKind: null },
            { channel: 'TELEGRAM', status: 'FAILED', errorKind: 'chat_unavailable' },
          ],
        }),
    })
    renderAppRoute('/settings/alerts', language)
    await ready()
    fireEvent.click(screen.getByRole('button', { name: t.sendTest }))
    const results = await screen.findByTestId('test-results')
    expect(within(results).getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      t.testSent(language === 'en' ? 'Email' : 'ইমেইল'),
      t.testFailed,
    ])
    expect(callsTo(TEST_ALERT).map((call) => call.method)).toEqual(['POST'])
  })

  it.each([
    ['ALERT_TEST_RATE_LIMITED', 429, 'rateLimited', { max: 5 }],
    ['ALERT_NO_CHANNEL', 409, 'noChannel', undefined],
    [undefined, 403, 'forbidden', undefined],
  ] as const)('test alert error %s (%i) shows its message', async (code, status, key, details) => {
    setup(alertSettings(), { onTest: error(status, code, details) })
    renderAppRoute('/settings/alerts', language)
    await ready()
    fireEvent.click(screen.getByRole('button', { name: t.sendTest }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain(t[key])
    expect(alert.textContent).not.toContain('server text')
  })

  it('moderator: read-only with a note, no Save / Connect / Remove / test', async () => {
    setup(alertSettings({ telegram: { enabled: true, available: true, configured: true, chats: [chat()] } }), {}, MODERATOR)
    renderAppRoute('/settings/alerts', language)
    await ready()
    expect(screen.getByText(t.readOnly)).toBeTruthy()
    expect(threshold().disabled).toBe(true)
    expect((screen.getByRole('switch', { name: t.emailSwitch }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('switch', { name: t.telegramSwitch }) as HTMLButtonElement).disabled).toBe(true)
    expect(recipient('m-owner').disabled).toBe(true)
    expect(screen.queryByRole('button', { name: t.save })).toBeNull()
    expect(screen.queryByRole('button', { name: t.connect })).toBeNull()
    expect(screen.queryByRole('button', { name: t.remove('Rahim') })).toBeNull()
    expect(screen.queryByRole('button', { name: t.sendTest })).toBeNull()
    expect(document.querySelector(`[data-chat="${chat().id}"]`)).toBeTruthy() // the linked chat is still listed
  })

  it('impersonated owner may edit (D2) and send a test alert (M7-D20)', async () => {
    setup(alertSettings(), {}, IMPERSONATED)
    renderAppRoute('/settings/alerts', language)
    await ready()
    expect(screen.getByText(t.impersonated, { exact: false })).toBeTruthy()
    fireEvent.change(threshold(), { target: { value: '20' } })
    fireEvent.click(saveButton())
    expect(await screen.findByText(t.saved)).toBeTruthy()
    expect(patches().map((call) => call.body)).toEqual([{ spikeThreshold: 20 }])
    fireEvent.click(screen.getByRole('button', { name: t.sendTest }))
    expect(await screen.findByTestId('test-results')).toBeTruthy()
  })

  it('a failed load shows the error with Try again', async () => {
    let fail = true
    setup(alertSettings(), { onGet: () => (fail ? error(500)() : json(200, alertSettings())) })
    renderAppRoute('/settings/alerts', language)
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain(t.loadFailed)
    expect(alert.textContent).toContain(t.server)
    fail = false
    fireEvent.click(within(alert).getByRole('button', { name: t.retry }))
    expect(await ready()).toBeTruthy()
  })
})
