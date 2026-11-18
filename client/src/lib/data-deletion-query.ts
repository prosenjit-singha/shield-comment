import { queryOptions } from '@tanstack/react-query'
import { dataDeletionStatusQueryKey, fetchDataDeletionStatus, type DataDeletionLookup } from '@/lib/data-deletion'
import { getServerDataDeletionStatus } from '@/server/data-deletion'

/**
 * `/data-deletion` status lookup. Server render: the `getServerDataDeletionStatus` server function calls
 * the backend directly; browser: same-origin `/api` via `apiFetch`. A plain `typeof window` branch, as in
 * `sessionQueryOptions` (a server fn inside `createIsomorphicFn().server()` drops out of the prod manifest).
 * No automatic retries: a 429 must not be repeated, and the page has a Try again button.
 */
export function dataDeletionStatusQueryOptions(code: string) {
  return queryOptions({
    queryKey: dataDeletionStatusQueryKey(code),
    queryFn: (): Promise<DataDeletionLookup> =>
      typeof window === 'undefined' ? getServerDataDeletionStatus({ data: code }) : fetchDataDeletionStatus(code),
    retry: false,
  })
}
