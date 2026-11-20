import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { RotateCcw, Save } from 'lucide-react'
import { type FormEvent, useId, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import {
  PLAYGROUND_DAILY_LIMIT_MAX,
  type PlatformSettings,
  platformSettingsKey,
  platformSettingsQueryOptions,
  playgroundLimitError,
  updatePlatformSettings,
} from '@/lib/admin-platform-settings'

/**
 * "Playground" (M6-T7b, D9): free client playground tests per workspace per Dhaka day. Same
 * platform settings query as the WhatsApp card; its PATCH sends only `playgroundDailyLimit`.
 */
export function PlaygroundLimitCard() {
  const query = useQuery(platformSettingsQueryOptions())
  return (
    <section aria-labelledby="playground-limit-title" className="flex min-w-0 flex-col gap-4 rounded-xl bg-card p-4 md:p-5">
      <div className="flex min-w-0 flex-col gap-1">
        <h2 id="playground-limit-title" className="text-lg font-semibold tracking-tight">
          Playground
        </h2>
        <p className="text-sm text-muted-foreground">
          Clients try comments on the playground for free. A new allowance starts every day at midnight (Dhaka).
        </p>
      </div>
      {query.isError && !query.data ? (
        <div role="alert" className="flex flex-wrap items-center gap-3 text-sm">
          <span className="text-destructive">Couldn't load the limit: {query.error.message}</span>
          <Button type="button" variant="outline" size="sm" onClick={() => void query.refetch()}>
            <RotateCcw data-icon="inline-start" />
            Try again
          </Button>
        </div>
      ) : !query.data ? (
        <Skeleton data-testid="playground-limit-skeleton" className="h-9 w-48 rounded-full" />
      ) : (
        // Re-keyed by the stored limit only, so a WhatsApp save never resets this draft.
        <LimitForm key={query.data.playgroundDailyLimit} settings={query.data} />
      )}
    </section>
  )
}

function LimitForm({ settings }: { settings: PlatformSettings }) {
  const queryClient = useQueryClient()
  const id = useId()
  const stored = String(settings.playgroundDailyLimit)
  const [value, setValue] = useState(stored)
  const [saveError, setSaveError] = useState<string | null>(null)
  const error = playgroundLimitError(value)
  const dirty = value.trim() !== stored

  const mutation = useMutation({
    mutationFn: updatePlatformSettings,
    onSuccess: (saved) => {
      queryClient.setQueryData(platformSettingsKey, saved)
      toast.success('Playground limit saved.')
    },
    onError: (err) => setSaveError(err.message),
  })

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!dirty || error || mutation.isPending) return
    setSaveError(null)
    mutation.mutate({ playgroundDailyLimit: Number(value.trim()) })
  }

  const message = saveError ?? error
  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-1.5">
      <Label htmlFor={id}>Playground tests per workspace per day</Label>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          id={id}
          type="number"
          inputMode="numeric"
          min={0}
          max={PLAYGROUND_DAILY_LIMIT_MAX}
          step={1}
          value={value}
          onChange={(e) => {
            setValue(e.target.value)
            setSaveError(null)
          }}
          aria-invalid={error !== null || undefined}
          aria-describedby={`${id}-hint`}
          disabled={mutation.isPending}
          className="h-9 w-28 tabular-nums"
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
        {message ?? '0 turns the playground off.'}
      </p>
    </form>
  )
}
