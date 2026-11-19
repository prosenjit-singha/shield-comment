import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, CircleCheck, CircleX, KeyRound, PlugZap, RotateCcw, Save, Undo2 } from 'lucide-react'
import { type FormEvent, type KeyboardEvent, type ReactNode, useId, useRef, useState } from 'react'
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
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import {
  AI_PROVIDERS,
  type AiConnectionTestResult,
  type AiDraft,
  type AiProvider,
  type AiSettingsResponse,
  type AiSettingSource,
  adminAiSettingsKey,
  aiErrorKindMessage,
  aiProviderHints,
  aiProviderLabels,
  aiSettingSourceLabels,
  aiSettingsKey,
  aiSettingsPatch,
  aiSettingsQueryOptions,
  aiTestBody,
  canTestAiDraft,
  draftFromAiSettings,
  effectiveModel,
  hasAiDraftErrors,
  hasDbKey,
  isAiDraftDirty,
  KEY_ENCRYPTION_MESSAGE,
  KEY_ENCRYPTION_NOT_CONFIGURED,
  keyStatusText,
  modelSuggestions,
  testAiConnection,
  updateAiSettings,
  validateAiDraft,
  withProvider,
} from '@/lib/admin-ai-settings'
import { formatDhakaDateTime } from '@/lib/admin-system'
import { ApiError } from '@/lib/api'

/**
 * A7 "AI provider" section (M5-T4, D16). The draft lives in the page (one `useBlocker` covers it
 * and the plan drafts); `undefined` = pristine. Typed keys exist only in that draft: Save and the
 * mutations' `gcTime: 0` + `reset()` keep them out of every cache, and a successful save drops the
 * draft so the password inputs are empty again.
 */
export function AiProviderCard({
  draft,
  onDraftChange,
}: {
  draft: AiDraft | undefined
  onDraftChange: (draft: AiDraft | undefined) => void
}) {
  const query = useQuery(aiSettingsQueryOptions())

  if (query.isError && !query.data) {
    return (
      <Shell>
        <div role="alert" className="flex flex-col items-center gap-3 border-t px-6 py-12 text-center">
          <h3 className="text-base font-semibold">Couldn't load the AI settings</h3>
          <p className="max-w-md text-sm text-muted-foreground">{query.error.message}</p>
          <Button type="button" variant="outline" onClick={() => void query.refetch()}>
            <RotateCcw data-icon="inline-start" />
            Try again
          </Button>
        </div>
      </Shell>
    )
  }
  if (!query.data) {
    return (
      <Shell>
        <div data-testid="ai-skeleton" aria-busy="true" aria-label="Loading AI settings" className="flex flex-col gap-4 border-t p-4 md:p-5">
          <div className="grid gap-3 sm:grid-cols-2">
            {Array.from({ length: 4 }, (_, i) => (
              <Skeleton key={i} className="h-20 rounded-2xl" />
            ))}
          </div>
          <Skeleton className="h-9 rounded-full" />
          <Skeleton className="h-32 rounded-2xl" />
        </div>
      </Shell>
    )
  }
  return <AiProviderForm settings={query.data} storedDraft={draft} onDraftChange={onDraftChange} />
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <section aria-labelledby="ai-provider-title" className="flex min-w-0 flex-col rounded-2xl border bg-card">
      <div className="p-4 md:p-5">
        <CardTitle />
      </div>
      {children}
    </section>
  )
}

function CardTitle() {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <h2 id="ai-provider-title" className="text-lg font-semibold tracking-tight">
        AI provider
      </h2>
      <p className="text-sm text-muted-foreground">
        The model that classifies comments. Keys are stored encrypted and never shown again.
      </p>
    </div>
  )
}

function AiProviderForm({
  settings,
  storedDraft,
  onDraftChange,
}: {
  settings: AiSettingsResponse
  storedDraft: AiDraft | undefined
  onDraftChange: (draft: AiDraft | undefined) => void
}) {
  const queryClient = useQueryClient()
  const id = useId()
  const [saveError, setSaveError] = useState<string | null>(null)
  const [testResult, setTestResult] = useState<AiConnectionTestResult | null>(null)
  const [testError, setTestError] = useState<string | null>(null)
  const [clearTarget, setClearTarget] = useState<AiProvider | null>(null)

  const draft = storedDraft ?? draftFromAiSettings(settings)
  const errors = validateAiDraft(draft)
  const invalid = hasAiDraftErrors(errors)
  const dirty = isAiDraftDirty(storedDraft, settings)
  const draftStatus = settings.providers[draft.provider]

  // `gcTime: 0` + `reset()` after each call: a typed key in `variables` doesn't outlive the request.
  const save = useMutation({
    mutationFn: updateAiSettings,
    gcTime: 0,
    onSuccess: (saved) => {
      queryClient.setQueryData<AiSettingsResponse>(aiSettingsKey, saved)
      onDraftChange(undefined)
      setSaveError(null)
      toast.success('AI settings saved.')
      // `['admin','ai-settings']` = these settings and every AI history page.
      void queryClient.invalidateQueries({ queryKey: adminAiSettingsKey })
    },
    onError: (err) => {
      if (err instanceof ApiError && err.status === 503 && err.code === KEY_ENCRYPTION_NOT_CONFIGURED) {
        setSaveError(KEY_ENCRYPTION_MESSAGE)
        toast.error('AI settings were not saved.', { description: KEY_ENCRYPTION_MESSAGE })
        void queryClient.invalidateQueries({ queryKey: aiSettingsKey })
      } else if (err instanceof ApiError && err.status === 400) {
        setSaveError(err.message)
        toast.error('AI settings were not saved.', { description: err.message })
      } else {
        const message = err instanceof Error ? err.message : 'Unknown error'
        setSaveError(message)
        toast.error('Could not save the AI settings.', { description: message })
      }
    },
  })

  const test = useMutation({
    mutationFn: testAiConnection,
    gcTime: 0,
    onSuccess: (result) => setTestResult(result),
    onError: (err) => setTestError(err instanceof Error ? err.message : 'Unknown error'),
  })

  const edit = (next: AiDraft) => {
    setSaveError(null)
    onDraftChange(next)
  }
  const setKey = (provider: AiProvider, value: string) =>
    edit({
      ...draft,
      keys: { ...draft.keys, [provider]: value },
      clearKeys: { ...draft.clearKeys, [provider]: false },
    })
  const setClear = (provider: AiProvider, clear: boolean) =>
    edit({
      ...draft,
      keys: { ...draft.keys, [provider]: '' },
      clearKeys: { ...draft.clearKeys, [provider]: clear },
    })

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!dirty || invalid || save.isPending) return
    const body = aiSettingsPatch(draft, settings)
    if (Object.keys(body).length === 0) return
    save.mutate(body, { onSettled: () => save.reset() })
  }
  const runTest = () => {
    if (!canTestAiDraft(draft) || test.isPending) return
    setTestResult(null)
    setTestError(null)
    test.mutate(aiTestBody(draft, settings), { onSettled: () => test.reset() })
  }
  const reset = () => {
    setSaveError(null)
    onDraftChange(undefined)
  }

  const activeLabel = aiProviderLabels[settings.provider]
  const activeStatus = settings.providers[settings.provider]
  const suggestions = modelSuggestions(draft.provider, draftStatus)
  const clearLabel = clearTarget ? aiProviderLabels[clearTarget] : ''

  return (
    <section
      aria-labelledby="ai-provider-title"
      data-testid="ai-provider-card"
      data-dirty={dirty || undefined}
      className="flex min-w-0 flex-col rounded-2xl border bg-card"
    >
      <form onSubmit={submit} noValidate className="flex flex-1 flex-col">
        <fieldset disabled={save.isPending} className="flex min-w-0 flex-1 flex-col gap-5 p-4 md:p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex min-w-0 flex-col gap-1">
              <CardTitle />
              {dirty && (
                <span data-testid="ai-unsaved" className="text-xs font-medium text-primary">
                  Unsaved changes
                </span>
              )}
            </div>
            <div className="flex shrink-0 flex-col items-end gap-1 text-right">
              <span
                data-testid="ai-status"
                className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
                  settings.configured ? 'bg-primary/10 text-primary' : 'bg-destructive/10 text-destructive'
                }`}
              >
                {settings.configured ? 'AI calls on' : 'AI calls off'}
              </span>
              {settings.updatedBy && settings.updatedAt && (
                <span className="text-xs text-muted-foreground">
                  Saved by {settings.updatedBy.name.trim() || settings.updatedBy.email} ·{' '}
                  <time dateTime={settings.updatedAt}>{formatDhakaDateTime(settings.updatedAt)}</time>
                </span>
              )}
            </div>
          </div>

          {!settings.configured && (
            <Notice testId="ai-not-configured" tone="warning">
              AI calls are off until {activeLabel}{' '}
              {!activeStatus.key.configured && 'has an API key'}
              {!activeStatus.key.configured && !activeStatus.baseUrlConfigured && ' and '}
              {!activeStatus.baseUrlConfigured && 'NEON_AI_GATEWAY_BASE_URL is set on the backend'}. New comments
              stay visible meanwhile.
            </Notice>
          )}
          {!settings.cipherConfigured && (
            <Notice testId="ai-cipher-off" tone="muted">
              {KEY_ENCRYPTION_MESSAGE}
            </Notice>
          )}

          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between">
              <h3 id={`${id}-provider`} className="text-sm font-semibold">
                Provider
              </h3>
              <p data-testid="ai-active" className="text-xs text-muted-foreground">
                In use: <span className="font-medium text-foreground">{activeLabel}</span>{' '}
                <SourcePill source={settings.providerSource} /> ·{' '}
                <span className="font-mono text-foreground">{settings.model}</span>{' '}
                <SourcePill source={settings.modelSource} />
              </p>
            </div>
            <ProviderPicker
              labelledBy={`${id}-provider`}
              settings={settings}
              value={draft.provider}
              onChange={(provider) => edit(withProvider(draft, settings, provider))}
            />
          </div>

          <div className="flex min-w-0 flex-col gap-1.5">
            <Label htmlFor={`${id}-model`}>Model</Label>
            <Input
              id={`${id}-model`}
              value={draft.model}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => edit({ ...draft, model: e.target.value })}
              aria-invalid={errors.model !== undefined || undefined}
              aria-describedby={`${id}-model-hint`}
              className="h-9 font-mono"
            />
            <p id={`${id}-model-hint`} className="min-h-4 text-xs">
              {errors.model ? (
                <span className="text-destructive">{errors.model}</span>
              ) : (
                <span data-testid="ai-model-hint" className="text-muted-foreground">
                  {aiProviderLabels[draft.provider]} uses{' '}
                  <span className="font-mono">{effectiveModel(settings, draft.provider)}</span> (
                  {aiSettingSourceLabels[
                    draft.provider === settings.provider ? settings.modelSource : draftStatus.modelSource
                  ]}
                  ) · default <span className="font-mono">{draftStatus.defaultModel}</span>
                </span>
              )}
            </p>
            <div role="group" aria-label="Suggested models" className="flex flex-wrap gap-1.5">
              {suggestions.map((model) => {
                const pressed = draft.model.trim() === model
                return (
                  <Button
                    key={model}
                    type="button"
                    size="xs"
                    variant={pressed ? 'secondary' : 'outline'}
                    aria-pressed={pressed}
                    className="font-mono"
                    onClick={() => edit({ ...draft, model })}
                  >
                    {model}
                  </Button>
                )
              })}
            </div>
          </div>

          <div className="flex flex-col gap-3">
            <h3 className="text-sm font-semibold">API keys</h3>
            <ul className="flex flex-col gap-3">
              {AI_PROVIDERS.map((provider) => (
                <KeyRow
                  key={provider}
                  id={`${id}-key-${provider}`}
                  provider={provider}
                  settings={settings}
                  value={draft.keys[provider]}
                  clearPending={draft.clearKeys[provider]}
                  error={errors.keys[provider]}
                  onChange={(value) => setKey(provider, value)}
                  onClear={() => setClearTarget(provider)}
                  onUndoClear={() => setClear(provider, false)}
                />
              ))}
            </ul>
          </div>
        </fieldset>

        {(testResult || testError || test.isPending) && (
          <div className="border-t px-4 py-3 md:px-5">
            <TestResult result={testResult} error={testError} pending={test.isPending} />
          </div>
        )}

        <div className="flex flex-col gap-3 border-t px-4 py-3 sm:flex-row sm:items-center sm:justify-between md:px-5">
          <p
            role={saveError ? 'alert' : undefined}
            data-testid="ai-save-error"
            className={`min-w-0 text-xs ${saveError ? 'text-destructive' : 'text-muted-foreground'}`}
          >
            {saveError ??
              (invalid ? 'Fix the highlighted fields to save.' : dirty ? 'Only changed fields are sent.' : 'No changes.')}
          </p>
          <div className="flex shrink-0 flex-wrap justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={!canTestAiDraft(draft) || test.isPending || save.isPending}
              onClick={runTest}
            >
              <PlugZap data-icon="inline-start" aria-hidden />
              {test.isPending ? 'Testing…' : 'Test connection'}
            </Button>
            <Button type="button" variant="outline" disabled={!storedDraft || save.isPending} onClick={reset}>
              <RotateCcw data-icon="inline-start" aria-hidden />
              Reset
            </Button>
            <Button type="submit" disabled={!dirty || invalid || save.isPending}>
              <Save data-icon="inline-start" aria-hidden />
              {save.isPending ? 'Saving…' : 'Save'}
            </Button>
          </div>
        </div>
      </form>

      <Dialog open={clearTarget !== null} onOpenChange={(open) => !open && setClearTarget(null)}>
        <DialogContent className="rounded-2xl sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Clear the {clearLabel} key?</DialogTitle>
            <DialogDescription>
              The key saved in the database is deleted when you save. If the backend's .env has a key for{' '}
              {clearLabel}, that one is used instead.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="rounded-b-2xl">
            <Button type="button" variant="outline" onClick={() => setClearTarget(null)}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => {
                if (clearTarget) setClear(clearTarget, true)
                setClearTarget(null)
              }}
            >
              Clear key
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  )
}

function SourcePill({ source }: { source: AiSettingSource }) {
  return (
    <span className="rounded-full bg-muted px-2 py-0.5 text-[0.7rem] text-muted-foreground">
      {aiSettingSourceLabels[source]}
    </span>
  )
}

function Notice({ testId, tone, children }: { testId: string; tone: 'warning' | 'muted'; children: ReactNode }) {
  return (
    <p
      data-testid={testId}
      className={`flex items-start gap-2 rounded-2xl px-3 py-2.5 text-sm ${
        tone === 'warning' ? 'bg-destructive/10 text-destructive' : 'bg-muted text-muted-foreground'
      }`}
    >
      <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
      <span className="min-w-0">{children}</span>
    </p>
  )
}

/** Radio group of the 4 providers (roving focus, arrow keys move and select). */
function ProviderPicker({
  labelledBy,
  settings,
  value,
  onChange,
}: {
  labelledBy: string
  settings: AiSettingsResponse
  value: AiProvider
  onChange: (provider: AiProvider) => void
}) {
  const refs = useRef<Partial<Record<AiProvider, HTMLButtonElement | null>>>({})
  const onKeyDown = (event: KeyboardEvent) => {
    const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0
    if (step === 0) return
    event.preventDefault()
    const index = AI_PROVIDERS.indexOf(value)
    const next = AI_PROVIDERS[(index + step + AI_PROVIDERS.length) % AI_PROVIDERS.length] as AiProvider
    onChange(next)
    refs.current[next]?.focus()
  }

  return (
    <div role="radiogroup" aria-labelledby={labelledBy} onKeyDown={onKeyDown} className="grid gap-3 sm:grid-cols-2">
      {AI_PROVIDERS.map((provider) => {
        const checked = provider === value
        const status = settings.providers[provider]
        return (
          <button
            key={provider}
            ref={(el) => {
              refs.current[provider] = el
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={checked ? 0 : -1}
            data-testid={`ai-provider-${provider}`}
            onClick={() => onChange(provider)}
            className={`flex min-w-0 flex-col gap-1.5 rounded-2xl border p-3 text-left transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50 ${
              checked ? 'border-primary bg-primary/5' : 'hover:bg-muted'
            }`}
          >
            <span className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{aiProviderLabels[provider]}</span>
              {provider === settings.provider && (
                <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[0.7rem] font-medium text-primary">
                  Active
                </span>
              )}
            </span>
            <span className="text-xs text-muted-foreground">{aiProviderHints[provider]}</span>
            <span className="flex items-center gap-1 text-xs text-muted-foreground">
              <KeyRound className="size-3" aria-hidden />
              {status.key.configured ? 'Key ready' : 'No key'}
              {provider === 'neon' && !status.baseUrlConfigured && ' · URL missing'}
            </span>
          </button>
        )
      })}
    </div>
  )
}

function KeyRow({
  id,
  provider,
  settings,
  value,
  clearPending,
  error,
  onChange,
  onClear,
  onUndoClear,
}: {
  id: string
  provider: AiProvider
  settings: AiSettingsResponse
  value: string
  clearPending: boolean
  error: string | undefined
  onChange: (value: string) => void
  onClear: () => void
  onUndoClear: () => void
}) {
  const status = settings.providers[provider]
  const label = aiProviderLabels[provider]
  return (
    <li data-testid={`ai-key-${provider}`} className="flex min-w-0 flex-col gap-2 rounded-2xl bg-muted/50 p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <Label htmlFor={id}>{label} API key</Label>
        <span data-testid="key-status" className="text-xs text-muted-foreground tabular-nums">
          {keyStatusText(status.key)}
        </span>
      </div>
      {status.key.unreadable && (
        <p data-testid="key-unreadable" className="flex items-start gap-1.5 text-xs text-destructive">
          <AlertTriangle className="mt-px size-3.5 shrink-0" aria-hidden />
          The saved key can't be decrypted, so it is ignored. Replace or clear it.
        </p>
      )}
      {provider === 'neon' && !status.baseUrlConfigured && (
        <p data-testid="neon-url-missing" className="text-xs text-muted-foreground">
          NEON_AI_GATEWAY_BASE_URL is not set on the backend: the Neon gateway can't be called until it is.
        </p>
      )}
      {clearPending ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p data-testid="key-clear-pending" className="text-sm text-destructive">
            The database key will be cleared when you save.
          </p>
          <Button type="button" size="sm" variant="outline" onClick={onUndoClear}>
            <Undo2 data-icon="inline-start" aria-hidden />
            Undo
          </Button>
        </div>
      ) : (
        <div className="flex gap-2">
          <Input
            id={id}
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={value}
            disabled={!settings.cipherConfigured}
            placeholder={
              !settings.cipherConfigured
                ? 'Key encryption is off'
                : status.key.configured
                  ? 'Paste a new key to replace it'
                  : 'Paste an API key'
            }
            onChange={(e) => onChange(e.target.value)}
            aria-invalid={error !== undefined || undefined}
            aria-describedby={`${id}-hint`}
            className="h-9 min-w-0 flex-1 font-mono"
          />
          {hasDbKey(status.key) && (
            <Button type="button" variant="outline" className="h-9" aria-label={`Clear the ${label} key`} onClick={onClear}>
              Clear
            </Button>
          )}
        </div>
      )}
      <p id={`${id}-hint`} className="text-xs">
        {error ? (
          <span className="text-destructive">{error}</span>
        ) : value.trim() !== '' ? (
          <span className="text-muted-foreground">New key, saved encrypted when you save.</span>
        ) : null}
      </p>
    </li>
  )
}

function TestResult({
  result,
  error,
  pending,
}: {
  result: AiConnectionTestResult | null
  error: string | null
  pending: boolean
}) {
  if (pending) {
    return (
      <p role="status" data-testid="ai-test-result" className="text-sm text-muted-foreground">
        Testing the connection…
      </p>
    )
  }
  if (error) {
    return (
      <p role="status" data-testid="ai-test-result" className="flex items-start gap-2 text-sm text-destructive">
        <CircleX className="mt-0.5 size-4 shrink-0" aria-hidden />
        <span>Test failed: {error}</span>
      </p>
    )
  }
  if (!result) return null
  const target = [result.provider && aiProviderLabels[result.provider], result.model].filter(Boolean).join(' · ')
  if (result.ok) {
    return (
      <p role="status" data-testid="ai-test-result" className="flex items-start gap-2 text-sm">
        <CircleCheck className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
        <span>
          <span className="font-medium">Connected</span> · {target} · {result.latencyMs} ms
        </span>
      </p>
    )
  }
  return (
    <div role="status" data-testid="ai-test-result" className="flex items-start gap-2 text-sm">
      <CircleX className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
      <div className="flex min-w-0 flex-col gap-0.5">
        <span>
          <span className="font-medium text-destructive">Connection failed</span>
          {target && <span className="text-muted-foreground"> · {target}</span>}
          {result.latencyMs > 0 && <span className="text-muted-foreground"> · {result.latencyMs} ms</span>}
        </span>
        <span data-testid="ai-test-kind">{aiErrorKindMessage(result.kind)}</span>
        {result.message && (
          <span data-testid="ai-test-message" className="break-words text-xs text-muted-foreground">
            {result.message}
          </span>
        )}
      </div>
    </div>
  )
}
