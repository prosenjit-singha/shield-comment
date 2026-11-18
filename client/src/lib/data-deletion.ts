import { ApiError, apiFetch, toApiError } from '@/lib/api'
import type { Language } from '@/lib/language'

/**
 * Meta Data Deletion status page (D6, M4-T12). The backend answers
 * `GET /api/meta/data-deletion/:code` → `{ status, requestedAt, completedAt }` (404 unknown/malformed).
 */

/** Same rule as the backend (`DATA_DELETION_CODE_PATTERN`): 16 random bytes, base64url. */
export const DATA_DELETION_CODE_PATTERN = /^[A-Za-z0-9_-]{22}$/

export type DataDeletionRequestStatus = 'PENDING' | 'COMPLETED'

export interface DataDeletionStatus {
  status: DataDeletionRequestStatus
  requestedAt: string
  completedAt: string | null
}

/** What a lookup can answer: a 404 is a normal answer here, not a failure. */
export type DataDeletionLookup = { kind: 'found'; request: DataDeletionStatus } | { kind: 'unknown' }

export interface DataDeletionSearch {
  code: string | undefined
}

/**
 * `?code=` survives only when it has the backend's shape, so a malformed code never leaves the browser.
 * The key is always returned: the router merges the raw search under this result.
 */
export function validateDataDeletionSearch(search: Record<string, unknown>): DataDeletionSearch {
  const code = search.code
  return { code: typeof code === 'string' && DATA_DELETION_CODE_PATTERN.test(code) ? code : undefined }
}

export function dataDeletionStatusPath(code: string): string {
  return `/api/meta/data-deletion/${encodeURIComponent(code)}`
}

const isTimestamp = (value: unknown): value is string => typeof value === 'string' && !Number.isNaN(Date.parse(value))

/** The backend body, or `null` when it doesn't have the expected shape. */
export function parseDataDeletionStatus(body: unknown): DataDeletionStatus | null {
  if (typeof body !== 'object' || body === null) return null
  const { status, requestedAt, completedAt } = body as Record<string, unknown>
  if (status !== 'PENDING' && status !== 'COMPLETED') return null
  if (!isTimestamp(requestedAt)) return null
  if (completedAt !== null && !isTimestamp(completedAt)) return null
  return { status, requestedAt, completedAt }
}

/** A 2xx body as a lookup result; an unexpected shape counts as a server failure. */
export function lookupFromBody(body: unknown): DataDeletionLookup {
  const request = parseDataDeletionStatus(body)
  if (!request) throw new ApiError(502, 'Unexpected response body')
  return { kind: 'found', request }
}

/** Browser path: same-origin `/api` proxy through `apiFetch`. */
export async function fetchDataDeletionStatus(code: string): Promise<DataDeletionLookup> {
  let body: unknown
  try {
    body = await apiFetch<unknown>(dataDeletionStatusPath(code))
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return { kind: 'unknown' }
    throw error
  }
  return lookupFromBody(body)
}

export const dataDeletionStatusQueryKey = (code: string) => ['meta', 'data-deletion', code] as const

export type DataDeletionFailure = 'rate-limited' | 'network' | 'unavailable'

/** Why a lookup failed (404 is not a failure, see `DataDeletionLookup`). */
export function dataDeletionFailure(error: unknown): DataDeletionFailure {
  const apiError = toApiError(error)
  if (apiError.status === 429) return 'rate-limited'
  if (apiError.isNetwork) return 'network'
  return 'unavailable'
}

const EN_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const BN_MONTHS = [
  'জানুয়ারি',
  'ফেব্রুয়ারি',
  'মার্চ',
  'এপ্রিল',
  'মে',
  'জুন',
  'জুলাই',
  'আগস্ট',
  'সেপ্টেম্বর',
  'অক্টোবর',
  'নভেম্বর',
  'ডিসেম্বর',
]
const BN_DIGITS = '০১২৩৪৫৬৭৮৯'
/** Bangladesh has been UTC+6 all year since 2009 (no DST). */
const DHAKA_OFFSET_MS = 6 * 60 * 60 * 1000

const pad = (value: number) => String(value).padStart(2, '0')

/** Digits only (no grouping), e.g. a year stays `২০২৬`, unlike `bnNumber`'s `২,০২৬`. */
export function toBanglaDigits(text: string): string {
  return text.replace(/[0-9]/g, (digit) => BN_DIGITS[Number(digit)] ?? digit)
}

/**
 * `19 Nov 2026, 15:05 (Bangladesh time)` / `১৯ নভেম্বর ২০২৬, ১৫:০৫ (বাংলাদেশ সময়)`. Built by hand (fixed
 * UTC+6, own month names) instead of `Intl`, so the server render and the browser always produce the
 * same string, whatever their time zone or ICU data.
 */
export function formatDhakaDateTime(iso: string, language: Language): string {
  const time = Date.parse(iso)
  if (Number.isNaN(time)) return iso
  const dhaka = new Date(time + DHAKA_OFFSET_MS)
  const day = dhaka.getUTCDate()
  const month = dhaka.getUTCMonth()
  const year = dhaka.getUTCFullYear()
  const clock = `${pad(dhaka.getUTCHours())}:${pad(dhaka.getUTCMinutes())}`
  if (language === 'bn') return `${toBanglaDigits(`${day} ${BN_MONTHS[month]} ${year}, ${clock}`)} (বাংলাদেশ সময়)`
  return `${day} ${EN_MONTHS[month]} ${year}, ${clock} (Bangladesh time)`
}
