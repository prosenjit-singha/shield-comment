import { keepPreviousData, queryOptions } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'

/**
 * A4 `/admin/billing` (M2-T9 list; M8-T9 filters, sheet, refunds, failed IPNs). Mirrors the backend's
 * `src/admin/dto/billing-transactions.dto.ts` and the outcome codes of `src/billing/payment-callback.ts`.
 */
export const TRANSACTION_STATUSES = ['PENDING', 'PAID', 'FAILED', 'CANCELLED', 'REFUNDED'] as const
export type TransactionStatus = (typeof TRANSACTION_STATUSES)[number]

export interface AdminTransaction {
  id: string
  workspace: { id: string; name: string }
  plan: { id: string; name: string }
  /** Whole taka (৳). */
  amountBdt: number
  /** `gatewayLabel()`: `bKash`, `Nagad`, `Visa`, …; `PROMOTION` (৳0); `SSLCommerz` (no card yet). */
  gateway: string
  status: TransactionStatus
  /** SSLCommerz `tran_id`. */
  tranId: string
  createdAt: string
  /** D10: SSLCommerz `risk_level = 1` (activated anyway, flagged here). */
  riskFlagged: boolean
  /** `SC-YYYY-NNNNN` once settled (PAID / REFUNDED). */
  invoiceNumber: string | null
}

export interface TransactionList {
  items: AdminTransaction[]
  total: number
  skip: number
  take: number
}

export type PaymentEventSource = 'IPN' | 'SUCCESS' | 'FAIL' | 'CANCEL'
export type PaymentKind = 'NEW' | 'RENEWAL' | 'UPGRADE'

export interface AdminPaymentEvent {
  id: string
  tranId: string | null
  source: PaymentEventSource
  /** `PAYMENT_OUTCOMES` code. */
  outcome: string
  receivedAt: string
}

export interface PromotionLine {
  type: 'DISCOUNT' | 'COUPON'
  name: string
  code: string | null
  label: string
  labelBn: string
  amountOffBdt: number
  months: { from: number; to: number; of: number } | null
}

/** `GET /api/admin/billing/transactions/:id`. */
export interface AdminTransactionDetail extends AdminTransaction {
  kind: PaymentKind
  interval: 'month' | 'year'
  user: { id: string; name: string; email: string } | null
  paidAt: string | null
  term: { start: string; end: string } | null
  valId: string | null
  bankTranId: string | null
  cardType: string | null
  riskLevel: number | null
  listPriceBdt: number
  promotions: PromotionLine[]
  creditBdt: number
  /** Oldest first. */
  events: AdminPaymentEvent[]
  refund: { admin: { id: string; name: string }; reason: string; createdAt: string } | null
}

export interface AdminPaymentEventItem extends AdminPaymentEvent {
  transaction: { id: string; workspace: { id: string; name: string } } | null
}

export interface PaymentEventList {
  items: AdminPaymentEventItem[]
  total: number
  skip: number
  take: number
}

export const TRANSACTIONS_PAGE_SIZE = 20
export const EVENTS_PAGE_SIZE = 20

export const transactionStatusLabels: Record<TransactionStatus, string> = {
  PENDING: 'Pending',
  PAID: 'Paid',
  FAILED: 'Failed',
  CANCELLED: 'Cancelled',
  REFUNDED: 'Refunded',
}

/** Labels the backend's `gatewayLabel()` produces; other card prefixes still work via the URL. */
export const GATEWAY_LABELS = ['bKash', 'Nagad', 'Visa', 'Mastercard', 'Amex', 'SSLCommerz', 'PROMOTION'] as const

export const paymentKindLabels: Record<PaymentKind, string> = {
  NEW: 'New',
  RENEWAL: 'Renewal',
  UPGRADE: 'Upgrade',
}

export const eventSourceLabels: Record<PaymentEventSource, string> = {
  IPN: 'IPN',
  SUCCESS: 'Success return',
  FAIL: 'Fail return',
  CANCEL: 'Cancel return',
}

/** `PAYMENT_OUTCOMES` (backend `payment-callback.ts`) → English label. */
const outcomeLabels: Record<string, string> = {
  PAID: 'Paid',
  PAID_DUPLICATE_CLAIM: 'Paid, promotion already claimed',
  ALREADY_PAID: 'Already paid',
  BAD_SIGNATURE: 'Bad signature',
  UNKNOWN_TRAN_ID: 'Unknown transaction ID',
  NO_VAL_ID: 'No validation ID',
  INVALID: 'Rejected by validation',
  TRAN_ID_MISMATCH: 'Transaction ID mismatch',
  CURRENCY_MISMATCH: 'Currency mismatch',
  AMOUNT_MISMATCH: 'Amount mismatch',
  VALIDATION_ERROR: 'Validation unreachable (retry)',
  ACTIVATION_FAILED: 'Activation failed (retry)',
  NOT_CONFIGURED: 'SSLCommerz not configured',
  FAILED: 'Payment failed',
  CANCELLED: 'Cancelled by customer',
  NOT_PENDING: 'Return after the payment closed',
}

/** Unknown codes (a newer backend) show as-is. */
export function outcomeLabel(code: string): string {
  return outcomeLabels[code] ?? code
}

/** `Month 2 of 6` / `Months 1–3 of 6`. */
export function promotionMonths(months: PromotionLine['months']): string | null {
  if (!months) return null
  return months.from === months.to
    ? `Month ${months.from} of ${months.of}`
    : `Months ${months.from}–${months.to} of ${months.of}`
}

/** `/admin/billing` URL search. Defaults are left out (`undefined`). `tab=failed` = Failed IPNs. */
export interface BillingSearch {
  tab?: 'failed'
  status?: TransactionStatus
  gateway?: string
  q?: string
  from?: string
  to?: string
  page?: number
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/

/** A real calendar day `YYYY-MM-DD` (rejects `2026-02-30`). */
function isDay(value: unknown): value is string {
  if (typeof value !== 'string' || !DATE_ONLY.test(value)) return false
  const date = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value)
}

/** The router JSON-parses values (`?q=123` → number): take numbers back as text. */
function text(value: unknown, max: number): string | undefined {
  const raw = typeof value === 'number' && Number.isFinite(value) ? String(value) : value
  if (typeof raw !== 'string') return undefined
  const trimmed = raw.trim()
  return trimmed && trimmed.length <= max ? trimmed : undefined
}

/**
 * `validateSearch`: drops anything malformed instead of throwing. Every key is returned
 * (`undefined` when invalid): the router merges the raw search under this result (M2-FIX1).
 * A `to` before `from` is dropped (the backend answers 400).
 */
export function validateBillingSearch(raw: Record<string, unknown>): BillingSearch {
  const page = typeof raw.page === 'number' ? raw.page : Number(raw.page)
  const from = isDay(raw.from) ? raw.from : undefined
  const to = isDay(raw.to) && !(from && raw.to < from) ? raw.to : undefined
  return {
    tab: raw.tab === 'failed' ? 'failed' : undefined,
    status: TRANSACTION_STATUSES.find((s) => s === raw.status),
    gateway: text(raw.gateway, 40),
    q: text(raw.q, 100),
    from,
    to,
    page: Number.isInteger(page) && page > 1 ? page : undefined,
  }
}

const skip = (page: number | undefined, size: number) => String(((page ?? 1) - 1) * size)

export function transactionListParams(search: BillingSearch): URLSearchParams {
  const params = new URLSearchParams()
  for (const key of ['status', 'gateway', 'q', 'from', 'to'] as const) {
    const value = search[key]
    if (value) params.set(key, value)
  }
  params.set('skip', skip(search.page, TRANSACTIONS_PAGE_SIZE))
  params.set('take', String(TRANSACTIONS_PAGE_SIZE))
  return params
}

export function eventListParams(page: number | undefined): URLSearchParams {
  return new URLSearchParams({
    outcome: 'failed',
    skip: skip(page, EVENTS_PAGE_SIZE),
    take: String(EVENTS_PAGE_SIZE),
  })
}

export const adminBillingKey = ['admin', 'billing'] as const

export function transactionsQueryOptions(search: BillingSearch) {
  const params = transactionListParams(search)
  return queryOptions({
    queryKey: [...adminBillingKey, 'transactions', params.toString()] as const,
    queryFn: ({ signal }) =>
      apiFetch<TransactionList>(`/admin/billing/transactions?${params.toString()}`, { signal }),
    placeholderData: keepPreviousData,
  })
}

export function transactionQueryOptions(id: string) {
  return queryOptions({
    queryKey: [...adminBillingKey, 'transaction', id] as const,
    queryFn: ({ signal }) =>
      apiFetch<AdminTransactionDetail>(`/admin/billing/transactions/${encodeURIComponent(id)}`, { signal }),
  })
}

export function failedEventsQueryOptions(page: number | undefined) {
  const params = eventListParams(page)
  return queryOptions({
    queryKey: [...adminBillingKey, 'events', params.toString()] as const,
    queryFn: ({ signal }) => apiFetch<PaymentEventList>(`/admin/billing/events?${params.toString()}`, { signal }),
    placeholderData: keepPreviousData,
  })
}

/** D9: marks a PAID row REFUNDED (the money is refunded in the SSLCommerz merchant panel). */
export function refundTransaction(input: { id: string; reason: string }) {
  return apiFetch<AdminTransactionDetail>(`/admin/billing/transactions/${encodeURIComponent(input.id)}/refund`, {
    method: 'POST',
    body: JSON.stringify({ reason: input.reason }),
  })
}

const dhakaTime = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Dhaka',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
})

/** `02:30` (24 h) in Bangladesh time; the date itself uses `formatDhakaDate`. */
export function formatDhakaTime(iso: string): string {
  return dhakaTime.format(new Date(iso))
}
