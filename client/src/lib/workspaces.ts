import { queryOptions } from '@tanstack/react-query'
import { authClient } from '@/lib/auth-client'
import { authErrorFromResponse, toAuthError } from '@/lib/auth-errors'

export interface WorkspaceSummary {
  id: string
  name: string
}

/** Not under `['workspace', …]`: switching removes those, this list stays. */
export const workspacesQueryKey = ['auth', 'workspaces'] as const

/** The workspaces the user belongs to (Better Auth `organization/list`, M7-T11 D8). */
export const workspacesQueryOptions = queryOptions({
  queryKey: workspacesQueryKey,
  queryFn: async (): Promise<WorkspaceSummary[]> => {
    let result: Awaited<ReturnType<typeof authClient.organization.list>>
    try {
      result = await authClient.organization.list()
    } catch (thrown) {
      throw toAuthError(thrown)
    }
    if (result.error) throw authErrorFromResponse(result.error)
    // The plugin types the list loosely here; the backend returns organization rows (id, name, slug, …).
    const rows: WorkspaceSummary[] = result.data ?? []
    return rows.map(({ id, name }) => ({ id, name }))
  },
})

/** Makes `workspaceId` the session's active workspace (`organization/set-active`); throws `AuthError`. */
export async function setActiveWorkspace(workspaceId: string): Promise<void> {
  let result: Awaited<ReturnType<typeof authClient.organization.setActive>>
  try {
    result = await authClient.organization.setActive({ organizationId: workspaceId })
  } catch (thrown) {
    throw toAuthError(thrown)
  }
  if (result.error) throw authErrorFromResponse(result.error)
}
