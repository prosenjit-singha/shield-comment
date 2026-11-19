import { QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AiConnectionTestResult,
  AiProvider,
  AiProviderStatus,
  AiSettingsAuditEntry,
  AiSettingsAuditList,
  AiSettingsResponse,
} from '@/lib/admin-ai-settings'
import type { PlanAuditEntry, PlanAuditList } from '@/lib/admin-plan-audit'
import type { AdminPlan } from '@/lib/admin-plans'
import { createQueryClient } from '@/lib/query-client'
import { createAppRouter } from '@/router'

// Files prefixed with `-` are ignored by the route generator.
const auth = vi.hoisted(() => ({ getSession: vi.fn(), signOut: vi.fn() }))
vi.mock('@/lib/auth-client', () => ({
  authClient: { getSession: auth.getSession, signOut: auth.signOut },
}))

const superAdmin = {
  data: {
    session: { id: 's1', impersonatedBy: null },
    user: { id: 'u1', email: 'root@shield.bd', name: 'Root Admin', role: 'super_admin', banned: false },
  },
  error: null,
}

const PLANS = '/api/admin/settings/plans'
const AUDIT = '/api/admin/settings/plans/audit'
const AI = '/api/admin/settings/ai'
const AI_TEST = '/api/admin/settings/ai/test'
const AI_AUDIT = '/api/admin/settings/ai/audit'

function plan(
  sortOrder: number,
  slug: string,
  name: string,
  price: number,
  offer: [number, string] | null,
  limits: [number, number, number],
  tier: 0 | 1 | 2,
  yearly: number | null = null,
): AdminPlan {
  return {
    id: `019a0000-0000-7000-8000-00000000000${sortOrder + 1}`,
    slug,
    name,
    sortOrder,
    isActive: true,
    monthlyPriceBdt: price,
    badgeEn: null,
    badgeBn: null,
    descriptionEn: null,
    descriptionBn: null,
    isHighlighted: false,
    offerPriceBdt: offer?.[0] ?? null,
    offerBadge: offer?.[1] ?? null,
    yearlyMonthlyPriceBdt: yearly,
    // PW-T1b seed: the sign-up trial lives on Starter only.
    trialDays: slug === 'starter' ? 7 : null,
    trialCommentLimit: slug === 'starter' ? 300 : null,
    featureConfig: {
      limits: { connectedPages: limits[0], monthlyComments: limits[1], teamSeats: limits[2], workspaces: limits[2] },
      features: {
        banglaAiFilter: true,
        autoHideScams: true,
        customBlocklist: tier >= 1,
        autoReplyTemplates: tier >= 1,
        messengerAlerts: tier >= 1,
        whiteLabelReports: tier >= 2,
        prioritySupportApi: tier >= 2,
      },
    },
    createdAt: '2026-11-18T00:00:00.000Z',
    updatedAt: '2026-11-18T00:00:00.000Z',
  }
}

// As seeded by 0007 + the 0008 launch offers + PW-T1b (yearly prices, Starter trial). The GET lists
// active plans only, so the deactivated Free row (PW-D7) never reaches the screen.
const seeded = [
  plan(1, 'starter', 'Starter', 999, [499, '50% Launch Offer'], [1, 2500, 1], 0, 449),
  plan(2, 'growth', 'Growth', 2499, [1499, '40% Off'], [5, 15000, 3], 1, 1349),
  plan(3, 'pro', 'Pro', 5999, [3999, '33% Off'], [25, 75000, 10], 2, 3599),
] as const satisfies AdminPlan[]
const starter: AdminPlan = seeded[0]

const rootAdmin = { id: 'u1', name: 'Root Admin', email: 'root@shield.bd' }

function auditEntry(n: number, patch: Partial<PlanAuditEntry> = {}): PlanAuditEntry {
  return {
    id: `019a0000-0000-7000-9000-${String(n).padStart(12, '0')}`,
    plan: { id: starter.id, slug: 'starter', name: 'Starter' },
    admin: rootAdmin,
    action: 'UPDATE',
    changes: [{ field: 'featureConfig.limits.teamSeats', before: n, after: n + 1 }],
    ip: '203.0.113.7',
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/140.0',
    createdAt: '2026-11-18T06:00:00.000Z',
    ...patch,
  }
}

function auditPage(items: PlanAuditEntry[], url: URL, total = items.length): PlanAuditList {
  return { items, total, skip: Number(url.searchParams.get('skip')), take: Number(url.searchParams.get('take')) }
}

function providerStatus(defaultModel: string, patch: Partial<AiProviderStatus> = {}): AiProviderStatus {
  return {
    defaultModel,
    model: defaultModel,
    modelSource: 'default',
    baseUrlConfigured: true,
    key: { configured: false, source: 'none', last4: null, unreadable: false, updatedAt: null },
    ...patch,
  }
}

/** OpenAI active from the DB with a DB key; Anthropic has an .env key; Neon has no URL. */
function aiSettings(patch: Partial<AiSettingsResponse> = {}): AiSettingsResponse {
  return {
    provider: 'openai',
    providerSource: 'db',
    model: 'gpt-4.1-mini',
    modelSource: 'db',
    configured: true,
    cipherConfigured: true,
    providers: {
      neon: providerStatus('gpt-oss-20b', { baseUrlConfigured: false }),
      openai: providerStatus('gpt-4.1-mini', {
        modelSource: 'db',
        key: { configured: true, source: 'db', last4: '1234', unreadable: false, updatedAt: '2026-11-19T04:00:00.000Z' },
      }),
      anthropic: providerStatus('claude-haiku-4-5', {
        model: 'claude-sonnet-4-5',
        modelSource: 'env',
        key: { configured: true, source: 'env', last4: '9876', unreadable: false, updatedAt: null },
      }),
      google: providerStatus('gemini-2.5-flash-lite'),
    },
    updatedAt: '2026-11-19T04:00:00.000Z',
    updatedBy: { id: 'u1', name: 'Root Admin', email: 'root@shield.bd' },
    ...patch,
  }
}

const fetchMock = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>()
let listHandler: () => Response | Promise<Response>
let patchHandler: (id: string, body: unknown) => Response | Promise<Response>
let auditHandler: (url: URL) => Response | Promise<Response>
let aiGetHandler: () => Response | Promise<Response>
let aiPatchHandler: (body: unknown) => Response | Promise<Response>
let aiTestHandler: (body: unknown) => Response | Promise<Response>
let aiAuditHandler: (url: URL) => Response | Promise<Response>

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function calls(method: string, path?: string) {
  return fetchMock.mock.calls.filter(([input, init]) => {
    const url = new URL(input, 'http://admin.localhost')
    return (
      (init?.method ?? 'GET') === method &&
      (path ? url.pathname === path : url.pathname.startsWith(PLANS) && url.pathname !== AUDIT)
    )
  })
}

function renderSettings() {
  const queryClient = createQueryClient()
  const defaults = queryClient.getDefaultOptions()
  queryClient.setDefaultOptions({ ...defaults, queries: { ...defaults.queries, retry: false } })
  const router = createAppRouter(queryClient, createMemoryHistory({ initialEntries: ['/admin/settings'] }))
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
  return { router, queryClient }
}

beforeEach(() => {
  auth.getSession.mockReset().mockResolvedValue(superAdmin)
  listHandler = () => json({ items: seeded })
  patchHandler = () => json({ statusCode: 500, message: 'unexpected PATCH' }, 500)
  auditHandler = (url) => json(auditPage([], url))
  aiGetHandler = () => json(aiSettings())
  aiPatchHandler = () => json({ statusCode: 500, message: 'unexpected AI PATCH' }, 500)
  aiTestHandler = () => json({ statusCode: 500, message: 'unexpected AI test' }, 500)
  aiAuditHandler = (url) => json({ items: [], total: 0, skip: Number(url.searchParams.get('skip')), take: 20 })
  fetchMock.mockReset().mockImplementation(async (input, init = {}) => {
    const url = new URL(input, 'http://admin.localhost')
    const method = init.method ?? 'GET'
    if (method === 'GET' && url.pathname === PLANS && url.search === '') return listHandler()
    if (method === 'GET' && url.pathname === AUDIT) return auditHandler(url)
    if (method === 'GET' && url.pathname === AI && url.search === '') return aiGetHandler()
    if (method === 'PATCH' && url.pathname === AI) return aiPatchHandler(JSON.parse(String(init.body)))
    if (method === 'POST' && url.pathname === AI_TEST) return aiTestHandler(JSON.parse(String(init.body)))
    if (method === 'GET' && url.pathname === AI_AUDIT) return aiAuditHandler(url)
    const match = /^\/api\/admin\/settings\/plans\/([^/]+)$/.exec(url.pathname)
    if (method === 'PATCH' && match) return patchHandler(decodeURIComponent(match[1] ?? ''), JSON.parse(String(init.body)))
    throw new Error(`unexpected fetch ${method} ${url.pathname}${url.search}`)
  })
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

async function card(name: string) {
  return screen.findByRole('region', { name })
}

function input(region: HTMLElement, label: string) {
  return within(region).getByLabelText(label) as HTMLInputElement
}

function type(el: HTMLElement, value: string) {
  fireEvent.change(el, { target: { value } })
}

function saveButton(region: HTMLElement) {
  return within(region).getByRole('button', { name: 'Save' }) as HTMLButtonElement
}

describe('/admin/settings', () => {
  it('renders one card per plan in sortOrder with name, slug, prices, limits and features', async () => {
    // The API orders by sortOrder; the screen keeps that order.
    renderSettings()
    await card('Starter')
    const cards = screen.getAllByTestId('plan-card')
    // Free is retired (PW-D7): not in the API list, no card.
    expect(cards.map((c) => within(c).getByRole('heading', { level: 2 }).textContent)).toEqual([
      'Starter',
      'Growth',
      'Pro',
    ])
    expect(screen.queryByRole('region', { name: 'Free' })).toBeNull()
    expect(cards.map((c) => within(c).getByText(/^(free|starter|growth|pro)$/).textContent)).toEqual([
      'starter',
      'growth',
      'pro',
    ])

    const pro = await card('Pro')
    expect(input(pro, 'Original price').value).toBe('5999')
    expect(input(pro, 'Offer price').value).toBe('3999')
    expect(input(pro, 'Offer badge').value).toBe('33% Off')
    expect(input(pro, 'Connected FB & IG Pages').value).toBe('25')
    expect(input(pro, 'Monthly comments').value).toBe('75000')
    expect(input(pro, 'Workspaces').value).toBe('10')
    // PW-T1b: comments are the limit again (no AI-credit estimate hint).
    const comments = input(pro, 'Monthly comments')
    const hint = document.getElementById(comments.getAttribute('aria-describedby') as string) as HTMLElement
    expect(hint.textContent).toBe('')
    type(comments, 'many')
    expect(hint.textContent).toBe('Use a whole number (digits only).')
    type(comments, '75000')
    expect(input(pro, 'Connected FB & IG Pages').getAttribute('aria-describedby')).toBeTruthy()
    expect(input(pro, 'Team / Moderator Seats').value).toBe('10')
    expect(within(pro).getAllByRole('switch')).toHaveLength(7)
    expect(within(pro).getByRole('switch', { name: 'Priority Support & API Webhook Access' }).getAttribute('aria-checked')).toBe('true')
    expect(within(pro).getByTestId('preview-price').textContent).toBe('৳3,999')
    expect(input(pro, 'Original price').className).toContain('rounded-full')

    const growth = await card('Growth')
    expect(within(growth).getByRole('switch', { name: 'White-Label CSV/PDF Agency Reports' }).getAttribute('aria-checked')).toBe('false')
    expect(saveButton(growth).disabled).toBe(true)
    expect(within(growth).getByRole('button', { name: 'Reset' })).toHaveProperty('disabled', true)
    expect(calls('GET', PLANS)).toHaveLength(1)
  })

  it('edits → dirty → Save sends the minimal PATCH body, toasts and ends clean', async () => {
    let saved: AdminPlan | undefined
    patchHandler = (id) => {
      expect(id).toBe(starter.id)
      saved = {
        ...starter,
        monthlyPriceBdt: 1199,
        offerPriceBdt: 599,
        offerBadge: '50% Eid Offer',
        featureConfig: {
          limits: { ...starter.featureConfig.limits, teamSeats: 2 },
          features: { ...starter.featureConfig.features, customBlocklist: true },
        },
        updatedAt: '2026-11-18T09:00:00.000Z',
      }
      return json({ plan: saved })
    }
    listHandler = () => json({ items: seeded.map((p): AdminPlan => (saved && p.id === saved.id ? saved : p)) })
    renderSettings()
    const region = await card('Starter')
    expect(region.dataset.dirty).toBeUndefined()

    type(input(region, 'Original price'), '1199')
    type(input(region, 'Offer price'), '599')
    type(input(region, 'Offer badge'), '  50% Eid Offer ')
    type(input(region, 'Team / Moderator Seats'), '2')
    fireEvent.click(within(region).getByRole('switch', { name: 'Custom Keyword & BD Phone Blocklist' }))

    expect(region.dataset.dirty).toBe('true')
    expect(within(region).getByTestId('unsaved').textContent).toBe('Unsaved changes')
    expect(within(region).getByTestId('preview-struck').textContent).toBe('৳1,199')
    expect(within(region).getByTestId('preview-price').textContent).toBe('৳599')
    expect(within(region).getByTestId('preview-badge').textContent).toBe('50% Eid Offer')
    expect(within(region).getByText('13/40')).toBeTruthy()

    fireEvent.click(saveButton(region))

    await waitFor(() => expect(calls('PATCH')).toHaveLength(1))
    const [url, init] = calls('PATCH')[0] ?? ['']
    expect(url).toBe(`${PLANS}/${starter.id}`)
    expect(JSON.parse(String(init?.body))).toEqual({
      monthlyPriceBdt: 1199,
      offerPriceBdt: 599,
      offerBadge: '50% Eid Offer',
      featureConfig: { limits: { teamSeats: 2 }, features: { customBlocklist: true } },
    })

    expect(await screen.findByText('Starter saved.')).toBeTruthy()
    await waitFor(() => expect(region.dataset.dirty).toBeUndefined())
    expect(within(region).queryByTestId('unsaved')).toBeNull()
    expect(input(region, 'Original price').value).toBe('1199')
    expect(input(region, 'Offer price').value).toBe('599')
    expect(input(region, 'Offer badge').value).toBe('50% Eid Offer')
    expect(saveButton(region).disabled).toBe(true)
    // The list is refreshed after the save.
    await waitFor(() => expect(calls('GET', PLANS)).toHaveLength(2))
  })

  it('sends only one changed field and clears an offer with null', async () => {
    patchHandler = () => json({ plan: { ...starter, offerPriceBdt: null } })
    renderSettings()
    const region = await card('Starter')
    type(input(region, 'Offer price'), '')
    fireEvent.click(saveButton(region))
    await waitFor(() => expect(calls('PATCH')).toHaveLength(1))
    expect(JSON.parse(String(calls('PATCH')[0]?.[1]?.body))).toEqual({ offerPriceBdt: null })
  })

  it('Reset brings back the stored values', async () => {
    renderSettings()
    const region = await card('Growth')
    type(input(region, 'Original price'), '1799')
    fireEvent.click(within(region).getByRole('switch', { name: 'WhatsApp & Telegram Alerts' }))
    expect(region.dataset.dirty).toBe('true')

    fireEvent.click(within(region).getByRole('button', { name: 'Reset' }))
    expect(region.dataset.dirty).toBeUndefined()
    expect(input(region, 'Original price').value).toBe('2499')
    expect(within(region).getByRole('switch', { name: 'WhatsApp & Telegram Alerts' }).getAttribute('aria-checked')).toBe('true')
    expect(saveButton(region).disabled).toBe(true)
    expect(calls('PATCH')).toHaveLength(0)
  })

  it('an offer above the original shows an inline error and disables Save', async () => {
    renderSettings()
    const region = await card('Starter')
    type(input(region, 'Offer price'), '1000')
    expect(within(region).getByText("The offer can't be more than the original price.")).toBeTruthy()
    expect(input(region, 'Offer price').getAttribute('aria-invalid')).toBe('true')
    expect(saveButton(region).disabled).toBe(true)
    expect(within(region).getByTestId('preview-price').textContent).toBe('—')

    type(input(region, 'Offer price'), '12.5')
    expect(within(region).getByText('Use a whole number (digits only).')).toBeTruthy()
    expect(saveButton(region).disabled).toBe(true)

    // Below the stored yearly per-month price (৳449): the yearly field is flagged (backend rule).
    type(input(region, 'Offer price'), '399')
    expect(within(region).getByText("Can't be more than the monthly price (৳399).")).toBeTruthy()
    expect(input(region, 'Yearly price per month').getAttribute('aria-invalid')).toBe('true')
    expect(saveButton(region).disabled).toBe(true)
    type(input(region, 'Yearly price per month'), '399')
    expect(saveButton(region).disabled).toBe(false)

    type(input(region, 'Monthly comments'), '10000001')
    expect(within(region).getByText(`Must be ${new Intl.NumberFormat('en-BD').format(10_000_000)} or less.`)).toBeTruthy()
    expect(saveButton(region).disabled).toBe(true)
    fireEvent.submit(saveButton(region).closest('form') as HTMLFormElement)
    expect(calls('PATCH')).toHaveLength(0)
  })

  it('a 400 shows the backend message and keeps the edit', async () => {
    patchHandler = () => json({ statusCode: 400, message: 'offerPriceBdt must not be greater than originalPriceBdt' }, 400)
    renderSettings()
    const region = await card('Pro')
    type(input(region, 'Original price'), '4999')
    fireEvent.click(saveButton(region))

    const alert = await within(region).findByRole('alert')
    expect(alert.textContent).toBe('offerPriceBdt must not be greater than originalPriceBdt')
    expect(await screen.findByText('Pro was not saved.')).toBeTruthy()
    expect(region.dataset.dirty).toBe('true')
    expect(input(region, 'Original price').value).toBe('4999')

    // Editing again clears the message.
    type(input(region, 'Original price'), '4998')
    expect(within(region).queryByRole('alert')).toBeNull()
  })

  it('a 404 toasts and refreshes the list', async () => {
    patchHandler = () => json({ statusCode: 404, message: 'Plan not found' }, 404)
    renderSettings()
    const region = await card('Growth')
    type(input(region, 'Team / Moderator Seats'), '4')
    fireEvent.click(saveButton(region))
    expect(await screen.findByText('Growth no longer exists.')).toBeTruthy()
    await waitFor(() => expect(calls('GET', PLANS)).toHaveLength(2))
  })

  it('shows skeletons while loading', async () => {
    let release: (res: Response) => void = () => {}
    listHandler = () => new Promise<Response>((resolve) => (release = resolve))
    renderSettings()
    expect((await screen.findAllByTestId('plan-skeleton')).length).toBe(3)
    expect(screen.queryAllByTestId('plan-card')).toHaveLength(0)
    await act(async () => release(json({ items: seeded })))
    expect(await card('Starter')).toBeTruthy()
    expect(screen.queryAllByTestId('plan-skeleton')).toHaveLength(0)
  })

  it('shows "No plans" for an empty list', async () => {
    listHandler = () => json({ items: [] })
    renderSettings()
    expect(await screen.findByRole('heading', { name: 'No plans' })).toBeTruthy()
    expect(screen.queryAllByTestId('plan-card')).toHaveLength(0)
  })

  it('shows the error state and recovers with Try again', async () => {
    listHandler = () => json({ statusCode: 500, message: 'Internal server error' }, 500)
    renderSettings()
    const alert = await screen.findByRole('alert')
    expect(within(alert).getByText("Couldn't load plans")).toBeTruthy()
    expect(within(alert).getByText('Internal server error')).toBeTruthy()

    listHandler = () => json({ items: seeded })
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }))
    expect(await card('Pro')).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('asks before leaving with unsaved changes', async () => {
    const { router } = renderSettings()
    const region = await card('Starter')
    type(input(region, 'Original price'), '599')

    act(() => void router.navigate({ to: '/admin/billing' }))
    const dialog = await screen.findByRole('dialog', { name: 'Leave without saving?' })
    expect(within(dialog).getByText('One plan has unsaved changes. They will be lost.')).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Stay' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(router.state.location.pathname).toBe('/admin/settings')
    expect(input(region, 'Original price').value).toBe('599')

    act(() => void router.navigate({ to: '/admin/billing' }))
    fireEvent.click(
      within(await screen.findByRole('dialog', { name: 'Leave without saving?' })).getByRole('button', {
        name: 'Discard changes',
      }),
    )
    await waitFor(() => expect(router.state.location.pathname).toBe('/admin/billing'))
  })

  it('leaves without asking when nothing is dirty', async () => {
    const { router } = renderSettings()
    await card('Starter')
    act(() => void router.navigate({ to: '/admin/billing' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/admin/billing'))
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

describe('/admin/settings yearly price + trial (PW-T7)', () => {
  const trialGroup = (region: HTMLElement) => within(region).getByRole('radiogroup', { name: 'Trial length' })
  const hintOf = (el: HTMLElement) =>
    (document.getElementById(el.getAttribute('aria-describedby') as string) as HTMLElement).textContent

  it('shows the yearly per-month price on every plan and the trial fields on Starter only', async () => {
    renderSettings()
    const starterCard = await card('Starter')
    const yearly = input(starterCard, 'Yearly price per month')
    expect(yearly.value).toBe('449')
    expect(hintOf(yearly)).toBe('Billed ৳5,388 yearly.')
    expect(input(await card('Pro'), 'Yearly price per month').value).toBe('3599')
    expect(hintOf(input(await card('Pro'), 'Yearly price per month'))).toBe(
      `Billed ৳${new Intl.NumberFormat('en-BD').format(43_188)} yearly.`,
    )

    const radios = within(trialGroup(starterCard)).getAllByRole('radio')
    expect(radios.map((r) => r.textContent)).toEqual(['No trial', '3 days', '7 days', '14 days', '30 days'])
    expect(radios.map((r) => r.getAttribute('aria-checked'))).toEqual(['false', 'false', 'true', 'false', 'false'])
    expect(radios[2]?.className).toContain('rounded-full')
    expect(within(starterCard).getByText('Changes apply to new trials only.')).toBeTruthy()
    const trialLimit = input(starterCard, 'Trial comment limit')
    expect(trialLimit.value).toBe('300')
    expect(hintOf(trialLimit)).toBe(`Empty = Starter's monthly comments (${new Intl.NumberFormat('en-BD').format(2500)}).`)

    for (const name of ['Growth', 'Pro']) {
      const region = await card(name)
      expect(within(region).queryByRole('radiogroup')).toBeNull()
      expect(within(region).queryByLabelText('Trial comment limit')).toBeNull()
      expect(within(region).queryByTestId('trial-section')).toBeNull()
    }
  })

  it('clearing yearly, picking No trial and emptying the trial limit PATCHes null for each', async () => {
    let saved: AdminPlan | undefined
    patchHandler = (_id, body) => {
      saved = { ...starter, ...(body as Partial<AdminPlan>), updatedAt: '2026-11-20T09:00:00.000Z' }
      return json({ plan: saved })
    }
    listHandler = () => json({ items: seeded.map((p): AdminPlan => (saved && p.id === saved.id ? saved : p)) })
    renderSettings()
    const region = await card('Starter')
    type(input(region, 'Yearly price per month'), '')
    expect(hintOf(input(region, 'Yearly price per month'))).toBe('Empty = no yearly option.')
    fireEvent.click(within(trialGroup(region)).getByRole('radio', { name: 'No trial' }))
    type(input(region, 'Trial comment limit'), '  ')
    expect(region.dataset.dirty).toBe('true')
    fireEvent.click(saveButton(region))
    await waitFor(() => expect(calls('PATCH')).toHaveLength(1))
    expect(JSON.parse(String(calls('PATCH')[0]?.[1]?.body))).toEqual({
      yearlyMonthlyPriceBdt: null,
      trialDays: null,
      trialCommentLimit: null,
    })
    await waitFor(() => expect(region.dataset.dirty).toBeUndefined())
    expect(within(trialGroup(region)).getByRole('radio', { name: 'No trial' }).getAttribute('aria-checked')).toBe('true')
  })

  it('arrow keys move the trial preset; Save sends only the changed trial + yearly values', async () => {
    patchHandler = (_id, body) => json({ plan: { ...starter, ...(body as Partial<AdminPlan>) } })
    renderSettings()
    const region = await card('Starter')
    const group = trialGroup(region)
    fireEvent.keyDown(within(group).getByRole('radio', { name: '7 days' }), { key: 'ArrowRight' })
    expect(within(group).getByRole('radio', { name: '14 days' }).getAttribute('aria-checked')).toBe('true')
    expect(document.activeElement?.textContent).toBe('14 days')
    type(input(region, 'Trial comment limit'), '500')
    type(input(region, 'Yearly price per month'), '450')
    expect(hintOf(input(region, 'Yearly price per month'))).toBe('Billed ৳5,400 yearly.')
    fireEvent.click(saveButton(region))
    await waitFor(() => expect(calls('PATCH')).toHaveLength(1))
    expect(JSON.parse(String(calls('PATCH')[0]?.[1]?.body))).toEqual({
      yearlyMonthlyPriceBdt: 450,
      trialDays: 14,
      trialCommentLimit: 500,
    })
  })

  it('a stored non-preset trial length still shows as the selected option', async () => {
    listHandler = () => json({ items: seeded.map((p) => (p.id === starter.id ? { ...p, trialDays: 10 } : p)) })
    renderSettings()
    const group = trialGroup(await card('Starter'))
    expect(within(group).getAllByRole('radio').map((r) => r.textContent)).toEqual([
      'No trial',
      '3 days',
      '7 days',
      '10 days',
      '14 days',
      '30 days',
    ])
    expect(within(group).getByRole('radio', { name: '10 days' }).getAttribute('aria-checked')).toBe('true')
  })

  it('validates the yearly price and trial limit inline; Growth sends no trial fields', async () => {
    patchHandler = (_id, body) => json({ plan: { ...seeded[1], ...(body as Partial<AdminPlan>) } })
    renderSettings()
    const starterCard = await card('Starter')
    type(input(starterCard, 'Yearly price per month'), '500')
    expect(within(starterCard).getByText("Can't be more than the monthly price (৳499).")).toBeTruthy()
    type(input(starterCard, 'Trial comment limit'), '10000001')
    expect(
      within(starterCard).getByText(`Must be ${new Intl.NumberFormat('en-BD').format(10_000_000)} or less.`),
    ).toBeTruthy()
    expect(saveButton(starterCard).disabled).toBe(true)

    const growth = await card('Growth')
    type(input(growth, 'Yearly price per month'), '1299')
    fireEvent.click(saveButton(growth))
    await waitFor(() => expect(calls('PATCH')).toHaveLength(1))
    expect(calls('PATCH')[0]?.[0]).toBe(`${PLANS}/${seeded[1].id}`)
    expect(JSON.parse(String(calls('PATCH')[0]?.[1]?.body))).toEqual({ yearlyMonthlyPriceBdt: 1299 })
  })

  it('shows a 400 from the yearly rule as today', async () => {
    patchHandler = () =>
      json({ statusCode: 400, message: 'yearlyMonthlyPriceBdt (1500) must not be greater than the monthly price (1499)' }, 400)
    renderSettings()
    const region = await card('Growth')
    type(input(region, 'Yearly price per month'), '1400')
    fireEvent.click(saveButton(region))
    expect((await within(region).findByRole('alert')).textContent).toBe(
      'yearlyMonthlyPriceBdt (1500) must not be greater than the monthly price (1499)',
    )
    expect(input(region, 'Yearly price per month').value).toBe('1400')
  })
})

describe('/admin/settings price preview', () => {
  it('shows the seeded launch offers struck through with badge and saving', async () => {
    renderSettings()
    const expected = [
      ['Starter', '৳999', '৳499', '50% Launch Offer', 'Saves 50%'],
      ['Growth', '৳2,499', '৳1,499', '40% Off', 'Saves 40%'],
      ['Pro', '৳5,999', '৳3,999', '33% Off', 'Saves 33%'],
    ] as const
    for (const [name, struck, price, badge, saves] of expected) {
      const preview = within(await card(name)).getByTestId('price-preview')
      const struckEl = within(preview).queryByTestId('preview-struck')
      expect(struckEl?.textContent ?? null).toBe(struck)
      if (struckEl) expect(struckEl.tagName).toBe('S')
      expect(within(preview).getByTestId('preview-price').textContent).toBe(price)
      expect(within(preview).getByText('/mo')).toBeTruthy()
      const badgeEl = within(preview).queryByTestId('preview-badge')
      expect(badgeEl?.textContent ?? null).toBe(badge)
      if (badgeEl) expect(badgeEl.className).toContain('rounded-full')
      if (saves) expect(within(preview).getByText(saves)).toBeTruthy()
      else expect(within(preview).queryByText(/^Saves/)).toBeNull()
    }
  })
})

describe('/admin/settings change history', () => {
  function history() {
    return screen.findByRole('region', { name: 'Change history' })
  }
  function auditCalls() {
    return fetchMock.mock.calls
      .map(([input]) => new URL(input, 'http://admin.localhost'))
      .filter((url) => url.pathname === AUDIT)
      .map((url) => Object.fromEntries(url.searchParams))
  }

  it('lists who, when, the action and every field before → after', async () => {
    auditHandler = (url) =>
      json(
        auditPage(
          [
            auditEntry(2, {
              changes: [
                { field: 'originalPriceBdt', before: 999, after: 1199 },
                { field: 'offerPriceBdt', before: 499, after: null },
                { field: 'offerBadge', before: '50% Launch Offer', after: null },
                // Rows from M5-T11 keep the AI-credit field name (PW-T1b renamed it back).
                { field: 'featureConfig.limits.monthlyAiCredits', before: 2500, after: 5000 },
                { field: 'featureConfig.limits.monthlyComments', before: 5000, after: 6000 },
                { field: 'featureConfig.features.customBlocklist', before: false, after: true },
              ],
            }),
            auditEntry(1, {
              plan: { id: seeded[2].id, slug: 'pro', name: 'Pro' },
              admin: { id: 'u2', name: 'Ops Admin', email: 'ops@shield.bd' },
              ip: null,
              userAgent: null,
              createdAt: '2026-11-17T18:30:00.000Z',
            }),
          ],
          url,
        ),
      )
    renderSettings()
    const panel = await history()
    const entries = await within(panel).findAllByTestId('audit-entry')
    expect(entries).toHaveLength(2)
    expect(auditCalls()).toEqual([{ skip: '0', take: '20' }])

    const [first, second] = entries as [HTMLElement, HTMLElement]
    expect(within(first).getByText('Updated')).toBeTruthy()
    expect(within(first).getByText('Starter')).toBeTruthy()
    expect(within(first).getByText('Root Admin')).toBeTruthy()
    expect(within(first).getByText('root@shield.bd')).toBeTruthy()
    // 06:00 UTC = 12:00 in Dhaka (UTC+6).
    const time = first.querySelector('time') as HTMLTimeElement
    expect(time.dateTime).toBe('2026-11-18T06:00:00.000Z')
    expect(time.textContent).toBe('18 Nov 2026, 12:00')

    const rows = within(first)
      .getAllByTestId('audit-change')
      .map((row) => [
        row.firstElementChild?.textContent,
        within(row).getByTestId('audit-before').textContent,
        within(row).getByTestId('audit-after').textContent,
      ])
    expect(rows).toEqual([
      ['Original price', '৳999', '৳1,199'],
      ['Offer price', '৳499', 'None'],
      ['Offer badge', '“50% Launch Offer”', 'None'],
      ['Monthly AI credits', new Intl.NumberFormat('en-BD').format(2500), new Intl.NumberFormat('en-BD').format(5000)],
      ['Monthly comments', new Intl.NumberFormat('en-BD').format(5000), new Intl.NumberFormat('en-BD').format(6000)],
      ['Custom Keyword & BD Phone Blocklist', 'Off', 'On'],
    ])
    const clientInfo = within(first).getByTestId('audit-client')
    expect(clientInfo.textContent).toBe('IP 203.0.113.7 · Mozilla/5.0 (X11; Linux x86_64) Chrome/140.0')
    expect(clientInfo.className).toContain('text-muted-foreground')

    expect(within(second).getByText('Pro')).toBeTruthy()
    expect(within(second).getByText('Ops Admin')).toBeTruthy()
    // 18:30 UTC on the 17th is already the 18th in Dhaka.
    expect(second.querySelector('time')?.textContent).toBe('18 Nov 2026, 00:30')
    expect(within(second).getByText('Team / Moderator Seats')).toBeTruthy()
    expect(within(second).queryByTestId('audit-client')).toBeNull()
    expect(within(panel).getByText('1–2 of 2 changes')).toBeTruthy()
  })

  it('pages through the history 20 at a time', async () => {
    auditHandler = (url) => {
      const skip = Number(url.searchParams.get('skip'))
      const items = Array.from({ length: Math.min(20, 45 - skip) }, (_, i) => auditEntry(skip + i))
      return json(auditPage(items, url, 45))
    }
    renderSettings()
    const panel = await history()
    expect(await within(panel).findAllByTestId('audit-entry')).toHaveLength(20)
    const nav = within(panel).getByRole('navigation', { name: 'Change history pages' })
    expect(within(nav).getByText('1–20 of 45 changes')).toBeTruthy()
    expect(within(nav).getByText('1 / 3')).toBeTruthy()
    expect(within(nav).getByRole('button', { name: 'Previous page' })).toHaveProperty('disabled', true)

    fireEvent.click(within(nav).getByRole('button', { name: 'Next page' }))
    expect(await within(panel).findByText('21–40 of 45 changes')).toBeTruthy()
    fireEvent.click(within(nav).getByRole('button', { name: 'Next page' }))
    expect(await within(panel).findByText('41–45 of 45 changes')).toBeTruthy()
    expect(within(panel).getAllByTestId('audit-entry')).toHaveLength(5)
    expect(within(nav).getByText('3 / 3')).toBeTruthy()
    expect(within(nav).getByRole('button', { name: 'Next page' })).toHaveProperty('disabled', true)

    fireEvent.click(within(nav).getByRole('button', { name: 'Previous page' }))
    expect(await within(panel).findByText('21–40 of 45 changes')).toBeTruthy()
    expect(auditCalls().map((q) => q.skip)).toEqual(['0', '20', '40'])
    // Page 2 came back from the cache: no 4th request.
    expect(auditCalls()).toHaveLength(3)
    expect(auditCalls().every((q) => q.take === '20' && q.planId === undefined)).toBe(true)
  })

  it('filters by plan and goes back to the first page', async () => {
    auditHandler = (url) => {
      const planId = url.searchParams.get('planId')
      if (planId === seeded[1].id) return json(auditPage([], url))
      if (planId === starter.id) return json(auditPage([auditEntry(7)], url))
      const skip = Number(url.searchParams.get('skip'))
      return json(auditPage(Array.from({ length: Math.min(20, 30 - skip) }, (_, i) => auditEntry(skip + i + 100)), url, 30))
    }
    renderSettings()
    const panel = await history()
    await within(panel).findByText('1–20 of 30 changes')
    const filter = within(panel).getByRole('group', { name: 'Filter by plan' })
    expect(within(filter).getAllByRole('button').map((b) => b.textContent)).toEqual([
      'All plans',
      'Starter',
      'Growth',
      'Pro',
    ])
    expect(within(filter).getByRole('button', { name: 'All plans' }).getAttribute('aria-pressed')).toBe('true')

    fireEvent.click(within(panel).getByRole('button', { name: 'Next page' }))
    await within(panel).findByText('21–30 of 30 changes')

    fireEvent.click(within(filter).getByRole('button', { name: 'Starter' }))
    expect(await within(panel).findByText('1–1 of 1 change')).toBeTruthy()
    expect(within(filter).getByRole('button', { name: 'Starter' }).getAttribute('aria-pressed')).toBe('true')
    expect(within(filter).getByRole('button', { name: 'All plans' }).getAttribute('aria-pressed')).toBe('false')
    expect(auditCalls().at(-1)).toEqual({ skip: '0', take: '20', planId: starter.id })

    fireEvent.click(within(filter).getByRole('button', { name: 'Growth' }))
    expect(await within(panel).findByRole('heading', { name: 'No changes to Growth yet' })).toBeTruthy()
    expect(within(panel).queryByRole('navigation')).toBeNull()
    expect(auditCalls().at(-1)).toEqual({ skip: '0', take: '20', planId: seeded[1].id })
  })

  it('shows skeletons, then the empty state', async () => {
    let release: (res: Response) => void = () => {}
    auditHandler = () => new Promise<Response>((resolve) => (release = resolve))
    renderSettings()
    const panel = await history()
    expect(await within(panel).findAllByTestId('audit-skeleton')).toHaveLength(3)
    await act(async () => release(json({ items: [], total: 0, skip: 0, take: 20 })))
    expect(await within(panel).findByRole('heading', { name: 'No plan changes yet' })).toBeTruthy()
    expect(within(panel).queryAllByTestId('audit-skeleton')).toHaveLength(0)
    expect(within(panel).queryByRole('navigation')).toBeNull()
  })

  it('shows the error state and recovers with Try again', async () => {
    auditHandler = () => json({ statusCode: 500, message: 'Audit store unavailable' }, 500)
    renderSettings()
    const panel = await history()
    const alert = await within(panel).findByRole('alert')
    expect(within(alert).getByText("Couldn't load the change history")).toBeTruthy()
    expect(within(alert).getByText('Audit store unavailable')).toBeTruthy()
    // The plan editors still work.
    expect(await card('Pro')).toBeTruthy()

    auditHandler = (url) => json(auditPage([auditEntry(1)], url))
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }))
    expect(await within(panel).findAllByTestId('audit-entry')).toHaveLength(1)
    expect(within(panel).queryByRole('alert')).toBeNull()
  })

  it('a save refetches the history so the new entry shows up', async () => {
    let saved = false
    patchHandler = () => {
      saved = true
      const growth = seeded[1]
      return json({ plan: { ...growth, featureConfig: { ...growth.featureConfig, limits: { ...growth.featureConfig.limits, teamSeats: 4 } } } })
    }
    auditHandler = (url) =>
      json(
        auditPage(
          saved
            ? [auditEntry(9, { id: 'new-entry', plan: { id: seeded[1].id, slug: 'growth', name: 'Growth' }, changes: [{ field: 'featureConfig.limits.teamSeats', before: 3, after: 4 }] })]
            : [],
          url,
        ),
      )
    renderSettings()
    const panel = await history()
    await within(panel).findByRole('heading', { name: 'No plan changes yet' })

    // Growth: toasts outlive a test and Starter saves elsewhere.
    const region = await card('Growth')
    type(input(region, 'Team / Moderator Seats'), '4')
    fireEvent.click(saveButton(region))
    expect(await screen.findByText('Growth saved.')).toBeTruthy()

    const entry = await within(panel).findByTestId('audit-entry')
    expect(within(entry).getByText('Team / Moderator Seats')).toBeTruthy()
    expect(within(entry).getByTestId('audit-before').textContent).toBe('3')
    expect(within(entry).getByTestId('audit-after').textContent).toBe('4')
    expect(auditCalls()).toHaveLength(2)
  })
})

describe('/admin/settings AI provider', () => {
  const KEY = 'sk-live-TOPSECRET-5678'
  const AI_KEY_PATH = ['admin', 'ai-settings', 'settings']

  function aiCard() {
    return screen.findByTestId('ai-provider-card')
  }
  function keyRow(card: HTMLElement, provider: AiProvider) {
    return within(card).getByTestId(`ai-key-${provider}`)
  }
  function aiCalls(method: string, path: string) {
    return fetchMock.mock.calls
      .filter(([input, init]) => (init?.method ?? 'GET') === method && new URL(input, 'http://admin.localhost').pathname === path)
      .map(([input, init]) => ({ url: new URL(input, 'http://admin.localhost'), body: init?.body ? JSON.parse(String(init.body)) : undefined }))
  }
  function aiSave(card: HTMLElement) {
    return within(card).getByRole('button', { name: 'Save' }) as HTMLButtonElement
  }

  it('shows the active provider + model with sources, masked keys and the Neon URL note', async () => {
    renderSettings()
    const card = await aiCard()
    expect(within(card).getByTestId('ai-status').textContent).toBe('AI calls on')
    expect(within(card).getByTestId('ai-active').textContent).toBe('In use: OpenAI database · gpt-4.1-mini database')
    expect(within(card).getByText(/Saved by Root Admin/)).toBeTruthy()

    const radios = within(card).getAllByRole('radio')
    expect(radios.map((r) => r.getAttribute('aria-checked'))).toEqual(['false', 'true', 'false', 'false'])
    expect(within(within(card).getByTestId('ai-provider-openai')).getByText('Active')).toBeTruthy()
    expect(within(card).getByTestId('ai-provider-neon').textContent).toContain('No key · URL missing')
    expect(within(card).getByTestId('ai-provider-anthropic').textContent).toContain('Key ready')

    expect((within(card).getByLabelText('Model') as HTMLInputElement).value).toBe('gpt-4.1-mini')
    expect(within(card).getByTestId('ai-model-hint').textContent).toBe('OpenAI uses gpt-4.1-mini (database) · default gpt-4.1-mini')

    expect(within(keyRow(card, 'openai')).getByTestId('key-status').textContent).toBe('Saved ••••1234 · database')
    expect(within(keyRow(card, 'anthropic')).getByTestId('key-status').textContent).toBe('Saved ••••9876 · .env')
    expect(within(keyRow(card, 'neon')).getByTestId('key-status').textContent).toBe('Not set')
    expect(within(keyRow(card, 'google')).getByTestId('key-status').textContent).toBe('Not set')
    expect(within(keyRow(card, 'neon')).getByTestId('neon-url-missing')).toBeTruthy()
    expect(within(card).queryByTestId('key-unreadable')).toBeNull()

    for (const label of ['Neon AI gateway API key', 'OpenAI API key', 'Anthropic API key', 'Google API key']) {
      const field = within(card).getByLabelText(label) as HTMLInputElement
      expect(field.type).toBe('password')
      expect(field.autocomplete).toBe('off')
      expect(field.value).toBe('')
      expect(field.disabled).toBe(false)
      expect(field.className).toContain('rounded-full')
    }
    // Only the DB key can be cleared (.env keys can't).
    expect(within(card).getAllByRole('button', { name: /^Clear the/ }).map((b) => b.getAttribute('aria-label'))).toEqual([
      'Clear the OpenAI key',
    ])
    expect(within(card).queryByTestId('ai-not-configured')).toBeNull()
    expect(within(card).queryByTestId('ai-cipher-off')).toBeNull()
    expect(aiSave(card).disabled).toBe(true)
  })

  it('warns when AI is off, the cipher is unset and a saved key is unreadable', async () => {
    const base = aiSettings()
    aiGetHandler = () =>
      json(
        aiSettings({
          provider: 'neon',
          providerSource: 'default',
          model: 'gpt-oss-20b',
          modelSource: 'default',
          configured: false,
          cipherConfigured: false,
          updatedAt: null,
          updatedBy: null,
          providers: {
            ...base.providers,
            google: {
              ...base.providers.google,
              key: { configured: false, source: 'none', last4: null, unreadable: true, updatedAt: '2026-11-18T00:00:00.000Z' },
            },
          },
        }),
      )
    renderSettings()
    const card = await aiCard()
    expect(within(card).getByTestId('ai-status').textContent).toBe('AI calls off')
    expect(within(card).getByTestId('ai-not-configured').textContent).toBe(
      'AI calls are off until Neon AI gateway has an API key and NEON_AI_GATEWAY_BASE_URL is set on the backend. New comments stay visible meanwhile.',
    )
    expect(within(card).getByTestId('ai-cipher-off').textContent).toContain('key encryption is not configured')
    expect(within(card).getByTestId('ai-active').textContent).toBe('In use: Neon AI gateway default · gpt-oss-20b default')
    expect(within(keyRow(card, 'google')).getByTestId('key-unreadable').textContent).toContain("can't be decrypted")
    for (const label of ['Neon AI gateway API key', 'OpenAI API key', 'Anthropic API key', 'Google API key']) {
      expect((within(card).getByLabelText(label) as HTMLInputElement).disabled).toBe(true)
    }
    // Clearing still works without the cipher (the unreadable Google row and the OpenAI DB key).
    expect(within(card).getAllByRole('button', { name: /^Clear the/ })).toHaveLength(2)
  })

  it('saves a typed key alone, updates the cache, refreshes the history and forgets the key', async () => {
    const base = aiSettings()
    const saved = aiSettings({
      providers: {
        ...base.providers,
        google: {
          ...base.providers.google,
          key: { configured: true, source: 'db', last4: '5678', unreadable: false, updatedAt: '2026-11-19T09:00:00.000Z' },
        },
      },
    })
    let done = false
    aiPatchHandler = () => {
      done = true
      return json(saved)
    }
    aiGetHandler = () => json(done ? saved : aiSettings())
    const { queryClient } = renderSettings()
    const card = await aiCard()
    await waitFor(() => expect(aiCalls('GET', AI_AUDIT)).toHaveLength(1))

    const field = within(card).getByLabelText('Google API key') as HTMLInputElement
    type(field, `  ${KEY} `)
    expect(within(card).getByTestId('ai-unsaved')).toBeTruthy()
    expect(aiSave(card).disabled).toBe(false)
    fireEvent.click(aiSave(card))

    expect(await screen.findByText('AI settings saved.')).toBeTruthy()
    expect(aiCalls('PATCH', AI).map((c) => c.body)).toEqual([{ keys: { google: KEY } }])
    await waitFor(() => expect(within(keyRow(card, 'google')).getByTestId('key-status').textContent).toBe('Saved ••••5678 · database'))
    expect(queryClient.getQueryData(AI_KEY_PATH)).toEqual(saved)
    expect((within(card).getByLabelText('Google API key') as HTMLInputElement).value).toBe('')
    expect(within(card).queryByTestId('ai-unsaved')).toBeNull()
    await waitFor(() => expect(aiCalls('GET', AI_AUDIT)).toHaveLength(2))
    expect(aiCalls('GET', AI)).toHaveLength(2)

    // The key is nowhere: not in the DOM, the query cache or the mutation cache.
    expect(document.body.innerHTML).not.toContain(KEY)
    expect(JSON.stringify(queryClient.getQueryCache().getAll().map((q) => q.state.data))).not.toContain(KEY)
    await waitFor(() =>
      expect(JSON.stringify(queryClient.getMutationCache().getAll().map((m) => m.state.variables ?? null))).not.toContain(KEY),
    )
  })

  it('clears a DB key only after confirming, and can undo before saving', async () => {
    const base = aiSettings()
    const cleared = aiSettings({
      configured: false,
      providers: {
        ...base.providers,
        openai: { ...base.providers.openai, key: { configured: false, source: 'none', last4: null, unreadable: false, updatedAt: null } },
      },
    })
    aiPatchHandler = () => {
      aiGetHandler = () => json(cleared)
      return json(cleared)
    }
    renderSettings()
    const card = await aiCard()

    fireEvent.click(within(card).getByRole('button', { name: 'Clear the OpenAI key' }))
    let dialog = await screen.findByRole('dialog', { name: 'Clear the OpenAI key?' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(within(card).queryByTestId('key-clear-pending')).toBeNull()

    fireEvent.click(within(card).getByRole('button', { name: 'Clear the OpenAI key' }))
    dialog = await screen.findByRole('dialog', { name: 'Clear the OpenAI key?' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Clear key' }))
    expect(await within(card).findByTestId('key-clear-pending')).toBeTruthy()
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    fireEvent.click(within(keyRow(card, 'openai')).getByRole('button', { name: 'Undo' }))
    expect(within(card).queryByTestId('key-clear-pending')).toBeNull()
    expect(aiSave(card).disabled).toBe(true)

    fireEvent.click(within(card).getByRole('button', { name: 'Clear the OpenAI key' }))
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Clear the OpenAI key?' })).getByRole('button', { name: 'Clear key' }))
    await within(card).findByTestId('key-clear-pending')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    fireEvent.click(aiSave(card))
    await waitFor(() => expect(within(keyRow(card, 'openai')).getByTestId('key-status').textContent).toBe('Not set'))
    expect(aiCalls('PATCH', AI).map((c) => c.body)).toEqual([{ keys: { openai: null } }])
  })

  it("switching provider shows that provider's model and saves only the provider", async () => {
    const switched = aiSettings({ provider: 'anthropic', model: 'claude-sonnet-4-5', modelSource: 'env' })
    aiPatchHandler = () => {
      aiGetHandler = () => json(switched)
      return json(switched)
    }
    renderSettings()
    const card = await aiCard()
    const model = within(card).getByLabelText('Model') as HTMLInputElement

    fireEvent.click(within(card).getByTestId('ai-provider-anthropic'))
    expect(within(card).getByTestId('ai-provider-anthropic').getAttribute('aria-checked')).toBe('true')
    expect(model.value).toBe('claude-sonnet-4-5')
    expect(within(card).getByTestId('ai-model-hint').textContent).toBe(
      'Anthropic uses claude-sonnet-4-5 (.env) · default claude-haiku-4-5',
    )
    const suggested = within(within(card).getByRole('group', { name: 'Suggested models' })).getAllByRole('button')
    expect(suggested.map((b) => b.textContent)).toEqual(['claude-haiku-4-5', 'claude-sonnet-4-5'])
    expect(suggested[1]?.getAttribute('aria-pressed')).toBe('true')

    // Arrow keys move through the radios.
    fireEvent.keyDown(within(card).getByTestId('ai-provider-anthropic'), { key: 'ArrowRight' })
    expect(model.value).toBe('gemini-2.5-flash-lite')
    fireEvent.keyDown(within(card).getByTestId('ai-provider-google'), { key: 'ArrowLeft' })
    expect(model.value).toBe('claude-sonnet-4-5')

    fireEvent.click(aiSave(card))
    await waitFor(() => expect(aiCalls('PATCH', AI)).toHaveLength(1))
    expect(aiCalls('PATCH', AI)[0]?.body).toEqual({ provider: 'anthropic' })
    await waitFor(() => expect(within(card).getByTestId('ai-active').textContent).toBe('In use: Anthropic database · claude-sonnet-4-5 .env'))
  })

  it('validates inline and sends nothing while invalid or unchanged', async () => {
    renderSettings()
    const card = await aiCard()
    const model = within(card).getByLabelText('Model')
    type(model, 'gpt 4')
    expect(within(card).getByText('Use printable characters without spaces.')).toBeTruthy()
    expect(aiSave(card).disabled).toBe(true)
    fireEvent.submit(aiSave(card).closest('form') as HTMLFormElement)
    type(model, 'gpt-4.1-mini')
    type(within(card).getByLabelText('OpenAI API key'), 'short')
    expect(within(keyRow(card, 'openai')).getByText('A key is 8–500 characters.')).toBeTruthy()
    expect(within(card).getByRole('button', { name: 'Test connection' })).toHaveProperty('disabled', true)
    type(within(card).getByLabelText('OpenAI API key'), '')
    expect(within(card).getByTestId('ai-save-error').textContent).toBe('No changes.')
    fireEvent.submit(aiSave(card).closest('form') as HTMLFormElement)
    expect(aiCalls('PATCH', AI)).toHaveLength(0)
  })

  it('shows a 400 message and keeps the draft', async () => {
    aiPatchHandler = () =>
      json({ statusCode: 400, message: ['model must be 1–100 printable characters without spaces'], error: 'Bad Request' }, 400)
    renderSettings()
    const card = await aiCard()
    type(within(card).getByLabelText('Model'), 'gpt-4o-mini')
    fireEvent.click(aiSave(card))
    const error = await within(card).findByRole('alert')
    expect(error.textContent).toBe('model must be 1–100 printable characters without spaces')
    expect((within(card).getByLabelText('Model') as HTMLInputElement).value).toBe('gpt-4o-mini')
    expect(aiCalls('PATCH', AI).map((c) => c.body)).toEqual([{ model: 'gpt-4o-mini' }])
  })

  it('maps 503 KEY_ENCRYPTION_NOT_CONFIGURED to the encryption message', async () => {
    aiPatchHandler = () =>
      json(
        {
          statusCode: 503,
          error: 'Service Unavailable',
          message: 'API keys cannot be saved: key encryption is not configured (TOKEN_ENCRYPTION_KEY)',
          code: 'KEY_ENCRYPTION_NOT_CONFIGURED',
        },
        503,
      )
    renderSettings()
    const card = await aiCard()
    type(within(card).getByLabelText('Anthropic API key'), KEY)
    fireEvent.click(aiSave(card))
    const error = await within(card).findByRole('alert')
    expect(error.textContent).toContain("API keys can't be saved here: key encryption is not configured")
    // The draft stays (still dirty); the settings are refetched to pick up cipherConfigured.
    expect((within(card).getByLabelText('Anthropic API key') as HTMLInputElement).value).toBe(KEY)
    await waitFor(() => expect(aiCalls('GET', AI)).toHaveLength(2))
  })

  it('Test connection sends the draft and shows ok + latency without saving or clearing it', async () => {
    const ok: AiConnectionTestResult = { ok: true, provider: 'anthropic', model: 'claude-haiku-4-5', latencyMs: 412 }
    aiTestHandler = () => json(ok)
    renderSettings()
    const card = await aiCard()
    fireEvent.click(within(card).getByTestId('ai-provider-anthropic'))
    type(within(card).getByLabelText('Model'), 'claude-haiku-4-5')
    type(within(card).getByLabelText('Anthropic API key'), KEY)
    fireEvent.click(within(card).getByRole('button', { name: 'Test connection' }))

    const result = await within(card).findByTestId('ai-test-result')
    await waitFor(() => expect(result.textContent).toBe('Connected · Anthropic · claude-haiku-4-5 · 412 ms'))
    expect(aiCalls('POST', AI_TEST).map((c) => c.body)).toEqual([
      { provider: 'anthropic', model: 'claude-haiku-4-5', apiKey: KEY },
    ])
    expect(aiCalls('PATCH', AI)).toHaveLength(0)
    expect((within(card).getByLabelText('Anthropic API key') as HTMLInputElement).value).toBe(KEY)
    expect(within(card).getByTestId('ai-unsaved')).toBeTruthy()
  })

  it('Test connection shows the failure kind and the scrubbed provider message', async () => {
    aiTestHandler = (body) =>
      json(
        (body as { provider?: string }).provider === 'google'
          ? ({ ok: false, kind: 'not_configured', latencyMs: 0, provider: 'google', model: 'gemini-2.5-flash-lite' } satisfies AiConnectionTestResult)
          : ({ ok: false, kind: 'auth', latencyMs: 230, provider: 'openai', model: 'gpt-4.1-mini', message: 'Incorrect API key provided: sk-***' } satisfies AiConnectionTestResult),
      )
    renderSettings()
    const card = await aiCard()

    fireEvent.click(within(card).getByRole('button', { name: 'Test connection' }))
    let result = await within(card).findByTestId('ai-test-kind')
    expect(result.textContent).toBe('The API key was rejected. Check that it is correct and still active.')
    expect(within(card).getByTestId('ai-test-message').textContent).toBe('Incorrect API key provided: sk-***')
    expect(within(card).getByTestId('ai-test-result').textContent).toContain('Connection failed · OpenAI · gpt-4.1-mini · 230 ms')

    fireEvent.click(within(card).getByTestId('ai-provider-google'))
    fireEvent.click(within(card).getByRole('button', { name: 'Test connection' }))
    await waitFor(() => expect(aiCalls('POST', AI_TEST)).toHaveLength(2))
    result = await within(card).findByTestId('ai-test-kind')
    await waitFor(() => expect(within(card).getByTestId('ai-test-kind').textContent).toContain('no API key'))
    expect(within(card).queryByTestId('ai-test-message')).toBeNull()
    expect(aiCalls('POST', AI_TEST).map((c) => c.body)).toEqual([{}, { provider: 'google' }])
  })

  it('asks before leaving with an unsaved AI draft (one dialog for plans and AI)', async () => {
    const { router } = renderSettings()
    const ai = await aiCard()
    type(within(ai).getByLabelText('Google API key'), KEY)

    act(() => void router.navigate({ to: '/admin/billing' }))
    let dialog = await screen.findByRole('dialog', { name: 'Leave without saving?' })
    expect(within(dialog).getByText('The AI provider settings have unsaved changes. They will be lost.')).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Stay' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect((within(ai).getByLabelText('Google API key') as HTMLInputElement).value).toBe(KEY)

    type(input(await card('Starter'), 'Original price'), '599')
    act(() => void router.navigate({ to: '/admin/billing' }))
    dialog = await screen.findByRole('dialog', { name: 'Leave without saving?' })
    expect(within(dialog).getAllByRole('heading')).toHaveLength(1)
    expect(within(dialog).getByText('One plan and the AI provider settings have unsaved changes. They will be lost.')).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Discard changes' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/admin/billing'))
  })

  it('shows the error state and recovers with Try again', async () => {
    aiGetHandler = () => json({ statusCode: 500, message: 'Settings store down' }, 500)
    renderSettings()
    const region = await screen.findByRole('region', { name: 'AI provider' })
    const alert = await within(region).findByRole('alert')
    expect(within(alert).getByText("Couldn't load the AI settings")).toBeTruthy()
    expect(within(alert).getByText('Settings store down')).toBeTruthy()
    aiGetHandler = () => json(aiSettings())
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }))
    expect(await aiCard()).toBeTruthy()
  })
})

describe('/admin/settings AI settings history', () => {
  function history() {
    return screen.findByRole('region', { name: 'AI settings history' })
  }
  function aiAuditEntry(n: number, patch: Partial<AiSettingsAuditEntry> = {}): AiSettingsAuditEntry {
    return {
      id: `019a0000-0000-7000-a000-${String(n).padStart(12, '0')}`,
      field: 'model',
      before: `model-${n}`,
      after: `model-${n + 1}`,
      admin: rootAdmin,
      ip: '203.0.113.7',
      userAgent: 'Mozilla/5.0',
      createdAt: '2026-11-19T06:00:00.000Z',
      ...patch,
    }
  }
  function aiAuditPage(items: AiSettingsAuditEntry[], url: URL, total = items.length): AiSettingsAuditList {
    return { items, total, skip: Number(url.searchParams.get('skip')), take: Number(url.searchParams.get('take')) }
  }

  it('lists field, before → after, admin and time with readable values', async () => {
    aiAuditHandler = (url) =>
      json(
        aiAuditPage(
          [
            aiAuditEntry(3, { field: 'provider', before: null, after: 'anthropic' }),
            aiAuditEntry(2, { field: 'model', before: 'gpt-4.1-mini', after: null }),
            aiAuditEntry(1, { field: 'key.openai', before: 'set', after: 'cleared', admin: { id: 'u2', name: ' ', email: 'ops@shield.bd' }, ip: null }),
            aiAuditEntry(0, { field: 'key.neon', before: null, after: 'set' }),
          ],
          url,
        ),
      )
    renderSettings()
    const panel = await history()
    const entries = await within(panel).findAllByTestId('ai-audit-entry')
    expect(
      entries.map((e) => [
        within(e).getByTestId('ai-audit-field').textContent,
        within(e).getByTestId('ai-audit-before').textContent,
        within(e).getByTestId('ai-audit-after').textContent,
      ]),
    ).toEqual([
      ['Provider', '.env / default', 'Anthropic'],
      ['Model', 'gpt-4.1-mini', '.env / default'],
      ['OpenAI API key', 'Set', 'Cleared'],
      ['Neon AI gateway API key', 'Not set', 'Set'],
    ])
    const [first, , third] = entries as [HTMLElement, HTMLElement, HTMLElement]
    expect(first.querySelector('time')?.textContent).toBe('19 Nov 2026, 12:00')
    expect(first.textContent).toContain('by Root Admin root@shield.bd · IP 203.0.113.7')
    expect(third.textContent).toContain('by ops@shield.bd ops@shield.bd')
    expect(within(panel).getByText('1–4 of 4 changes')).toBeTruthy()
  })

  it('pages 20 at a time and shows the empty state', async () => {
    aiAuditHandler = (url) => {
      const skip = Number(url.searchParams.get('skip'))
      return json(aiAuditPage(Array.from({ length: Math.min(20, 25 - skip) }, (_, i) => aiAuditEntry(skip + i)), url, 25))
    }
    renderSettings()
    const panel = await history()
    expect(await within(panel).findAllByTestId('ai-audit-entry')).toHaveLength(20)
    const nav = within(panel).getByRole('navigation', { name: 'AI settings history pages' })
    expect(within(nav).getByText('1–20 of 25 changes')).toBeTruthy()
    fireEvent.click(within(nav).getByRole('button', { name: 'Next page' }))
    expect(await within(panel).findByText('21–25 of 25 changes')).toBeTruthy()
    expect(within(panel).getAllByTestId('ai-audit-entry')).toHaveLength(5)
    expect(within(nav).getByRole('button', { name: 'Next page' })).toHaveProperty('disabled', true)
    const queries = fetchMock.mock.calls
      .map(([u]) => new URL(u, 'http://admin.localhost'))
      .filter((u) => u.pathname === AI_AUDIT)
      .map((u) => Object.fromEntries(u.searchParams))
    expect(queries).toEqual([
      { skip: '0', take: '20' },
      { skip: '20', take: '20' },
    ])
    // The plan history panel is separate and still there.
    expect(screen.getByRole('region', { name: 'Change history' })).toBeTruthy()
  })

  it('shows the empty state', async () => {
    renderSettings()
    const panel = await history()
    expect(await within(panel).findByRole('heading', { name: 'No AI settings changes yet' })).toBeTruthy()
    expect(within(panel).queryByRole('navigation')).toBeNull()
  })
})
