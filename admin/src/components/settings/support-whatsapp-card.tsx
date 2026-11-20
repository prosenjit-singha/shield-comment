import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { RotateCcw, Save } from 'lucide-react'
import { type FormEvent, useId, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import {
  type PlatformSettings,
  platformSettingsKey,
  platformSettingsQueryOptions,
  updatePlatformSettings,
  whatsappNumberError,
} from '@/lib/admin-platform-settings'
import { formatDhakaDateTime } from '@/lib/admin-system'

/**
 * "Support WhatsApp number" (PR-T5, PR-D18): the number behind the client "Contact us" button
 * (`GET /api/plans` → `contactWhatsapp`). Empty + Save clears it (sends `null`), which hides the
 * button. The draft is local: it is one field and not part of the page's leave guard.
 */
export function SupportWhatsappCard() {
  const query = useQuery(platformSettingsQueryOptions())
  return (
    <section aria-labelledby="support-whatsapp-title" className="flex min-w-0 flex-col gap-4 rounded-2xl border bg-card p-4 md:p-5">
      <div className="flex min-w-0 flex-col gap-1">
        <h2 id="support-whatsapp-title" className="text-lg font-semibold tracking-tight">
          Support WhatsApp number
        </h2>
        <p className="text-sm text-muted-foreground">
          Clients tap “Contact us” on the plans page to chat with this number. Empty = the button is hidden.
        </p>
      </div>
      {query.isError && !query.data ? (
        <div role="alert" className="flex flex-wrap items-center gap-3 text-sm">
          <span className="text-destructive">Couldn't load the number: {query.error.message}</span>
          <Button type="button" variant="outline" size="sm" onClick={() => void query.refetch()}>
            <RotateCcw data-icon="inline-start" />
            Try again
          </Button>
        </div>
      ) : !query.data ? (
        <Skeleton data-testid="whatsapp-skeleton" className="h-9 w-72 rounded-full" />
      ) : (
        // Re-keyed by the stored number only, so a playground limit save never resets this draft.
        <WhatsappForm key={query.data.supportWhatsappNumber ?? ''} settings={query.data} />
      )}
    </section>
  )
}

function WhatsappForm({ settings }: { settings: PlatformSettings }) {
  const queryClient = useQueryClient()
  const id = useId()
  const stored = settings.supportWhatsappNumber ?? ''
  const [value, setValue] = useState(stored)
  const [saveError, setSaveError] = useState<string | null>(null)
  const error = whatsappNumberError(value)
  const dirty = value.trim() !== stored

  const mutation = useMutation({
    mutationFn: updatePlatformSettings,
    onSuccess: (saved) => {
      // A new stored number re-keys the form, so it starts again from the saved value.
      queryClient.setQueryData(platformSettingsKey, saved)
      toast.success(saved.supportWhatsappNumber ? 'WhatsApp number saved.' : 'WhatsApp number cleared.')
    },
    onError: (err) => setSaveError(err.message),
  })

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!dirty || error || mutation.isPending) return
    setSaveError(null)
    mutation.mutate({ supportWhatsappNumber: value.trim() || null })
  }

  const message = saveError ?? error
  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-1.5">
      <Label htmlFor={id}>WhatsApp number</Label>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          id={id}
          inputMode="numeric"
          autoComplete="off"
          value={value}
          onChange={(e) => {
            setValue(e.target.value)
            setSaveError(null)
          }}
          placeholder="8801712345678"
          aria-invalid={error !== null || undefined}
          aria-describedby={`${id}-hint`}
          disabled={mutation.isPending}
          className="h-9 w-56 tabular-nums"
        />
        <Button type="submit" disabled={!dirty || error !== null || mutation.isPending}>
          <Save data-icon="inline-start" aria-hidden />
          {mutation.isPending ? 'Saving…' : 'Save'}
        </Button>
      </div>
      <p
        id={`${id}-hint`}
        role={message ? 'alert' : undefined}
        className={`text-xs ${message ? 'text-destructive' : 'text-muted-foreground'}`}
      >
        {message ?? 'Country code + number, digits only, e.g. 8801712345678.'}
      </p>
      <p data-testid="whatsapp-saved" className="text-xs text-muted-foreground">
        {settings.updatedAt ? `Last saved ${formatDhakaDateTime(settings.updatedAt)}.` : 'Never saved.'}
      </p>
    </form>
  )
}
