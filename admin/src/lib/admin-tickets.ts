import { keepPreviousData, queryOptions } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'

/** Mirrors the M2-T7 backend contract (`backend/src/support-tickets/`). */
export const TICKET_STATUSES = ['OPEN', 'IN_PROGRESS', 'RESOLVED'] as const
export const TICKET_PRIORITIES = ['LOW', 'MEDIUM', 'HIGH'] as const
export const TICKET_CATEGORIES = ['BILLING', 'TECHNICAL', 'ACCOUNT', 'OTHER'] as const
export type TicketStatus = (typeof TICKET_STATUSES)[number]
export type TicketPriority = (typeof TICKET_PRIORITIES)[number]
export type TicketCategory = (typeof TICKET_CATEGORIES)[number]
export type TicketSenderRole = 'ADMIN' | 'CLIENT'

export interface TicketPerson {
  id: string
  name: string
  email: string
}

/** `GET /api/admin/tickets` item. Timestamps are ISO strings; counts include internal notes. */
export interface TicketListItem {
  id: string
  subject: string
  category: TicketCategory
  priority: TicketPriority
  status: TicketStatus
  createdAt: string
  updatedAt: string
  workspace: { id: string; name: string }
  requester: TicketPerson
  lastMessageAt: string | null
  messageCount: number
}

export interface TicketMessage {
  id: string
  senderRole: TicketSenderRole
  sender: TicketPerson
  body: string
  isInternalNote: boolean
  createdAt: string
}

/** `GET /api/admin/tickets/:id`: messages oldest first, internal notes included. */
export interface TicketThread extends TicketListItem {
  messages: TicketMessage[]
}

export interface TicketList {
  items: TicketListItem[]
  total: number
  skip: number
  take: number
}

export const statusLabels: Record<TicketStatus, string> = {
  OPEN: 'Open',
  IN_PROGRESS: 'In progress',
  RESOLVED: 'Resolved',
}
export const priorityLabels: Record<TicketPriority, string> = {
  LOW: 'Low',
  MEDIUM: 'Medium',
  HIGH: 'High',
}
export const categoryLabels: Record<TicketCategory, string> = {
  BILLING: 'Billing',
  TECHNICAL: 'Technical',
  ACCOUNT: 'Account',
  OTHER: 'Other',
}

export const TICKETS_PAGE_SIZE = 20
export const TICKET_SEARCH_MAX = 100
export const REPLY_MAX = 5000

/**
 * `/admin/tickets` URL search params. Defaults are left out (`undefined`): all statuses,
 * priorities and categories, no search, page 1, no ticket open. `ticket` is the open thread's id.
 */
export interface TicketsSearch {
  status?: TicketStatus
  priority?: TicketPriority
  category?: TicketCategory
  q?: string
  page?: number
  ticket?: string
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function oneOf<T extends string>(values: readonly T[], value: unknown): T | undefined {
  return values.find((v) => v === value)
}

/**
 * `validateSearch` for the route: drops anything malformed instead of throwing. Every key is
 * returned (`undefined` when missing or malformed): TanStack Router merges the raw search under
 * this result, so an omitted key would let a malformed value through (`?page=abc` → `skip=NaN`).
 */
export function validateTicketsSearch(raw: Record<string, unknown>): TicketsSearch {
  const page = typeof raw.page === 'number' ? raw.page : Number(raw.page)
  // The router JSON-parses search values, so a hand-typed `?q=123` arrives as a number.
  const q = typeof raw.q === 'number' && Number.isFinite(raw.q) ? String(raw.q) : raw.q
  return {
    status: oneOf(TICKET_STATUSES, raw.status),
    priority: oneOf(TICKET_PRIORITIES, raw.priority),
    category: oneOf(TICKET_CATEGORIES, raw.category),
    q: typeof q === 'string' && q.trim() ? q.trim().slice(0, TICKET_SEARCH_MAX) : undefined,
    page: Number.isInteger(page) && page > 1 ? page : undefined,
    ticket: typeof raw.ticket === 'string' && UUID.test(raw.ticket) ? raw.ticket : undefined,
  }
}

/** Query string for `GET /api/admin/tickets` (the open ticket is not a list filter). */
export function ticketListParams(search: TicketsSearch): URLSearchParams {
  const params = new URLSearchParams()
  if (search.status) params.set('status', search.status)
  if (search.priority) params.set('priority', search.priority)
  if (search.category) params.set('category', search.category)
  if (search.q) params.set('q', search.q)
  params.set('skip', String(((search.page ?? 1) - 1) * TICKETS_PAGE_SIZE))
  params.set('take', String(TICKETS_PAGE_SIZE))
  return params
}

export const adminTicketsKey = ['admin', 'tickets'] as const
export const ticketListsKey = [...adminTicketsKey, 'list'] as const
export const ticketThreadKey = (id: string) => [...adminTicketsKey, 'thread', id] as const

export function ticketsQueryOptions(search: TicketsSearch) {
  const params = ticketListParams(search)
  return queryOptions({
    queryKey: [...ticketListsKey, params.toString()] as const,
    queryFn: ({ signal }) => apiFetch<TicketList>(`/admin/tickets?${params.toString()}`, { signal }),
    // Keep the previous page on screen while the next filter/page loads.
    placeholderData: keepPreviousData,
  })
}

export function ticketThreadQueryOptions(id: string) {
  return queryOptions({
    queryKey: ticketThreadKey(id),
    queryFn: ({ signal }) =>
      apiFetch<TicketThread>(`/admin/tickets/${encodeURIComponent(id)}`, { signal }),
  })
}

export function replyToTicket(input: { id: string; body: string; isInternalNote: boolean }) {
  return apiFetch<{ message: TicketMessage; ticket: TicketListItem }>(
    `/admin/tickets/${encodeURIComponent(input.id)}/reply`,
    { method: 'POST', body: JSON.stringify({ body: input.body, isInternalNote: input.isInternalNote }) },
  )
}

export function updateTicketStatus(input: { id: string; status: TicketStatus }) {
  return apiFetch<{ ticket: TicketListItem; changed: boolean }>(
    `/admin/tickets/${encodeURIComponent(input.id)}/status`,
    { method: 'PATCH', body: JSON.stringify({ status: input.status }) },
  )
}

/** Trimmed body → error text, or `null` when valid (backend: trimmed, 1–5000). */
export function replyError(body: string): string | null {
  const trimmed = body.trim()
  if (!trimmed) return 'Write a message first.'
  if (trimmed.length > REPLY_MAX) return `Keep it to ${REPLY_MAX} characters or fewer.`
  return null
}

/** Last activity on a ticket: newest message (notes included), else when it was opened. */
export const lastActivity = (ticket: TicketListItem) => ticket.lastMessageAt ?? ticket.createdAt

const DHAKA = 'Asia/Dhaka'
const dayKey = new Intl.DateTimeFormat('en-CA', { timeZone: DHAKA, year: 'numeric', month: '2-digit', day: '2-digit' })
const timeOnly = new Intl.DateTimeFormat('en-GB', { timeZone: DHAKA, hour: 'numeric', minute: '2-digit', hour12: true })
const dayMonth = new Intl.DateTimeFormat('en-GB', { timeZone: DHAKA, day: 'numeric', month: 'short' })
const fullDate = new Intl.DateTimeFormat('en-GB', { timeZone: DHAKA, day: 'numeric', month: 'short', year: 'numeric' })
const fullDateTime = new Intl.DateTimeFormat('en-GB', {
  timeZone: DHAKA,
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  hour12: true,
})

/** Compact Dhaka time for the queue: today → `3:45 pm`, this year → `18 Nov`, else `18 Nov 2025`. */
export function formatQueueTime(iso: string, now: Date = new Date()): string {
  const date = new Date(iso)
  const day = dayKey.format(date)
  const today = dayKey.format(now)
  if (day === today) return timeOnly.format(date)
  if (day.slice(0, 4) === today.slice(0, 4)) return dayMonth.format(date)
  return fullDate.format(date)
}

/** Full Dhaka date-time for messages and tooltips: `18 Nov 2026, 3:45 pm`. */
export function formatDhakaDateTime(iso: string): string {
  return fullDateTime.format(new Date(iso))
}
