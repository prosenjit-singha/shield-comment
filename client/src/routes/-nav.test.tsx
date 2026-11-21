import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { alertSettings, alertsApi } from '@/test/alerts-api'
import { billingSummary, IMPERSONATED, renderAppRoute, SESSION, stubAppGlobals, SUMMARY, summaryApi, team, teamApi, ticketsApi } from '@/test/app-routes'
import { apiCalls, callsTo, fetchMock, json, mockApi } from '@/test/auth-routes'

// The server-render session function needs the Start compiler; the browser path never calls it.
vi.mock('@/server/session', () => ({ getServerSession: vi.fn() }))

// M7-T11: the "More" sheet (D16 a), `/support` (tickets since M7-T12) + `/settings` placeholders, the workspace switcher (D8 a).

const LIST = '/api/auth/organization/list'
const SET_ACTIVE = '/api/auth/organization/set-active'
const W2_SUMMARY = '/api/workspaces/w2/billing/summary'
const TWO_WORKSPACES = [
  { id: 'w1', name: 'Rahim Fashion', slug: 'rahim-fashion', createdAt: '2026-11-18T00:00:00.000Z' },
  { id: 'w2', name: 'Karim Gadgets', slug: 'karim-gadgets', createdAt: '2026-11-19T00:00:00.000Z' },
]

const copy = {
  en: {
    more: 'More',
    moreItems: ['Pages', 'Playground', 'Plans', 'Billing', 'Support', 'Settings'],
    support: 'Support',
    supportEmpty: 'No tickets yet. Open one when you need help.',
    settings: 'Settings',
    team: 'Team',
    alerts: 'Alerts',
    teamMembers: 'Members',
    alertsHeading: 'Scam-spike alerts',
    switcher: (name: string) => `Workspace: ${name}`,
    switchFailed: 'Couldn’t switch the workspace.',
    server: 'The server is unavailable right now.',
  },
  bn: {
    more: 'আরও',
    moreItems: ['পেজ', 'প্লেগ্রাউন্ড', 'প্ল্যান', 'বিলিং', 'সাপোর্ট', 'সেটিংস'],
    support: 'সাপোর্ট',
    supportEmpty: 'এখনো কোনো টিকিট নেই। সাহায্য দরকার হলে একটি টিকিট খুলুন।',
    settings: 'সেটিংস',
    team: 'টিম',
    alerts: 'অ্যালার্ট',
    teamMembers: 'সদস্য',
    alertsHeading: 'স্ক্যাম-স্পাইক অ্যালার্ট',
    switcher: (name: string) => `ওয়ার্কস্পেস: ${name}`,
    switchFailed: 'ওয়ার্কস্পেস বদলানো যায়নি।',
    server: 'সার্ভার এই মুহূর্তে পাওয়া যাচ্ছে না।',
  },
} as const

const bottomBar = () => screen.getByTestId('app-bottom-bar')
const sidebarCurrent = () =>
  within(screen.getByTestId('app-sidebar'))
    .getAllByRole('link')
    .filter((link) => link.getAttribute('aria-current') === 'page')
    .map((link) => link.getAttribute('href'))

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  stubAppGlobals()
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe.each(['en', 'bn'] as const)('M7-T11 navigation (%s)', (language) => {
  const t = copy[language]

  it('"More" opens a sheet with the other six pages; picking one navigates, closes it and marks More active', async () => {
    mockApi({ '/api/auth/get-session': () => json(200, SESSION), ...summaryApi(), ...ticketsApi(), ...teamApi() })
    const { history } = renderAppRoute('/support', language)
    expect(await screen.findByText(t.supportEmpty)).toBeTruthy()
    expect(within(bottomBar()).getByRole('button', { name: t.more }).dataset.status).toBe('active')

    fireEvent.click(within(bottomBar()).getByRole('button', { name: t.more }))
    const sheet = await screen.findByRole('dialog', { name: t.more })
    const links = within(sheet).getAllByRole('link')
    expect(links.map((link) => link.textContent)).toEqual([...t.moreItems])
    expect(links.map((link) => link.getAttribute('href'))).toEqual(['/pages', '/playground', '/plans', '/billing', '/support', '/settings'])
    expect(links.map((link) => link.getAttribute('aria-current'))).toEqual([null, null, null, null, 'page', null])

    fireEvent.click(within(sheet).getByRole('link', { name: t.settings }))
    await waitFor(() => expect(history.location.pathname).toBe('/settings/team'))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(within(bottomBar()).getByRole('button', { name: t.more }).dataset.status).toBe('active')
  })

  it('More is not active on a bottom-bar page', async () => {
    mockApi({ '/api/auth/get-session': () => json(200, SESSION), ...summaryApi(), '/api/workspaces/w1/moderation/policy': () => json(503, {}) })
    renderAppRoute('/rules', language)
    await waitFor(() => expect(sidebarCurrent()).toEqual(['/rules']))
    expect(within(bottomBar()).getByRole('button', { name: t.more }).dataset.status).toBeUndefined()
  })

  it('/support shows the tickets screen with Support active', async () => {
    mockApi({ '/api/auth/get-session': () => json(200, SESSION), ...summaryApi(), ...ticketsApi() })
    renderAppRoute('/support', language)
    expect(await screen.findByRole('heading', { name: t.support })).toBeTruthy()
    expect(sidebarCurrent()).toEqual(['/support'])
  })

  it('/settings redirects to /settings/team; the tabs switch to Alerts and Settings stays active', async () => {
    mockApi({ '/api/auth/get-session': () => json(200, SESSION), ...summaryApi(), ...ticketsApi(), ...alertsApi() })
    const { history } = renderAppRoute('/settings', language)

    expect(await screen.findByRole('heading', { name: t.teamMembers })).toBeTruthy()
    expect(history.location.pathname).toBe('/settings/team')
    expect(screen.getByRole('heading', { name: t.settings })).toBeTruthy()
    const tabs = within(screen.getByRole('navigation', { name: t.settings }))
    expect(tabs.getAllByRole('link').map((link) => [link.textContent, link.getAttribute('href')])).toEqual([
      [t.team, '/settings/team'],
      [t.alerts, '/settings/alerts'],
    ])
    expect(tabs.getByRole('link', { name: t.team }).getAttribute('aria-current')).toBe('page')
    expect(sidebarCurrent()).toEqual(['/settings'])

    fireEvent.click(tabs.getByRole('link', { name: t.alerts }))
    expect(await screen.findByRole('heading', { name: t.alertsHeading })).toBeTruthy()
    expect(history.location.pathname).toBe('/settings/alerts')
    expect(tabs.getByRole('link', { name: t.alerts }).getAttribute('aria-current')).toBe('page')
    expect(tabs.getByRole('link', { name: t.team }).getAttribute('aria-current')).toBeNull()
    expect(sidebarCurrent()).toEqual(['/settings'])
  })

  describe('workspace switcher (D8)', () => {
    it('is hidden for someone in one workspace', async () => {
      mockApi({ '/api/auth/get-session': () => json(200, SESSION), ...summaryApi(), ...ticketsApi() }) // list default: one workspace
      renderAppRoute('/support', language)
      expect(await screen.findByText(t.supportEmpty)).toBeTruthy()
      await waitFor(() => expect(callsTo(LIST)).toHaveLength(1))
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(screen.queryByRole('button', { name: t.switcher('Rahim Fashion') })).toBeNull()
    })

    it('is hidden (and the list never loaded) while impersonated', async () => {
      mockApi({ '/api/auth/get-session': () => json(200, IMPERSONATED), ...summaryApi(), ...ticketsApi(), [LIST]: () => json(200, TWO_WORKSPACES) })
      renderAppRoute('/support', language)
      expect(await screen.findByText(t.supportEmpty)).toBeTruthy()
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(screen.queryByRole('button', { name: t.switcher('Rahim Fashion') })).toBeNull()
      expect(callsTo(LIST)).toHaveLength(0)
    })

    it('switches: set-active, session refetched, workspace queries dropped, same route, new name', async () => {
      let active = 'w1'
      mockApi({
        '/api/auth/get-session': () => json(200, { ...SESSION, session: { ...SESSION.session, activeOrganizationId: active } }),
        [LIST]: () => json(200, TWO_WORKSPACES),
        ...summaryApi(),
        [W2_SUMMARY]: () => json(200, billingSummary()),
        ...alertsApi(),
        '/api/workspaces/w2/alerts/settings': () => json(200, alertSettings({ workspaceId: 'w2' })),
        '/api/workspaces/w2/team': () => json(200, team()),
        [SET_ACTIVE]: (init) => {
          active = (JSON.parse(String(init?.body)) as { organizationId: string }).organizationId
          return json(200, TWO_WORKSPACES[1])
        },
      })
      const { history, queryClient } = renderAppRoute('/settings/alerts', language)
      const trigger = await screen.findByRole('button', { name: t.switcher('Rahim Fashion') })
      queryClient.setQueryData(['workspace', 'w1', 'stats'], { scanned: 42 })
      const sessionCalls = callsTo('/api/auth/get-session').length

      fireEvent.keyDown(trigger, { key: 'Enter' })
      fireEvent.click(await screen.findByRole('menuitemradio', { name: 'Karim Gadgets' }))

      expect(await screen.findByRole('button', { name: t.switcher('Karim Gadgets') })).toBeTruthy()
      expect(callsTo(SET_ACTIVE)).toEqual([{ path: SET_ACTIVE, method: 'POST', body: { organizationId: 'w2' } }])
      expect(callsTo('/api/auth/get-session').length).toBeGreaterThan(sessionCalls)
      expect(queryClient.getQueryData(['workspace', 'w1', 'stats'])).toBeUndefined()
      await waitFor(() => expect(callsTo(W2_SUMMARY)).toHaveLength(1)) // the shell reloads for the new workspace
      expect(history.location.pathname).toBe('/settings/alerts')
      expect(await screen.findByRole('heading', { name: t.alertsHeading })).toBeTruthy()
      expect(screen.queryByRole('alert')).toBeNull()
    })

    it('choosing the active workspace again sends nothing', async () => {
      mockApi({ '/api/auth/get-session': () => json(200, SESSION), [LIST]: () => json(200, TWO_WORKSPACES), ...summaryApi(), ...ticketsApi() })
      renderAppRoute('/support', language)
      fireEvent.keyDown(await screen.findByRole('button', { name: t.switcher('Rahim Fashion') }), { key: 'Enter' })
      fireEvent.click(await screen.findByRole('menuitemradio', { name: 'Rahim Fashion' }))
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(callsTo(SET_ACTIVE)).toHaveLength(0)
    })

    it('a failed switch shows an alert and keeps the workspace and its data', async () => {
      mockApi({
        '/api/auth/get-session': () => json(200, SESSION),
        [LIST]: () => json(200, TWO_WORKSPACES),
        ...summaryApi(),
        ...ticketsApi(),
        [SET_ACTIVE]: () => json(500, { message: 'boom' }),
      })
      const { queryClient } = renderAppRoute('/support', language)
      const trigger = await screen.findByRole('button', { name: t.switcher('Rahim Fashion') })
      queryClient.setQueryData(['workspace', 'w1', 'stats'], { scanned: 42 })

      fireEvent.keyDown(trigger, { key: 'Enter' })
      fireEvent.click(await screen.findByRole('menuitemradio', { name: 'Karim Gadgets' }))

      const alert = await screen.findByRole('alert')
      expect(alert.dataset.kind).toBe('server')
      expect(alert.textContent).toContain(t.switchFailed)
      expect(alert.textContent).toContain(t.server)
      expect(screen.getByRole('button', { name: t.switcher('Rahim Fashion') })).toBeTruthy()
      expect(queryClient.getQueryData(['workspace', 'w1', 'stats'])).toEqual({ scanned: 42 })
      expect(callsTo(SUMMARY)).toHaveLength(1)
      expect(apiCalls().some((call) => call.path === W2_SUMMARY)).toBe(false)
    })
  })
})
