import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { formatCommentTime } from '@/lib/comments-feed'
import type { Language } from '@/lib/language'
import {
  IMPERSONATED,
  PLAYGROUND_TEST,
  PLAYGROUND_USAGE,
  playgroundApi,
  type PlaygroundApiOptions,
  playgroundResult,
  renderAppRoute,
  SESSION,
  stubAppGlobals,
  summaryApi,
} from '@/test/app-routes'
import { callsTo, fetchMock, json, mockApi } from '@/test/auth-routes'

// The server-render session function needs the Start compiler; the browser path never calls it.
vi.mock('@/server/session', () => ({ getServerSession: vi.fn() }))

// C8 `/playground` (M6-T11; D9/D7): real `_app` + route files (harness `src/test/app-routes.tsx`).

const RESETS_AT = '2026-11-20T18:00:00.000Z'

const copy = {
  en: {
    heading: 'Playground',
    comment: 'Comment',
    test: 'Test',
    facebook: 'Facebook',
    instagram: 'Instagram',
    left: '8 of 10 tests left today',
    leftAfter: '7 of 10 tests left today',
    noneLeft: '0 of 10 tests left today',
    off: 'The playground is turned off right now.',
    usageFailed: 'Couldn’t check how many tests are left today.',
    count: '0/2,000',
    countTyped: '5/2,000',
    empty: 'Write a comment to test.',
    tooLong: 'Keep the comment to 2,000 characters or fewer.',
    keyword: 'Blocked keyword',
    phone: 'Phone number',
    scam: 'Scam / phishing',
    safe: 'Safe inquiry',
    confidence: '93% confident',
    latency: 'Checked in 324 ms',
    hide: 'Would hide this comment',
    del: 'Would delete this comment',
    visible: 'Would leave this comment visible',
    review: 'Would send this comment to review',
    reviewMode: 'Review mode is on in your rules.',
    belowThreshold: 'The AI is less sure than your confidence setting.',
    replyBn: 'Auto-reply it would post (Bangla)',
    limit: (when: string) => `You’ve used all 10 tests. You can test again from ${when} (Dhaka time).`,
    aiOff: 'The AI isn’t available right now, so this comment couldn’t be checked. Please try again later.',
    aiRetry: 'The AI didn’t answer in time. Try again; this test wasn’t counted.',
    aiFailed: 'The AI couldn’t check this comment. This test wasn’t counted.',
    invalid: 'Write a comment of 1–2,000 characters and try again.',
    forbidden: 'You don’t have access to the playground in this workspace.',
    notFound: 'This workspace couldn’t be found.',
    network: 'Can’t reach the server. Check your connection and try again.',
    server: 'The server is unavailable right now. Try again shortly.',
  },
  bn: {
    heading: 'প্লেগ্রাউন্ড',
    comment: 'কমেন্ট',
    test: 'টেস্ট করুন',
    facebook: 'Facebook',
    instagram: 'Instagram',
    left: 'আজ ১০টির মধ্যে ৮টি টেস্ট বাকি',
    leftAfter: 'আজ ১০টির মধ্যে ৭টি টেস্ট বাকি',
    noneLeft: 'আজ ১০টির মধ্যে ০টি টেস্ট বাকি',
    off: 'প্লেগ্রাউন্ড এই মুহূর্তে বন্ধ আছে।',
    usageFailed: 'আজ কতগুলো টেস্ট বাকি আছে তা দেখা যায়নি।',
    count: '০/২,০০০',
    countTyped: '৫/২,০০০',
    empty: 'টেস্ট করার জন্য একটি কমেন্ট লিখুন।',
    tooLong: 'কমেন্টটি ২,০০০ অক্ষরের মধ্যে রাখুন।',
    keyword: 'ব্লক করা কিওয়ার্ড',
    phone: 'ফোন নম্বর',
    scam: 'স্ক্যাম / ফিশিং',
    safe: 'সাধারণ জিজ্ঞাসা',
    confidence: '৯৩% নিশ্চিত',
    latency: '৩২৪ মিলিসেকেন্ডে যাচাই হয়েছে',
    hide: 'কমেন্টটি হাইড করা হতো',
    del: 'কমেন্টটি ডিলিট করা হতো',
    visible: 'কমেন্টটি দৃশ্যমান রাখা হতো',
    review: 'কমেন্টটি রিভিউতে পাঠানো হতো',
    reviewMode: 'আপনার নিয়মে রিভিউ মোড চালু আছে।',
    belowThreshold: 'AI-এর নিশ্চয়তা আপনার কনফিডেন্স সেটিংয়ের চেয়ে কম।',
    replyBn: 'যে অটো-রিপ্লাই পোস্ট হতো (বাংলা)',
    limit: (when: string) => `আজকের ১০টি টেস্ট শেষ। ${when} (ঢাকা সময়) থেকে আবার টেস্ট করতে পারবেন।`,
    aiOff: 'এই মুহূর্তে AI পাওয়া যাচ্ছে না, তাই কমেন্টটি যাচাই করা যায়নি। একটু পরে আবার চেষ্টা করুন।',
    aiRetry: 'AI সময়মতো উত্তর দেয়নি। আবার চেষ্টা করুন; এই টেস্টটি গোনা হয়নি।',
    aiFailed: 'AI এই কমেন্টটি যাচাই করতে পারেনি। এই টেস্টটি গোনা হয়নি।',
    invalid: '১–২,০০০ অক্ষরের একটি কমেন্ট লিখে আবার চেষ্টা করুন।',
    forbidden: 'এই ওয়ার্কস্পেসে প্লেগ্রাউন্ড ব্যবহারের অনুমতি আপনার নেই।',
    notFound: 'এই ওয়ার্কস্পেসটি খুঁজে পাওয়া যায়নি।',
    network: 'সার্ভারে সংযোগ করা যাচ্ছে না। ইন্টারনেট সংযোগ দেখে আবার চেষ্টা করুন।',
    server: 'সার্ভার এই মুহূর্তে পাওয়া যাচ্ছে না। একটু পরে আবার চেষ্টা করুন।',
  },
} as const

type Copy = (typeof copy)[Language]
type Respond = Parameters<typeof playgroundApi>[0]

function setup(respond?: Respond, options: PlaygroundApiOptions = {}, session: unknown = SESSION) {
  mockApi({
    '/api/auth/get-session': () => json(200, session),
    ...summaryApi(),
    ...playgroundApi(respond, options),
  })
}

async function openPlayground(language: Language) {
  const rendered = renderAppRoute('/playground', language)
  await screen.findByRole('heading', { name: copy[language].heading, level: 1 })
  return rendered
}

const posts = () => callsTo(PLAYGROUND_TEST).map((call) => call.body)
const testButton = (t: Copy) => screen.getByRole('button', { name: t.test }) as HTMLButtonElement
const testsLeft = () => screen.getByTestId('tests-left')
const result = () => within(screen.getByTestId('playground-result'))

function type(t: Copy, text: string) {
  fireEvent.change(screen.getByLabelText(t.comment), { target: { value: text } })
}

async function runTest(t: Copy, text = 'bkash e taka pathan') {
  type(t, text)
  fireEvent.click(testButton(t))
}

async function errorText() {
  return (await screen.findByRole('alert')).textContent
}

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  stubAppGlobals()
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe.each(['en', 'bn'] as const)('/playground (%s)', (language: Language) => {
  const t = copy[language]

  it('renders the form with today’s tests left, Facebook picked, nothing sent', async () => {
    setup()
    await openPlayground(language)

    await waitFor(() => expect(testsLeft().textContent).toBe(t.left))
    expect(screen.getByTestId('text-count').textContent).toBe(t.count)
    expect((screen.getByRole('radio', { name: t.facebook }) as HTMLInputElement).checked).toBe(true)
    expect(testButton(t).disabled).toBe(false)
    expect(screen.queryByTestId('playground-result')).toBeNull()
    expect(posts()).toEqual([])
    expect(callsTo(PLAYGROUND_USAGE)).toHaveLength(1)
  })

  it('checks the text before sending: empty and over 2,000 characters', async () => {
    setup()
    await openPlayground(language)

    fireEvent.click(testButton(t))
    expect(screen.getByText(t.empty)).toBeTruthy()
    type(t, '   ')
    fireEvent.click(testButton(t))
    expect(screen.getByText(t.empty)).toBeTruthy()
    type(t, 'x'.repeat(2_001))
    fireEvent.click(testButton(t))
    expect(screen.getByText(t.tooLong)).toBeTruthy()
    // Surrounding spaces don't count.
    type(t, `  ${'x'.repeat(2_000)}  `)
    fireEvent.click(testButton(t))
    await screen.findByTestId('playground-result')
    expect(screen.queryByText(t.tooLong)).toBeNull()
    expect(posts()).toEqual([{ text: 'x'.repeat(2_000), platform: 'FACEBOOK' }])
  })

  it('sends the trimmed text + platform and shows a rule hit; tests left follow the answer', async () => {
    setup(() =>
      json(
        200,
        playgroundResult({
          ruleMatch: { kind: 'keyword', value: 'cashback' },
          classification: null,
          decision: { action: 'DELETE', status: 'DELETED', reason: 'policy' },
        }),
      ),
    )
    await openPlayground(language)
    await waitFor(() => expect(testsLeft().textContent).toBe(t.left))

    type(t, '  Hello  ')
    expect(screen.getByTestId('text-count').textContent).toBe(t.countTyped)
    fireEvent.click(screen.getByRole('radio', { name: t.instagram }))
    fireEvent.click(testButton(t))

    await screen.findByTestId('playground-result')
    expect(posts()).toEqual([{ text: 'Hello', platform: 'INSTAGRAM' }])
    expect(result().getByTestId('result-rule').textContent).toContain(t.keyword)
    expect(result().getByTestId('result-rule').textContent).toContain('“cashback”')
    expect(result().queryByTestId('result-ai')).toBeNull()
    expect(result().getByTestId('result-decision').textContent).toBe(t.del)
    expect(result().getByTestId('result-latency').textContent).toBe(t.latency)
    expect(testsLeft().textContent).toBe(t.leftAfter)
    // No refetch: the answer's count is used.
    expect(callsTo(PLAYGROUND_USAGE)).toHaveLength(1)
  })

  it('shows an AI result with category, confidence, reasoning and each decision kind', async () => {
    const answers = [
      playgroundResult(),
      playgroundResult({ decision: { action: 'DELETE', status: 'DELETED', reason: 'policy' } }),
      playgroundResult({
        classification: { category: 'SAFE_INQUIRY', confidence: 0.93, reasoning: 'Asks about the price.', language: 'banglish' },
        decision: { action: 'NONE', status: 'VISIBLE', reason: 'policy' },
      }),
      playgroundResult({ decision: { action: 'NONE', status: 'NEEDS_REVIEW', reason: 'review_mode' } }),
      playgroundResult({ decision: { action: 'NONE', status: 'NEEDS_REVIEW', reason: 'below_threshold' } }),
    ]
    let call = 0
    setup(() => json(200, answers[call++]))
    await openPlayground(language)

    await runTest(t)
    await waitFor(() => expect(result().getByTestId('result-decision').textContent).toBe(t.hide))
    const ai = within(result().getByTestId('result-ai'))
    expect(ai.getByText(t.scam)).toBeTruthy()
    expect(ai.getByTestId('result-confidence').textContent).toBe(t.confidence)
    expect(ai.getByText('Asks for a bKash payment.')).toBeTruthy()
    expect(result().queryByTestId('result-rule')).toBeNull()
    expect(result().queryByTestId('result-reply')).toBeNull()

    const expected = [t.del, t.visible, `${t.review}${t.reviewMode}`, `${t.review}${t.belowThreshold}`]
    for (const line of expected) {
      fireEvent.click(testButton(t))
      await waitFor(() => expect(result().getByTestId('result-decision').textContent).toBe(line))
    }
    expect(result().getByText(t.scam)).toBeTruthy()
    expect(posts()).toHaveLength(5)
  })

  it('shows the auto-reply preview when the decision has one', async () => {
    setup(() =>
      json(
        200,
        playgroundResult({
          classification: { category: 'SAFE_INQUIRY', confidence: 0.9, reasoning: 'Price question.', language: 'banglish' },
          decision: { action: 'NONE', status: 'VISIBLE', reason: 'policy', reply: { language: 'bn', text: 'ইনবক্স চেক করুন' } },
        }),
      ),
    )
    await openPlayground(language)

    await runTest(t, 'dam koto?')
    const reply = within(await screen.findByTestId('result-reply'))
    expect(reply.getByText(t.replyBn)).toBeTruthy()
    expect(reply.getByText('ইনবক্স চেক করুন')).toBeTruthy()
    expect(result().getByText(t.safe)).toBeTruthy()
  })

  it('no tests left today or playground off → Test is disabled; usage failure still lets you test', async () => {
    setup(undefined, { onUsage: () => json(200, { limit: 10, used: 10, testsLeft: 0, resetsAt: RESETS_AT }) })
    await openPlayground(language)
    await waitFor(() => expect(testsLeft().textContent).toBe(t.noneLeft))
    expect(testButton(t).disabled).toBe(true)
    cleanup()

    setup(undefined, { onUsage: () => json(200, { limit: 0, used: 0, testsLeft: 0, resetsAt: RESETS_AT }) })
    await openPlayground(language)
    await waitFor(() => expect(testsLeft().textContent).toBe(t.off))
    expect(testButton(t).disabled).toBe(true)
    cleanup()

    setup(undefined, { onUsage: () => json(503, { message: 'down' }) })
    await openPlayground(language)
    await waitFor(() => expect(testsLeft().textContent).toBe(t.usageFailed))
    await runTest(t)
    await screen.findByTestId('playground-result')
    expect(posts()).toHaveLength(1)
  })

  it('429: limit reached with the Dhaka reset time, then the count is reloaded', async () => {
    let usage = { limit: 10, used: 2, testsLeft: 8, resetsAt: RESETS_AT }
    setup(
      () => {
        usage = { ...usage, used: 10, testsLeft: 0 }
        return json(429, { message: 'x', code: 'PLAYGROUND_LIMIT_REACHED', details: { limit: 10, resetsAt: RESETS_AT } })
      },
      { onUsage: () => json(200, usage) },
    )
    await openPlayground(language)
    await waitFor(() => expect(testsLeft().textContent).toBe(t.left))

    await runTest(t)
    expect(await errorText()).toBe(t.limit(formatCommentTime(RESETS_AT, language)))
    await waitFor(() => expect(testsLeft().textContent).toBe(t.noneLeft))
    expect(testButton(t).disabled).toBe(true)
  })

  it('429 with limit 0: the playground is turned off', async () => {
    setup(() => json(429, { message: 'x', code: 'PLAYGROUND_LIMIT_REACHED', details: { limit: 0, resetsAt: RESETS_AT } }))
    await openPlayground(language)

    await runTest(t)
    expect(await errorText()).toBe(t.off)
  })

  it.each([
    ['503 AI not configured', 503, { code: 'PLAYGROUND_AI_NOT_CONFIGURED' }, 'aiOff'],
    ['502 retryable', 502, { code: 'PLAYGROUND_AI_FAILED', details: { errorKind: 'transient', retryable: true } }, 'aiRetry'],
    ['502 not retryable', 502, { code: 'PLAYGROUND_AI_FAILED', details: { errorKind: 'invalid_output', retryable: false } }, 'aiFailed'],
    ['400 validation', 400, { message: ['text must be shorter than or equal to 2000 characters'] }, 'invalid'],
    ['403', 403, { message: 'Forbidden' }, 'forbidden'],
    ['404', 404, { message: 'Not Found' }, 'notFound'],
    ['500', 500, { message: 'boom' }, 'server'],
  ] as const)('%s → its message', async (_name, status, body, key) => {
    setup(() => json(status, { message: 'x', ...body }))
    await openPlayground(language)

    await runTest(t)
    expect(await errorText()).toBe(t[key])
    expect(screen.queryByTestId('playground-result')).toBeNull()
  })

  it('network failure → offline message; the next test clears it', async () => {
    let fail = true
    setup(() => {
      if (fail) throw new TypeError('Failed to fetch')
      return json(200, playgroundResult())
    })
    await openPlayground(language)

    await runTest(t)
    expect(await errorText()).toBe(t.network)
    fail = false
    fireEvent.click(testButton(t))
    await screen.findByTestId('playground-result')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('an impersonating admin (or any member: no role gate) can test', async () => {
    setup(undefined, {}, IMPERSONATED)
    await openPlayground(language)

    await runTest(t)
    await screen.findByTestId('playground-result')
    expect(posts()).toEqual([{ text: 'bkash e taka pathan', platform: 'FACEBOOK' }])
  })
})
