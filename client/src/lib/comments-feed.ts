import { infiniteQueryOptions, queryOptions, type InfiniteData } from '@tanstack/react-query'
import { apiFetch, type ApiError } from '@/lib/api'
import type { ContentFn } from '@/lib/auth-errors'
import type { Language } from '@/lib/language'
import { genericFailure } from '@/lib/meta-messages'
import type { ModerationCategory } from '@/lib/moderation-policy'

/*
 * C5 `/comments` data (M6-T9; D1/D7/D8 answered 2026-11-20).
 * - `GET /api/workspaces/:workspaceId/comments` (M6-T3, every member, impersonated ok) → `{ items, nextCursor }`.
 * - `POST …/comments/:commentId/override` (M6-T4) `{ action, replyText? }` → the updated feed item.
 * Mirrors `backend/src/comments/dto/comments-feed.dto.ts` + `comment-override.dto.ts` (dates are ISO strings).
 */

export const COMMENT_STATUSES = ['PENDING', 'VISIBLE', 'NEEDS_REVIEW', 'HIDDEN', 'DELETED', 'SKIPPED', 'FAILED'] as const
export type CommentStatus = (typeof COMMENT_STATUSES)[number]

export const COMMENT_PLATFORMS = ['FACEBOOK', 'INSTAGRAM'] as const
export type CommentPlatform = (typeof COMMENT_PLATFORMS)[number]

export const MODERATION_CATEGORIES = [
  'SAFE_INQUIRY',
  'COMPETITOR_POACH',
  'SCAM_PHISHING',
  'SPAM_IRRELEVANT',
  'ABUSIVE_TOXIC',
] as const satisfies readonly ModerationCategory[]

export type OverrideAction = 'HIDE' | 'UNHIDE' | 'DELETE' | 'REPLY' | 'KEEP'

export interface CommentFeedAction {
  action: OverrideAction
  source: 'AUTO' | 'USER'
  state: 'PENDING' | 'SUCCEEDED' | 'FAILED'
  at: string
}

export interface CommentFeedItem {
  id: string
  platform: CommentPlatform
  /** `null` once the Page was disconnected. */
  page: { id: string; name: string } | null
  postId: string
  authorName: string | null
  message: string | null
  status: CommentStatus
  statusReason: string | null
  category: ModerationCategory | null
  confidence: number | null
  language: 'bn' | 'banglish' | 'en' | null
  reasoning: string | null
  ruleMatch: string | null
  overriddenAt: string | null
  editedAt: string | null
  createdAt: string
  lastAction: CommentFeedAction | null
}

export interface CommentsFeedResponse {
  items: CommentFeedItem[]
  nextCursor: string | null
}

/** Feed filters = the URL search of `/comments` (every key optional; unset keys stay out of the URL). */
export interface CommentsFeedSearch {
  status?: CommentStatus
  category?: ModerationCategory
  platform?: CommentPlatform
  /** Our `social_pages.id` (an item's `page.id`). */
  pageId?: string
  /** Inclusive Asia/Dhaka days, `YYYY-MM-DD`. */
  from?: string
  to?: string
  q?: string
}

/** Backend limits (`FEED_SEARCH_MAX`, D8 reply 1–500). */
export const FEED_SEARCH_MAX = 100
export const REPLY_MAX = 500
/** D1 (a): poll every 15 s; TanStack pauses `refetchInterval` while the tab is hidden. */
export const FEED_POLL_MS = 15_000
const NEW_COMMENTS_LIMIT = 50

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DAY = /^\d{4}-\d{2}-\d{2}$/

const oneOf = <T extends string>(values: readonly T[], value: unknown): T | undefined =>
  (values as readonly unknown[]).includes(value) ? (value as T) : undefined

/** A real calendar day `YYYY-MM-DD`, else `undefined`. */
export const validDay = (value: unknown): string | undefined =>
  typeof value === 'string' && DAY.test(value) && new Date(`${value}T00:00:00Z`).toISOString().startsWith(value)
    ? value
    : undefined

/** Drops anything the API would refuse (400), so a hand-edited URL never breaks the page. */
export function validateCommentsFeedSearch(raw: Record<string, unknown>): CommentsFeedSearch {
  const q = typeof raw.q === 'string' ? raw.q.trim() : ''
  return {
    status: oneOf(COMMENT_STATUSES, raw.status),
    category: oneOf(MODERATION_CATEGORIES, raw.category),
    platform: oneOf(COMMENT_PLATFORMS, raw.platform),
    pageId: typeof raw.pageId === 'string' && UUID.test(raw.pageId) ? raw.pageId : undefined,
    from: validDay(raw.from),
    to: validDay(raw.to),
    q: q && q.length <= FEED_SEARCH_MAX ? q : undefined,
  }
}

/** The set filters only (stable query key, `undefined` keys dropped). */
export function activeFilters(search: CommentsFeedSearch): CommentsFeedSearch {
  return Object.fromEntries(Object.entries(search).filter(([, value]) => value !== undefined))
}

export const commentsFeedRootKey = (workspaceId: string) => ['workspace', workspaceId, 'comments'] as const
export const commentsFeedQueryKey = (workspaceId: string, filters: CommentsFeedSearch) =>
  [...commentsFeedRootKey(workspaceId), activeFilters(filters)] as const

function fetchFeed(workspaceId: string, filters: CommentsFeedSearch, extra: Record<string, string | undefined> = {}) {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries({ ...filters, ...extra })) if (value !== undefined) params.set(key, value)
  const query = params.toString()
  return apiFetch<CommentsFeedResponse>(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/comments${query ? `?${query}` : ''}`,
  )
}

export type CommentsFeedData = InfiniteData<CommentsFeedResponse, unknown>

/** Newest first, 20 per page; "Load more" follows `nextCursor`. An empty feed polls itself (no `since` to ask from). */
export function commentsFeedQueryOptions(workspaceId: string, filters: CommentsFeedSearch) {
  return infiniteQueryOptions({
    queryKey: commentsFeedQueryKey(workspaceId, filters),
    queryFn: ({ pageParam }) => fetchFeed(workspaceId, filters, { cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    refetchInterval: (query) => (query.state.data?.pages[0]?.items.length ? false : FEED_POLL_MS),
  })
}

/**
 * D1 polling: comments created after `since` (the newest loaded `createdAt`) with the same filters.
 * Postgres keeps microseconds and `since` has milliseconds, so the newest loaded row can come back
 * too: callers count only ids they don't have (`unseenComments`).
 */
export function newCommentsQueryOptions(workspaceId: string, filters: CommentsFeedSearch, since: string) {
  return queryOptions({
    queryKey: [...commentsFeedQueryKey(workspaceId, filters), 'new', since] as const,
    queryFn: () => fetchFeed(workspaceId, filters, { since, limit: String(NEW_COMMENTS_LIMIT) }),
    // Fresh "nothing new yet" (within `staleTime`): the first request goes out at the first tick, not on mount.
    initialData: { items: [], nextCursor: null },
    refetchInterval: FEED_POLL_MS,
  })
}

export function unseenComments(feed: CommentsFeedData, fresh: CommentFeedItem[]): CommentFeedItem[] {
  const known = new Set(feed.pages.flatMap((page) => page.items.map((item) => item.id)))
  return fresh.filter((item) => !known.has(item.id))
}

/** Puts new comments on top of the first page. */
export function mergeNewComments(feed: CommentsFeedData, fresh: CommentFeedItem[]): CommentsFeedData {
  const [first, ...rest] = feed.pages
  if (!first) return feed
  return { ...feed, pages: [{ ...first, items: [...unseenComments(feed, fresh), ...first.items] }, ...rest] }
}

/** Swaps the override answer in wherever the comment is loaded. */
export function replaceComment(feed: CommentsFeedData, item: CommentFeedItem): CommentsFeedData {
  return {
    ...feed,
    pages: feed.pages.map((page) => ({ ...page, items: page.items.map((row) => (row.id === item.id ? item : row)) })),
  }
}

export function overrideComment(
  workspaceId: string,
  commentId: string,
  action: OverrideAction,
  replyText?: string,
): Promise<CommentFeedItem> {
  return apiFetch<CommentFeedItem>(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/comments/${encodeURIComponent(commentId)}/override`,
    { method: 'POST', body: action === 'REPLY' ? { action, replyText } : { action } },
  )
}

/**
 * What the API accepts per status (executor rules): nothing on a deleted comment; Unhide only when
 * hidden; "Keep visible" (D8) never on a hidden one and only where it changes something (not VISIBLE).
 */
export function availableActions(status: CommentStatus): OverrideAction[] {
  if (status === 'DELETED') return []
  if (status === 'HIDDEN') return ['UNHIDE', 'REPLY', 'DELETE']
  return status === 'VISIBLE' ? ['HIDE', 'REPLY', 'DELETE'] : ['KEEP', 'HIDE', 'REPLY', 'DELETE']
}

/** `null` = ok. Trimmed like the backend. */
export function replyTextError(text: string, content: ContentFn): string | null {
  const length = text.trim().length
  if (length === 0) return content('Write a reply first.', 'আগে একটি উত্তর লিখুন।')
  if (length > REPLY_MAX) {
    return content(`Keep the reply to ${REPLY_MAX} characters or fewer.`, 'উত্তরটি ৫০০ অক্ষরের মধ্যে রাখুন।')
  }
  return null
}

export function statusLabel(status: CommentStatus, content: ContentFn): string {
  switch (status) {
    case 'PENDING':
      return content('Pending', 'অপেক্ষমাণ')
    case 'VISIBLE':
      return content('Visible', 'দৃশ্যমান')
    case 'NEEDS_REVIEW':
      return content('Needs review', 'রিভিউ দরকার')
    case 'HIDDEN':
      return content('Hidden', 'লুকানো')
    case 'DELETED':
      return content('Deleted', 'মুছে ফেলা')
    case 'SKIPPED':
      return content('Skipped', 'বাদ দেওয়া')
    case 'FAILED':
      return content('Failed', 'ব্যর্থ')
  }
}

export function overrideSuccessMessage(action: OverrideAction, content: ContentFn): string {
  switch (action) {
    case 'HIDE':
      return content('Comment hidden.', 'কমেন্টটি লুকানো হয়েছে।')
    case 'UNHIDE':
      return content('Comment is visible again.', 'কমেন্টটি আবার দেখা যাচ্ছে।')
    case 'DELETE':
      return content('Comment deleted.', 'কমেন্টটি মুছে ফেলা হয়েছে।')
    case 'REPLY':
      return content('Reply sent.', 'উত্তর পাঠানো হয়েছে।')
    case 'KEEP':
      return content('Comment kept visible.', 'কমেন্টটি দৃশ্যমান রাখা হয়েছে।')
  }
}

/** Override failures by `status` + `code` (M6-T4 `overrideError`); backend text is never shown. */
export function overrideErrorMessage(error: ApiError, content: ContentFn): string {
  if (error.status === 404) return content('This comment no longer exists.', 'এই কমেন্টটি আর নেই।')
  if (error.status === 409) {
    switch (error.code) {
      case 'COMMENT_DELETED':
        return content('This comment was already deleted.', 'এই কমেন্টটি আগেই মুছে ফেলা হয়েছে।')
      case 'COMMENT_HIDDEN':
        return content('This comment is hidden. Unhide it instead.', 'এই কমেন্টটি লুকানো আছে। এর বদলে আনহাইড করুন।')
      case 'ALREADY_REPLIED':
        return content('A reply was already sent.', 'আগেই একটি উত্তর পাঠানো হয়েছে।')
      case 'PAGE_DISCONNECTED':
        return content('This comment’s Page is disconnected.', 'এই কমেন্টের পেজটি ডিসকানেক্ট করা আছে।')
      case 'PAGE_INACTIVE':
        return content(
          'This comment’s Page is switched off. Turn it on in Pages first.',
          'এই কমেন্টের পেজটি বন্ধ আছে। আগে পেজ থেকে এটি চালু করুন।',
        )
      case 'CONNECTION_INACTIVE':
      case 'PAGE_TOKEN_MISSING':
      case 'PAGE_TOKEN_UNDECRYPTABLE':
        return content('Reconnect Facebook to act on this comment.', 'এই কমেন্টে কাজ করতে ফেসবুক আবার কানেক্ট করুন।')
      default:
        return content('This comment changed meanwhile. Refresh and try again.', 'এর মধ্যে কমেন্টটি বদলে গেছে। রিফ্রেশ করে আবার চেষ্টা করুন।')
    }
  }
  if (error.status === 503 && error.code === 'META_NOT_CONFIGURED') {
    return content(
      'Facebook actions aren’t set up on our server yet. Please contact support.',
      'আমাদের সার্ভারে ফেসবুক অ্যাকশন এখনো সেট আপ করা হয়নি। অনুগ্রহ করে সাপোর্টে যোগাযোগ করুন।',
    )
  }
  if (error.status === 502 && error.code === 'META_ACTION_FAILED') {
    return error.details?.retryable === true
      ? content('Facebook didn’t respond in time. Try again in a minute.', 'ফেসবুক সময়মতো সাড়া দেয়নি। এক মিনিট পরে আবার চেষ্টা করুন।')
      : content('Facebook refused this action.', 'ফেসবুক এই অ্যাকশনটি গ্রহণ করেনি।')
  }
  return genericFailure(error, content)
}

export function feedLoadErrorMessage(error: ApiError, content: ContentFn): string {
  if (error.status === 404) return content('This workspace couldn’t be found.', 'এই ওয়ার্কস্পেসটি খুঁজে পাওয়া যায়নি।')
  return genericFailure(error, content)
}

const TIME_FORMAT: Record<Language, Intl.DateTimeFormat> = {
  en: new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Dhaka' }),
  bn: new Intl.DateTimeFormat('bn-BD', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Dhaka' }),
}

export function formatCommentTime(iso: string, language: Language): string {
  return TIME_FORMAT[language].format(new Date(iso))
}
