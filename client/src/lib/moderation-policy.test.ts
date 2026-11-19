import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/lib/api'
import {
  AI_CONTEXT_LEVELS,
  aiContextLevelSaveErrorMessage,
  DEFAULT_AI_CONTEXT_LEVEL,
  isAiContextLevel,
  moderationPolicyLoadErrorMessage,
  moderationPolicyQueryKey,
  moderationPolicyQueryOptions,
  policyFromUpdate,
  updateAiContextLevel,
  type ModerationPolicy,
  type ModerationPolicyUpdate,
} from '@/lib/moderation-policy'

const en = (english: string) => english
const bn = (_: string, bangla: string) => bangla

const fetchMock = vi.fn<typeof fetch>()

const rule = { action: 'HIDE', autoReply: false, replyEn: null, replyBn: null } as const
function policy(overrides: Partial<ModerationPolicy> = {}): ModerationPolicy {
  return {
    workspaceId: 'w1',
    mode: 'AUTO',
    confidenceThreshold: 0.7,
    aiContextLevel: 'comment_only',
    categories: {
      SAFE_INQUIRY: { ...rule, action: 'NONE' },
      COMPETITOR_POACH: rule,
      SCAM_PHISHING: rule,
      SPAM_IRRELEVANT: rule,
      ABUSIVE_TOXIC: rule,
    },
    autoReplyAvailable: false,
    updatedAt: '2026-11-19T00:00:00.000Z',
    ...overrides,
  }
}

afterEach(() => {
  fetchMock.mockReset()
  vi.unstubAllGlobals()
})

describe('AI context levels (D8)', () => {
  it('mirrors the backend levels and default (no credit costs since PW-D1)', async () => {
    expect(AI_CONTEXT_LEVELS).toEqual(['comment_only', 'page_name', 'post_caption'])
    expect(DEFAULT_AI_CONTEXT_LEVEL).toBe('comment_only')
    expect(Object.keys(await import('@/lib/moderation-policy')).some((name) => /credit/i.test(name))).toBe(false)
  })

  it('isAiContextLevel accepts only the known levels', () => {
    for (const level of AI_CONTEXT_LEVELS) expect(isAiContextLevel(level)).toBe(true)
    for (const value of ['', 'COMMENT_ONLY', 'author', 'toString', null, undefined, 1]) {
      expect(isAiContextLevel(value)).toBe(false)
    }
  })
})

describe('policy API', () => {
  it('uses a workspace-scoped query key and GETs the policy', async () => {
    expect(moderationPolicyQueryKey('w 1')).toEqual(['workspace', 'w 1', 'moderation', 'policy'])
    fetchMock.mockResolvedValue(new Response(JSON.stringify(policy()), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const options = moderationPolicyQueryOptions('w 1')
    expect(options.queryKey).toEqual(['workspace', 'w 1', 'moderation', 'policy'])
    const queryFn = options.queryFn as () => Promise<unknown>
    await expect(queryFn()).resolves.toEqual(policy())
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('/api/workspaces/w%201/moderation/policy')
    expect(init?.method).toBe('GET')
  })

  it('PATCHes only { aiContextLevel }', async () => {
    const answer = { ...policy({ aiContextLevel: 'page_name' }), changed: true }
    fetchMock.mockResolvedValue(new Response(JSON.stringify(answer), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(updateAiContextLevel('w1', 'page_name')).resolves.toEqual(answer)
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('/api/workspaces/w1/moderation/policy')
    expect(init?.method).toBe('PATCH')
    expect(JSON.parse(String(init?.body))).toEqual({ aiContextLevel: 'page_name' })
  })

  it('policyFromUpdate drops `changed` and keeps the rest', () => {
    const update: ModerationPolicyUpdate = { ...policy({ aiContextLevel: 'post_caption' }), changed: false }
    const result = policyFromUpdate(update)
    expect(result).toEqual(policy({ aiContextLevel: 'post_caption' }))
    expect('changed' in result).toBe(false)
    expect(update.changed).toBe(false)
  })
})

describe('messages', () => {
  it('load errors: 403, 404, network, 5xx (en + bn)', () => {
    expect(moderationPolicyLoadErrorMessage(new ApiError(403, 'Forbidden'), en)).toBe(
      'Only workspace owners and admins can change how comments are analysed.',
    )
    expect(moderationPolicyLoadErrorMessage(new ApiError(403, 'Forbidden'), bn)).toBe(
      'শুধু ওয়ার্কস্পেসের মালিক ও অ্যাডমিন কমেন্ট বিশ্লেষণের ধরন বদলাতে পারেন।',
    )
    expect(moderationPolicyLoadErrorMessage(new ApiError(404, 'Not Found'), en)).toBe('This workspace couldn’t be found.')
    expect(moderationPolicyLoadErrorMessage(new ApiError(0, 'Network error'), en)).toBe(
      'Couldn’t load your AI analysis setting. Can’t reach the server. Check your connection and try again.',
    )
    expect(moderationPolicyLoadErrorMessage(new ApiError(503, 'x'), bn)).toBe(
      'আপনার AI বিশ্লেষণের সেটিং লোড করা যায়নি। সার্ভার এই মুহূর্তে পাওয়া যাচ্ছে না। একটু পরে আবার চেষ্টা করুন।',
    )
  })

  it('save errors: 403, 404, 400, 5xx (en + bn)', () => {
    expect(aiContextLevelSaveErrorMessage(new ApiError(403, 'Forbidden'), en)).toBe(
      'Your choice wasn’t saved. Only workspace owners and admins can change how comments are analysed.',
    )
    expect(aiContextLevelSaveErrorMessage(new ApiError(403, 'Forbidden'), bn)).toBe(
      'আপনার পছন্দ সেভ হয়নি। শুধু ওয়ার্কস্পেসের মালিক ও অ্যাডমিন কমেন্ট বিশ্লেষণের ধরন বদলাতে পারেন।',
    )
    expect(aiContextLevelSaveErrorMessage(new ApiError(404, 'Not Found'), en)).toBe(
      'Your choice wasn’t saved. This workspace couldn’t be found.',
    )
    expect(aiContextLevelSaveErrorMessage(new ApiError(400, 'Bad Request'), en)).toBe(
      'Your choice wasn’t saved. Something went wrong (400). Try again.',
    )
    expect(aiContextLevelSaveErrorMessage(new ApiError(500, 'x'), en)).toBe(
      'Your choice wasn’t saved. The server is unavailable right now. Try again shortly.',
    )
  })
})
