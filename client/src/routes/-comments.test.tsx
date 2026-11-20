import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CommentFeedItem } from '@/lib/comments-feed'
import type { Language } from '@/lib/language'
import {
  comment,
  COMMENTS,
  commentsApi,
  IMPERSONATED,
  overrideUrl,
  renderAppRoute,
  SESSION,
  stubAppGlobals,
  summaryApi,
} from '@/test/app-routes'
import { callsTo, fetchMock, json, mockApi } from '@/test/auth-routes'

// The server-render session function needs the Start compiler; the browser path never calls it.
vi.mock('@/server/session', () => ({ getServerSession: vi.fn() }))

// C5 `/comments` (M6-T9; D1 polling, D7 every member acts, D8 Keep visible): real `_app` + route files.

const copy = {
  en: {
    heading: 'Comments',
    status: 'Status',
    category: 'Category',
    all: 'All',
    needsReview: 'Needs review',
    hidden: 'Hidden',
    visible: 'Visible',
    deleted: 'Deleted',
    scam: 'Scam / phishing',
    spam: 'Spam',
    confidence: '72% confident',
    why: 'Why this result?',
    reasoning: 'Asks for a bKash payment to a personal number.',
    hide: 'Hide',
    unhide: 'Unhide',
    del: 'Delete',
    reply: 'Reply',
    keep: 'Keep visible',
    yesDelete: 'Yes, delete',
    cancel: 'Cancel',
    send: 'Send reply',
    hiddenOk: 'Comment hidden.',
    unhiddenOk: 'Comment is visible again.',
    deletedOk: 'Comment deleted.',
    repliedOk: 'Reply sent.',
    keptOk: 'Comment kept visible.',
    replyEmpty: 'Write a reply first.',
    replyLong: 'Keep the reply to 500 characters or fewer.',
    loadMore: 'Load more',
    newTwo: '2 new comments',
    search: 'Search comments',
    searchBtn: 'Search',
    clear: 'Clear filters',
    empty: 'No comments yet. They show up here as soon as your Pages get comments.',
    emptyFiltered: 'No comments match these filters.',
    loadFailed: 'Couldn’t load comments',
    retry: 'Try again',
    errors: {
      notFound: 'This comment no longer exists.',
      hidden: 'This comment is hidden. Unhide it instead.',
      inactive: 'This comment’s Page is switched off. Turn it on in Pages first.',
      reconnect: 'Reconnect Facebook to act on this comment.',
      retryable: 'Facebook didn’t respond in time. Try again in a minute.',
      refused: 'Facebook refused this action.',
      notConfigured: 'Facebook actions aren’t set up on our server yet. Please contact support.',
      network: 'Can’t reach the server. Check your connection and try again.',
      server: 'The server is unavailable right now. Try again shortly.',
    },
  },
  bn: {
    heading: 'কমেন্ট',
    status: 'স্ট্যাটাস',
    category: 'ক্যাটাগরি',
    all: 'সব',
    needsReview: 'রিভিউ দরকার',
    hidden: 'লুকানো',
    visible: 'দৃশ্যমান',
    deleted: 'মুছে ফেলা',
    scam: 'স্ক্যাম / ফিশিং',
    spam: 'স্প্যাম',
    confidence: '৭২% নিশ্চিত',
    why: 'কেন এই ফলাফল?',
    reasoning: 'Asks for a bKash payment to a personal number.',
    hide: 'হাইড করুন',
    unhide: 'আনহাইড করুন',
    del: 'ডিলিট করুন',
    reply: 'উত্তর দিন',
    keep: 'দৃশ্যমান রাখুন',
    yesDelete: 'হ্যাঁ, ডিলিট করুন',
    cancel: 'বাতিল',
    send: 'উত্তর পাঠান',
    hiddenOk: 'কমেন্টটি লুকানো হয়েছে।',
    unhiddenOk: 'কমেন্টটি আবার দেখা যাচ্ছে।',
    deletedOk: 'কমেন্টটি মুছে ফেলা হয়েছে।',
    repliedOk: 'উত্তর পাঠানো হয়েছে।',
    keptOk: 'কমেন্টটি দৃশ্যমান রাখা হয়েছে।',
    replyEmpty: 'আগে একটি উত্তর লিখুন।',
    replyLong: 'উত্তরটি ৫০০ অক্ষরের মধ্যে রাখুন।',
    loadMore: 'আরও দেখুন',
    newTwo: '২টি নতুন কমেন্ট',
    search: 'কমেন্ট খুঁজুন',
    searchBtn: 'খুঁজুন',
    clear: 'ফিল্টার মুছুন',
    empty: 'এখনো কোনো কমেন্ট নেই। আপনার পেজে কমেন্ট এলেই এখানে দেখা যাবে।',
    emptyFiltered: 'এই ফিল্টারে কোনো কমেন্ট নেই।',
    loadFailed: 'কমেন্ট লোড করা যায়নি',
    retry: 'আবার চেষ্টা করুন',
    errors: {
      notFound: 'এই কমেন্টটি আর নেই।',
      hidden: 'এই কমেন্টটি লুকানো আছে। এর বদলে আনহাইড করুন।',
      inactive: 'এই কমেন্টের পেজটি বন্ধ আছে। আগে পেজ থেকে এটি চালু করুন।',
      reconnect: 'এই কমেন্টে কাজ করতে ফেসবুক আবার কানেক্ট করুন।',
      retryable: 'ফেসবুক সময়মতো সাড়া দেয়নি। এক মিনিট পরে আবার চেষ্টা করুন।',
      refused: 'ফেসবুক এই অ্যাকশনটি গ্রহণ করেনি।',
      notConfigured: 'আমাদের সার্ভারে ফেসবুক অ্যাকশন এখনো সেট আপ করা হয়নি। অনুগ্রহ করে সাপোর্টে যোগাযোগ করুন।',
      network: 'সার্ভারে সংযোগ করা যাচ্ছে না। ইন্টারনেট সংযোগ দেখে আবার চেষ্টা করুন।',
      server: 'সার্ভার এই মুহূর্তে পাওয়া যাচ্ছে না। একটু পরে আবার চেষ্টা করুন।',
    },
  },
} as const

/** A moderator's session: the client has no role gate (D7), the backend allows every member. */
const MODERATOR = {
  session: { id: 's3', userId: 'u3', impersonatedBy: null, activeOrganizationId: 'w1' },
  user: { id: 'u3', email: 'mod@shop.bd', name: 'Mita', emailVerified: true },
}

/** Every feed GET, as its search params (in order). */
const feedRequests = () =>
  fetchMock.mock.calls
    .map(([input]) => new URL(String(input), 'http://localhost'))
    .filter((url) => url.pathname === COMMENTS)
    .map((url) => Object.fromEntries(url.searchParams))

const row = (id: string) => within(screen.getByTestId(`comment-${id}`))
const statusText = (id: string) => row(id).getByTestId('status-pill').textContent

function setup(items: CommentFeedItem[], options: Parameters<typeof commentsApi>[1] = {}, session: unknown = SESSION) {
  mockApi({ '/api/auth/get-session': () => json(200, session), ...summaryApi(), ...commentsApi(items, options) })
}

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  stubAppGlobals()
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe.each(['en', 'bn'] as const)('/comments (%s)', (language: Language) => {
  const t = copy[language]

  it('lists comments with status + category pills, confidence and the reasoning behind a disclosure', async () => {
    setup([comment(), comment({ id: 'c2', status: 'HIDDEN', category: 'SPAM_IRRELEVANT', confidence: null, reasoning: null })])
    renderAppRoute('/comments', language)

    expect(await screen.findByRole('heading', { name: t.heading, level: 1 })).toBeTruthy()
    await screen.findByTestId('comment-c1')
    expect(feedRequests()).toEqual([{}])
    expect(statusText('c1')).toBe(t.needsReview)
    expect(row('c1').getByTestId('category-pill').textContent).toBe(t.scam)
    expect(row('c1').getByTestId('confidence').textContent).toBe(t.confidence)
    const details = row('c1').getByText(t.why).closest('details')!
    expect(details.open).toBe(false)
    fireEvent.click(row('c1').getByText(t.why))
    expect(details.open).toBe(true)
    expect(row('c1').getByText(t.reasoning)).toBeTruthy()

    expect(statusText('c2')).toBe(t.hidden)
    expect(row('c2').getByTestId('category-pill').textContent).toBe(t.spam)
    expect(row('c2').queryByTestId('confidence')).toBeNull()
    expect(row('c2').queryByText(t.why)).toBeNull()
    // Actions per status: review → Keep/Hide/Reply/Delete, hidden → Unhide/Reply/Delete.
    expect(row('c1').getAllByRole('button').map((b) => b.textContent)).toEqual([t.keep, t.hide, t.reply, t.del])
    expect(row('c2').getAllByRole('button').map((b) => b.textContent)).toEqual([t.unhide, t.reply, t.del])
  })

  it('shows the empty state and the load error with a retry', async () => {
    let fail = true
    setup([], { onList: () => (fail ? json(503, { message: 'down' }) : json(200, { items: [], nextCursor: null })) })
    renderAppRoute('/comments', language)

    const alert = await screen.findByRole('alert')
    expect(within(alert).getByText(t.loadFailed)).toBeTruthy()
    expect(within(alert).getByText(t.errors.server)).toBeTruthy()
    fail = false
    fireEvent.click(within(alert).getByRole('button', { name: t.retry }))
    expect(await screen.findByText(t.empty)).toBeTruthy()
  })

  it('puts filters in the URL and the API query, and drops invalid ones', async () => {
    setup([comment()])
    const { history } = renderAppRoute('/comments', language)
    await screen.findByTestId('comment-c1')

    fireEvent.click(within(screen.getByRole('group', { name: t.status })).getByRole('button', { name: t.needsReview }))
    await waitFor(() => expect(feedRequests().at(-1)).toEqual({ status: 'NEEDS_REVIEW' }))
    fireEvent.click(within(screen.getByRole('group', { name: t.category })).getByRole('button', { name: t.scam }))
    await waitFor(() => expect(feedRequests().at(-1)).toEqual({ status: 'NEEDS_REVIEW', category: 'SCAM_PHISHING' }))
    fireEvent.change(screen.getByRole('searchbox', { name: t.search }), { target: { value: '  bkash  ' } })
    fireEvent.click(screen.getByRole('button', { name: t.searchBtn }))
    await waitFor(() => expect(feedRequests().at(-1)).toEqual({ status: 'NEEDS_REVIEW', category: 'SCAM_PHISHING', q: 'bkash' }))
    const params = new URLSearchParams(history.location.search)
    expect([params.get('status'), params.get('category'), params.get('q')]).toEqual(['NEEDS_REVIEW', 'SCAM_PHISHING', 'bkash'])
    expect(within(screen.getByRole('group', { name: t.status })).getByRole('button', { name: t.needsReview }).getAttribute('aria-pressed')).toBe('true')

    // "All" removes the key from the URL.
    fireEvent.click(within(screen.getByRole('group', { name: t.status })).getByRole('button', { name: t.all }))
    await waitFor(() => expect(feedRequests().at(-1)).toEqual({ category: 'SCAM_PHISHING', q: 'bkash' }))
    expect(new URLSearchParams(history.location.search).has('status')).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: t.clear }))
    await waitFor(() => expect(history.location.search).toBe(''))
    cleanup()

    fetchMock.mockClear()
    const pageId = '6f1c2a3b-0000-4000-8000-000000000001'
    renderAppRoute(`/comments?status=HIDDEN&category=bogus&pageId=${pageId}&from=2026-11-01&to=2026-02-30&platform=TIKTOK`, language)
    await screen.findByTestId('comment-c1')
    expect(feedRequests()).toEqual([{ status: 'HIDDEN', pageId, from: '2026-11-01' }])
  })

  it('follows the cursor with "Load more"', async () => {
    setup([], {
      onList: (url) =>
        url.searchParams.get('cursor') === 'next-1'
          ? json(200, { items: [comment({ id: 'c2', createdAt: '2026-11-19T08:00:00.000Z' })], nextCursor: null })
          : json(200, { items: [comment()], nextCursor: 'next-1' }),
    })
    renderAppRoute('/comments', language)
    await screen.findByTestId('comment-c1')

    fireEvent.click(screen.getByRole('button', { name: t.loadMore }))
    expect(await screen.findByTestId('comment-c2')).toBeTruthy()
    expect(feedRequests()).toEqual([{}, { cursor: 'next-1' }])
    expect(screen.getByTestId('comment-c1')).toBeTruthy()
    expect(screen.queryByRole('button', { name: t.loadMore })).toBeNull()
  })

  it('polls every 15 s with `since` + the filters and merges new comments on click (D1)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    const first = comment()
    const newer = [
      comment({ id: 'c3', createdAt: '2026-11-20T08:20:00.000Z' }),
      comment({ id: 'c2', createdAt: '2026-11-20T08:10:00.000Z' }),
      first, // same millisecond as `since`: already on screen, not counted
    ]
    setup([], {
      onList: (url) => json(200, { items: url.searchParams.has('since') ? newer : [first], nextCursor: null }),
    })
    renderAppRoute('/comments?status=NEEDS_REVIEW', language)
    await screen.findByTestId('comment-c1')
    expect(feedRequests()).toEqual([{ status: 'NEEDS_REVIEW' }])

    await act(() => vi.advanceTimersByTimeAsync(15_000))
    await waitFor(() =>
      expect(feedRequests()).toContainEqual({ status: 'NEEDS_REVIEW', since: first.createdAt, limit: '50' }),
    )
    const pill = await screen.findByRole('button', { name: t.newTwo })
    expect(screen.queryByTestId('comment-c3')).toBeNull()

    fireEvent.click(pill)
    await waitFor(() => expect(screen.queryByRole('button', { name: t.newTwo })).toBeNull())
    const order = screen.getAllByTestId(/^comment-c/).map((el) => el.dataset.testid)
    expect(order).toEqual(['comment-c3', 'comment-c2', 'comment-c1'])
    // The next poll asks from the newest one.
    await act(() => vi.advanceTimersByTimeAsync(15_000))
    await waitFor(() => expect(feedRequests()).toContainEqual({ status: 'NEEDS_REVIEW', since: newer[0]!.createdAt, limit: '50' }))
  })

  it('Unhide → POST + the status changes + the list refetches (gate 2b)', async () => {
    setup([comment({ status: 'HIDDEN' })])
    renderAppRoute('/comments', language)
    await screen.findByTestId('comment-c1')
    expect(statusText('c1')).toBe(t.hidden)

    fireEvent.click(row('c1').getByRole('button', { name: t.unhide }))
    await waitFor(() => expect(statusText('c1')).toBe(t.visible))
    expect(callsTo(overrideUrl('c1'))).toEqual([{ path: overrideUrl('c1'), method: 'POST', body: { action: 'UNHIDE' } }])
    expect(screen.getByTestId('feed-notice').textContent).toBe(t.unhiddenOk)
    expect(row('c1').getAllByRole('button').map((b) => b.textContent)).toEqual([t.hide, t.reply, t.del])
    await waitFor(() => expect(feedRequests().filter((params) => !params.since)).toHaveLength(2))
  })

  it('"Keep visible" sends KEEP (D8) and is offered only where the API allows it', async () => {
    setup([comment(), comment({ id: 'c2', status: 'VISIBLE' })])
    renderAppRoute('/comments', language)
    await screen.findByTestId('comment-c1')
    expect(row('c2').queryByRole('button', { name: t.keep })).toBeNull()

    fireEvent.click(row('c1').getByRole('button', { name: t.keep }))
    await waitFor(() => expect(statusText('c1')).toBe(t.visible))
    expect(callsTo(overrideUrl('c1'))[0]?.body).toEqual({ action: 'KEEP' })
    expect(screen.getByTestId('feed-notice').textContent).toBe(t.keptOk)
  })

  it('asks before deleting: cancel sends nothing, confirm deletes', async () => {
    setup([comment()])
    renderAppRoute('/comments', language)
    await screen.findByTestId('comment-c1')

    fireEvent.click(row('c1').getByRole('button', { name: t.del }))
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: t.cancel }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(callsTo(overrideUrl('c1'))).toEqual([])

    fireEvent.click(row('c1').getByRole('button', { name: t.del }))
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: t.yesDelete }))
    await waitFor(() => expect(statusText('c1')).toBe(t.deleted))
    expect(callsTo(overrideUrl('c1')).map((call) => call.body)).toEqual([{ action: 'DELETE' }])
    expect(screen.getByTestId('feed-notice').textContent).toBe(t.deletedOk)
    expect(row('c1').queryAllByRole('button')).toEqual([])
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('validates the reply (1–500 characters) before sending it', async () => {
    setup([comment()])
    renderAppRoute('/comments', language)
    await screen.findByTestId('comment-c1')

    fireEvent.click(row('c1').getByRole('button', { name: t.reply }))
    const dialog = within(await screen.findByRole('dialog'))
    const send = dialog.getByRole('button', { name: t.send })
    const box = dialog.getByRole('textbox')

    fireEvent.change(box, { target: { value: '   ' } })
    fireEvent.click(send)
    expect(dialog.getByRole('alert').textContent).toBe(t.replyEmpty)
    expect(box.getAttribute('aria-invalid')).toBe('true')
    fireEvent.change(box, { target: { value: 'a'.repeat(501) } })
    fireEvent.click(send)
    expect(dialog.getByRole('alert').textContent).toBe(t.replyLong)
    expect(callsTo(overrideUrl('c1'))).toEqual([])

    fireEvent.change(box, { target: { value: '  Inbox us for the price.  ' } })
    fireEvent.click(send)
    await waitFor(() => expect(screen.getByTestId('feed-notice').textContent).toBe(t.repliedOk))
    expect(callsTo(overrideUrl('c1')).map((call) => call.body)).toEqual([{ action: 'REPLY', replyText: 'Inbox us for the price.' }])
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  const failures: Array<[string, () => Response, keyof (typeof copy)['en']['errors']]> = [
    ['404', () => json(404, { message: 'Comment not found' }), 'notFound'],
    ['409 COMMENT_HIDDEN', () => json(409, { message: 'x', code: 'COMMENT_HIDDEN' }), 'hidden'],
    ['409 PAGE_INACTIVE', () => json(409, { message: 'x', code: 'PAGE_INACTIVE' }), 'inactive'],
    ['409 CONNECTION_INACTIVE', () => json(409, { message: 'x', code: 'CONNECTION_INACTIVE' }), 'reconnect'],
    ['502 retryable', () => json(502, { message: 'x', code: 'META_ACTION_FAILED', details: { errorKind: 'timeout', retryable: true } }), 'retryable'],
    ['502 refused', () => json(502, { message: 'x', code: 'META_ACTION_FAILED', details: { errorKind: 'permission', retryable: false } }), 'refused'],
    ['503 META_NOT_CONFIGURED', () => json(503, { message: 'x', code: 'META_NOT_CONFIGURED' }), 'notConfigured'],
    [
      'network',
      () => {
        throw new TypeError('offline')
      },
      'network',
    ],
  ]

  it.each(failures)('shows the %s failure on the row and keeps the comment as it was', async (_name, respond, key) => {
    setup([comment()], { onOverride: () => respond() })
    renderAppRoute('/comments', language)
    await screen.findByTestId('comment-c1')

    fireEvent.click(row('c1').getByRole('button', { name: t.hide }))
    expect((await row('c1').findByRole('alert')).textContent).toBe(t.errors[key])
    expect(statusText('c1')).toBe(t.needsReview)
    expect(row('c1').getByRole('button', { name: t.hide }).hasAttribute('disabled')).toBe(false)
  })

  it.each([
    ['a moderator', MODERATOR],
    ['an impersonated session', IMPERSONATED],
  ])('lets %s see the feed and act (D7)', async (_name, session) => {
    setup([comment()], {}, session)
    renderAppRoute('/comments', language)
    await screen.findByTestId('comment-c1')

    fireEvent.click(row('c1').getByRole('button', { name: t.hide }))
    await waitFor(() => expect(statusText('c1')).toBe(t.hidden))
    expect(screen.getByTestId('feed-notice').textContent).toBe(t.hiddenOk)
  })

  it('disables the row while its action runs', async () => {
    let release: () => void = () => {}
    const pending = new Promise<void>((resolve) => (release = resolve))
    setup([comment(), comment({ id: 'c2', createdAt: '2026-11-19T08:00:00.000Z' })], {
      onOverride: async (item) => {
        await pending
        item.status = 'HIDDEN'
        return json(200, item)
      },
    })
    renderAppRoute('/comments', language)
    await screen.findByTestId('comment-c1')

    fireEvent.click(row('c1').getByRole('button', { name: t.hide }))
    await waitFor(() => expect(screen.getByTestId('comment-c1').getAttribute('aria-busy')).toBe('true'))
    expect(row('c1').getAllByRole('button').every((b) => b.hasAttribute('disabled'))).toBe(true)
    expect(row('c2').getAllByRole('button').some((b) => b.hasAttribute('disabled'))).toBe(false)
    release()
    await waitFor(() => expect(statusText('c1')).toBe(t.hidden))
  })
})
