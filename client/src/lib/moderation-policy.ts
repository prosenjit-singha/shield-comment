import { queryOptions } from '@tanstack/react-query'
import { apiFetch, type ApiError } from '@/lib/api'
import type { ContentFn } from '@/lib/auth-errors'
import { genericFailure } from '@/lib/meta-messages'

/**
 * Workspace moderation policy (M5-T8 backend, D5), the fields the client uses so far (M5-T15 "AI
 * analysis" card on `/pages`; Module 6 `/rules` adds the rest):
 * - `GET /api/workspaces/:id/moderation/policy` → `ModerationPolicy` (owner/admin, impersonated ok;
 *   moderator/member 403, non-member 404). The row is created with the defaults on first read.
 * - `PATCH` same path, partial body (here only `{ aiContextLevel }`) → policy + `changed`.
 * Mirrors `backend/src/moderation/dto/moderation-policy.dto.ts` (dates arrive as ISO strings).
 */

/** D8 data sent to the AI per comment (`CONTEXT_LEVELS` in `backend/src/moderation/moderation.constants.ts`). */
export const AI_CONTEXT_LEVELS = ['comment_only', 'page_name', 'post_caption'] as const
export type AiContextLevel = (typeof AI_CONTEXT_LEVELS)[number]

export const DEFAULT_AI_CONTEXT_LEVEL: AiContextLevel = 'comment_only'

/** D8/D15 credits per analysed comment (`CONTEXT_LEVEL_CREDITS`; a post without a caption costs 1). */
export const AI_CONTEXT_LEVEL_CREDITS: Readonly<Record<AiContextLevel, number>> = {
  comment_only: 1,
  page_name: 1,
  post_caption: 2,
}

export type ModerationMode = 'AUTO' | 'REVIEW'
export type ModerationCategory = 'SAFE_INQUIRY' | 'COMPETITOR_POACH' | 'SCAM_PHISHING' | 'SPAM_IRRELEVANT' | 'ABUSIVE_TOXIC'
export type PolicyAction = 'NONE' | 'HIDE' | 'DELETE'

export interface CategoryRule {
  action: PolicyAction
  autoReply: boolean
  replyEn: string | null
  replyBn: string | null
}

/** `ModerationPolicyResponse`. */
export interface ModerationPolicy {
  workspaceId: string
  mode: ModerationMode
  confidenceThreshold: number
  aiContextLevel: AiContextLevel
  categories: Record<ModerationCategory, CategoryRule>
  autoReplyAvailable: boolean
  updatedAt: string
}

/** `ModerationPolicyUpdateResponse`: `changed: false` = the body matched the stored policy. */
export interface ModerationPolicyUpdate extends ModerationPolicy {
  changed: boolean
}

export function isAiContextLevel(value: unknown): value is AiContextLevel {
  return typeof value === 'string' && (AI_CONTEXT_LEVELS as readonly string[]).includes(value)
}

const policyPath = (workspaceId: string) => `/api/workspaces/${encodeURIComponent(workspaceId)}/moderation/policy`

export const moderationPolicyQueryKey = (workspaceId: string) => ['workspace', workspaceId, 'moderation', 'policy'] as const

export function moderationPolicyQueryOptions(workspaceId: string) {
  return queryOptions({
    queryKey: moderationPolicyQueryKey(workspaceId),
    queryFn: () => apiFetch<ModerationPolicy>(policyPath(workspaceId)),
  })
}

/** `useMutation` key of the "AI analysis" save. */
export const aiContextLevelMutationKey = (workspaceId: string) =>
  ['workspace', workspaceId, 'moderation', 'policy', 'ai-context-level'] as const

export function updateAiContextLevel(workspaceId: string, aiContextLevel: AiContextLevel): Promise<ModerationPolicyUpdate> {
  return apiFetch<ModerationPolicyUpdate>(policyPath(workspaceId), { method: 'PATCH', body: { aiContextLevel } })
}

/** The PATCH answer as the cached GET shape (`changed` is about that one request, not the policy). */
export function policyFromUpdate(update: ModerationPolicyUpdate): ModerationPolicy {
  const policy: ModerationPolicy & { changed?: boolean } = { ...update }
  delete policy.changed
  return policy
}

/** `GET …/moderation/policy` failures. */
export function moderationPolicyLoadErrorMessage(error: ApiError, content: ContentFn): string {
  if (error.status === 403) return onlyOwnersMessage(content)
  if (error.status === 404) {
    return content('This workspace couldn’t be found.', 'এই ওয়ার্কস্পেসটি খুঁজে পাওয়া যায়নি।')
  }
  return `${content('Couldn’t load your AI analysis setting.', 'আপনার AI বিশ্লেষণের সেটিং লোড করা যায়নি।')} ${genericFailure(error, content)}`
}

/** `PATCH …/moderation/policy` failures. */
export function aiContextLevelSaveErrorMessage(error: ApiError, content: ContentFn): string {
  const prefix = content('Your choice wasn’t saved.', 'আপনার পছন্দ সেভ হয়নি।')
  if (error.status === 403) return `${prefix} ${onlyOwnersMessage(content)}`
  if (error.status === 404) {
    return `${prefix} ${content('This workspace couldn’t be found.', 'এই ওয়ার্কস্পেসটি খুঁজে পাওয়া যায়নি।')}`
  }
  return `${prefix} ${genericFailure(error, content)}`
}

function onlyOwnersMessage(content: ContentFn): string {
  return content(
    'Only workspace owners and admins can change how comments are analysed.',
    'শুধু ওয়ার্কস্পেসের মালিক ও অ্যাডমিন কমেন্ট বিশ্লেষণের ধরন বদলাতে পারেন।',
  )
}
