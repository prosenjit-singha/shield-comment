import { queryOptions } from '@tanstack/react-query'
import { apiFetch, type ApiError } from '@/lib/api'
import type { ContentFn } from '@/lib/auth-errors'
import { UUID } from '@/lib/comments-feed'
import { formatCount } from '@/lib/dashboard-summary'
import { genericFailure } from '@/lib/meta-messages'

/*
 * C13 `/support` data (M7-T12; Module 7 D1–D5 answered 2026-11-20).
 * Mirrors `backend/src/support-tickets/client-tickets.*` + `dto/tickets.dto.ts` (dates are ISO strings):
 * - `GET  /api/workspaces/:workspaceId/support/tickets` → `{ items, total, skip, take }` (moderators get only their own, D1).
 * - `POST …/support/tickets` → 201 `ClientTicketDetail`; `GET …/:ticketId` → `ClientTicketDetail`.
 * - `POST …/:ticketId/reply` → 201 `{ message, ticket }`.
 * Writes are JSON, or `multipart/form-data` (`files`) only when images are attached (M7-T3).
 */

export const TICKET_CATEGORIES = ['BILLING', 'TECHNICAL', 'ACCOUNT', 'OTHER'] as const
export type TicketCategory = (typeof TICKET_CATEGORIES)[number]
export type TicketStatus = 'OPEN' | 'IN_PROGRESS' | 'RESOLVED'

export interface TicketAttachment {
  id: string
  contentType: string
  sizeBytes: number
  /** Presigned (15 min); `null` when storage is off. */
  url: string | null
}

export interface TicketItem {
  id: string
  subject: string
  category: TicketCategory
  status: TicketStatus
  createdAt: string
  updatedAt: string
  requester: { id: string; name: string }
  lastMessageAt: string | null
  /** The newest public message is from support. */
  hasNewReply: boolean
}

export interface TicketMessage {
  id: string
  senderRole: 'ADMIN' | 'CLIENT'
  sender: { id: string | null; name: string }
  body: string
  createdAt: string
  attachments: TicketAttachment[]
}

export type TicketDetail = TicketItem & { messages: TicketMessage[] }

export interface TicketList {
  items: TicketItem[]
  total: number
  skip: number
  take: number
}

/** Backend limits (`TICKET_SUBJECT_MAX`, `TICKET_MESSAGE_BODY_MAX`, D4 b attachments). */
export const SUBJECT_MAX = 200
export const BODY_MAX = 5000
export const ATTACHMENTS_MAX = 3
export const ATTACHMENT_MAX_BYTES = 5 * 1024 * 1024
export const ATTACHMENT_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const
/** D5 (a): thread every 15 s, list every 60 s; TanStack pauses `refetchInterval` while the tab is hidden. */
export const THREAD_POLL_MS = 15_000
export const LIST_POLL_MS = 60_000
/** ponytail: one page of the 100 newest tickets (API max); add "Load more" if workspaces outgrow it. */
const LIST_TAKE = 100

export interface SupportSearch {
  ticket?: string
}

export function validateSupportSearch(raw: Record<string, unknown>): SupportSearch {
  return { ticket: typeof raw.ticket === 'string' && UUID.test(raw.ticket) ? raw.ticket : undefined }
}

const base = (workspaceId: string) => `/api/workspaces/${encodeURIComponent(workspaceId)}/support/tickets`

export const supportRootKey = (workspaceId: string) => ['workspace', workspaceId, 'support'] as const

export function ticketsQueryOptions(workspaceId: string) {
  return queryOptions({
    queryKey: [...supportRootKey(workspaceId), 'tickets'] as const,
    queryFn: () => apiFetch<TicketList>(`${base(workspaceId)}?take=${LIST_TAKE}`),
    refetchInterval: LIST_POLL_MS,
  })
}

export function ticketQueryOptions(workspaceId: string, ticketId: string) {
  return queryOptions({
    queryKey: [...supportRootKey(workspaceId), 'ticket', ticketId] as const,
    queryFn: () => apiFetch<TicketDetail>(`${base(workspaceId)}/${encodeURIComponent(ticketId)}`),
    refetchInterval: THREAD_POLL_MS,
  })
}

/** JSON, or multipart with the fields as text when images are attached. */
function messageBody(fields: Record<string, string>, files: readonly File[]): Record<string, string> | FormData {
  if (!files.length) return fields
  const form = new FormData()
  for (const [key, value] of Object.entries(fields)) form.set(key, value)
  for (const file of files) form.append('files', file)
  return form
}

export interface NewTicket {
  category: TicketCategory
  subject: string
  body: string
  files: readonly File[]
}

export function createTicket(workspaceId: string, input: NewTicket): Promise<TicketDetail> {
  const { files, ...fields } = input
  return apiFetch<TicketDetail>(base(workspaceId), { method: 'POST', body: messageBody(fields, files) })
}

export function replyToTicket(
  workspaceId: string,
  ticketId: string,
  input: { body: string; files: readonly File[] },
): Promise<{ message: TicketMessage; ticket: TicketItem }> {
  return apiFetch(`${base(workspaceId)}/${encodeURIComponent(ticketId)}/reply`, {
    method: 'POST',
    body: messageBody({ body: input.body }, input.files),
  })
}

type AttachmentProblem = 'ATTACHMENT_TOO_MANY' | 'ATTACHMENT_TOO_LARGE' | 'ATTACHMENT_TYPE_INVALID'

function attachmentMessage(code: AttachmentProblem | 'ATTACHMENTS_UNAVAILABLE', content: ContentFn): string {
  switch (code) {
    case 'ATTACHMENT_TOO_MANY':
      return content(`Attach at most ${ATTACHMENTS_MAX} images per message.`, 'প্রতি মেসেজে সর্বোচ্চ ৩টি ছবি যোগ করুন।')
    case 'ATTACHMENT_TOO_LARGE':
      return content('Each image must be 5 MB or smaller.', 'প্রতিটি ছবি ৫ MB বা তার কম হতে হবে।')
    case 'ATTACHMENT_TYPE_INVALID':
      return content('Only PNG, JPEG or WebP images can be attached.', 'শুধু PNG, JPEG বা WebP ছবি যোগ করা যায়।')
    case 'ATTACHMENTS_UNAVAILABLE':
      return content(
        'Screenshots can’t be uploaded right now. Remove them and send the message without images.',
        'এই মুহূর্তে স্ক্রিনশট আপলোড করা যাচ্ছে না। ছবিগুলো সরিয়ে ছবি ছাড়া মেসেজটি পাঠান।',
      )
  }
}

/**
 * Adds picked files to the current ones, checked like the backend (type, 5 MB, 3 per message);
 * files that fail are left out and `error` explains the first one.
 */
export function addAttachments(current: readonly File[], picked: readonly File[], content: ContentFn) {
  const files = [...current]
  let problem: AttachmentProblem | null = null
  for (const file of picked) {
    const issue: AttachmentProblem | null = !(ATTACHMENT_TYPES as readonly string[]).includes(file.type)
      ? 'ATTACHMENT_TYPE_INVALID'
      : file.size > ATTACHMENT_MAX_BYTES
        ? 'ATTACHMENT_TOO_LARGE'
        : files.length >= ATTACHMENTS_MAX
          ? 'ATTACHMENT_TOO_MANY'
          : null
    if (issue) problem ??= issue
    else files.push(file)
  }
  return { files, error: problem ? attachmentMessage(problem, content) : null }
}

/** `null` = ok. Trimmed like the backend. */
export function subjectError(subject: string, content: ContentFn): string | null {
  const length = subject.trim().length
  if (length === 0) return content('Add a subject.', 'একটি বিষয় লিখুন।')
  if (length > SUBJECT_MAX) return content(`Keep the subject to ${SUBJECT_MAX} characters or fewer.`, 'বিষয়টি ২০০ অক্ষরের মধ্যে রাখুন।')
  return null
}

export function bodyError(body: string, content: ContentFn): string | null {
  const length = body.trim().length
  if (length === 0) return content('Write a message first.', 'আগে একটি মেসেজ লিখুন।')
  if (length > BODY_MAX) return content(`Keep the message to ${BODY_MAX} characters or fewer.`, 'মেসেজটি ৫০০০ অক্ষরের মধ্যে রাখুন।')
  return null
}

/** Create / reply failures by `status` + `code`; backend text is never shown. */
export function writeErrorMessage(error: ApiError, content: ContentFn): string {
  switch (error.code) {
    case 'IMPERSONATION_READ_ONLY':
      return content(
        'You’re signed in as this client by support, so you can read tickets but not write them.',
        'আপনি সাপোর্ট থেকে এই ক্লায়েন্ট হিসেবে লগ ইন করেছেন, তাই টিকিট পড়তে পারবেন কিন্তু লিখতে পারবেন না।',
      )
    case 'TICKET_LIMIT_REACHED': {
      const limit = typeof error.details?.limit === 'number' ? error.details.limit : 20
      return content(
        `This workspace already has ${limit} open tickets. Wait for support to resolve one, or reply on an open ticket.`,
        `এই ওয়ার্কস্পেসে আগে থেকেই ${formatCount(limit, 'bn')}টি খোলা টিকিট আছে। সাপোর্ট একটি সমাধান করা পর্যন্ত অপেক্ষা করুন, অথবা খোলা কোনো টিকিটে উত্তর দিন।`,
      )
    }
    case 'ATTACHMENT_TOO_MANY':
    case 'ATTACHMENT_TOO_LARGE':
    case 'ATTACHMENT_TYPE_INVALID':
    case 'ATTACHMENTS_UNAVAILABLE':
      return attachmentMessage(error.code, content)
  }
  if (error.status === 404) return content('This ticket no longer exists.', 'এই টিকিটটি আর নেই।')
  if (error.status === 403) return content('You don’t have access to this workspace’s support.', 'এই ওয়ার্কস্পেসের সাপোর্টে আপনার অ্যাক্সেস নেই।')
  if (error.status === 400) return content('Check the form and try again.', 'ফর্মটি দেখে আবার চেষ্টা করুন।')
  return genericFailure(error, content)
}

/** List / thread load failures. */
export function loadErrorMessage(error: ApiError, content: ContentFn): string {
  if (error.status === 404) return content('This ticket couldn’t be found.', 'এই টিকিটটি খুঁজে পাওয়া যায়নি।')
  if (error.status === 403) return content('You don’t have access to this workspace’s support.', 'এই ওয়ার্কস্পেসের সাপোর্টে আপনার অ্যাক্সেস নেই।')
  return genericFailure(error, content)
}

export function categoryLabel(category: TicketCategory, content: ContentFn): string {
  switch (category) {
    case 'BILLING':
      return content('Billing', 'বিলিং')
    case 'TECHNICAL':
      return content('Technical', 'টেকনিক্যাল')
    case 'ACCOUNT':
      return content('Account', 'অ্যাকাউন্ট')
    case 'OTHER':
      return content('Other', 'অন্যান্য')
  }
}

export function statusLabel(status: TicketStatus, content: ContentFn): string {
  switch (status) {
    case 'OPEN':
      return content('Open', 'খোলা')
    case 'IN_PROGRESS':
      return content('In progress', 'চলমান')
    case 'RESOLVED':
      return content('Resolved', 'সমাধান হয়েছে')
  }
}
