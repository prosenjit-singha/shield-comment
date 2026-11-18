import { useMutation, type UseMutationResult } from '@tanstack/react-query'
import type { ApiError } from '@/lib/api'
import { fetchMetaOAuthUrl, goToExternalUrl, type MetaReturnPath } from '@/lib/meta-pages'

export type MetaConnectMutation = UseMutationResult<string, ApiError, void>

/**
 * "Continue with / Reconnect Facebook" (D5/D6) for `/onboarding` and `/pages`: `GET …/meta/oauth/url
 * ?returnTo=` → full-page navigation to the Meta dialog (the callback brings the user back to `returnTo`).
 * UI: `src/components/meta/meta-connect.tsx`.
 */
export function useMetaConnect(workspaceId: string, returnTo: MetaReturnPath): MetaConnectMutation {
  return useMutation<string, ApiError, void>({
    mutationFn: () => fetchMetaOAuthUrl(workspaceId, returnTo),
    onSuccess: (url) => goToExternalUrl(url),
  })
}
