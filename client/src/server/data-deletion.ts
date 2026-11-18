import { createServerFn } from '@tanstack/react-start'
import { getRequest, getRequestIP } from '@tanstack/react-start/server'
import { DATA_DELETION_CODE_PATTERN, type DataDeletionLookup } from '@/lib/data-deletion'
import { fetchDataDeletionStatusUpstream } from '@/server/data-deletion-upstream'

/** `/data-deletion` lookup during a server render, so the status is in the first HTML (M4-T12). */
export const getServerDataDeletionStatus = createServerFn({ method: 'GET' })
  .validator((code: unknown): string => {
    if (typeof code !== 'string' || !DATA_DELETION_CODE_PATTERN.test(code)) throw new Error('Invalid confirmation code')
    return code
  })
  .handler(
    ({ data }): Promise<DataDeletionLookup> => fetchDataDeletionStatusUpstream(data, getRequest(), getRequestIP()),
  )
