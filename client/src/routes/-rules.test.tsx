import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Language } from '@/lib/language'
import type { ModerationPolicy } from '@/lib/moderation-policy'
import {
  dashboardApi,
  IMPERSONATED,
  POLICY,
  policy,
  policyApi,
  type PolicyApiOptions,
  renderAppRoute,
  SESSION,
  stubAppGlobals,
  summaryApi,
} from '@/test/app-routes'
import { callsTo, fetchMock, json, mockApi } from '@/test/auth-routes'

// The server-render session function needs the Start compiler; the browser path never calls it.
vi.mock('@/server/session', () => ({ getServerSession: vi.fn() }))

// C7 `/rules` (M6-T10; D2 b, D4, D5, D6, D14): real `_app` + route files (harness `src/test/app-routes.tsx`).

const copy = {
  en: {
    heading: 'Rules',
    safe: 'Safe inquiry',
    scam: 'Scam / phishing',
    safeDesc: 'Normal questions about price, size, stock or delivery.',
    action: 'Action',
    show: 'Show',
    hide: 'Hide',
    del: 'Delete',
    mode: 'Mode',
    auto: 'Auto',
    review: 'Review',
    threshold: 'Confidence needed to act',
    seventy: '70%',
    eightyFive: '85%',
    save: 'Save',
    discard: 'Discard',
    saved: 'Rules saved. New comments follow them.',
    autoReply: 'Auto-reply',
    replyEn: 'Reply in English',
    replyBn: 'Reply in Bangla',
    missing: 'Write both an English and a Bangla reply for every auto-reply you switch on.',
    keywordInput: 'New keyword',
    add: 'Add',
    remove: (item: string) => `Remove ${item}`,
    keywordDupe: 'This keyword is already in the list.',
    keywordLong: 'Keep a keyword to 50 characters or fewer.',
    keywordLimit: 'You can block up to 200 keywords.',
    keywordPlan: 'Custom keywords are on the Growth and Pro plans.',
    autoReplyPlan: 'Auto-replies are on the Growth and Pro plans.',
    urlPhonePlan: 'Link and phone number blocking needs an active plan.',
    links: 'Block links',
    phones: 'Block phone numbers',
    domainInput: 'New domain',
    domainInvalid: 'Write a domain name like myshop.com.',
    phoneAction: 'When a phone number matches',
    forbidden: 'Only workspace owners and admins can see and change the moderation rules.',
    leave: 'You have unsaved changes. Leave without saving?',
    loadFailed: 'Couldn’t load your rules',
    retry: 'Try again',
    prefix: 'Your rules weren’t saved.',
    errors: {
      keywordInvalid: 'The keyword “x” can’t be used. Keywords are 1–50 characters.',
      keywordsLimit: 'You can block up to 200 keywords.',
      domainInvalid: '“bad” isn’t a domain name. Write it like myshop.com.',
      domainsLimit: 'You can allow up to 20 domains.',
      textsRequired: 'Write both an English and a Bangla reply before switching on the auto-reply for “Scam / phishing”.',
      validation: 'Some settings aren’t valid. Check them and try again.',
      planKeywords: 'Custom keywords are on the Growth and Pro plans.',
      planReplies: 'Auto-replies are on the Growth and Pro plans.',
      planUrlPhone: 'Link and phone number blocking needs an active plan.',
      forbidden: 'Only workspace owners and admins can see and change the moderation rules.',
      network: 'Can’t reach the server. Check your connection and try again.',
      server: 'The server is unavailable right now. Try again shortly.',
    },
  },
  bn: {
    heading: 'নিয়ম',
    safe: 'সাধারণ জিজ্ঞাসা',
    scam: 'স্ক্যাম / ফিশিং',
    safeDesc: 'দাম, সাইজ, স্টক বা ডেলিভারি নিয়ে সাধারণ প্রশ্ন।',
    action: 'অ্যাকশন',
    show: 'দেখান',
    hide: 'হাইড করুন',
    del: 'ডিলিট করুন',
    mode: 'মোড',
    auto: 'অটো',
    review: 'রিভিউ',
    threshold: 'অ্যাকশনের জন্য প্রয়োজনীয় নিশ্চয়তা',
    seventy: '৭০%',
    eightyFive: '৮৫%',
    save: 'সেভ করুন',
    discard: 'বাতিল করুন',
    saved: 'নিয়ম সেভ হয়েছে। নতুন কমেন্টে এগুলো প্রযোজ্য হবে।',
    autoReply: 'অটো-রিপ্লাই',
    replyEn: 'ইংরেজিতে উত্তর',
    replyBn: 'বাংলায় উত্তর',
    missing: 'যে অটো-রিপ্লাই চালু করবেন তার জন্য ইংরেজি ও বাংলা দুটো উত্তরই লিখুন।',
    keywordInput: 'নতুন কিওয়ার্ড',
    add: 'যোগ করুন',
    remove: (item: string) => `${item} সরান`,
    keywordDupe: 'এই কিওয়ার্ডটি আগেই তালিকায় আছে।',
    keywordLong: 'কিওয়ার্ড ৫০ অক্ষরের মধ্যে রাখুন।',
    keywordLimit: 'সর্বোচ্চ ২০০টি কিওয়ার্ড ব্লক করা যায়।',
    keywordPlan: 'কাস্টম কিওয়ার্ড গ্রোথ ও প্রো প্ল্যানে আছে।',
    autoReplyPlan: 'অটো-রিপ্লাই গ্রোথ ও প্রো প্ল্যানে আছে।',
    urlPhonePlan: 'লিংক ও ফোন নম্বর ব্লক করতে একটি চালু প্ল্যান লাগবে।',
    links: 'লিংক ব্লক করুন',
    phones: 'ফোন নম্বর ব্লক করুন',
    domainInput: 'নতুন ডোমেইন',
    domainInvalid: 'myshop.com এর মতো করে ডোমেইন নাম লিখুন।',
    phoneAction: 'ফোন নম্বর মিললে',
    forbidden: 'শুধু ওয়ার্কস্পেসের মালিক ও অ্যাডমিন মডারেশনের নিয়ম দেখতে ও বদলাতে পারেন।',
    leave: 'কিছু পরিবর্তন সেভ করা হয়নি। সেভ না করেই চলে যাবেন?',
    loadFailed: 'আপনার নিয়ম লোড করা যায়নি',
    retry: 'আবার চেষ্টা করুন',
    prefix: 'আপনার নিয়ম সেভ হয়নি।',
    errors: {
      keywordInvalid: '“x” কিওয়ার্ডটি ব্যবহার করা যাবে না। কিওয়ার্ড ১–৫০ অক্ষরের হতে হবে।',
      keywordsLimit: 'সর্বোচ্চ ২০০টি কিওয়ার্ড ব্লক করা যায়।',
      domainInvalid: '“bad” কোনো ডোমেইন নাম নয়। myshop.com এর মতো করে লিখুন।',
      domainsLimit: 'সর্বোচ্চ ২০টি ডোমেইন অনুমতি দেওয়া যায়।',
      textsRequired: '“স্ক্যাম / ফিশিং” এর অটো-রিপ্লাই চালুর আগে ইংরেজি ও বাংলা দুটো উত্তরই লিখুন।',
      validation: 'কিছু সেটিং সঠিক নয়। দেখে আবার চেষ্টা করুন।',
      planKeywords: 'কাস্টম কিওয়ার্ড গ্রোথ ও প্রো প্ল্যানে আছে।',
      planReplies: 'অটো-রিপ্লাই গ্রোথ ও প্রো প্ল্যানে আছে।',
      planUrlPhone: 'লিংক ও ফোন নম্বর ব্লক করতে একটি চালু প্ল্যান লাগবে।',
      forbidden: 'শুধু ওয়ার্কস্পেসের মালিক ও অ্যাডমিন মডারেশনের নিয়ম দেখতে ও বদলাতে পারেন।',
      network: 'সার্ভারে সংযোগ করা যাচ্ছে না। ইন্টারনেট সংযোগ দেখে আবার চেষ্টা করুন।',
      server: 'সার্ভার এই মুহূর্তে পাওয়া যাচ্ছে না। একটু পরে আবার চেষ্টা করুন।',
    },
  },
} as const

type Copy = (typeof copy)[Language]

/** Growth-like plan: every rule feature available. */
const GROWTH: Partial<ModerationPolicy> = { autoReplyAvailable: true, keywordRulesAvailable: true, urlPhoneRulesAvailable: true }

function setup(initial: Partial<ModerationPolicy> = {}, options: PolicyApiOptions = {}, session: unknown = SESSION) {
  mockApi({
    '/api/auth/get-session': () => json(200, session),
    ...summaryApi(),
    ...dashboardApi(),
    ...policyApi('comment_only', { ...options, initial }),
  })
}

async function openRules(language: Language) {
  const rendered = renderAppRoute('/rules', language)
  await screen.findByTestId('rules-general')
  return rendered
}

const card = (category: string) => within(screen.getByTestId(`category-${category}`))
const patches = () => callsTo(POLICY).filter((call) => call.method === 'PATCH').map((call) => call.body)
const saveButton = (t: Copy) => screen.getByRole('button', { name: t.save }) as HTMLButtonElement
const keywords = () => within(screen.getByTestId('rules-keywords'))

async function saveAndWait(t: Copy) {
  fireEvent.click(saveButton(t))
  expect(await screen.findByText(t.saved)).toBeTruthy()
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

describe.each(['en', 'bn'] as const)('/rules (%s)', (language: Language) => {
  const t = copy[language]

  it('loads the policy into category cards, mode and threshold; Save waits for a change', async () => {
    setup()
    await openRules(language)

    expect(screen.getByRole('heading', { name: t.heading, level: 1 })).toBeTruthy()
    expect(card('SAFE_INQUIRY').getByRole('heading', { name: t.safe })).toBeTruthy()
    expect(card('SAFE_INQUIRY').getByText(t.safeDesc)).toBeTruthy()
    expect((card('SAFE_INQUIRY').getByRole('radio', { name: t.show }) as HTMLInputElement).checked).toBe(true)
    expect((card('SCAM_PHISHING').getByRole('radio', { name: t.hide }) as HTMLInputElement).checked).toBe(true)
    expect((screen.getByRole('radio', { name: t.auto }) as HTMLInputElement).checked).toBe(true)
    expect(screen.getByTestId('threshold-value').textContent).toBe(t.seventy)
    expect(saveButton(t).disabled).toBe(true)
    expect(patches()).toEqual([])
  })

  it('sends only the changed field and writes the answer back', async () => {
    setup()
    await openRules(language)

    fireEvent.click(card('SCAM_PHISHING').getByRole('radio', { name: t.del }))
    expect(saveButton(t).disabled).toBe(false)
    await saveAndWait(t)
    expect(patches()).toEqual([{ categories: { SCAM_PHISHING: { action: 'DELETE' } } }])
    expect((card('SCAM_PHISHING').getByRole('radio', { name: t.del }) as HTMLInputElement).checked).toBe(true)
    expect(saveButton(t).disabled).toBe(true)
  })

  it('changes mode and threshold; Discard drops the draft', async () => {
    setup()
    await openRules(language)

    fireEvent.click(card('SAFE_INQUIRY').getByRole('radio', { name: t.hide }))
    fireEvent.click(screen.getByRole('button', { name: t.discard }))
    expect((card('SAFE_INQUIRY').getByRole('radio', { name: t.show }) as HTMLInputElement).checked).toBe(true)

    fireEvent.click(screen.getByRole('radio', { name: t.review }))
    fireEvent.change(screen.getByRole('slider', { name: t.threshold }), { target: { value: '85' } })
    expect(screen.getByTestId('threshold-value').textContent).toBe(t.eightyFive)
    await saveAndWait(t)
    expect(patches()).toEqual([{ mode: 'REVIEW', confidenceThreshold: 0.85 }])
  })

  it('adds and removes keyword chips with the client limits', async () => {
    setup({ ...GROWTH, rules: { ...policy().rules, blockedKeywords: ['bkash agent'] } })
    await openRules(language)

    const input = keywords().getByRole('textbox', { name: t.keywordInput })
    const add = (text: string) => {
      fireEvent.change(input, { target: { value: text } })
      fireEvent.click(keywords().getByRole('button', { name: t.add }))
    }
    add('  Inbox   E  Price ')
    expect(keywords().getByText('inbox e price')).toBeTruthy()
    expect((input as HTMLInputElement).value).toBe('')
    add('BKASH agent')
    expect(keywords().getByText(t.keywordDupe)).toBeTruthy()
    add('x'.repeat(51))
    expect(keywords().getByText(t.keywordLong)).toBeTruthy()
    fireEvent.click(keywords().getByRole('button', { name: t.remove('bkash agent') }))

    await saveAndWait(t)
    expect(patches()).toEqual([{ rules: { blockedKeywords: ['inbox e price'] } }])
  })

  it('stops at 200 keywords', async () => {
    const full = Array.from({ length: 200 }, (_, i) => `word ${i}`)
    setup({ ...GROWTH, rules: { ...policy().rules, blockedKeywords: full } })
    await openRules(language)

    fireEvent.change(keywords().getByRole('textbox', { name: t.keywordInput }), { target: { value: 'one more' } })
    fireEvent.click(keywords().getByRole('button', { name: t.add }))
    expect(keywords().getByText(t.keywordLimit)).toBeTruthy()
    expect(saveButton(t).disabled).toBe(true)
  })

  it('shows plan messages and locks what the plan lacks (removing stays possible)', async () => {
    setup({ urlPhoneRulesAvailable: false, rules: { ...policy().rules, blockedKeywords: ['old word'] } })
    await openRules(language)

    expect(screen.getByTestId('keyword-plan-note').textContent).toContain(t.keywordPlan)
    expect(keywords().queryByRole('textbox')).toBeNull()
    expect(screen.getByTestId('auto-reply-plan-note-SAFE_INQUIRY').textContent).toContain(t.autoReplyPlan)
    expect((card('SAFE_INQUIRY').getByRole('switch', { name: t.autoReply }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByTestId('url-phone-plan-note').textContent).toContain(t.urlPhonePlan)
    expect((screen.getByRole('switch', { name: t.links }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('switch', { name: t.phones }) as HTMLButtonElement).disabled).toBe(true)

    fireEvent.click(keywords().getByRole('button', { name: t.remove('old word') }))
    await saveAndWait(t)
    expect(patches()).toEqual([{ rules: { blockedKeywords: [] } }])
  })

  it('switches link/phone rules, edits allowed domains and the per-kind action', async () => {
    setup()
    await openRules(language)

    expect(screen.queryByTestId('url-phone-plan-note')).toBeNull()
    fireEvent.click(screen.getByRole('switch', { name: t.links }))
    const links = within(screen.getByTestId('rules-links'))
    const domain = links.getByRole('textbox', { name: t.domainInput })
    fireEvent.change(domain, { target: { value: 'not a domain' } })
    fireEvent.click(links.getByRole('button', { name: t.add }))
    expect(links.getByText(t.domainInvalid)).toBeTruthy()
    fireEvent.change(domain, { target: { value: ' WWW.MyShop.com ' } })
    fireEvent.click(links.getByRole('button', { name: t.add }))
    expect(links.getByText('myshop.com')).toBeTruthy()
    const phoneActions = within(screen.getByRole('group', { name: t.phoneAction }))
    fireEvent.click(phoneActions.getByRole('radio', { name: t.del }))

    await saveAndWait(t)
    expect(patches()).toEqual([{ rules: { blockUrls: true, allowedDomains: ['myshop.com'], actions: { phone: 'DELETE' } } }])
  })

  it('needs both reply texts before an auto-reply can be saved', async () => {
    setup(GROWTH)
    await openRules(language)

    fireEvent.click(card('SAFE_INQUIRY').getByRole('switch', { name: t.autoReply }))
    fireEvent.change(card('SAFE_INQUIRY').getByRole('textbox', { name: t.replyEn }), { target: { value: '  Thanks! Check your inbox.  ' } })
    fireEvent.click(saveButton(t))
    expect(screen.getByRole('alert').textContent).toContain(t.missing)
    expect(card('SAFE_INQUIRY').getByRole('textbox', { name: t.replyBn }).getAttribute('aria-invalid')).toBe('true')
    expect(patches()).toEqual([])

    fireEvent.change(card('SAFE_INQUIRY').getByRole('textbox', { name: t.replyBn }), { target: { value: 'ধন্যবাদ! ইনবক্স দেখুন।' } })
    expect(screen.queryByRole('alert')).toBeNull()
    expect(card('SAFE_INQUIRY').getByRole('textbox', { name: t.replyEn }).getAttribute('maxlength')).toBe('500')
    await saveAndWait(t)
    expect(patches()).toEqual([
      { categories: { SAFE_INQUIRY: { autoReply: true, replyEn: 'Thanks! Check your inbox.', replyBn: 'ধন্যবাদ! ইনবক্স দেখুন।' } } },
    ])
  })

  it.each([
    ['400 BLOCKED_KEYWORD_INVALID', () => json(400, { code: 'BLOCKED_KEYWORD_INVALID', details: { keyword: 'x' } }), 'keywordInvalid'],
    ['400 BLOCKED_KEYWORDS_LIMIT', () => json(400, { code: 'BLOCKED_KEYWORDS_LIMIT', details: { max: 200 } }), 'keywordsLimit'],
    ['400 ALLOWED_DOMAIN_INVALID', () => json(400, { code: 'ALLOWED_DOMAIN_INVALID', details: { domain: 'bad' } }), 'domainInvalid'],
    ['400 ALLOWED_DOMAINS_LIMIT', () => json(400, { code: 'ALLOWED_DOMAINS_LIMIT', details: { max: 20 } }), 'domainsLimit'],
    ['400 AUTO_REPLY_TEXTS_REQUIRED', () => json(400, { code: 'AUTO_REPLY_TEXTS_REQUIRED', details: { category: 'SCAM_PHISHING' } }), 'textsRequired'],
    ['400 validation', () => json(400, { message: ['mode must be one of the following values'] }), 'validation'],
    ['409 customBlocklist', () => json(409, { code: 'PLAN_FEATURE_UNAVAILABLE', details: { feature: 'customBlocklist' } }), 'planKeywords'],
    ['409 autoReplyTemplates', () => json(409, { code: 'PLAN_FEATURE_UNAVAILABLE', details: { feature: 'autoReplyTemplates' } }), 'planReplies'],
    ['409 autoHideScams', () => json(409, { code: 'PLAN_FEATURE_UNAVAILABLE', details: { feature: 'autoHideScams' } }), 'planUrlPhone'],
    ['403', () => json(403, { message: 'Forbidden' }), 'forbidden'],
    ['network', () => Promise.reject(new TypeError('Failed to fetch')), 'network'],
    ['503', () => json(503, { message: 'down' }), 'server'],
  ] as const)('explains a failed save: %s', async (_name, respond, key) => {
    setup({}, { onPatch: respond })
    await openRules(language)

    fireEvent.click(card('SCAM_PHISHING').getByRole('radio', { name: t.del }))
    fireEvent.click(saveButton(t))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain(`${t.prefix} ${t.errors[key]}`)
    // The draft stays for another try.
    expect(saveButton(t).disabled).toBe(false)
  })

  it('tells a moderator (403 on load) that only owners and admins can see the rules', async () => {
    setup({}, { onGet: () => json(403, { message: 'Forbidden' }) })
    renderAppRoute('/rules', language)

    expect((await screen.findByTestId('rules-forbidden')).textContent).toBe(t.forbidden)
    expect(screen.queryByRole('button', { name: t.save })).toBeNull()
  })

  it('shows a load error with a retry', async () => {
    let fail = true
    setup({}, { onGet: () => (fail ? json(503, { message: 'down' }) : json(200, policy())) })
    renderAppRoute('/rules', language)

    const alert = await screen.findByRole('alert')
    expect(within(alert).getByText(t.loadFailed)).toBeTruthy()
    expect(within(alert).getByText(t.errors.server)).toBeTruthy()
    fail = false
    fireEvent.click(within(alert).getByRole('button', { name: t.retry }))
    expect(await screen.findByTestId('rules-general')).toBeTruthy()
  })

  it('lets an impersonating admin save', async () => {
    setup({}, {}, IMPERSONATED)
    await openRules(language)

    fireEvent.click(screen.getByRole('radio', { name: t.review }))
    await saveAndWait(t)
    expect(patches()).toEqual([{ mode: 'REVIEW' }])
  })

  it('asks before leaving with unsaved changes', async () => {
    setup()
    const { history } = await openRules(language)
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    const dashboardLink = within(screen.getByTestId('app-sidebar')).getAllByRole('link')[0]!

    // Clean form: no question.
    fireEvent.click(dashboardLink)
    await waitFor(() => expect(history.location.pathname).toBe('/dashboard'))
    expect(confirm).not.toHaveBeenCalled()
    fireEvent.click(within(screen.getByTestId('app-sidebar')).getAllByRole('link')[3]!)
    await screen.findByTestId('rules-general')

    fireEvent.click(screen.getByRole('radio', { name: t.review }))
    fireEvent.click(within(screen.getByTestId('app-sidebar')).getAllByRole('link')[0]!)
    await waitFor(() => expect(confirm).toHaveBeenCalledWith(t.leave))
    expect(history.location.pathname).toBe('/rules')

    confirm.mockReturnValue(true)
    fireEvent.click(within(screen.getByTestId('app-sidebar')).getAllByRole('link')[0]!)
    await waitFor(() => expect(history.location.pathname).toBe('/dashboard'))
    expect(patches()).toEqual([])
  })
})
