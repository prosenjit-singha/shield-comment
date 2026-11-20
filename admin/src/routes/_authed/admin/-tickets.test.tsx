import { QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TicketList, TicketListItem, TicketMessage, TicketThread } from '@/lib/admin-tickets'
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
const rootAdmin = { id: 'u1', name: 'Root Admin', email: 'root@shield.bd' }
const rahim = { id: 'c1', name: 'Rahim Uddin', email: 'rahim@acme.bd' }

const T1 = '0199b000-0000-7000-8000-000000000001'
const T2 = '0199b000-0000-7000-8000-000000000002'

const bkash: TicketListItem = {
  id: T1,
  subject: 'bKash payment not reflected',
  category: 'BILLING',
  priority: 'HIGH',
  status: 'OPEN',
  createdAt: '2026-11-17T04:00:00.000Z',
  updatedAt: '2026-11-17T05:00:00.000Z',
  workspace: { id: 'w1', name: 'Acme Fashion', plan: { slug: 'pro', name: 'Pro', prioritySupport: true } },
  requester: { ...rahim, role: 'owner' },
  lastMessageAt: '2026-11-17T05:00:00.000Z',
  messageCount: 2,
}
const meta: TicketListItem = {
  id: T2,
  subject: 'Facebook page disconnected',
  category: 'TECHNICAL',
  priority: 'LOW',
  status: 'RESOLVED',
  createdAt: '2026-11-10T04:00:00.000Z',
  updatedAt: '2026-11-11T04:00:00.000Z',
  workspace: { id: 'w2', name: 'Bazaar BD', plan: null },
  requester: { id: 'c2', name: 'Karim', email: 'karim@bazaar.bd', role: null },
  lastMessageAt: null,
  messageCount: 0,
}
const list: TicketList = { items: [bkash, meta], total: 2, skip: 0, take: 20 }

const clientMessage: TicketMessage = {
  id: 'm1',
  senderRole: 'CLIENT',
  sender: rahim,
  body: 'I paid ৳1,500 by bKash but my plan is still Free.',
  isInternalNote: false,
  createdAt: '2026-11-17T04:00:00.000Z',
  attachments: [],
}
const note: TicketMessage = {
  id: 'm2',
  senderRole: 'ADMIN',
  sender: rootAdmin,
  body: 'Checked the gateway: payment is pending on their side.',
  isInternalNote: true,
  createdAt: '2026-11-17T05:00:00.000Z',
  attachments: [],
}
const thread: TicketThread = { ...bkash, messages: [clientMessage, note] }

type Handler = (url: URL, init: RequestInit) => Response | Promise<Response>
const fetchMock = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>()
let handlers: Record<string, Handler>

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}
function apiError(status: number, message: string, code?: string) {
  return json({ statusCode: status, error: 'Error', message, code, path: '/api', timestamp: '' }, status)
}
/** A response the test resolves by hand (to look at the optimistic state in between). */
function deferred() {
  let resolve: (res: Response) => void = () => {}
  const promise = new Promise<Response>((r) => {
    resolve = r
  })
  return { promise, resolve }
}
const never = () => new Promise<Response>(() => {})

function calls(method: string, path: string) {
  return fetchMock.mock.calls
    .map(([input, init]) => ({
      url: new URL(input, 'http://admin.localhost'),
      method: init?.method ?? 'GET',
      body: init?.body,
    }))
    .filter((c) => c.method === method && c.url.pathname === path)
}
const listCalls = () => calls('GET', '/api/admin/tickets').map((c) => c.url.searchParams)
const lastListCall = () => listCalls().at(-1)
const bodyOf = (c: { body?: BodyInit | null } | undefined) => JSON.parse(String(c?.body))

/** Stop serving fresh data, so what is on screen can only come from the cache and the mutation. */
function freezeRefetches() {
  handlers['GET /api/admin/tickets'] = never
  handlers[`GET /api/admin/tickets/${T1}`] = never
}

function renderAt(path: string) {
  const queryClient = createQueryClient()
  const defaults = queryClient.getDefaultOptions()
  queryClient.setDefaultOptions({ ...defaults, queries: { ...defaults.queries, retry: false } })
  const router = createAppRouter(queryClient, createMemoryHistory({ initialEntries: [path] }))
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
  return { router, queryClient }
}

beforeEach(() => {
  auth.getSession.mockReset().mockResolvedValue(superAdmin)
  handlers = {
    'GET /api/admin/tickets': () => json(list),
    [`GET /api/admin/tickets/${T1}`]: () => json(thread),
  }
  fetchMock.mockReset().mockImplementation(async (input, init = {}) => {
    const url = new URL(input, 'http://admin.localhost')
    const handler = handlers[`${init.method ?? 'GET'} ${url.pathname}`]
    if (!handler) throw new Error(`unexpected fetch ${init.method ?? 'GET'} ${url.pathname}`)
    return handler(url, init)
  })
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const queue = () => within(screen.getByRole('list', { name: 'Tickets' }))
const queueRow = (subject: string) => {
  const link = queue().getByText(subject).closest('a')
  if (!link) throw new Error(`no row for ${subject}`)
  return within(link)
}
const conversation = () => within(screen.getByRole('region', { name: 'Conversation' }))

async function renderThread() {
  const result = renderAt(`/admin/tickets?ticket=${T1}`)
  await screen.findByRole('list', { name: 'Messages' })
  return result
}
const replyBox = () => conversation().getByLabelText(/^(Reply|Internal note)$/, { selector: 'textarea' })
const sendButton = () =>
  conversation().getByRole('button', { name: /Send reply|Add note|Sending/ }) as HTMLButtonElement

describe('/admin/tickets queue', () => {
  it('lists tickets from GET /api/admin/tickets with the row details', async () => {
    renderAt('/admin/tickets')
    expect(await screen.findByText('bKash payment not reflected')).toBeTruthy()
    expect(screen.getByRole('heading', { level: 1, name: 'Tickets' })).toBeTruthy()
    const params = lastListCall()
    expect(params?.get('skip')).toBe('0')
    expect(params?.get('take')).toBe('20')
    expect(['status', 'priority', 'category', 'q'].some((k) => params?.has(k))).toBe(false)

    const row = queueRow('bKash payment not reflected')
    expect(row.getByText('Acme Fashion · Rahim Uddin')).toBeTruthy()
    expect(row.getByTestId('ticket-status').textContent).toBe('Open')
    expect(row.getByLabelText('Priority: High')).toBeTruthy()
    expect(row.getByLabelText('2 messages')).toBeTruthy()
    // Last activity = lastMessageAt, else createdAt (Dhaka dates).
    expect(row.getByText('17 Nov').getAttribute('datetime')).toBe(bkash.lastMessageAt)
    expect(queueRow('Facebook page disconnected').getByText('10 Nov').getAttribute('datetime')).toBe(
      meta.createdAt,
    )
    expect(queueRow('Facebook page disconnected').getByTestId('ticket-status').textContent).toBe('Resolved')
    expect(screen.getByText('1–2 of 2 tickets')).toBeTruthy()
    expect(screen.getByText('Pick a ticket')).toBeTruthy()
  })

  it('maps status, priority, category and the debounced search to the URL and API params', async () => {
    const { router } = renderAt('/admin/tickets?page=2')
    await screen.findByText('bKash payment not reflected')
    expect(lastListCall()?.get('skip')).toBe('20')

    fireEvent.mouseDown(screen.getByRole('tab', { name: 'In progress' }), { button: 0 })
    await waitFor(() => expect(router.state.location.search).toEqual({ status: 'IN_PROGRESS' }))
    await waitFor(() => expect(lastListCall()?.get('status')).toBe('IN_PROGRESS'))
    expect(lastListCall()?.get('skip')).toBe('0') // a filter change resets the page

    fireEvent.keyDown(screen.getByRole('button', { name: 'Priority: All' }), { key: 'Enter' })
    fireEvent.click(await screen.findByRole('menuitemradio', { name: 'High' }))
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
    await waitFor(() => expect(lastListCall()?.get('priority')).toBe('HIGH'))

    fireEvent.keyDown(screen.getByRole('button', { name: 'Category: All' }), { key: 'Enter' })
    fireEvent.click(await screen.findByRole('menuitemradio', { name: 'Billing' }))
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
    await waitFor(() => expect(lastListCall()?.get('category')).toBe('BILLING'))

    const sent = listCalls().length
    fireEvent.change(screen.getByLabelText('Search tickets'), { target: { value: '  bkash ' } })
    expect(listCalls()).toHaveLength(sent) // nothing while typing
    await waitFor(() => expect(lastListCall()?.get('q')).toBe('bkash'))
    expect(router.state.location.search).toEqual({
      status: 'IN_PROGRESS',
      priority: 'HIGH',
      category: 'BILLING',
      q: 'bkash',
    })

    fireEvent.click(screen.getAllByRole('button', { name: /Clear/ })[0]!)
    await waitFor(() => expect(router.state.location.search).toEqual({}))
  })

  it.each([
    '/admin/tickets?page=abc',
    '/admin/tickets?page=-1',
    '/admin/tickets?page=2.5&q=%20%20',
    '/admin/tickets?status=BOGUS&priority=urgent&category=billing',
    '/admin/tickets?ticket=not-a-uuid',
    '/admin/tickets?page=abc&status=BOGUS&ticket=nope',
  ])('falls back to the defaults for malformed params: %s', async (path) => {
    const { router, queryClient } = renderAt(path)
    expect(await screen.findByText('bKash payment not reflected')).toBeTruthy()
    // Only the default list request goes out: no NaN skip, no bogus filter, no thread fetch.
    expect(listCalls().map((p) => p.toString())).toEqual(['skip=0&take=20'])
    expect(fetchMock.mock.calls.every(([input]) => !String(input).includes('/admin/tickets/'))).toBe(true)
    const keys = queryClient.getQueryCache().findAll({ queryKey: ['admin', 'tickets'] }).map((q) => q.queryKey)
    expect(keys).toEqual([['admin', 'tickets', 'list', 'skip=0&take=20']])
    expect(router.state.location.search).toEqual({})
    expect(screen.getByRole('tab', { name: 'All' }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByRole('button', { name: 'Priority: All' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Category: All' })).toBeTruthy()
    expect((screen.getByLabelText('Search tickets') as HTMLInputElement).value).toBe('')
    expect(screen.getByText('Pick a ticket')).toBeTruthy()
  })

  it('shows a filtered empty state and the unfiltered one', async () => {
    handlers['GET /api/admin/tickets'] = (url) =>
      json(url.searchParams.has('status') ? { items: [], total: 0, skip: 0, take: 20 } : list)
    const { router } = renderAt('/admin/tickets?status=RESOLVED')
    expect(await screen.findByText('No tickets match these filters')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }))
    await waitFor(() => expect(router.state.location.search).toEqual({}))
    expect(await screen.findByText('bKash payment not reflected')).toBeTruthy()

    cleanup()
    handlers['GET /api/admin/tickets'] = () => json({ items: [], total: 0, skip: 0, take: 20 })
    renderAt('/admin/tickets')
    expect(await screen.findByText('No support tickets yet')).toBeTruthy()
  })

  it('shows an error state with Try again', async () => {
    handlers['GET /api/admin/tickets'] = () => apiError(500, 'Internal server error')
    renderAt('/admin/tickets')
    const alert = await screen.findByRole('alert')
    expect(within(alert).getByText("Couldn't load tickets")).toBeTruthy()
    handlers['GET /api/admin/tickets'] = () => json(list)
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }))
    expect(await screen.findByText('bKash payment not reflected')).toBeTruthy()
  })
})

describe('thread', () => {
  it('opens the selected ticket from the queue: messages oldest first, internal notes marked', async () => {
    const { router } = renderAt('/admin/tickets')
    fireEvent.click(await screen.findByText('bKash payment not reflected'))
    await waitFor(() => expect(router.state.location.search).toEqual({ ticket: T1 }))
    const messages = await screen.findByRole('list', { name: 'Messages' })
    expect(calls('GET', `/api/admin/tickets/${T1}`)).toHaveLength(1)

    const items = within(messages).getAllByRole('listitem')
    expect(items.map((li) => li.getAttribute('aria-label'))).toEqual([
      'Message from Rahim Uddin',
      'Internal note from Root Admin',
    ])
    expect(items[0]!.textContent).toContain(clientMessage.body)
    expect(items[0]!.hasAttribute('data-internal-note')).toBe(false)
    expect(items[1]!.getAttribute('data-internal-note')).toBe('true')
    expect(within(items[1]!).getByText('Internal note · only admins see this')).toBeTruthy()

    expect(conversation().getByRole('heading', { name: 'bKash payment not reflected' })).toBeTruthy()
    expect(conversation().getByRole('button', { name: 'Status: Open' })).toBeTruthy()
    expect(queue().getByText('bKash payment not reflected').closest('a')?.getAttribute('aria-current')).toBe(
      'page',
    )
    expect(queue().getByText('Facebook page disconnected').closest('a')?.hasAttribute('aria-current')).toBe(
      false,
    )
  })

  it('shows a not-found state for an unknown ticket', async () => {
    handlers[`GET /api/admin/tickets/${T2}`] = () => apiError(404, 'Ticket not found')
    renderAt(`/admin/tickets?ticket=${T2}`)
    expect(await screen.findByText('This ticket no longer exists')).toBeTruthy()
    expect(conversation().getByRole('link', { name: 'Back to queue' })).toBeTruthy()
  })
})

describe('reply box', () => {
  it('sends a trimmed public reply, shows it at once, then takes IN_PROGRESS from the response', async () => {
    const post = deferred()
    handlers[`POST /api/admin/tickets/${T1}/reply`] = () => post.promise
    await renderThread()
    freezeRefetches() // the status below can only come from the reply response

    fireEvent.change(replyBox(), { target: { value: '  We are checking with bKash now.  ' } })
    fireEvent.click(sendButton())

    await waitFor(() => expect(calls('POST', `/api/admin/tickets/${T1}/reply`)).toHaveLength(1))
    expect(bodyOf(calls('POST', `/api/admin/tickets/${T1}/reply`)[0])).toEqual({
      body: 'We are checking with bKash now.',
      isInternalNote: false,
    })
    // Optimistic: in the thread before the server answered, box cleared. The status is not
    // flipped optimistically (only the first public admin reply moves it, M2-T14).
    const pending = await screen.findByRole('listitem', { name: 'Message from Root Admin' })
    expect(within(pending).getByText('Sending…')).toBeTruthy()
    expect((replyBox() as HTMLTextAreaElement).value).toBe('')
    expect(conversation().getByRole('button', { name: 'Status: Open' })).toBeTruthy()

    const message: TicketMessage = {
      id: 'm3',
      senderRole: 'ADMIN',
      sender: rootAdmin,
      body: 'We are checking with bKash now.',
      isInternalNote: false,
      createdAt: '2026-11-18T06:00:00.000Z',
      attachments: [],
    }
    const ticket = { ...bkash, status: 'IN_PROGRESS', messageCount: 3, lastMessageAt: message.createdAt }
    post.resolve(json({ message, ticket }, 201))

    expect(await conversation().findByRole('button', { name: 'Status: In progress' })).toBeTruthy()
    expect(queueRow('bKash payment not reflected').getByTestId('ticket-status').textContent).toBe(
      'In progress',
    )
    expect(await screen.findByText('Reply sent.')).toBeTruthy()
    expect(screen.getByText('Status moved to In progress.')).toBeTruthy()
    expect(screen.queryByText('Sending…')).toBeNull()
    expect(screen.getAllByRole('listitem', { name: /from Root Admin/ })).toHaveLength(2)
  })

  it('hint: the first public reply on an OPEN ticket moves it; notes never do', async () => {
    await renderThread()
    expect(
      conversation().getByText('The client sees this. The first reply moves the ticket to In progress.'),
    ).toBeTruthy()
    fireEvent.click(conversation().getByRole('switch'))
    expect(conversation().getByText('Only admins see notes. The status stays the same.')).toBeTruthy()
  })

  it('an OPEN ticket that already had a public admin reply stays OPEN on the next reply (M2-T14)', async () => {
    const earlier: TicketMessage = {
      id: 'm0',
      senderRole: 'ADMIN',
      sender: rootAdmin,
      body: 'Looking into it.',
      isInternalNote: false,
      createdAt: '2026-11-17T04:30:00.000Z',
      attachments: [],
    }
    handlers[`GET /api/admin/tickets/${T1}`] = () =>
      json({ ...thread, messageCount: 3, messages: [clientMessage, earlier, note] })
    handlers[`POST /api/admin/tickets/${T1}/reply`] = () =>
      json(
        {
          message: { ...earlier, id: 'm5', body: 'Any update?', createdAt: '2026-11-18T06:00:00.000Z' },
          ticket: { ...bkash, messageCount: 4, lastMessageAt: '2026-11-18T06:00:00.000Z' },
        },
        201,
      )
    await renderThread()
    expect(conversation().getByText('The client sees this reply. The status stays the same.')).toBeTruthy()
    // Sonner toasts outlive tests: compare counts instead of asserting absence.
    const sent = screen.queryAllByText('Reply sent.').length
    const moved = screen.queryAllByText('Status moved to In progress.').length
    fireEvent.change(replyBox(), { target: { value: 'Any update?' } })
    fireEvent.click(sendButton())

    await waitFor(() => expect(screen.queryAllByText('Reply sent.')).toHaveLength(sent + 1))
    expect(screen.queryAllByText('Status moved to In progress.')).toHaveLength(moved)
    expect(conversation().getByRole('button', { name: 'Status: Open' })).toBeTruthy()
  })

  it('sends an internal note with isInternalNote: true and keeps the status', async () => {
    handlers[`POST /api/admin/tickets/${T1}/reply`] = (_url, init) => {
      const { body } = JSON.parse(String(init.body)) as { body: string }
      return json(
        {
          message: { ...note, id: 'm4', body, createdAt: '2026-11-18T06:00:00.000Z' },
          ticket: { ...bkash, messageCount: 3 },
        },
        201,
      )
    }
    await renderThread()
    fireEvent.click(conversation().getByRole('switch'))
    expect(conversation().getByRole('button', { name: 'Add note' })).toBeTruthy()
    fireEvent.change(replyBox(), { target: { value: 'Escalated to finance' } })
    fireEvent.click(sendButton())

    await waitFor(() => expect(calls('POST', `/api/admin/tickets/${T1}/reply`)).toHaveLength(1))
    expect(bodyOf(calls('POST', `/api/admin/tickets/${T1}/reply`)[0])).toEqual({
      body: 'Escalated to finance',
      isInternalNote: true,
    })
    expect(await screen.findByText('Internal note added.')).toBeTruthy()
    expect(conversation().getByRole('button', { name: 'Status: Open' })).toBeTruthy()
  })

  it('blocks a blank or 5001-character body', async () => {
    await renderThread()
    expect(sendButton().disabled).toBe(true)

    fireEvent.change(replyBox(), { target: { value: '    ' } })
    expect(sendButton().disabled).toBe(true)
    fireEvent.submit(replyBox().closest('form')!)
    expect(conversation().getByRole('alert').textContent).toBe('Write a message first.')

    fireEvent.change(replyBox(), { target: { value: `  ${'x'.repeat(5001)}  ` } })
    expect(sendButton().disabled).toBe(true)
    expect(conversation().getByRole('alert').textContent).toMatch(/5000 characters/)
    expect(conversation().getByText('5001/5000')).toBeTruthy()
    fireEvent.keyDown(replyBox(), { key: 'Enter', ctrlKey: true })

    // Exactly 5000 after trimming is fine.
    fireEvent.change(replyBox(), { target: { value: ` ${'x'.repeat(5000)} ` } })
    expect(sendButton().disabled).toBe(false)
    expect(calls('POST', `/api/admin/tickets/${T1}/reply`)).toHaveLength(0)
  })

  it.each([
    [400, 'body must be shorter than or equal to 5000 characters', 'The reply was rejected.'],
    [404, 'Ticket not found', 'This ticket no longer exists.'],
  ])('rolls back the optimistic message and toasts a %i', async (status, message, toastText) => {
    const post = deferred()
    handlers[`POST /api/admin/tickets/${T1}/reply`] = () => post.promise
    await renderThread()
    freezeRefetches()

    fireEvent.change(replyBox(), { target: { value: 'Hello' } })
    fireEvent.click(sendButton())
    expect(await screen.findByRole('listitem', { name: 'Message from Root Admin' })).toBeTruthy()

    post.resolve(apiError(status, message))
    expect(await screen.findByText(toastText)).toBeTruthy()
    await waitFor(() => expect(screen.queryByRole('listitem', { name: 'Message from Root Admin' })).toBeNull())
    expect(screen.getAllByRole('listitem', { name: /^(Message|Internal note) from/ })).toHaveLength(2)
    expect((replyBox() as HTMLTextAreaElement).value).toBe('Hello') // draft given back
  })
})

describe('status menu', () => {
  async function pickStatus(current: string, next: string) {
    fireEvent.keyDown(conversation().getByRole('button', { name: `Status: ${current}` }), { key: 'Enter' })
    fireEvent.click(await screen.findByRole('menuitemradio', { name: next }))
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
  }

  it('PATCHes { status }, shows it at once and toasts the change', async () => {
    const patch = deferred()
    handlers[`PATCH /api/admin/tickets/${T1}/status`] = () => patch.promise
    await renderThread()
    freezeRefetches()

    await pickStatus('Open', 'Resolved')
    await waitFor(() => expect(calls('PATCH', `/api/admin/tickets/${T1}/status`)).toHaveLength(1))
    expect(bodyOf(calls('PATCH', `/api/admin/tickets/${T1}/status`)[0])).toEqual({ status: 'RESOLVED' })
    // Optimistic, in the thread and in the queue.
    expect(await conversation().findByRole('button', { name: 'Status: Resolved' })).toBeTruthy()
    expect(queueRow('bKash payment not reflected').getByTestId('ticket-status').textContent).toBe('Resolved')

    patch.resolve(json({ ticket: { ...bkash, status: 'RESOLVED' }, changed: true }))
    expect(await screen.findByText('Marked as resolved.')).toBeTruthy()
  })

  it('reopens a resolved ticket', async () => {
    handlers[`GET /api/admin/tickets/${T1}`] = () => json({ ...thread, status: 'RESOLVED' })
    handlers[`PATCH /api/admin/tickets/${T1}/status`] = () =>
      json({ ticket: { ...bkash, status: 'OPEN' }, changed: true })
    await renderThread()
    await pickStatus('Resolved', 'Reopen')
    await waitFor(() =>
      expect(bodyOf(calls('PATCH', `/api/admin/tickets/${T1}/status`)[0])).toEqual({ status: 'OPEN' }),
    )
    expect(await screen.findByText('Ticket reopened.')).toBeTruthy()
  })

  it('does not toast changed: false as a change', async () => {
    handlers[`PATCH /api/admin/tickets/${T1}/status`] = () =>
      json({ ticket: { ...bkash, status: 'IN_PROGRESS' }, changed: false })
    await renderThread()
    await pickStatus('Open', 'In progress')
    expect(await screen.findByText('Already in progress. Nothing changed.')).toBeTruthy()
    expect(screen.queryByText('Marked as in progress.')).toBeNull()
    expect(calls('PATCH', `/api/admin/tickets/${T1}/status`)).toHaveLength(1)
  })

  it('does not send the status already on screen', async () => {
    await renderThread()
    await pickStatus('Open', 'Open')
    expect(calls('PATCH', `/api/admin/tickets/${T1}/status`)).toHaveLength(0)
  })

  it.each([
    [400, 'status must be one of the following values: OPEN, IN_PROGRESS, RESOLVED', 'The status change was rejected.'],
    [404, 'Ticket not found', 'This ticket no longer exists.'],
  ])('rolls back and toasts a %i', async (status, message, toastText) => {
    const patch = deferred()
    handlers[`PATCH /api/admin/tickets/${T1}/status`] = () => patch.promise
    await renderThread()
    freezeRefetches()

    await pickStatus('Open', 'Resolved')
    expect(await conversation().findByRole('button', { name: 'Status: Resolved' })).toBeTruthy()
    patch.resolve(apiError(status, message))

    expect(await screen.findByText(toastText)).toBeTruthy()
    expect(await conversation().findByRole('button', { name: 'Status: Open' })).toBeTruthy()
    expect(queueRow('bKash payment not reflected').getByTestId('ticket-status').textContent).toBe('Open')
  })
})

describe('attachments, priority support, requester role + plan (M7-T10)', () => {
  const image = (name: string, type = 'image/png', size = 2048) => {
    const file = new File(['x'], name, { type })
    Object.defineProperty(file, 'size', { value: size })
    return file
  }
  const filesInput = () => conversation().getByTestId('reply-files') as HTMLInputElement
  const pick = (...files: File[]) => fireEvent.change(filesInput(), { target: { files } })
  const previews = () => within(conversation().getByRole('list', { name: 'Images to send' })).getAllByRole('img')
  const pickerButton = () => conversation().getByRole('button', { name: /^Images \d\/3$/ }) as HTMLButtonElement

  it('marks priority-support workspaces in the queue, apart from the priority', async () => {
    renderAt('/admin/tickets')
    await screen.findByText('bKash payment not reflected')
    const pro = queueRow('bKash payment not reflected')
    expect(pro.getByText('Priority support').closest('span')?.getAttribute('title')).toBe(
      'Pro plan: priority support',
    )
    expect(pro.getByLabelText('Priority: High')).toBeTruthy()
    expect(queueRow('Facebook page disconnected').queryByText('Priority support')).toBeNull()
  })

  it("shows the requester's role and the workspace's live plan in the thread header", async () => {
    await renderThread()
    const header = within(conversation().getByRole('banner'))
    expect(header.getByText('Owner')).toBeTruthy()
    expect(header.getByText('Pro plan')).toBeTruthy()
    expect(header.getByText('Priority support')).toBeTruthy()
    cleanup()

    handlers[`GET /api/admin/tickets/${T2}`] = () => json({ ...meta, messages: [] })
    renderAt(`/admin/tickets?ticket=${T2}`)
    expect(await screen.findByText('No longer a member')).toBeTruthy()
    const gone = within(conversation().getByRole('banner'))
    expect(gone.getByText('No plan')).toBeTruthy()
    expect(gone.queryByText('Priority support')).toBeNull()
  })

  it('shows thumbnails that open full size, and a placeholder when the URL is null', async () => {
    const url = 'https://storage.test/tickets/a.png?sig=1'
    handlers[`GET /api/admin/tickets/${T1}`] = () =>
      json({
        ...thread,
        messages: [
          {
            ...clientMessage,
            attachments: [
              { id: 'a1', contentType: 'image/png', sizeBytes: 1000, url },
              { id: 'a2', contentType: 'image/webp', sizeBytes: 2000, url: null },
            ],
          },
          note,
        ],
      })
    await renderThread()
    const attachments = within(screen.getByRole('list', { name: 'Attachments' }))
    const link = attachments.getByRole('link', { name: 'Image 1 (opens full size)' })
    expect(link.getAttribute('href')).toBe(url)
    expect(link.getAttribute('target')).toBe('_blank')
    expect(link.getAttribute('rel')).toBe('noopener noreferrer')
    // Fixed size: no layout jump while it loads.
    const img = within(link).getByRole('img')
    expect([img.getAttribute('width'), img.getAttribute('height')]).toEqual(['96', '96'])
    expect(attachments.getByText('File unavailable')).toBeTruthy()
    expect(attachments.getAllByRole('link')).toHaveLength(1)
  })

  it('checks picked images like the backend: type, 5 MB, at most 3; previews can be removed', async () => {
    await renderThread()
    pick(image('scam.gif', 'image/gif'))
    expect(conversation().getByRole('alert').textContent).toBe('Only PNG, JPEG or WebP images can be attached')
    expect(conversation().queryByRole('list', { name: 'Images to send' })).toBeNull()

    pick(image('huge.png', 'image/png', 5 * 1024 * 1024 + 1))
    expect(conversation().getByRole('alert').textContent).toBe('Each image must be 5 MB or smaller')

    pick(image('1.png'), image('2.jpg', 'image/jpeg'), image('3.webp', 'image/webp'), image('4.png'))
    expect(conversation().getByRole('alert').textContent).toBe('Attach at most 3 images per message')
    expect(previews().map((img) => img.getAttribute('alt'))).toEqual(['1.png', '2.jpg', '3.webp'])
    expect(pickerButton().disabled).toBe(true)
    expect(pickerButton().textContent).toContain('Images 3/3')

    fireEvent.click(conversation().getByRole('button', { name: 'Remove image 2 (2.jpg)' }))
    expect(previews().map((img) => img.getAttribute('alt'))).toEqual(['1.png', '3.webp'])
    expect(pickerButton().disabled).toBe(false)
    expect(conversation().queryByRole('alert')).toBeNull()
    expect(calls('POST', `/api/admin/tickets/${T1}/reply`)).toHaveLength(0)
  })

  it('sends multipart/form-data (files + body + isInternalNote) and clears the images', async () => {
    const message: TicketMessage = {
      id: 'm6',
      senderRole: 'ADMIN',
      sender: rootAdmin,
      body: 'See the screenshots',
      isInternalNote: true,
      createdAt: '2026-11-18T06:00:00.000Z',
      attachments: [{ id: 'a9', contentType: 'image/png', sizeBytes: 2048, url: 'https://storage.test/b.png' }],
    }
    handlers[`POST /api/admin/tickets/${T1}/reply`] = () => json({ message, ticket: { ...bkash, messageCount: 3 } }, 201)
    await renderThread()
    freezeRefetches() // the thumbnail below can only come from the reply response
    const one = image('one.png')
    const two = image('two.jpg', 'image/jpeg')
    pick(one, two)
    fireEvent.click(conversation().getByRole('switch'))
    fireEvent.change(replyBox(), { target: { value: ' See the screenshots ' } })
    fireEvent.click(sendButton())

    await waitFor(() => expect(calls('POST', `/api/admin/tickets/${T1}/reply`)).toHaveLength(1))
    const [, init] = fetchMock.mock.calls.find(([, i]) => i?.method === 'POST')!
    const form = init?.body
    expect(form).toBeInstanceOf(FormData)
    const data = form as FormData
    expect(data.get('body')).toBe('See the screenshots')
    expect(data.get('isInternalNote')).toBe('true')
    expect(data.getAll('files').map((f) => (f as File).name)).toEqual(['one.png', 'two.jpg'])
    // The browser sets the multipart boundary; a JSON Content-Type would break it.
    expect(new Headers(init?.headers).has('Content-Type')).toBe(false)

    // The server's message brings its thumbnail; the box is emptied.
    expect(await screen.findByRole('link', { name: 'Image 1 (opens full size)' })).toBeTruthy()
    expect(conversation().queryByRole('list', { name: 'Images to send' })).toBeNull()
  })

  it('409 ATTACHMENTS_UNAVAILABLE hides the picker with a note and keeps the draft', async () => {
    handlers[`POST /api/admin/tickets/${T1}/reply`] = () =>
      apiError(409, 'Attachments are not available right now', 'ATTACHMENTS_UNAVAILABLE')
    await renderThread()
    pick(image('proof.png'))
    fireEvent.change(replyBox(), { target: { value: 'Here is the proof' } })
    fireEvent.click(sendButton())

    const note409 = "Image uploads are off: file storage isn't set up. Send it without images."
    expect(await screen.findByText('The reply was rejected.')).toBeTruthy()
    await waitFor(() => expect(conversation().getByText(note409)).toBeTruthy())
    expect(conversation().queryByRole('button', { name: /^Images/ })).toBeNull()
    expect(conversation().queryByTestId('reply-files')).toBeNull()
    expect(conversation().queryByRole('list', { name: 'Images to send' })).toBeNull()
    expect((replyBox() as HTMLTextAreaElement).value).toBe('Here is the proof')
  })

  it.each([
    ['ATTACHMENT_TOO_LARGE', 'Each image must be 5 MB or smaller'],
    ['ATTACHMENT_TYPE_INVALID', 'Only PNG, JPEG or WebP images can be attached'],
  ])('a 400 %s is toasted with its message and keeps the images', async (code, text) => {
    handlers[`POST /api/admin/tickets/${T1}/reply`] = () => apiError(400, text, code)
    await renderThread()
    pick(image('a.png'))
    fireEvent.change(replyBox(), { target: { value: `Retry ${code}` } })
    fireEvent.click(sendButton())
    await waitFor(() => expect(screen.getAllByText(text).length).toBeGreaterThan(0))
    expect(previews()).toHaveLength(1)
    expect(pickerButton()).toBeTruthy()
  })
})
