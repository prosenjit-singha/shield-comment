import { queryOptions } from '@tanstack/react-query'
import { apiFetch, type ApiError } from '@/lib/api'
import type { ContentFn } from '@/lib/auth-errors'
import type { CommentPlatform, CommentStatus } from '@/lib/comments-feed'
import { formatCommentTime } from '@/lib/comments-feed'
import { formatCount } from '@/lib/dashboard-summary'
import type { Language } from '@/lib/language'
import { genericFailure } from '@/lib/meta-messages'
import type { ModerationCategory, RuleKind } from '@/lib/moderation-policy'

/*
 * C8 `/playground` data (M6-T11; D9/D7 answered 2026-11-20). Every member, impersonated ok.
 * - `GET /api/workspaces/:workspaceId/playground/usage` → `{ limit, used, testsLeft, resetsAt }` (read only).
 * - `POST …/playground/test` `{ text 1–2,000 trimmed, platform? }` → `PlaygroundResult` (stores nothing,
 *   never calls Meta). Mirrors `backend/src/moderation/dto/playground.dto.ts`.
 */

export const PLAYGROUND_TEXT_MAX = 2_000

export interface PlaygroundUsage {
  /** Admin setting; 0 = playground off. */
  limit: number
  used: number
  testsLeft: number
  /** Next Dhaka midnight (ISO). */
  resetsAt: string
}

export interface PlaygroundResult {
  ruleMatch: { kind: RuleKind; value: string } | null
  classification: { category: ModerationCategory; confidence: number; reasoning: string; language: string } | null
  decision: {
    action: 'NONE' | 'HIDE' | 'UNHIDE' | 'DELETE'
    status: CommentStatus
    reason: string
    reply?: { language: 'en' | 'bn'; text: string }
  }
  latencyMs: number
  testsLeft: number
}

export interface PlaygroundInput {
  text: string
  platform: CommentPlatform
}

const playgroundPath = (workspaceId: string) => `/api/workspaces/${encodeURIComponent(workspaceId)}/playground`

export const playgroundUsageQueryKey = (workspaceId: string) => ['workspace', workspaceId, 'playground', 'usage'] as const

export function playgroundUsageQueryOptions(workspaceId: string) {
  return queryOptions({
    queryKey: playgroundUsageQueryKey(workspaceId),
    queryFn: () => apiFetch<PlaygroundUsage>(`${playgroundPath(workspaceId)}/usage`),
  })
}

export function runPlaygroundTest(workspaceId: string, { text, platform }: PlaygroundInput): Promise<PlaygroundResult> {
  return apiFetch<PlaygroundResult>(`${playgroundPath(workspaceId)}/test`, { method: 'POST', body: { text: text.trim(), platform } })
}

/** Client check of the comment text (the API trims and allows 1–2,000 chars). */
export function playgroundTextError(text: string, content: ContentFn): string | null {
  const length = text.trim().length
  if (length === 0) return content('Write a comment to test.', 'টেস্ট করার জন্য একটি কমেন্ট লিখুন।')
  if (length > PLAYGROUND_TEXT_MAX) {
    return content('Keep the comment to 2,000 characters or fewer.', 'কমেন্টটি ২,০০০ অক্ষরের মধ্যে রাখুন।')
  }
  return null
}

/** "8 of 10 tests left today", or the "turned off" line for limit 0. */
export function testsLeftLine(usage: Pick<PlaygroundUsage, 'limit' | 'testsLeft'>, content: ContentFn, language: Language): string {
  if (usage.limit === 0) return playgroundOffMessage(content)
  const left = formatCount(usage.testsLeft, language)
  const limit = formatCount(usage.limit, language)
  return content(`${left} of ${limit} tests left today`, `আজ ${limit}টির মধ্যে ${left}টি টেস্ট বাকি`)
}

function playgroundOffMessage(content: ContentFn): string {
  return content('The playground is turned off right now.', 'প্লেগ্রাউন্ড এই মুহূর্তে বন্ধ আছে।')
}

/** `POST …/test` failures (429 limit / off, 503 AI not set up, 502 AI failed, 400, 403, 404, network, 5xx). */
export function playgroundErrorMessage(error: ApiError, content: ContentFn, language: Language): string {
  if (error.status === 429 && error.code === 'PLAYGROUND_LIMIT_REACHED') {
    const limit = error.details?.limit
    if (limit === 0) return playgroundOffMessage(content)
    const resetsAt = error.details?.resetsAt
    const when = typeof resetsAt === 'string' ? formatCommentTime(resetsAt, language) : null
    const count = typeof limit === 'number' ? formatCount(limit, language) : null
    return content(
      `You’ve used ${count ? `all ${count}` : 'all of today’s'} tests. ${when ? `You can test again from ${when} (Dhaka time).` : 'You can test again tomorrow.'}`,
      `আজকের ${count ? `${count}টি ` : ''}টেস্ট শেষ। ${when ? `${when} (ঢাকা সময়) থেকে আবার টেস্ট করতে পারবেন।` : 'আগামীকাল আবার টেস্ট করতে পারবেন।'}`,
    )
  }
  if (error.status === 503 && error.code === 'PLAYGROUND_AI_NOT_CONFIGURED') {
    return content(
      'The AI isn’t available right now, so this comment couldn’t be checked. Please try again later.',
      'এই মুহূর্তে AI পাওয়া যাচ্ছে না, তাই কমেন্টটি যাচাই করা যায়নি। একটু পরে আবার চেষ্টা করুন।',
    )
  }
  if (error.status === 502 && error.code === 'PLAYGROUND_AI_FAILED') {
    return error.details?.retryable === true
      ? content('The AI didn’t answer in time. Try again; this test wasn’t counted.', 'AI সময়মতো উত্তর দেয়নি। আবার চেষ্টা করুন; এই টেস্টটি গোনা হয়নি।')
      : content(
          'The AI couldn’t check this comment. This test wasn’t counted.',
          'AI এই কমেন্টটি যাচাই করতে পারেনি। এই টেস্টটি গোনা হয়নি।',
        )
  }
  if (error.status === 400) {
    return content('Write a comment of 1–2,000 characters and try again.', '১–২,০০০ অক্ষরের একটি কমেন্ট লিখে আবার চেষ্টা করুন।')
  }
  if (error.status === 403) {
    return content('You don’t have access to the playground in this workspace.', 'এই ওয়ার্কস্পেসে প্লেগ্রাউন্ড ব্যবহারের অনুমতি আপনার নেই।')
  }
  if (error.status === 404) return content('This workspace couldn’t be found.', 'এই ওয়ার্কস্পেসটি খুঁজে পাওয়া যায়নি।')
  return genericFailure(error, content)
}

export function ruleKindLabel(kind: RuleKind, content: ContentFn): string {
  switch (kind) {
    case 'keyword':
      return content('Blocked keyword', 'ব্লক করা কিওয়ার্ড')
    case 'url':
      return content('Link', 'লিংক')
    case 'phone':
      return content('Phone number', 'ফোন নম্বর')
  }
}

/** What the worker would do with this comment if it arrived now. */
export function decisionLine(decision: PlaygroundResult['decision'], content: ContentFn): string {
  switch (decision.action) {
    case 'HIDE':
      return content('Would hide this comment', 'কমেন্টটি হাইড করা হতো')
    case 'DELETE':
      return content('Would delete this comment', 'কমেন্টটি ডিলিট করা হতো')
    default:
      return decision.status === 'NEEDS_REVIEW'
        ? content('Would send this comment to review', 'কমেন্টটি রিভিউতে পাঠানো হতো')
        : content('Would leave this comment visible', 'কমেন্টটি দৃশ্যমান রাখা হতো')
  }
}

/** Why a comment goes to review (only for `NEEDS_REVIEW`). */
export function reviewHint(decision: PlaygroundResult['decision'], content: ContentFn): string | null {
  if (decision.status !== 'NEEDS_REVIEW') return null
  if (decision.reason === 'review_mode') return content('Review mode is on in your rules.', 'আপনার নিয়মে রিভিউ মোড চালু আছে।')
  if (decision.reason === 'below_threshold') {
    return content('The AI is less sure than your confidence setting.', 'AI-এর নিশ্চয়তা আপনার কনফিডেন্স সেটিংয়ের চেয়ে কম।')
  }
  return null
}
