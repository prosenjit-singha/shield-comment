import { useMutation, useQueryClient } from '@tanstack/react-query'
import { RotateCcw, Save } from 'lucide-react'
import { type FormEvent, type ReactNode, useId, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import {
  type AdminPlan,
  type AdminPlansResponse,
  adminPlansKey,
  draftFromPlan,
  formatPlanPrice,
  hasDraftErrors,
  isDraftDirty,
  PLAN_FEATURE_KEYS,
  PLAN_LIMIT_KEYS,
  PLAN_OFFER_BADGE_MAX,
  type PlanDraft,
  planFeatureLabels,
  planLimitLabels,
  planPatch,
  plansListKey,
  pricePreview,
  replacePlanInList,
  updatePlan,
  validatePlanDraft,
} from '@/lib/admin-plans'
import { ApiError } from '@/lib/api'

/**
 * One plan's editor. The draft lives in the page (so leaving with unsaved changes can be
 * blocked); `undefined` = pristine, the card then shows the stored plan as it is.
 * Save sends only the changed fields (`planPatch`).
 */
export function PlanEditorCard({
  plan,
  draft: storedDraft,
  onDraftChange,
}: {
  plan: AdminPlan
  draft: PlanDraft | undefined
  onDraftChange: (draft: PlanDraft | undefined) => void
}) {
  const queryClient = useQueryClient()
  const id = useId()
  const [saveError, setSaveError] = useState<string | null>(null)

  const draft = storedDraft ?? draftFromPlan(plan)
  const errors = validatePlanDraft(draft)
  const invalid = hasDraftErrors(errors)
  const dirty = isDraftDirty(plan, storedDraft)
  const preview = pricePreview(draft)
  const headingId = `${id}-name`

  const mutation = useMutation({
    mutationFn: updatePlan,
    onSuccess: ({ plan: saved }) => {
      queryClient.setQueryData<AdminPlansResponse>(plansListKey, (old) => replacePlanInList(old, saved))
      onDraftChange(undefined)
      toast.success(`${saved.name} saved.`)
      // `['admin','plans']` = the list and every plan audit history page (the new entry shows up).
      void queryClient.invalidateQueries({ queryKey: adminPlansKey })
    },
    onError: (err) => {
      if (err instanceof ApiError && err.status === 404) {
        toast.error(`${plan.name} no longer exists.`, { description: 'The plan list was refreshed.' })
        void queryClient.invalidateQueries({ queryKey: adminPlansKey })
      } else if (err instanceof ApiError && err.status === 400) {
        setSaveError(err.message)
        toast.error(`${plan.name} was not saved.`, { description: err.message })
      } else {
        toast.error(`Could not save ${plan.name}.`, {
          description: err instanceof Error ? err.message : undefined,
        })
      }
    },
  })

  const edit = (next: PlanDraft) => {
    setSaveError(null)
    onDraftChange(next)
  }
  const setLimit = (key: (typeof PLAN_LIMIT_KEYS)[number], value: string) =>
    edit({ ...draft, limits: { ...draft.limits, [key]: value } })
  const setFeature = (key: (typeof PLAN_FEATURE_KEYS)[number], value: boolean) =>
    edit({ ...draft, features: { ...draft.features, [key]: value } })

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!dirty || invalid || mutation.isPending) return
    mutation.mutate({ id: plan.id, body: planPatch(plan, draft) })
  }
  const reset = () => {
    setSaveError(null)
    onDraftChange(undefined)
  }

  const badgeLength = draft.offerBadge.trim().length

  return (
    <section
      aria-labelledby={headingId}
      data-testid="plan-card"
      data-dirty={dirty || undefined}
      className="flex min-w-0 flex-col rounded-2xl border bg-card"
    >
      <form onSubmit={submit} noValidate className="flex flex-1 flex-col">
        <fieldset disabled={mutation.isPending} className="flex min-w-0 flex-1 flex-col gap-5 p-4 md:p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex min-w-0 flex-col gap-1">
              <div className="flex flex-wrap items-center gap-2">
                <h2 id={headingId} className="text-lg font-semibold tracking-tight">
                  {plan.name}
                </h2>
                <span className="rounded-full bg-muted px-2.5 py-0.5 font-mono text-xs text-muted-foreground">
                  {plan.slug}
                </span>
                {!plan.isActive && (
                  <span className="rounded-full bg-muted px-2.5 py-0.5 text-xs text-muted-foreground">Inactive</span>
                )}
              </div>
              {dirty && (
                <span data-testid="unsaved" className="text-xs font-medium text-primary">
                  Unsaved changes
                </span>
              )}
            </div>
            <PricePreviewBlock preview={preview} />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              id={`${id}-original`}
              label="Original price"
              error={errors.originalPriceBdt}
              hint="Monthly, whole taka."
            >
              <TakaInput
                id={`${id}-original`}
                value={draft.originalPriceBdt}
                onChange={(value) => edit({ ...draft, originalPriceBdt: value })}
                invalid={errors.originalPriceBdt !== undefined}
              />
            </Field>
            <Field id={`${id}-offer`} label="Offer price" error={errors.offerPriceBdt} hint="Empty = no offer.">
              <TakaInput
                id={`${id}-offer`}
                value={draft.offerPriceBdt}
                placeholder="No offer"
                onChange={(value) => edit({ ...draft, offerPriceBdt: value })}
                invalid={errors.offerPriceBdt !== undefined}
              />
            </Field>
            <Field
              id={`${id}-badge`}
              label="Offer badge"
              error={errors.offerBadge}
              hint="Empty = no badge."
              counter={
                <span className={badgeLength > PLAN_OFFER_BADGE_MAX ? 'text-destructive' : undefined}>
                  {badgeLength}/{PLAN_OFFER_BADGE_MAX}
                </span>
              }
              className="sm:col-span-2"
            >
              <Input
                id={`${id}-badge`}
                value={draft.offerBadge}
                onChange={(e) => edit({ ...draft, offerBadge: e.target.value })}
                placeholder="e.g. 50% Launch Offer"
                aria-invalid={errors.offerBadge !== undefined || undefined}
                aria-describedby={`${id}-badge-hint`}
                className="h-9"
              />
            </Field>
          </div>

          <div className="flex flex-col gap-3">
            <h3 className="text-sm font-semibold">Limits</h3>
            <div className="grid gap-4 sm:grid-cols-2">
              {PLAN_LIMIT_KEYS.map((key) => (
                <Field
                  key={key}
                  id={`${id}-${key}`}
                  label={planLimitLabels[key]}
                  error={errors.limits[key]}
                >
                  <Input
                    id={`${id}-${key}`}
                    inputMode="numeric"
                    autoComplete="off"
                    value={draft.limits[key]}
                    onChange={(e) => setLimit(key, e.target.value)}
                    aria-invalid={errors.limits[key] !== undefined || undefined}
                    aria-describedby={`${id}-${key}-hint`}
                    className="h-9 tabular-nums"
                  />
                </Field>
              ))}
            </div>
          </div>

          <div className="flex flex-col gap-3">
            <h3 className="text-sm font-semibold">Features</h3>
            <ul className="grid gap-x-4 gap-y-3 sm:grid-cols-2">
              {PLAN_FEATURE_KEYS.map((key) => (
                <li key={key} className="flex min-w-0 items-center gap-3">
                  <Switch
                    id={`${id}-${key}`}
                    checked={draft.features[key]}
                    onCheckedChange={(checked) => setFeature(key, checked)}
                  />
                  <Label htmlFor={`${id}-${key}`} className="min-w-0 leading-snug font-normal">
                    {planFeatureLabels[key]}
                  </Label>
                </li>
              ))}
            </ul>
          </div>
        </fieldset>

        <div className="flex flex-col gap-3 border-t px-4 py-3 sm:flex-row sm:items-center sm:justify-between md:px-5">
          <p
            role={saveError ? 'alert' : undefined}
            data-testid="save-error"
            className={`min-w-0 text-xs ${saveError ? 'text-destructive' : 'text-muted-foreground'}`}
          >
            {saveError ?? (invalid ? 'Fix the highlighted fields to save.' : dirty ? 'Only changed fields are sent.' : 'No changes.')}
          </p>
          <div className="flex shrink-0 justify-end gap-2">
            <Button type="button" variant="outline" disabled={!storedDraft || mutation.isPending} onClick={reset}>
              <RotateCcw data-icon="inline-start" aria-hidden />
              Reset
            </Button>
            <Button type="submit" disabled={!dirty || invalid || mutation.isPending}>
              <Save data-icon="inline-start" aria-hidden />
              {mutation.isPending ? 'Saving…' : 'Save'}
            </Button>
          </div>
        </div>
      </form>
    </section>
  )
}

function Field({
  id,
  label,
  error,
  hint,
  counter,
  className,
  children,
}: {
  id: string
  label: string
  error: string | undefined
  hint?: string
  counter?: ReactNode
  className?: string
  children: ReactNode
}) {
  return (
    <div className={`flex min-w-0 flex-col gap-1.5 ${className ?? ''}`}>
      <Label htmlFor={id} className="leading-snug">
        {label}
      </Label>
      {children}
      <div id={`${id}-hint`} className="flex min-h-4 justify-between gap-3 text-xs">
        {error ? (
          <span className="text-destructive">{error}</span>
        ) : (
          <span className="text-muted-foreground">{hint}</span>
        )}
        {counter && <span className="shrink-0 text-muted-foreground tabular-nums">{counter}</span>}
      </div>
    </div>
  )
}

function TakaInput({
  id,
  value,
  onChange,
  invalid,
  placeholder,
}: {
  id: string
  value: string
  onChange: (value: string) => void
  invalid: boolean
  placeholder?: string
}) {
  return (
    <div className="relative">
      <span
        className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-sm text-muted-foreground"
        aria-hidden
      >
        ৳
      </span>
      <Input
        id={id}
        inputMode="numeric"
        autoComplete="off"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={invalid || undefined}
        aria-describedby={`${id}-hint`}
        className="h-9 pl-7 tabular-nums"
      />
    </div>
  )
}

function PricePreviewBlock({ preview }: { preview: ReturnType<typeof pricePreview> }) {
  return (
    <div
      data-testid="price-preview"
      aria-label="Price preview"
      role="group"
      className="flex shrink-0 flex-col items-end gap-1 rounded-2xl bg-muted px-3 py-2 text-right"
    >
      {preview.badge && (
        <span
          data-testid="preview-badge"
          className="max-w-56 truncate rounded-full bg-secondary px-2.5 py-0.5 text-xs font-semibold text-secondary-foreground"
        >
          {preview.badge}
        </span>
      )}
      <p className="flex items-baseline gap-1.5 whitespace-nowrap">
        {preview.struck !== null && (
          <s data-testid="preview-struck" className="text-sm text-muted-foreground tabular-nums">
            {formatPlanPrice(preview.struck)}
          </s>
        )}
        <span data-testid="preview-price" className="text-xl font-semibold tracking-tight tabular-nums">
          {preview.price === null ? '—' : formatPlanPrice(preview.price)}
        </span>
        <span className="text-xs text-muted-foreground">/mo</span>
      </p>
      {preview.discountPercent !== null && (
        <span className="text-xs text-muted-foreground">Saves {preview.discountPercent}%</span>
      )}
    </div>
  )
}
