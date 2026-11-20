import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  IMPERSONATED,
  NEW_TICKET_ID,
  replyUrl,
  renderAppRoute,
  type SentMessage,
  SESSION,
  stubAppGlobals,
  summaryApi,
  ticket,
  ticketMessage,
  TICKETS,
  ticketsApi,
  type TicketsApiOptions,
  ticketUrl,
} from '@/test/app-routes'
import { callsTo, json, fetchMock, mockApi } from '@/test/auth-routes'
import type { TicketDetail } from '@/lib/support-tickets'

// The server-render session function needs the Start compiler; the browser path never calls it.
vi.mock('@/server/session', () => ({ getServerSession: vi.fn() }))

// M7-T12: C13 `/support` (Module 7 D1–D5).

const copy = {
  en: {
    newTicket: 'New ticket',
    empty: 'No tickets yet. Open one when you need help.',
    open: 'Open',
    inProgress: 'In progress',
    resolved: 'Resolved',
    newReply: 'New reply',
    technical: 'Technical',
    billing: 'Billing',
    category: 'Category',
    subject: 'Subject',
    message: 'Message',
    send: 'Send ticket',
    cancel: 'Cancel',
    pickCategory: 'Pick a category.',
    addSubject: 'Add a subject.',
    writeMessage: 'Write a message first.',
    addScreenshot: 'Add screenshot',
    tooMany: 'Attach at most 3 images per message.',
    tooLarge: 'Each image must be 5 MB or smaller.',
    badType: 'Only PNG, JPEG or WebP images can be attached.',
    unavailable: 'Screenshots can’t be uploaded right now.',
    limit: 'This workspace already has 20 open tickets.',
    readOnlyError: 'so you can read tickets but not write them.',
    gone: 'This ticket no longer exists.',
    server: 'The server is unavailable right now.',
    loadFailed: 'Couldn’t load your tickets',
    readOnly: 'You’re signed in as this client by support.',
    support: 'Support',
    allTickets: 'All tickets',
    reply: 'Your reply',
    sendReply: 'Send reply',
    reopens: 'This ticket is resolved. Replying opens it again.',
    unavailableImage: 'Image unavailable',
    shot: (n: number) => `Screenshot ${n} (opens full size)`,
  },
  bn: {
    newTicket: 'নতুন টিকিট',
    empty: 'এখনো কোনো টিকিট নেই। সাহায্য দরকার হলে একটি টিকিট খুলুন।',
    open: 'খোলা',
    inProgress: 'চলমান',
    resolved: 'সমাধান হয়েছে',
    newReply: 'নতুন উত্তর',
    technical: 'টেকনিক্যাল',
    billing: 'বিলিং',
    category: 'ক্যাটাগরি',
    subject: 'বিষয়',
    message: 'মেসেজ',
    send: 'টিকিট পাঠান',
    cancel: 'বাতিল',
    pickCategory: 'একটি ক্যাটাগরি বেছে নিন।',
    addSubject: 'একটি বিষয় লিখুন।',
    writeMessage: 'আগে একটি মেসেজ লিখুন।',
    addScreenshot: 'স্ক্রিনশট যোগ করুন',
    tooMany: 'প্রতি মেসেজে সর্বোচ্চ ৩টি ছবি যোগ করুন।',
    tooLarge: 'প্রতিটি ছবি ৫ MB বা তার কম হতে হবে।',
    badType: 'শুধু PNG, JPEG বা WebP ছবি যোগ করা যায়।',
    unavailable: 'এই মুহূর্তে স্ক্রিনশট আপলোড করা যাচ্ছে না।',
    limit: 'এই ওয়ার্কস্পেসে আগে থেকেই ২০টি খোলা টিকিট আছে।',
    readOnlyError: 'টিকিট পড়তে পারবেন কিন্তু লিখতে পারবেন না।',
    gone: 'এই টিকিটটি আর নেই।',
    server: 'সার্ভার এই মুহূর্তে পাওয়া যাচ্ছে না।',
    loadFailed: 'আপনার টিকিট লোড করা যায়নি',
    readOnly: 'আপনি সাপোর্ট থেকে এই ক্লায়েন্ট হিসেবে লগ ইন করেছেন।',
    support: 'সাপোর্ট',
    allTickets: 'সব টিকিট',
    reply: 'আপনার উত্তর',
    sendReply: 'উত্তর পাঠান',
    reopens: 'এই টিকিটটি সমাধান হয়েছে। উত্তর দিলে এটি আবার খুলবে।',
    unavailableImage: 'ছবি পাওয়া যাচ্ছে না',
    shot: (n: number) => `স্ক্রিনশট ${n} (পূর্ণ আকারে খোলে)`,
  },
} as const

const T1 = ticket()
const T2 = ticket({
  id: '9a6c1d2e-0000-4000-8000-000000000002',
  subject: 'Invoice question',
  category: 'BILLING',
  status: 'IN_PROGRESS',
  requester: { id: 'u2', name: 'Karim (moderator)' },
  hasNewReply: true,
})
const T3 = ticket({ id: '9a6c1d2e-0000-4000-8000-000000000003', subject: 'Old issue', status: 'RESOLVED' })

const setup = (items: TicketDetail[] = [], options: TicketsApiOptions = {}, session: unknown = SESSION) =>
  mockApi({ '/api/auth/get-session': () => json(200, session), ...summaryApi(), ...ticketsApi(items, options) })

const png = (name = 'shot.png', size?: number) => {
  const file = new File(['png'], name, { type: 'image/png' })
  if (size !== undefined) Object.defineProperty(file, 'size', { value: size })
  return file
}
const pick = (...files: File[]) => fireEvent.change(screen.getByTestId('ticket-files'), { target: { files } })
const rows = () => within(screen.getByRole('list', { name: /Tickets|টিকিট/ })).getAllByRole('button')
const sent = (path: string) => callsTo(path).filter((call) => call.method === 'POST')

let blobs = 0
beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  stubAppGlobals()
  URL.createObjectURL = vi.fn(() => `blob:preview-${++blobs}`)
  URL.revokeObjectURL = vi.fn()
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe.each(['en', 'bn'] as const)('M7-T12 /support (%s)', (language) => {
  const t = copy[language]

  describe('list', () => {
    it('shows status pills, the New reply badge (D5) and the requester for every ticket the API returns (owner, D1)', async () => {
      setup([T1, T2, T3])
      renderAppRoute('/support', language)
      await screen.findByText('Invoice question')
      const [first, second, third] = rows()
      expect(within(first!).getByText(t.open)).toBeTruthy()
      expect(within(first!).queryByText(t.newReply)).toBeNull()
      expect(within(second!).getByText(t.inProgress)).toBeTruthy()
      expect(within(second!).getByText(t.newReply)).toBeTruthy()
      expect(within(second!).getByText(t.billing)).toBeTruthy()
      expect(second!.textContent).toContain('Karim (moderator)')
      expect(within(third!).getByText(t.resolved)).toBeTruthy()
      expect(screen.getAllByTestId('new-reply')).toHaveLength(1)
      expect(callsTo(TICKETS)[0]?.method).toBe('GET')
    })

    it('a moderator sees only what the API returns (their own, D1)', async () => {
      setup([T2])
      renderAppRoute('/support', language)
      await screen.findByText('Invoice question')
      expect(rows()).toHaveLength(1)
    })

    it('empty list → empty state + New ticket button', async () => {
      setup()
      renderAppRoute('/support', language)
      expect(await screen.findByText(t.empty)).toBeTruthy()
      expect(screen.getByRole('button', { name: t.newTicket })).toBeTruthy()
    })

    it('a failed load shows an alert with a retry', async () => {
      let fail = true
      setup([T1], { onList: () => (fail ? json(503, {}) : json(200, { items: [T1], total: 1, skip: 0, take: 100 })) })
      renderAppRoute('/support', language)
      const alert = await screen.findByRole('alert')
      expect(alert.textContent).toContain(t.loadFailed)
      expect(alert.textContent).toContain(t.server)
      fail = false
      fireEvent.click(within(alert).getByRole('button'))
      expect(await screen.findByText(T1.subject)).toBeTruthy()
    })

    it('polls the list every 60 s (D5)', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
      setup([T1])
      renderAppRoute('/support', language)
      await screen.findByText(T1.subject)
      expect(callsTo(TICKETS)).toHaveLength(1)
      await act(() => vi.advanceTimersByTimeAsync(15_000))
      expect(callsTo(TICKETS)).toHaveLength(1)
      await act(() => vi.advanceTimersByTimeAsync(45_000))
      await waitFor(() => expect(callsTo(TICKETS)).toHaveLength(2))
    })
  })

  describe('new ticket', () => {
    const openForm = async () => {
      fireEvent.click(await screen.findByRole('button', { name: t.newTicket }))
      return screen.findByLabelText(t.category)
    }
    const fill = () => {
      fireEvent.change(screen.getByLabelText(t.category), { target: { value: 'BILLING' } })
      fireEvent.change(screen.getByLabelText(t.subject), { target: { value: '  Refund please  ' } })
      fireEvent.change(screen.getByLabelText(t.message), { target: { value: '  I was charged twice.  ' } })
    }

    it('checks category, subject and message before sending anything', async () => {
      setup()
      renderAppRoute('/support', language)
      await openForm()
      fireEvent.click(screen.getByRole('button', { name: t.send }))
      expect(await screen.findByText(t.pickCategory)).toBeTruthy()
      expect(screen.getByText(t.addSubject)).toBeTruthy()
      expect(screen.getByText(t.writeMessage)).toBeTruthy()
      fireEvent.change(screen.getByLabelText(t.subject), { target: { value: '   ' } })
      fireEvent.click(screen.getByRole('button', { name: t.send }))
      expect(sent(TICKETS)).toHaveLength(0)
    })

    it('sends JSON (trimmed, no priority) without images, then opens the new thread', async () => {
      setup()
      const { history } = renderAppRoute('/support', language)
      await openForm()
      fill()
      fireEvent.click(screen.getByRole('button', { name: t.send }))
      expect(await screen.findByText('I was charged twice.')).toBeTruthy()
      expect(sent(TICKETS)).toEqual([
        { path: TICKETS, method: 'POST', body: { category: 'BILLING', subject: 'Refund please', body: 'I was charged twice.' } },
      ])
      expect(history.location.search).toContain(NEW_TICKET_ID)
      expect(screen.getByRole('heading', { name: 'Refund please' })).toBeTruthy()
    })

    it('checks images like the backend (type, 5 MB, at most 3) and sends multipart with `files`', async () => {
      let received: SentMessage | undefined
      setup([], {
        onCreate: (message) => {
          received = message
          return json(201, ticket({ id: NEW_TICKET_ID }))
        },
      })
      renderAppRoute('/support', language)
      await openForm()
      fill()

      pick(new File(['gif'], 'a.gif', { type: 'image/gif' }))
      expect((await screen.findByRole('alert')).textContent).toBe(t.badType)
      pick(png('big.png', 5 * 1024 * 1024 + 1))
      expect(screen.getByRole('alert').textContent).toBe(t.tooLarge)
      pick(png('1.png'), png('2.png'), png('3.png'), png('4.png'))
      expect(screen.getByRole('alert').textContent).toBe(t.tooMany)
      expect(screen.getAllByRole('img')).toHaveLength(3)
      expect((screen.getByRole('button', { name: t.addScreenshot }) as HTMLButtonElement).disabled).toBe(true)

      fireEvent.click(screen.getByRole('button', { name: /3\.png/ }))
      expect(screen.getAllByRole('img')).toHaveLength(2)
      expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1)

      fireEvent.click(screen.getByRole('button', { name: t.send }))
      await waitFor(() => expect(received).toBeDefined())
      expect(received!.fields).toEqual({ category: 'BILLING', subject: 'Refund please', body: 'I was charged twice.' })
      expect(received!.files.map((file) => file.name)).toEqual(['1.png', '2.png'])
    })

    it.each([
      ['TICKET_LIMIT_REACHED', 409, { limit: 20 }, 'limit'],
      ['ATTACHMENTS_UNAVAILABLE', 409, undefined, 'unavailable'],
      ['ATTACHMENT_TYPE_INVALID', 400, undefined, 'badType'],
      ['ATTACHMENT_TOO_LARGE', 400, undefined, 'tooLarge'],
      ['ATTACHMENT_TOO_MANY', 400, undefined, 'tooMany'],
      ['IMPERSONATION_READ_ONLY', 403, undefined, 'readOnlyError'],
      [undefined, 503, undefined, 'server'],
    ] as const)('maps %s (%i) to its message', async (code, status, details, key) => {
      setup([], { onCreate: () => json(status, { message: 'backend text', code, details }) })
      renderAppRoute('/support', language)
      await openForm()
      fill()
      fireEvent.click(screen.getByRole('button', { name: t.send }))
      const alert = await screen.findByRole('alert')
      expect(alert.dataset.kind).toBe('create-error')
      expect(alert.textContent).toContain(t[key])
      expect(alert.textContent).not.toContain('backend text')
    })

    it('Cancel closes the form', async () => {
      setup()
      renderAppRoute('/support', language)
      await openForm()
      fireEvent.click(screen.getByRole('button', { name: t.cancel }))
      expect(await screen.findByRole('button', { name: t.newTicket })).toBeTruthy()
      expect(screen.queryByLabelText(t.category)).toBeNull()
    })
  })

  describe('thread', () => {
    const withReply = ticket({
      status: 'RESOLVED',
      hasNewReply: true,
      messages: [
        ticketMessage({
          id: 'm1',
          body: 'Scams stay visible.',
          attachments: [
            { id: 'a1', contentType: 'image/png', sizeBytes: 100, url: 'https://storage.test/a1.png' },
            { id: 'a2', contentType: 'image/jpeg', sizeBytes: 100, url: null },
          ],
        }),
        ticketMessage({ id: 'm2', senderRole: 'ADMIN', sender: { id: null, name: 'Support' }, body: 'Fixed, please check.', createdAt: '2026-11-20T09:00:00.000Z' }),
      ],
    })

    it('shows exactly the public messages the API sends, support as "Support", and the attachments', async () => {
      setup([withReply])
      renderAppRoute(`/support?ticket=${withReply.id}`, language)
      const messages = within(await screen.findByRole('list', { name: /Messages|মেসেজ/ })).getAllByRole('listitem')
      expect(messages.map((item) => item.dataset.sender)).toEqual(['CLIENT', 'ADMIN'])
      expect(within(messages[1]!).getByText(t.support)).toBeTruthy()
      expect(within(messages[0]!).getByText('Rahim')).toBeTruthy()
      const link = within(messages[0]!).getByRole('link', { name: t.shot(1) })
      expect(link.getAttribute('href')).toBe('https://storage.test/a1.png')
      expect(link.getAttribute('target')).toBe('_blank')
      expect(within(messages[0]!).getByText(t.unavailableImage)).toBeTruthy()
      expect(screen.getByText(t.reopens)).toBeTruthy()
      expect(screen.getByText(t.resolved)).toBeTruthy()
    })

    it('opens from the list and goes back', async () => {
      setup([T1, T2])
      const { history } = renderAppRoute('/support', language)
      fireEvent.click(await screen.findByRole('button', { name: /Invoice question/ }))
      expect(await screen.findByRole('heading', { name: 'Invoice question' })).toBeTruthy()
      expect(history.location.search).toContain(T2.id)
      fireEvent.click(screen.getByRole('button', { name: t.allTickets }))
      expect(await screen.findByText(T1.subject)).toBeTruthy()
    })

    it('a missing ticket shows "not found"; a malformed ?ticket= shows the list', async () => {
      setup([T1], { onDetail: () => json(404, { message: 'Ticket not found' }) })
      renderAppRoute(`/support?ticket=${T1.id}`, language)
      expect((await screen.findByRole('alert')).textContent).toBeTruthy()
      cleanup()
      setup([T1])
      renderAppRoute('/support?ticket=not-a-uuid', language)
      expect(await screen.findByText(T1.subject)).toBeTruthy()
      expect(callsTo(ticketUrl('not-a-uuid'))).toHaveLength(0)
    })

    it('reply: validates, sends JSON, refreshes the thread and clears the box', async () => {
      setup([withReply])
      renderAppRoute(`/support?ticket=${withReply.id}`, language)
      const box = await screen.findByLabelText(t.reply)
      fireEvent.click(screen.getByRole('button', { name: t.sendReply }))
      expect(await screen.findByText(t.writeMessage)).toBeTruthy()
      expect(sent(replyUrl(withReply.id))).toHaveLength(0)

      fireEvent.change(box, { target: { value: ' Still broken. ' } })
      fireEvent.click(screen.getByRole('button', { name: t.sendReply }))
      expect(await screen.findByText('Still broken.')).toBeTruthy()
      expect(sent(replyUrl(withReply.id))).toEqual([{ path: replyUrl(withReply.id), method: 'POST', body: { body: 'Still broken.' } }])
      expect((screen.getByLabelText(t.reply) as HTMLTextAreaElement).value).toBe('')
      await waitFor(() => expect(screen.queryByText(t.reopens)).toBeNull()) // reopened
    })

    it('reply with images sends multipart and clears the previews', async () => {
      let received: SentMessage | undefined
      setup([T1], {
        onReply: (_id, message) => {
          received = message
          return json(201, { message: ticketMessage(), ticket: T1 })
        },
      })
      renderAppRoute(`/support?ticket=${T1.id}`, language)
      fireEvent.change(await screen.findByLabelText(t.reply), { target: { value: 'See screenshot' } })
      pick(png('a.png'), new File(['j'], 'b.jpg', { type: 'image/jpeg' }))
      expect(screen.getAllByRole('img')).toHaveLength(2)
      fireEvent.click(screen.getByRole('button', { name: t.sendReply }))
      await waitFor(() => expect(received).toBeDefined())
      expect(received!.fields).toEqual({ body: 'See screenshot' })
      expect(received!.files.map((file) => file.name)).toEqual(['a.png', 'b.jpg'])
      await waitFor(() => expect(screen.queryAllByRole('img')).toHaveLength(0))
    })

    it.each([
      [404, undefined, 'gone'],
      [409, 'ATTACHMENTS_UNAVAILABLE', 'unavailable'],
      [403, 'IMPERSONATION_READ_ONLY', 'readOnlyError'],
    ] as const)('reply error %i %s keeps the text and explains', async (status, code, key) => {
      setup([T1], { onReply: () => json(status, { message: 'x', code }) })
      renderAppRoute(`/support?ticket=${T1.id}`, language)
      fireEvent.change(await screen.findByLabelText(t.reply), { target: { value: 'Hello again' } })
      fireEvent.click(screen.getByRole('button', { name: t.sendReply }))
      const alert = await screen.findByRole('alert')
      expect(alert.dataset.kind).toBe('reply-error')
      expect(alert.textContent).toContain(t[key])
      expect((screen.getByLabelText(t.reply) as HTMLTextAreaElement).value).toBe('Hello again')
    })

    it('polls the open thread every 15 s and shows new support replies (D5)', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
      let current = T1
      setup([T1], { onDetail: () => json(200, current) })
      renderAppRoute(`/support?ticket=${T1.id}`, language)
      await screen.findByRole('heading', { name: T1.subject })
      expect(callsTo(ticketUrl(T1.id))).toHaveLength(1)
      current = { ...T1, messages: [...T1.messages, ticketMessage({ id: 'm9', senderRole: 'ADMIN', sender: { id: null, name: 'Support' }, body: 'On it.' })] }
      await act(() => vi.advanceTimersByTimeAsync(15_000))
      expect(await screen.findByText('On it.')).toBeTruthy()
      expect(callsTo(ticketUrl(T1.id))).toHaveLength(2)
      expect(callsTo(TICKETS)).toHaveLength(0) // the list isn't mounted, so it doesn't poll
    })
  })

  describe('impersonated (D2)', () => {
    it('reads the list but cannot open a ticket', async () => {
      setup([T1], {}, IMPERSONATED)
      renderAppRoute('/support', language)
      expect(await screen.findByText(T1.subject)).toBeTruthy()
      expect(screen.getAllByRole('status').find((el) => el.dataset.kind === 'impersonation-read-only')?.textContent).toContain(t.readOnly)
      expect(screen.queryByRole('button', { name: t.newTicket })).toBeNull()
    })

    it('reads the thread but has no reply box', async () => {
      setup([T1], {}, IMPERSONATED)
      renderAppRoute(`/support?ticket=${T1.id}`, language)
      expect(await screen.findByRole('heading', { name: T1.subject })).toBeTruthy()
      expect(screen.getByText(t.readOnly, { exact: false })).toBeTruthy()
      expect(screen.queryByLabelText(t.reply)).toBeNull()
      expect(screen.queryByRole('button', { name: t.sendReply })).toBeNull()
    })
  })
})
