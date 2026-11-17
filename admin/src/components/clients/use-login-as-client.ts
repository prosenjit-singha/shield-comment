import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { type AdminClient, adminClientsKey, impersonateClient } from '@/lib/admin-clients'
import { ApiError } from '@/lib/api'

/**
 * 1-click "Login as Client" (M1-T3 API). The new tab is opened **synchronously inside the click**
 * (popup blockers only allow `window.open` during a user gesture), then pointed at the client app's
 * `/impersonate?token=…` once the API answers, or closed on error. The admin tab keeps its own
 * host-only session cookie, so it stays signed in.
 */
export function useLoginAsClient() {
  const queryClient = useQueryClient()
  const mutation = useMutation({ mutationFn: impersonateClient })

  const start = (client: AdminClient) => {
    const tab = window.open('', '_blank')
    // The client app is another origin: don't let it script this admin tab.
    if (tab) tab.opener = null

    mutation.mutateAsync(client.id).then(
      ({ redirectUrl }) => {
        if (tab && !tab.closed) {
          tab.location.href = redirectUrl
          return
        }
        // Blocked anyway (or closed by the user): offer a second click, which is its own gesture.
        toast.info(`Your browser blocked the new tab for ${client.name}.`, {
          action: { label: 'Open', onClick: () => window.open(redirectUrl, '_blank', 'noopener') },
          duration: 60_000, // the token is valid for 60 s
        })
      },
      (err: unknown) => {
        tab?.close()
        // 404/409 mean the row on screen is stale (deleted, suspended, owner gone): refresh it.
        if (err instanceof ApiError && (err.status === 404 || err.status === 409)) {
          void queryClient.invalidateQueries({ queryKey: adminClientsKey })
        }
        if (err instanceof ApiError && err.status === 409) {
          toast.error(`Can't log in as ${client.name}.`, { description: err.message })
        } else if (err instanceof ApiError && err.status === 404) {
          toast.error('This client no longer exists.')
        } else {
          toast.error(`Couldn't log in as ${client.name}.`, {
            description: err instanceof Error ? err.message : undefined,
          })
        }
      },
    )
  }

  return { start, pendingId: mutation.isPending ? mutation.variables : undefined }
}
