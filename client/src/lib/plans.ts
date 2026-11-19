import { queryOptions } from '@tanstack/react-query'
import { apiFetch, type ApiError } from '@/lib/api'
import type { ContentFn } from '@/lib/auth-errors'
import type { BillingSummary, SubscriptionInterval } from '@/lib/billing-summary'
import { bnNumber, type Language } from '@/lib/language'

/**
 * Public plans (PR-T2 backend, plan doc §5.7): `GET /api/plans` → `PublicPlansResponse`. Mirrors
 * `backend/src/plans/dto/public-plan.dto.ts` + `plan-price.ts` (dates arrive as ISO strings). Read by
 * the client `/plans` page (PR-T6). Prices already carry the best live discount (reading 9: there is
 * no per-account price before Module 8).
 */

/** Both languages; the server already falls back `bn` → `en` (PR-D17). */
export interface PlanText {
  en: string
  bn: string
}

export interface PriceSaving {
  promotionId: string
  /** "50% off" / "৳200 off" (+ " for 3 months"): plain text, never a badge (PR-D7). */
  label: string
  labelBn: string
  amountBdt: number
}

export interface PlanPrice {
  /** The struck price per month (monthly, or yearly per month). */
  listPerMonthBdt: number
  listChargedBdt: number
  /** The figure the card shows. */
  perMonthBdt: number
  /** First bill after the discount (yearly: the whole year). */
  chargedBdt: number
  saving: PriceSaving | null
}

export const PLAN_LIMIT_KEYS = ['connectedPages', 'monthlyComments', 'teamSeats', 'workspaces'] as const
export type PlanLimitKey = (typeof PLAN_LIMIT_KEYS)[number]

export const PLAN_FEATURE_KEYS = [
  'banglaAiFilter',
  'autoHideScams',
  'customBlocklist',
  'autoReplyTemplates',
  'messengerAlerts',
  'whiteLabelReports',
  'prioritySupportApi',
] as const
export type PlanFeatureKey = (typeof PLAN_FEATURE_KEYS)[number]

export interface PublicTrial {
  promotionId: string
  days: number
  /** Comments the trial grants (already resolved). */
  commentLimit: number
  endsAt: string | null
}

export interface PublicPlan {
  id: string
  slug: string
  name: string
  badge: PlanText | null
  description: PlanText | null
  /** The one highlighted plan (PR-D9): strong card + primary button. */
  highlighted: boolean
  monthly: PlanPrice
  /** `null` = no yearly option. */
  yearly: PlanPrice | null
  limits: Record<PlanLimitKey, number>
  features: Record<PlanFeatureKey, boolean>
  /** A live TRIAL promotion for this plan (PR-D10); `null` = none. */
  trial: PublicTrial | null
}

export interface PublicPlansResponse {
  /** Active plans in `sort_order`. */
  items: PublicPlan[]
  /** "Save up to N%" on the Monthly/Yearly switch; 0 = hide it. */
  yearlySaveUpToPercent: number
  /** Support WhatsApp number (`8801…`) for "Contact us" (PR-D18); `null` = hide the button. */
  contactWhatsapp: string | null
}

export const plansQueryKey = ['plans'] as const

export const plansQueryOptions = queryOptions({
  queryKey: plansQueryKey,
  queryFn: () => apiFetch<PublicPlansResponse>('/api/plans'),
})

/** `POST /api/workspaces/:workspaceId/billing/trial` (PR-T3, owner only) → 201 + the billing summary. */
export function startTrial(workspaceId: string, planId: string): Promise<BillingSummary> {
  return apiFetch<BillingSummary>(`/api/workspaces/${encodeURIComponent(workspaceId)}/billing/trial`, {
    method: 'POST',
    body: { planId },
  })
}

const EN_NUMBER = new Intl.NumberFormat('en-BD')

/** A whole number in the page language (`2,500` / `২,৫০০`). */
export function formatNumber(value: number, language: Language): string {
  return language === 'bn' ? bnNumber(value) : EN_NUMBER.format(value)
}

/** `৳1,349` / `৳১,৩৪৯`. */
export function formatTaka(value: number, language: Language): string {
  return `৳${formatNumber(value, language)}`
}

/**
 * "Contact us" link (PR-D13, PR-D18): a WhatsApp chat with the support number, prefilled with the plan
 * and interval in the page language. `null` without a number (the button is hidden).
 */
export function contactWhatsappHref(
  number: string | null,
  planName: string,
  interval: SubscriptionInterval,
  content: ContentFn,
): string | null {
  if (!number) return null
  const text =
    interval === 'year'
      ? content(`Hi! I'd like the ${planName} plan (Yearly).`, `হ্যালো! আমি ${planName} প্ল্যানটি (বার্ষিক) নিতে চাই।`)
      : content(`Hi! I'd like the ${planName} plan (Monthly).`, `হ্যালো! আমি ${planName} প্ল্যানটি (মাসিক) নিতে চাই।`)
  return `https://wa.me/${number}?text=${encodeURIComponent(text)}`
}

/**
 * Why `POST …/billing/trial` failed, for people (PR-T3 codes: `TRIAL_ERROR_CODES` + `redeem()`'s 409s).
 * A 403 is either an impersonated session or a non-owner member (the backend says which by context only).
 */
export function trialErrorMessage(error: ApiError, content: ContentFn, impersonated: boolean): string {
  if (error.isNetwork) return content('Can’t reach the server. Check your connection and try again.', 'সার্ভারে সংযোগ করা যাচ্ছে না। ইন্টারনেট সংযোগ দেখে আবার চেষ্টা করুন।')
  if (error.status === 403) {
    return impersonated
      ? content('A trial can’t be started while impersonating. The owner has to start it.', 'ইমপারসোনেশনের সময় ট্রায়াল শুরু করা যায় না। মালিককে নিজে শুরু করতে হবে।')
      : content('Only the workspace owner can start a trial.', 'শুধু ওয়ার্কস্পেসের মালিক ট্রায়াল শুরু করতে পারেন।')
  }
  switch (error.code) {
    case 'TRIAL_ALREADY_USED':
    case 'PROMOTION_ALREADY_CLAIMED':
      return content('Your account has already used its free trial.', 'আপনার অ্যাকাউন্টে ফ্রি ট্রায়াল আগেই ব্যবহার করা হয়েছে।')
    case 'TRIAL_NOT_AVAILABLE':
    case 'PROMOTION_NOT_LIVE':
    case 'PROMOTION_USED_UP':
    case 'PROMOTION_NOT_FOR_PLAN':
      return content('This trial is no longer available.', 'এই ট্রায়ালটি এখন আর পাওয়া যাচ্ছে না।')
    case 'PLAN_ALREADY_ACTIVE':
      return content('Your account already has an active plan.', 'আপনার অ্যাকাউন্টে আগে থেকেই একটি চালু প্ল্যান আছে।')
    case 'NO_BILLING_ACCOUNT':
      return content('This workspace isn’t linked to a billing account. Contact support.', 'এই ওয়ার্কস্পেসটি কোনো বিলিং অ্যাকাউন্টের সাথে যুক্ত নয়। সাপোর্টে যোগাযোগ করুন।')
    case 'PLAN_NOT_AVAILABLE':
      return content('This plan is no longer available.', 'এই প্ল্যানটি এখন আর পাওয়া যাচ্ছে না।')
    default:
      return content('Couldn’t start the trial. Please try again.', 'ট্রায়াল শুরু করা যায়নি। আবার চেষ্টা করুন।')
  }
}

export function limitLabel(key: PlanLimitKey, value: number, content: ContentFn, language: Language): string {
  const n = formatNumber(value, language)
  switch (key) {
    case 'connectedPages':
      return content(`${n} Facebook & Instagram ${value === 1 ? 'Page' : 'Pages'}`, `${n}টি ফেসবুক ও ইনস্টাগ্রাম পেজ`)
    case 'monthlyComments':
      return content(`${n} comments scanned a month`, `মাসে ${n}টি কমেন্ট যাচাই`)
    case 'teamSeats':
      return content(`${n} team ${value === 1 ? 'seat' : 'seats'}`, `${n}টি টিম সিট`)
    case 'workspaces':
      return content(`${n} ${value === 1 ? 'workspace' : 'workspaces'}`, `${n}টি ওয়ার্কস্পেস`)
  }
}

export function featureLabel(key: PlanFeatureKey, content: ContentFn): string {
  switch (key) {
    case 'banglaAiFilter':
      return content('Bangla, Banglish & English AI filter', 'বাংলা, বাংলিশ ও ইংরেজি এআই ফিল্টার')
    case 'autoHideScams':
      return content('Auto-hide scam & poaching links', 'স্ক্যাম ও কাস্টমার টানার লিংক অটো-হাইড')
    case 'customBlocklist':
      return content('Custom keyword & BD phone blocklist', 'নিজস্ব কিওয়ার্ড ও ফোন নম্বর ব্লকলিস্ট')
    case 'autoReplyTemplates':
      return content('Brand-voice auto-reply templates', 'ব্র্যান্ডের ভাষায় অটো-রিপ্লাই টেমপ্লেট')
    case 'messengerAlerts':
      return content('WhatsApp & Telegram alerts', 'হোয়াটসঅ্যাপ ও টেলিগ্রাম অ্যালার্ট')
    case 'whiteLabelReports':
      return content('White-label CSV/PDF reports', 'হোয়াইট-লেবেল CSV/PDF রিপোর্ট')
    case 'prioritySupportApi':
      return content('Priority support & API webhooks', 'অগ্রাধিকার সাপোর্ট ও API ওয়েবহুক')
  }
}
