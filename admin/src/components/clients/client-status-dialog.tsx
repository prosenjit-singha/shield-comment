import { useMutation, useQueryClient } from '@tanstack/react-query'
import { type FormEvent, useId, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  type AdminClient,
  adminClientsKey,
  type ClientStatus,
  REASON_MAX,
  reasonError,
  updateClientStatus,
} from '@/lib/admin-clients'
import { ApiError } from '@/lib/api'

export interface StatusChange {
  client: AdminClient
  status: ClientStatus
}

/** Confirm dialog for suspend/activate. The backend requires a reason (trimmed, 1–500) for its audit log. */
export function ClientStatusDialog({
  change,
  onClose,
}: {
  change: StatusChange | null
  onClose: () => void
}) {
  return (
    <Dialog open={change !== null} onOpenChange={(open) => !open && onClose()}>
      {/* Keyed so each opening starts with an empty reason. */}
      {change && <StatusForm key={`${change.client.id}:${change.status}`} change={change} onClose={onClose} />}
    </Dialog>
  )
}

function StatusForm({ change, onClose }: { change: StatusChange; onClose: () => void }) {
  const queryClient = useQueryClient()
  const reasonId = useId()
  const [reason, setReason] = useState('')
  const [touched, setTouched] = useState(false)
  const error = reasonError(reason)
  const suspending = change.status === 'SUSPENDED'
  const { client } = change

  const mutation = useMutation({
    mutationFn: updateClientStatus,
    onSuccess: ({ changed }) => {
      if (!changed) toast.info(`${client.name} was already ${suspending ? 'suspended' : 'active'}.`)
      else if (suspending) toast.success(`${client.name} is suspended.`)
      else toast.success(`${client.name} is active again.`)
      onClose()
    },
    onError: (err) => {
      if (err instanceof ApiError && err.status === 404) {
        toast.error('This client no longer exists.')
        onClose()
      } else if (err instanceof ApiError && err.status === 400) {
        toast.error('The status change was rejected.', { description: err.message })
      } else {
        toast.error('Could not change the status.', {
          description: err instanceof Error ? err.message : undefined,
        })
      }
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: adminClientsKey }),
  })

  const submit = (event: FormEvent) => {
    event.preventDefault()
    setTouched(true)
    if (error || mutation.isPending) return
    mutation.mutate({ id: client.id, status: change.status, reason: reason.trim() })
  }

  const showError = touched && error !== null
  const length = reason.trim().length

  return (
    <DialogContent className="sm:max-w-md">
      <form onSubmit={submit} className="grid gap-4" noValidate>
        <DialogHeader>
          <DialogTitle>{suspending ? `Suspend ${client.name}?` : `Activate ${client.name}?`}</DialogTitle>
          <DialogDescription>
            {suspending
              ? 'Its members lose access to the workspace and Login as Client is blocked until you activate it again. Sessions are not signed out.'
              : 'Its members get access to the workspace again.'}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-2">
          <Label htmlFor={reasonId}>Reason</Label>
          <Textarea
            id={reasonId}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            onBlur={() => setTouched(true)}
            placeholder={suspending ? 'e.g. Chargeback on the last payment' : 'e.g. Payment received'}
            aria-invalid={showError || undefined}
            aria-describedby={`${reasonId}-hint`}
            rows={3}
            autoFocus
          />
          <div id={`${reasonId}-hint`} className="flex justify-between gap-3 text-xs">
            <span className={showError ? 'text-destructive' : 'text-muted-foreground'} role={showError ? 'alert' : undefined}>
              {showError ? error : 'Saved to the audit log.'}
            </span>
            <span className={length > REASON_MAX ? 'text-destructive' : 'text-muted-foreground'}>
              {length}/{REASON_MAX}
            </span>
          </div>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant={suspending ? 'destructive' : 'default'}
            disabled={error !== null || mutation.isPending}
          >
            {mutation.isPending ? 'Saving…' : suspending ? 'Suspend client' : 'Activate client'}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  )
}
