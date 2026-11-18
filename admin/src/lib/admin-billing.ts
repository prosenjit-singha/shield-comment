import { keepPreviousData, queryOptions } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'

/**
 * `GET /api/admin/billing/transactions` (M2-T9, user decision 2026-11-18). Mirrors the backend's
 * `src/admin/dto/billing-transactions.dto.ts`. The list stays empty until Module 8 adds SSLCommerz
 * payments; the screen already renders the final columns, so Module 8 only swaps data in.
 */
export const TRANSACTION_STATUSES = ['PENDING', 'PAID', 'FAILED', 'CANCELLED', 'REFUNDED'] as const
export type TransactionStatus = (typeof TRANSACTION_STATUSES)[number]

export interface AdminTransaction {
  id: string
  workspace: { id: string; name: string }
  plan: { id: string; name: string }
  /** Whole taka (৳). */
  amountBdt: number
  /** SSLCommerz `card_type` label, e.g. `bKash`, `Nagad`, `Visa`. */
  gateway: string
  status: TransactionStatus
  /** SSLCommerz `tran_id`. */
  tranId: string
  createdAt: string
}

export interface TransactionList {
  items: AdminTransaction[]
  total: number
  skip: number
  take: number
}

export const TRANSACTIONS_PAGE_SIZE = 20

export const transactionStatusLabels: Record<TransactionStatus, string> = {
  PENDING: 'Pending',
  PAID: 'Paid',
  FAILED: 'Failed',
  CANCELLED: 'Cancelled',
  REFUNDED: 'Refunded',
}

/** `/admin/billing` URL search params. Page 1 is left out of the URL. */
export interface BillingSearch {
  page?: number
}

/**
 * `validateSearch` for the route: drops anything malformed instead of throwing. `page` is always
 * returned (possibly `undefined`): the router merges the raw URL search under the validated one, so
 * omitting the key would let `?page=abc` through.
 */
export function validateBillingSearch(raw: Record<string, unknown>): BillingSearch {
  const page = typeof raw.page === 'number' ? raw.page : Number(raw.page)
  return { page: Number.isInteger(page) && page > 1 ? page : undefined }
}

export function transactionListParams(search: BillingSearch): URLSearchParams {
  return new URLSearchParams({
    skip: String(((search.page ?? 1) - 1) * TRANSACTIONS_PAGE_SIZE),
    take: String(TRANSACTIONS_PAGE_SIZE),
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
