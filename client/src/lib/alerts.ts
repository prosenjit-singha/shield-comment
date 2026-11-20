import { queryOptions } from '@tanstack/react-query'
import { apiFetch, type ApiError } from '@/lib/api'
import type { ContentFn } from '@/lib/auth-errors'
import { formatCount } from '@/lib/dashboard-summary'
import type { Language } from '@/lib/language'
import { genericFailure } from '@/lib/meta-messages'

/*
 * C12 `/settings/alerts` data (M7-T15; Module 7 D2, D12–D15, M7-D20/D21 answered 2026-11-20).
 * Backend `src/alerts/`: `GET/PATCH …/alerts/settings` (GET every member, PATCH owner/admin, impersonated ok),
 * `POST …/alerts/telegram/link`, `DELETE …/alerts/telegram/chats/:id`, `POST …/alerts/test` (owner/admin).
 */

export type AlertChannel = 'EMAIL' | 'TELEGRAM'
export type AlertDeliveryStatus = 'SENT' | 'FAILED'

export interface AlertRecipient {
  memberId: string
  userId: string
  name: string
  email: string
  role: string
}

export interface TelegramChat {
  id: string
  title: string
  type: 'private' | 'group' | 'supergroup'
  linkedAt: string
}

export interface AlertDelivery {
  channel: AlertChannel
  status: AlertDeliveryStatus
  scamCount: number
  errorKind: string | null
  sentAt: string
}

export interface AlertSettings {
  workspaceId: string
  spikeThreshold: number
  email: { enabled: boolean; available: true; recipients: AlertRecipient[] }
  /** `available` = the plan has `messengerAlerts` (D12); `configured` = the platform bot is set up. */
  telegram: { enabled: boolean; available: boolean; configured: boolean; chats: TelegramChat[] }
  whatsapp: { enabled: false; available: false; comingSoon: true }
  /** Latest real (non-test) delivery per channel (M7-D21). */
  lastAlerts: AlertDelivery[]
  updatedAt: string | null
}

export interface AlertSettingsPatch {
  spikeThreshold?: number
  emailEnabled?: boolean
  emailRecipientMemberIds?: string[]
  telegramEnabled?: boolean
}

export interface TelegramLink {
  url: string
  groupUrl: string
  expiresAt: string
}

export interface TestAlertResult {
  deliveries: { channel: AlertChannel; status: AlertDeliveryStatus; errorKind: string | null }[]
}

export const MIN_SPIKE_THRESHOLD = 1
export const MAX_SPIKE_THRESHOLD = 1000
export const MAX_EMAIL_RECIPIENTS = 10
export const MAX_TELEGRAM_CHATS = 3

const base = (workspaceId: string) => `/api/workspaces/${encodeURIComponent(workspaceId)}/alerts`

export const alertSettingsKey = (workspaceId: string) => ['workspace', workspaceId, 'alerts', 'settings'] as const

export function alertSettingsQueryOptions(workspaceId: string) {
  return queryOptions({
    queryKey: alertSettingsKey(workspaceId),
    queryFn: () => apiFetch<AlertSettings>(`${base(workspaceId)}/settings`),
  })
}

export const updateAlertSettings = (workspaceId: string, patch: AlertSettingsPatch) =>
  apiFetch<AlertSettings>(`${base(workspaceId)}/settings`, { method: 'PATCH', body: patch })
export const createTelegramLink = (workspaceId: string) => apiFetch<TelegramLink>(`${base(workspaceId)}/telegram/link`, { method: 'POST' })
export const removeTelegramChat = (workspaceId: string, chatId: string) =>
  apiFetch<void>(`${base(workspaceId)}/telegram/chats/${encodeURIComponent(chatId)}`, { method: 'DELETE' })
export const sendTestAlert = (workspaceId: string) => apiFetch<TestAlertResult>(`${base(workspaceId)}/test`, { method: 'POST' })

/** The form's editable fields; the threshold stays text while typing. */
export interface AlertDraft {
  threshold: string
  emailEnabled: boolean
  recipientIds: string[]
  telegramEnabled: boolean
}

export function alertDraft(settings: AlertSettings): AlertDraft {
  return {
    threshold: String(settings.spikeThreshold),
    emailEnabled: settings.email.enabled,
    recipientIds: settings.email.recipients.map((recipient) => recipient.memberId),
    telegramEnabled: settings.telegram.enabled,
  }
}

const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((id) => b.includes(id))

/** Only the changed fields (`null` = nothing to save). Call after `alertDraftErrors` is empty. */
export function alertSettingsPatch(saved: AlertSettings, draft: AlertDraft): AlertSettingsPatch | null {
  const before = alertDraft(saved)
  const patch: AlertSettingsPatch = {}
  const threshold = Number(draft.threshold.trim())
  if (threshold !== saved.spikeThreshold) patch.spikeThreshold = threshold
  if (draft.emailEnabled !== before.emailEnabled) patch.emailEnabled = draft.emailEnabled
  if (!sameSet(draft.recipientIds, before.recipientIds)) patch.emailRecipientMemberIds = draft.recipientIds
  if (draft.telegramEnabled !== before.telegramEnabled) patch.telegramEnabled = draft.telegramEnabled
  return Object.keys(patch).length > 0 ? patch : null
}

export interface AlertDraftErrors {
  threshold?: string
  recipients?: string
}

export function alertDraftErrors(draft: AlertDraft, content: ContentFn, language: Language): AlertDraftErrors {
  const errors: AlertDraftErrors = {}
  const value = draft.threshold.trim()
  const n = Number(value)
  if (!/^\d+$/.test(value) || n < MIN_SPIKE_THRESHOLD || n > MAX_SPIKE_THRESHOLD) errors.threshold = thresholdMessage(content, language)
  if (draft.recipientIds.length > MAX_EMAIL_RECIPIENTS) errors.recipients = recipientsLimitMessage(content, language)
  else if (draft.emailEnabled && draft.recipientIds.length === 0) errors.recipients = recipientsRequiredMessage(content)
  return errors
}

const thresholdMessage = (content: ContentFn, language: Language) =>
  content(
    `Enter a whole number from ${MIN_SPIKE_THRESHOLD} to ${formatCount(MAX_SPIKE_THRESHOLD, 'en')}.`,
    `${formatCount(MIN_SPIKE_THRESHOLD, language)} থেকে ${formatCount(MAX_SPIKE_THRESHOLD, language)}-এর মধ্যে একটি পূর্ণ সংখ্যা লিখুন।`,
  )
const recipientsLimitMessage = (content: ContentFn, language: Language) =>
  content(
    `Choose up to ${MAX_EMAIL_RECIPIENTS} people for email alerts.`,
    `ইমেইল অ্যালার্টের জন্য সর্বোচ্চ ${formatCount(MAX_EMAIL_RECIPIENTS, language)} জন বেছে নিন।`,
  )
const recipientsRequiredMessage = (content: ContentFn) =>
  content('Choose at least one person to get email alerts, or switch email off.', 'ইমেইল অ্যালার্ট পেতে অন্তত একজন বেছে নিন, অথবা ইমেইল বন্ধ করুন।')
const planMessage = (content: ContentFn) =>
  content(
    'Telegram alerts are part of the Growth and Pro plans. Upgrade to use them.',
    'টেলিগ্রাম অ্যালার্ট গ্রোথ ও প্রো প্ল্যানে আছে। ব্যবহার করতে প্ল্যান আপগ্রেড করুন।',
  )

/** Every alert write failure by `code`, then by status; server text is never shown. */
export function alertErrorMessage(error: ApiError, content: ContentFn, language: Language): string {
  switch (error.code) {
    case 'ALERT_THRESHOLD_INVALID':
      return thresholdMessage(content, language)
    case 'ALERT_RECIPIENTS_LIMIT':
      return recipientsLimitMessage(content, language)
    case 'ALERT_RECIPIENTS_REQUIRED':
      return recipientsRequiredMessage(content)
    case 'ALERT_RECIPIENT_NOT_MEMBER':
      return content(
        'Someone you chose is no longer in this workspace. The list has been refreshed; check it and save again.',
        'আপনার বেছে নেওয়া একজন আর এই ওয়ার্কস্পেসে নেই। তালিকা আবার লোড হয়েছে; দেখে আবার সেভ করুন।',
      )
    case 'PLAN_FEATURE_UNAVAILABLE':
      return planMessage(content)
    case 'TELEGRAM_NOT_CONFIGURED':
      return content('Telegram alerts aren’t available right now. Try again later.', 'টেলিগ্রাম অ্যালার্ট এই মুহূর্তে পাওয়া যাচ্ছে না। পরে আবার চেষ্টা করুন।')
    case 'TELEGRAM_CHAT_LIMIT':
      return content(
        `You can link up to ${MAX_TELEGRAM_CHATS} Telegram chats. Remove one to link another.`,
        `সর্বোচ্চ ${formatCount(MAX_TELEGRAM_CHATS, language)}টি টেলিগ্রাম চ্যাট যুক্ত করা যায়। আরেকটি যুক্ত করতে একটি সরান।`,
      )
    case 'ALERT_NO_CHANNEL':
      return content(
        'Nothing to send to yet. Switch on email, or Telegram with a linked chat, and save first.',
        'পাঠানোর মতো কিছু নেই। আগে ইমেইল, অথবা যুক্ত চ্যাটসহ টেলিগ্রাম চালু করে সেভ করুন।',
      )
    case 'ALERT_TEST_RATE_LIMITED': {
      const max = typeof error.details?.max === 'number' ? error.details.max : 5
      return content(
        `You can send ${max} test alerts an hour. Try again later.`,
        `ঘণ্টায় ${formatCount(max, language)}টি টেস্ট অ্যালার্ট পাঠানো যায়। পরে আবার চেষ্টা করুন।`,
      )
    }
  }
  if (error.status === 403)
    return content('Only the owner and admins can change alert settings.', 'শুধু মালিক ও অ্যাডমিন অ্যালার্ট সেটিংস বদলাতে পারেন।')
  if (error.status === 404) return content('This chat is no longer linked.', 'এই চ্যাটটি আর যুক্ত নেই।')
  if (error.status === 400) return content('Check the details and try again.', 'তথ্যগুলো দেখে আবার চেষ্টা করুন।')
  return genericFailure(error, content)
}

export function alertLoadErrorMessage(error: ApiError, content: ContentFn): string {
  if (error.status === 404) return content('This workspace couldn’t be found.', 'এই ওয়ার্কস্পেসটি খুঁজে পাওয়া যায়নি।')
  return genericFailure(error, content)
}

/** Why a delivery failed (backend `TelegramSendError.kind` / email kinds), short. */
export function deliveryErrorText(kind: string | null, content: ContentFn): string {
  switch (kind) {
    case 'chat_unavailable':
      return content('a chat removed the bot or was deleted', 'কোনো চ্যাট বট সরিয়ে দিয়েছে বা মুছে ফেলা হয়েছে')
    case 'not_configured':
      return content('sending isn’t set up on our side yet', 'আমাদের দিকে পাঠানোর ব্যবস্থা এখনো চালু হয়নি')
    case 'rate_limited':
      return content('too many messages, try again later', 'অনেক বেশি মেসেজ, পরে আবার চেষ্টা করুন')
    default:
      return content('it couldn’t be delivered', 'পৌঁছানো যায়নি')
  }
}

export const channelLabel = (channel: AlertChannel, content: ContentFn) =>
  channel === 'EMAIL' ? content('Email', 'ইমেইল') : content('Telegram', 'টেলিগ্রাম')
