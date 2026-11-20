import { queryOptions } from '@tanstack/react-query'
import type { AiProvider } from '@/lib/admin-ai-settings'
import { dhakaToday } from '@/lib/admin-dashboard'
import { ApiError, apiFetch } from '@/lib/api'

/**
 * Admin AI analysis log, credit top-ups and spend summary (M5-T15e; D25/D26). Mirrors
 * `backend/src/admin/dto/admin-ai.dto.ts` (M5-T15d). Costs are estimates (tokens × catalog
 * prices); Neon has no balance API. `message` is untrusted client text: render as text only.
 */

export type AiDecision = 'NONE' | 'HIDE' | 'DELETE'
export type AiCategory = 'SAFE_INQUIRY' | 'COMPETITOR_POACH' | 'SCAM_PHISHING' | 'SPAM_IRRELEVANT' | 'ABUSIVE_TOXIC'
export type AiCommentStatus = 'PENDING' | 'VISIBLE' | 'NEEDS_REVIEW' | 'HIDDEN' | 'DELETED' | 'SKIPPED' | 'FAILED'
export type AiActionState = 'PENDING' | 'SUCCEEDED' | 'FAILED'

export interface AiAnalysis {
  id: string
  classifiedAt: string
  workspace: { id: string; name: string }
  /** `null` once the Page was disconnected. */
  page: { id: string; pageId: string; name: string } | null
  platform: 'FACEBOOK' | 'INSTAGRAM'
  message: string | null
  category: AiCategory
  confidence: number
  decision: AiDecision
  actionState: AiActionState | null
  status: AiCommentStatus
  statusReason: string | null
  provider: AiProvider
  model: string
  inputTokens: number | null
  outputTokens: number | null
  latencyMs: number | null
  estimatedCostUsd: number | null
}

export interface AiSpendSummary {
  asOf: string
  timezone: 'Asia/Dhaka'
  creditAddedUsd: number
  estimatedSpendUsd: number
  /** added − spend; may be negative. */
  estimatedRemainingUsd: number
  unpricedCalls: number
  commentsAnalyzed: { total: number; today: number; last7Days: number }
  tokens: { input: number; output: number }
  spendByModel: {
    provider: AiProvider
    model: string
    calls: number
    inputTokens: number
    outputTokens: number
    costUsd: number | null
  }[]
  spendByDecision: { decision: AiDecision; comments: number; costUsd: number; unpricedComments: number }[]
}

export interface AiCreditTopup {
  id: string
  amountUsd: number
  /** Dhaka calendar date `YYYY-MM-DD`. */
  toppedUpOn: string
  note: string | null
  createdAt: string
  createdBy: { id: string; name: string }
}

export interface CreateTopupBody {
  amountUsd: number
  toppedUpOn: string
  note?: string
}

export const AI_ANALYSES_LIMIT = 20
export const TOPUP_AMOUNT_MAX = 1_000_000
export const TOPUP_NOTE_MAX = 200

export const adminAiSummaryKey = ['admin', 'ai', 'summary'] as const
export const adminAiAnalysesKey = ['admin', 'ai', 'analyses'] as const
export const adminAiTopupsKey = ['admin', 'ai', 'credit-topups'] as const

export function aiSummaryQueryOptions() {
  return queryOptions({
    queryKey: adminAiSummaryKey,
    queryFn: ({ signal }) => apiFetch<AiSpendSummary>('/admin/ai/summary', { signal }),
  })
}

export function aiAnalysesQueryOptions() {
  return queryOptions({
    queryKey: adminAiAnalysesKey,
    queryFn: ({ signal }) =>
      apiFetch<{ items: AiAnalysis[] }>(`/admin/ai/analyses?limit=${AI_ANALYSES_LIMIT}`, { signal }),
  })
}

export function aiTopupsQueryOptions() {
  return queryOptions({
    queryKey: adminAiTopupsKey,
    queryFn: ({ signal }) => apiFetch<{ items: AiCreditTopup[] }>('/admin/ai/credit-topups', { signal }),
  })
}

export function createTopup(body: CreateTopupBody) {
  return apiFetch<{ topup: AiCreditTopup }>('/admin/ai/credit-topups', { method: 'POST', body: JSON.stringify(body) })
}

/** 204 → `null` body. */
export function deleteTopup(id: string) {
  return apiFetch<null>(`/admin/ai/credit-topups/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

/** Context length as the user asked (D25): `40`, `0.4k`, `1.2k`, `12k`, `1.5M`; `null` → `n/a`. */
export function formatTokenCount(value: number | null): string {
  if (value === null) return 'n/a'
  if (value < 100) return String(value)
  const trim = (s: string) => s.replace(/\.0$/, '')
  if (value < 9_950) return `${trim((value / 1000).toFixed(1))}k`
  if (Math.round(value / 1000) < 1000) return `${Math.round(value / 1000)}k`
  return `${trim((value / 1_000_000).toFixed(1))}M`
}

/** `0.4k in / 0.1k out`; both unknown → `n/a`. */
export function formatTokenPair(input: number | null, output: number | null): string {
  if (input === null && output === null) return 'n/a'
  return `${formatTokenCount(input)} in / ${formatTokenCount(output)} out`
}

export const decisionLabels: Record<AiDecision, string> = { NONE: 'Allowed', HIDE: 'Hidden', DELETE: 'Deleted' }

/** Pill tone per decision (shadcn tokens). */
export const decisionPillClass: Record<AiDecision, string> = {
  NONE: 'bg-primary/10 text-primary',
  HIDE: 'bg-chart-4/15 text-foreground',
  DELETE: 'bg-destructive/10 text-destructive',
}

export const categoryLabels: Record<AiCategory, string> = {
  SAFE_INQUIRY: 'Safe inquiry',
  COMPETITOR_POACH: 'Competitor poaching',
  SCAM_PHISHING: 'Scam / phishing',
  SPAM_IRRELEVANT: 'Spam',
  ABUSIVE_TOXIC: 'Abusive',
}

/** `0.92` → `92%`. */
export function formatConfidence(value: number): string {
  return `${Math.round(value * 100)}%`
}

const noteStatuses: Partial<Record<AiCommentStatus, string>> = {
  FAILED: 'Failed',
  SKIPPED: 'Skipped',
  NEEDS_REVIEW: 'Needs review',
}

/** Extra line under the decision pill: a failed / pending Meta action or a stored problem state. */
export function analysisNote(a: Pick<AiAnalysis, 'actionState' | 'status' | 'statusReason'>): string | null {
  const parts: string[] = []
  if (a.actionState === 'FAILED') parts.push('Action failed')
  else if (a.actionState === 'PENDING') parts.push('Action pending')
  const status = noteStatuses[a.status]
  if (status) parts.push(a.statusReason ? `${status}: ${a.statusReason.replace(/_/g, ' ')}` : status)
  return parts.length > 0 ? parts.join(' · ') : null
}

export const COMMENT_PREVIEW_CHARS = 80

/** First 80 characters + `…`, or the text itself when short. */
export function commentPreview(message: string): string {
  const chars = Array.from(message)
  return chars.length > COMMENT_PREVIEW_CHARS ? `${chars.slice(0, COMMENT_PREVIEW_CHARS).join('').trimEnd()}…` : message
}

const AMOUNT = /^\d+(\.\d{1,2})?$/

/** Amount in USD as typed: > 0, at most 2 decimals, ≤ 1,000,000. */
export function topupAmountError(value: string): string | null {
  const v = value.trim()
  if (!v) return 'Enter the amount in USD.'
  if (!AMOUNT.test(v)) return 'Use a number with at most 2 decimals, e.g. 25 or 12.50.'
  const n = Number(v)
  if (n <= 0) return 'The amount must be more than $0.'
  if (n > TOPUP_AMOUNT_MAX) return 'The amount can be at most $1,000,000.'
  return null
}

/** Date from `<input type="date">`: required, not after today in Dhaka. */
export function topupDateError(value: string, now: Date = new Date()): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return 'Pick the top-up date.'
  if (value > dhakaToday(now)) return 'The date can’t be in the future (Bangladesh time).'
  return null
}

export function topupNoteError(value: string): string | null {
  return value.trim().length > TOPUP_NOTE_MAX ? `The note can be at most ${TOPUP_NOTE_MAX} characters.` : null
}

/** API errors for the add dialog: known codes get a plain sentence, else the backend message. */
export function topupErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === 'TOPUP_DATE_IN_FUTURE') return 'The top-up date can’t be after today (Bangladesh time).'
    return err.message
  }
  return err instanceof Error ? err.message : 'Could not add the top-up.'
}
