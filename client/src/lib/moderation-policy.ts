import { queryOptions } from '@tanstack/react-query'
import { apiFetch, type ApiError } from '@/lib/api'
import type { ContentFn } from '@/lib/auth-errors'
import { MODERATION_CATEGORIES } from '@/lib/comments-feed'
import { categoryLabel } from '@/lib/dashboard-summary'
import { bnNumber, type Language } from '@/lib/language'
import { genericFailure } from '@/lib/meta-messages'

/**
 * Workspace moderation policy (M5-T8 backend, D5; static rules M6-T1): the M5-T15 "AI analysis" card on
 * `/pages` and the C7 `/rules` screen (M6-T10).
 * - `GET /api/workspaces/:id/moderation/policy` → `ModerationPolicy` (owner/admin, impersonated ok;
 *   moderator/member 403, non-member 404). The row is created with the defaults on first read.
 * - `PATCH` same path, partial body (`{ aiContextLevel }`, or a `PolicyPatch` from `/rules`) → policy + `changed`.
 * Mirrors `backend/src/moderation/dto/moderation-policy.dto.ts` (dates arrive as ISO strings).
 */

/** D8 data sent to the AI per comment (`CONTEXT_LEVELS` in `backend/src/moderation/moderation.constants.ts`). */
export const AI_CONTEXT_LEVELS = ['comment_only', 'page_name', 'post_caption'] as const
export type AiContextLevel = (typeof AI_CONTEXT_LEVELS)[number]

export const DEFAULT_AI_CONTEXT_LEVEL: AiContextLevel = 'comment_only'

export type ModerationMode = 'AUTO' | 'REVIEW'
export type ModerationCategory = 'SAFE_INQUIRY' | 'COMPETITOR_POACH' | 'SCAM_PHISHING' | 'SPAM_IRRELEVANT' | 'ABUSIVE_TOXIC'
export const POLICY_ACTIONS = ['NONE', 'HIDE', 'DELETE'] as const
export type PolicyAction = (typeof POLICY_ACTIONS)[number]
export const MODERATION_MODES = ['AUTO', 'REVIEW'] as const satisfies readonly ModerationMode[]

/** Static rules (M6-T1; D2 b / D4 / D5 / D6). Limits mirror `backend/src/moderation/moderation.constants.ts`. */
export const RULE_KINDS = ['keyword', 'url', 'phone'] as const
export type RuleKind = (typeof RULE_KINDS)[number]
export const RULE_ACTIONS = ['HIDE', 'DELETE'] as const
export type RuleAction = (typeof RULE_ACTIONS)[number]
export const MAX_BLOCKED_KEYWORDS = 200
export const MAX_KEYWORD_CHARS = 50
export const MAX_ALLOWED_DOMAINS = 20
export const AUTO_REPLY_TEXT_MAX_CHARS = 500
export const MIN_CONFIDENCE_THRESHOLD = 0.5

export interface StaticRules {
  blockedKeywords: string[]
  blockUrls: boolean
  blockPhoneNumbers: boolean
  allowedDomains: string[]
  actions: Record<RuleKind, RuleAction>
}

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
  rules: StaticRules
  /** Plan has `customBlocklist` (D4): keywords may be added. */
  keywordRulesAvailable: boolean
  /** Plan has `autoHideScams` (D4): the URL / phone rules may be switched on. */
  urlPhoneRulesAvailable: boolean
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

/** `/rules` edit state: texts as typed (`''` = none). */
export interface CategoryDraft {
  action: PolicyAction
  autoReply: boolean
  replyEn: string
  replyBn: string
}

export interface PolicyDraft {
  mode: ModerationMode
  confidenceThreshold: number
  categories: Record<ModerationCategory, CategoryDraft>
  rules: StaticRules
}

/** `PATCH` body from `/rules`: only what changed. */
export interface PolicyPatch {
  mode?: ModerationMode
  confidenceThreshold?: number
  categories?: Partial<Record<ModerationCategory, Partial<CategoryRule>>>
  rules?: Partial<Omit<StaticRules, 'actions'>> & { actions?: Partial<Record<RuleKind, RuleAction>> }
}

const entries = <K extends string, V>(record: Record<K, V>) => Object.entries(record) as [K, V][]

export function policyDraft(policy: ModerationPolicy): PolicyDraft {
  const categories = Object.fromEntries(
    entries(policy.categories).map(([category, rule]) => [
      category,
      { ...rule, replyEn: rule.replyEn ?? '', replyBn: rule.replyBn ?? '' },
    ]),
  ) as Record<ModerationCategory, CategoryDraft>
  return { mode: policy.mode, confidenceThreshold: policy.confidenceThreshold, categories, rules: policy.rules }
}

const replyText = (text: string): string | null => text.trim() || null
const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((item, i) => item === b[i])

/** The fields of `draft` that differ from `saved`, or `null` when nothing changed. */
export function policyPatch(saved: ModerationPolicy, draft: PolicyDraft): PolicyPatch | null {
  const patch: PolicyPatch = {}
  if (draft.mode !== saved.mode) patch.mode = draft.mode
  if (draft.confidenceThreshold !== saved.confidenceThreshold) patch.confidenceThreshold = draft.confidenceThreshold

  const categories: NonNullable<PolicyPatch['categories']> = {}
  for (const [category, next] of entries(draft.categories)) {
    const before = saved.categories[category]
    const change: Partial<CategoryRule> = {}
    if (next.action !== before.action) change.action = next.action
    if (next.autoReply !== before.autoReply) change.autoReply = next.autoReply
    if (replyText(next.replyEn) !== before.replyEn) change.replyEn = replyText(next.replyEn)
    if (replyText(next.replyBn) !== before.replyBn) change.replyBn = replyText(next.replyBn)
    if (Object.keys(change).length > 0) categories[category] = change
  }
  if (Object.keys(categories).length > 0) patch.categories = categories

  const rules: NonNullable<PolicyPatch['rules']> = {}
  const next = draft.rules
  const before = saved.rules
  if (!sameList(next.blockedKeywords, before.blockedKeywords)) rules.blockedKeywords = next.blockedKeywords
  if (next.blockUrls !== before.blockUrls) rules.blockUrls = next.blockUrls
  if (next.blockPhoneNumbers !== before.blockPhoneNumbers) rules.blockPhoneNumbers = next.blockPhoneNumbers
  if (!sameList(next.allowedDomains, before.allowedDomains)) rules.allowedDomains = next.allowedDomains
  const actions = Object.fromEntries(RULE_KINDS.filter((kind) => next.actions[kind] !== before.actions[kind]).map((kind) => [kind, next.actions[kind]]))
  if (Object.keys(actions).length > 0) rules.actions = actions
  if (Object.keys(rules).length > 0) patch.rules = rules

  return Object.keys(patch).length > 0 ? patch : null
}

/** Categories whose auto-reply is on without both texts (the API would 400 `AUTO_REPLY_TEXTS_REQUIRED`). */
export function missingReplyTexts(draft: PolicyDraft): ModerationCategory[] {
  return entries(draft.categories)
    .filter(([, rule]) => rule.autoReply && (!rule.replyEn.trim() || !rule.replyBn.trim()))
    .map(([category]) => category)
}

export function updatePolicy(workspaceId: string, patch: PolicyPatch): Promise<ModerationPolicyUpdate> {
  return apiFetch<ModerationPolicyUpdate>(policyPath(workspaceId), { method: 'PATCH', body: patch })
}

export const policyMutationKey = (workspaceId: string) => ['workspace', workspaceId, 'moderation', 'policy', 'rules'] as const

/** D5 keyword form, as the backend stores it (`normalizeRuleText`): NFKC, lower-case, one space. */
export function normalizeKeyword(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim()
}

const HOSTNAME = /^(?:[\p{L}\p{N}](?:[\p{L}\p{M}\p{N}-]{0,61}[\p{L}\p{M}\p{N}])?\.)+\p{L}[\p{L}\p{M}\p{N}-]{1,62}$/u

/**
 * D6 allow-list entry → lower-case host without `www.`, or `null` when it is not a domain name. A light
 * check: the backend (`normalizeDomain`) has the final word (punycode, 400 `ALLOWED_DOMAIN_INVALID`).
 */
export function normalizeAllowedDomain(input: string): string | null {
  const domain = input.trim().toLowerCase().replace(/\.$/, '').replace(/^www\./, '')
  return domain.length <= 253 && HOSTNAME.test(domain) ? domain : null
}

const count = (value: unknown, language: Language) =>
  typeof value === 'number' ? (language === 'bn' ? bnNumber(value) : String(value)) : '?'

/** `PATCH` failures on `/rules` (400 codes, 409 plan feature, 403, 404, network, 5xx). */
export function policySaveErrorMessage(
  error: ApiError,
  content: ContentFn,
  language: Language,
): string {
  const prefix = content('Your rules weren’t saved.', 'আপনার নিয়ম সেভ হয়নি।')
  const detail = (key: string) => error.details?.[key]
  const quoted = (key: string) => (typeof detail(key) === 'string' ? `“${String(detail(key))}”` : '')
  if (error.status === 400) {
    switch (error.code) {
      case 'BLOCKED_KEYWORD_INVALID':
        return `${prefix} ${content(
          `The keyword ${quoted('keyword')} can’t be used. Keywords are 1–50 characters.`,
          `${quoted('keyword')} কিওয়ার্ডটি ব্যবহার করা যাবে না। কিওয়ার্ড ১–৫০ অক্ষরের হতে হবে।`,
        )}`
      case 'BLOCKED_KEYWORDS_LIMIT':
        return `${prefix} ${content(
          `You can block up to ${count(detail('max'), language)} keywords.`,
          `সর্বোচ্চ ${count(detail('max'), language)}টি কিওয়ার্ড ব্লক করা যায়।`,
        )}`
      case 'ALLOWED_DOMAIN_INVALID':
        return `${prefix} ${content(
          `${quoted('domain')} isn’t a domain name. Write it like myshop.com.`,
          `${quoted('domain')} কোনো ডোমেইন নাম নয়। myshop.com এর মতো করে লিখুন।`,
        )}`
      case 'ALLOWED_DOMAINS_LIMIT':
        return `${prefix} ${content(
          `You can allow up to ${count(detail('max'), language)} domains.`,
          `সর্বোচ্চ ${count(detail('max'), language)}টি ডোমেইন অনুমতি দেওয়া যায়।`,
        )}`
      case 'AUTO_REPLY_TEXTS_REQUIRED': {
        const category = detail('category')
        const known = MODERATION_CATEGORIES.find((item) => item === category)
        const name = known ? categoryLabel(known, content) : ''
        return `${prefix} ${content(
          `Write both an English and a Bangla reply before switching on the auto-reply${name ? ` for “${name}”` : ''}.`,
          `${name ? `“${name}” এর ` : ''}অটো-রিপ্লাই চালুর আগে ইংরেজি ও বাংলা দুটো উত্তরই লিখুন।`,
        )}`
      }
      default:
        return `${prefix} ${content('Some settings aren’t valid. Check them and try again.', 'কিছু সেটিং সঠিক নয়। দেখে আবার চেষ্টা করুন।')}`
    }
  }
  if (error.status === 409 && error.code === 'PLAN_FEATURE_UNAVAILABLE') {
    switch (detail('feature')) {
      case 'customBlocklist':
        return `${prefix} ${content('Custom keywords are on the Growth and Pro plans.', 'কাস্টম কিওয়ার্ড গ্রোথ ও প্রো প্ল্যানে আছে।')}`
      case 'autoReplyTemplates':
        return `${prefix} ${content('Auto-replies are on the Growth and Pro plans.', 'অটো-রিপ্লাই গ্রোথ ও প্রো প্ল্যানে আছে।')}`
      case 'autoHideScams':
        return `${prefix} ${content('Link and phone number blocking needs an active plan.', 'লিংক ও ফোন নম্বর ব্লক করতে একটি চালু প্ল্যান লাগবে।')}`
      default:
        return `${prefix} ${content('Your plan doesn’t include this feature.', 'আপনার প্ল্যানে এই ফিচারটি নেই।')}`
    }
  }
  if (error.status === 403) return `${prefix} ${rulesOwnersOnlyMessage(content)}`
  if (error.status === 404) {
    return `${prefix} ${content('This workspace couldn’t be found.', 'এই ওয়ার্কস্পেসটি খুঁজে পাওয়া যায়নি।')}`
  }
  return `${prefix} ${genericFailure(error, content)}`
}

/** `/rules` GET 403: moderators can't see or change the rules. */
export function rulesOwnersOnlyMessage(content: ContentFn): string {
  return content(
    'Only workspace owners and admins can see and change the moderation rules.',
    'শুধু ওয়ার্কস্পেসের মালিক ও অ্যাডমিন মডারেশনের নিয়ম দেখতে ও বদলাতে পারেন।',
  )
}

/** `/rules` GET failures other than 403. */
export function rulesLoadErrorMessage(error: ApiError, content: ContentFn): string {
  if (error.status === 404) return content('This workspace couldn’t be found.', 'এই ওয়ার্কস্পেসটি খুঁজে পাওয়া যায়নি।')
  return genericFailure(error, content)
}

function onlyOwnersMessage(content: ContentFn): string {
  return content(
    'Only workspace owners and admins can change how comments are analysed.',
    'শুধু ওয়ার্কস্পেসের মালিক ও অ্যাডমিন কমেন্ট বিশ্লেষণের ধরন বদলাতে পারেন।',
  )
}
