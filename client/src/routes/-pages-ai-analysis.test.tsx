import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AiContextLevel } from '@/lib/moderation-policy'
import {
  IMPERSONATED,
  PAGES,
  POLICY,
  SESSION,
  page,
  pagesApi,
  policy,
  policyApi,
  renderAppRoute,
  stubAppGlobals,
  summaryApi,
} from '@/test/app-routes'
import { callsTo, fetchMock, json, mockApi } from '@/test/auth-routes'

// The server-render session function needs the Start compiler; the browser path never calls it.
vi.mock('@/server/session', () => ({ getServerSession: vi.fn() }))

/** M5-T15 (D8) "AI analysis" card on C6 `/pages` (harness `src/test/app-routes.tsx`). */

function deferred() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

const copy = {
  en: {
    title: 'AI analysis',
    intro: 'The commenter’s name and profile are never sent.',
    tradeOff: 'Sending more gives a better filter but shares more of your data.',
    countsOnce: 'Each comment counts once toward your monthly comment limit, whatever you choose.',
    credit: /credit/i,
    options: {
      comment_only: {
        label: 'Comment only',
        detail: 'Pro: sends the least data. Con: the AI reads only the comment text, so it can miss context.',
      },
      page_name: {
        label: '+ Page name',
        detail:
          'Pro: better at catching competitors who try to pull your buyers away. Con: your Page name is sent too.',
      },
      post_caption: {
        label: '+ Post caption',
        detail:
          'Pro: the most context, so the best filter. Con: your Page name and the post caption are sent too.',
      },
    } satisfies Record<AiContextLevel, { label: string; detail: string }>,
    default: 'Default',
    save: 'Save',
    saving: 'Saving…',
    saved: (label: string) => `Saved. New comments are analysed with “${label}”.`,
    notSaved: 'Your choice wasn’t saved.',
    server: 'The server is unavailable right now. Try again shortly.',
    forbidden: 'Only workspace owners and admins can change how comments are analysed.',
    loadFailed: 'Couldn’t load your AI analysis setting.',
    retry: 'Try again',
  },
  bn: {
    title: 'AI বিশ্লেষণ',
    intro: 'কমেন্টকারীর নাম ও প্রোফাইল কখনো পাঠানো হয় না।',
    tradeOff: 'বেশি তথ্য পাঠালে ফিল্টার আরও ভালো হয়, তবে আপনার বেশি তথ্য শেয়ার হয়।',
    countsOnce: 'যেটাই বেছে নিন, প্রতিটি কমেন্ট আপনার মাসিক কমেন্ট সীমায় একবারই গোনা হয়।',
    credit: /ক্রেডিট|credit/i,
    options: {
      comment_only: {
        label: 'শুধু কমেন্ট',
        detail: 'সুবিধা: সবচেয়ে কম তথ্য পাঠানো হয়। অসুবিধা: AI শুধু কমেন্টের লেখা পড়ে, তাই প্রসঙ্গ বুঝতে ভুল হতে পারে।',
      },
      page_name: {
        label: '+ পেজের নাম',
        detail:
          'সুবিধা: আপনার ক্রেতা টেনে নিতে চাওয়া প্রতিযোগীদের আরও ভালোভাবে ধরে। অসুবিধা: আপনার পেজের নামও পাঠানো হয়।',
      },
      post_caption: {
        label: '+ পোস্টের ক্যাপশন',
        detail:
          'সুবিধা: সবচেয়ে বেশি প্রসঙ্গ, তাই সবচেয়ে ভালো ফিল্টার। অসুবিধা: আপনার পেজের নাম ও পোস্টের ক্যাপশনও পাঠানো হয়।',
      },
    } satisfies Record<AiContextLevel, { label: string; detail: string }>,
    default: 'ডিফল্ট',
    save: 'সেভ করুন',
    saving: 'সেভ হচ্ছে…',
    saved: (label: string) => `সেভ হয়েছে। নতুন কমেন্ট “${label}” দিয়ে বিশ্লেষণ করা হবে।`,
    notSaved: 'আপনার পছন্দ সেভ হয়নি।',
    server: 'সার্ভার এই মুহূর্তে পাওয়া যাচ্ছে না। একটু পরে আবার চেষ্টা করুন।',
    forbidden: 'শুধু ওয়ার্কস্পেসের মালিক ও অ্যাডমিন কমেন্ট বিশ্লেষণের ধরন বদলাতে পারেন।',
    loadFailed: 'আপনার AI বিশ্লেষণের সেটিং লোড করা যায়নি।',
    retry: 'আবার চেষ্টা করুন',
  },
} as const

const LEVELS: AiContextLevel[] = ['comment_only', 'page_name', 'post_caption']

const patches = () => callsTo(POLICY).filter((call) => call.method === 'PATCH')
const gets = () => callsTo(POLICY).filter((call) => call.method === 'GET')

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  stubAppGlobals()
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe.each(['en', 'bn'] as const)('/pages AI analysis card (%s)', (language) => {
  const t = copy[language]
  const card = () => screen.findByRole('region', { name: t.title })
  const radio = (level: AiContextLevel) => screen.findByRole('radio', { name: t.options[level].label })
  const saveButton = () => screen.getByRole('button', { name: t.save })

  it('shows the 3 options with label and data trade-off (no credit costs); the default is selected and Save is off', async () => {
    mockApi({ '/api/auth/get-session': () => json(200, SESSION), ...pagesApi([page()]) })
    renderAppRoute('/pages', language)

    const region = await card()
    expect(region.textContent).toContain(t.intro)
    expect(region.textContent).toContain(t.tradeOff)
    expect(region.textContent).toContain(t.countsOnce)
    // PW-D1: every level counts 1 comment, so no credit cost anywhere on the card.
    expect(region.textContent).not.toMatch(t.credit)
    expect(region.querySelector('[data-credits]')).toBeNull()
    // Below the Pages list.
    const list = screen.getByRole('list', { name: /Your Pages|আপনার পেজসমূহ/ })
    expect(list.compareDocumentPosition(region) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    const radios = await within(region).findAllByRole('radio')
    expect(radios).toHaveLength(3)
    for (const [index, level] of LEVELS.entries()) {
      const input = await radio(level)
      expect(input).toBe(radios[index])
      // The accessible description is the one-line pro/con.
      const description = (input.getAttribute('aria-describedby') ?? '')
        .split(' ')
        .map((id) => document.getElementById(id)?.textContent)
        .join(' ')
      expect(description).toBe(t.options[level].detail)
      const option = region.querySelector(`[data-level="${level}"]`)!
      expect(option.textContent?.includes(t.default)).toBe(level === 'comment_only')
    }
    expect(((await radio('comment_only')) as HTMLInputElement).checked).toBe(true)
    expect(((await radio('page_name')) as HTMLInputElement).checked).toBe(false)
    expect(saveButton().hasAttribute('disabled')).toBe(true)
    expect(gets()).toHaveLength(1)
  })

  it('selects the saved level from the policy', async () => {
    mockApi({ '/api/auth/get-session': () => json(200, SESSION), ...pagesApi([page()]), ...policyApi('post_caption') })
    renderAppRoute('/pages', language)

    expect(((await radio('post_caption')) as HTMLInputElement).checked).toBe(true)
    expect(((await radio('comment_only')) as HTMLInputElement).checked).toBe(false)
    expect(saveButton().hasAttribute('disabled')).toBe(true)
  })

  it('saves a changed level: PATCH { aiContextLevel }, pending state, success notice, cache updated', async () => {
    const gate = deferred()
    const api = policyApi('comment_only')
    mockApi({
      '/api/auth/get-session': () => json(200, SESSION),
      ...pagesApi([page()]),
      [POLICY]: async (init?: RequestInit) => {
        if (init?.method === 'PATCH') await gate.promise
        return api[POLICY](init)
      },
    })
    renderAppRoute('/pages', language)

    fireEvent.click(await radio('page_name'))
    expect(((await radio('page_name')) as HTMLInputElement).checked).toBe(true)
    expect(saveButton().hasAttribute('disabled')).toBe(false)
    fireEvent.click(saveButton())

    const pending = await screen.findByRole('button', { name: t.saving })
    expect(pending.hasAttribute('disabled')).toBe(true)
    expect(pending.getAttribute('aria-busy')).toBe('true')
    expect((await radio('post_caption')).matches(':disabled')).toBe(true)
    gate.release()

    await waitFor(() => expect(document.querySelector('[data-kind="ai-analysis-saved"]')?.textContent).toBe(t.saved(t.options.page_name.label)))
    expect(patches()).toEqual([{ path: POLICY, method: 'PATCH', body: { aiContextLevel: 'page_name' } }])
    expect(((await radio('page_name')) as HTMLInputElement).checked).toBe(true)
    expect((await radio('page_name')).matches(':disabled')).toBe(false)
    // Saved = unchanged again; the answer went into the cache, no refetch.
    expect(saveButton().hasAttribute('disabled')).toBe(true)
    expect(gets()).toHaveLength(1)

    // A new choice clears the notice; going back to the saved one disables Save again.
    fireEvent.click(await radio('post_caption'))
    expect(document.querySelector('[data-kind="ai-analysis-saved"]')).toBeNull()
    expect(saveButton().hasAttribute('disabled')).toBe(false)
    fireEvent.click(await radio('page_name'))
    expect(saveButton().hasAttribute('disabled')).toBe(true)
    expect(patches()).toHaveLength(1)
  })

  it('choosing the saved level again keeps Save disabled and sends nothing', async () => {
    mockApi({ '/api/auth/get-session': () => json(200, SESSION), ...pagesApi([page()]), ...policyApi('page_name') })
    renderAppRoute('/pages', language)

    fireEvent.click(await radio('comment_only'))
    expect(saveButton().hasAttribute('disabled')).toBe(false)
    fireEvent.click(await radio('page_name'))
    expect(saveButton().hasAttribute('disabled')).toBe(true)
    fireEvent.click(saveButton())
    expect(patches()).toHaveLength(0)
  })

  it('a failed save shows the error and keeps the choice for another try', async () => {
    let fail = true
    mockApi({
      '/api/auth/get-session': () => json(200, SESSION),
      ...pagesApi([page()]),
      ...policyApi('comment_only', {
        onPatch: (body) =>
          fail
            ? json(500, { statusCode: 500, message: 'Internal server error' })
            : json(200, { ...policy(body as { aiContextLevel: AiContextLevel }), changed: true }),
      }),
    })
    renderAppRoute('/pages', language)

    fireEvent.click(await radio('post_caption'))
    fireEvent.click(saveButton())

    const error = await waitFor(() => {
      const node = document.querySelector('[data-kind="ai-analysis-save"]')
      expect(node).not.toBeNull()
      return node!
    })
    expect(error.getAttribute('role')).toBe('alert')
    expect(error.textContent).toBe(`${t.notSaved} ${t.server}`)
    expect(((await radio('post_caption')) as HTMLInputElement).checked).toBe(true)
    expect(saveButton().hasAttribute('disabled')).toBe(false)

    fail = false
    fireEvent.click(saveButton())
    await waitFor(() =>
      expect(document.querySelector('[data-kind="ai-analysis-saved"]')?.textContent).toBe(t.saved(t.options.post_caption.label)),
    )
    expect(document.querySelector('[data-kind="ai-analysis-save"]')).toBeNull()
    expect(patches().map((call) => call.body)).toEqual([{ aiContextLevel: 'post_caption' }, { aiContextLevel: 'post_caption' }])
  })

  it('a 403 on save says only owners and admins can change it', async () => {
    mockApi({
      '/api/auth/get-session': () => json(200, SESSION),
      ...pagesApi([page()]),
      ...policyApi('comment_only', { onPatch: () => json(403, { statusCode: 403, message: 'Forbidden' }) }),
    })
    renderAppRoute('/pages', language)

    fireEvent.click(await radio('page_name'))
    fireEvent.click(saveButton())
    await waitFor(() =>
      expect(document.querySelector('[data-kind="ai-analysis-save"]')?.textContent).toBe(`${t.notSaved} ${t.forbidden}`),
    )
  })

  it('shows skeletons while loading, then a load error with Try again that refetches', async () => {
    const gate = deferred()
    let calls = 0
    mockApi({
      '/api/auth/get-session': () => json(200, SESSION),
      ...pagesApi([page()]),
      ...policyApi('page_name', {
        onGet: async () => {
          calls += 1
          if (calls === 1) {
            await gate.promise
            return json(503, { statusCode: 503, message: 'Service Unavailable' })
          }
          return json(200, policy({ aiContextLevel: 'page_name' }))
        },
      }),
    })
    renderAppRoute('/pages', language)

    await card()
    expect(await screen.findByTestId('ai-analysis-loading')).toBeTruthy()
    expect(screen.queryAllByRole('radio')).toHaveLength(0)
    gate.release()

    const error = await waitFor(() => {
      const node = document.querySelector('[data-kind="ai-analysis-load"]')
      expect(node).not.toBeNull()
      return node as HTMLElement
    })
    expect(error.textContent).toContain(`${t.loadFailed} ${t.server}`)
    expect(screen.queryByRole('button', { name: t.save })).toBeNull()

    fireEvent.click(within(error).getByRole('button', { name: t.retry }))
    expect(((await radio('page_name')) as HTMLInputElement).checked).toBe(true)
    expect(document.querySelector('[data-kind="ai-analysis-load"]')).toBeNull()
    expect(calls).toBe(2)
  })

  it('a 403 on load shows the owner/admin message', async () => {
    mockApi({
      '/api/auth/get-session': () => json(200, SESSION),
      ...pagesApi([page()]),
      ...policyApi('comment_only', { onGet: () => json(403, { statusCode: 403, message: 'Forbidden' }) }),
    })
    renderAppRoute('/pages', language)

    await waitFor(() => expect(document.querySelector('[data-kind="ai-analysis-load"]')?.textContent).toContain(t.forbidden))
  })

  it('an impersonated session can change and save it', async () => {
    mockApi({ '/api/auth/get-session': () => json(200, IMPERSONATED), ...pagesApi([page()]) })
    renderAppRoute('/pages', language)

    fireEvent.click(await radio('post_caption'))
    fireEvent.click(saveButton())
    await waitFor(() =>
      expect(document.querySelector('[data-kind="ai-analysis-saved"]')?.textContent).toBe(t.saved(t.options.post_caption.label)),
    )
    expect(patches()).toEqual([{ path: POLICY, method: 'PATCH', body: { aiContextLevel: 'post_caption' } }])
  })

  it('shows with an empty Pages list, but not when the list failed (and then never loads the policy)', async () => {
    mockApi({ '/api/auth/get-session': () => json(200, SESSION), ...pagesApi([]) })
    renderAppRoute('/pages', language)
    await screen.findByTestId('pages-empty')
    expect(await card()).toBeTruthy()
    cleanup()

    fetchMock.mockReset()
    mockApi({
      '/api/auth/get-session': () => json(200, SESSION),
      ...summaryApi(),
      [PAGES]: () => json(403, { statusCode: 403, message: 'Forbidden' }),
    })
    renderAppRoute('/pages', language)
    await waitFor(() => expect(document.querySelector('[data-kind="pages-load"]')).not.toBeNull())
    expect(screen.queryByRole('region', { name: t.title })).toBeNull()
    expect(callsTo(POLICY)).toHaveLength(0)
  })
})
