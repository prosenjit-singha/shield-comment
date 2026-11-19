import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { type FormEvent, type ReactNode, useId, useState } from 'react'
import { toast } from 'sonner'
import { PillRadioGroup, type PillOption } from '@/components/clients/pill-radio-group'
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
import { Switch } from '@/components/ui/switch'
import { dhakaToday } from '@/lib/admin-activation'
import { plansQueryOptions } from '@/lib/admin-plans'
import {
  type AdminPromotion,
  adminPromotionsKey,
  createBody,
  createPromotion,
  type DiscountScope,
  type DiscountType,
  type DraftErrors,
  type DraftField,
  draftFromPromotion,
  emptyDraft,
  kindLabels,
  patchBody,
  PROMOTION_KINDS,
  PROMOTION_NAME_MAX,
  type PromotionDraft,
  type PromotionKind,
  type PromotionPlan,
  promotionSaveError,
  promotionValue,
  TRIAL_DAY_PRESETS,
  updatePromotion,
  validateDraft,
} from '@/lib/admin-promotions'

/** `null` = closed; `{ promotion: null }` = new; else edit that promotion. */
export type PromotionFormTarget = { promotion: AdminPromotion | null } | null

/**
 * "New promotion" / edit (PR-T5b; PR-D2, D4, D5, reading 8): kind first (new only), then that
 * kind's fields. Edit PATCHes only the changed fields; once a client has claimed the promotion its
 * money terms show read-only.
 */
export function PromotionFormDialog({ target, onClose }: { target: PromotionFormTarget; onClose: () => void }) {
  return (
    <Dialog open={target !== null} onOpenChange={(open) => !open && onClose()}>
      {target && (
        <PromotionForm key={target.promotion?.id ?? 'new'} promotion={target.promotion} onClose={onClose} />
      )}
    </Dialog>
  )
}

type Length = 'FOREVER' | 'MONTHS'
type Ends = 'UNTIL_STOPPED' | 'DATE'

function PromotionForm({ promotion, onClose }: { promotion: AdminPromotion | null; onClose: () => void }) {
  const queryClient = useQueryClient()
  const plans = useQuery(plansQueryOptions())
  const id = useId()
  const [today] = useState(() => dhakaToday(new Date()))
  const [draft, setDraft] = useState<PromotionDraft>(() =>
    promotion ? draftFromPromotion(promotion) : emptyDraft(),
  )
  const [submitted, setSubmitted] = useState(false)
  const [serverError, setServerError] = useState<{ field?: DraftField; message: string } | null>(null)

  const locked = promotion?.termsLocked ?? false
  const trial = draft.kind === 'TRIAL'
  const errors: DraftErrors = submitted ? validateDraft(draft, today, promotion?.endsOn) : {}
  if (serverError?.field) errors[serverError.field] = serverError.message
  const patch = promotion ? patchBody(promotion, draft) : null
  const unchanged = patch !== null && Object.keys(patch).length === 0

  const set = (next: Partial<PromotionDraft>) => {
    setDraft((d) => ({ ...d, ...next }))
    setServerError(null)
  }

  const mutation = useMutation({
    mutationFn: () =>
      promotion ? updatePromotion({ id: promotion.id, body: patch ?? {} }) : createPromotion(createBody(draft)),
    onSuccess: ({ promotion: saved }) => {
      toast.success(promotion ? `${saved.name} is saved.` : `${saved.name} is created.`)
      void queryClient.invalidateQueries({ queryKey: adminPromotionsKey })
      onClose()
    },
    onError: (err) => {
      setServerError(promotionSaveError(err))
      void queryClient.invalidateQueries({ queryKey: adminPromotionsKey })
    },
  })

  const submit = (event: FormEvent) => {
    event.preventDefault()
    setSubmitted(true)
    setServerError(null)
    const invalid = Object.keys(validateDraft(draft, today, promotion?.endsOn)).length > 0
    if (invalid || unchanged || mutation.isPending) return
    mutation.mutate()
  }

  // Active plans, plus any current target that is no longer active (so it stays visible).
  const active = (plans.data?.items ?? []).filter((plan) => plan.isActive)
  const planOptions: PromotionPlan[] = [
    ...active,
    ...(promotion?.plans ?? []).filter((t) => !active.some((plan) => plan.id === t.id)),
  ]

  const kindOptions: PillOption<PromotionKind>[] = PROMOTION_KINDS.map((k) => ({ value: k, label: kindLabels[k] }))
  const presetDays: number[] = [...TRIAL_DAY_PRESETS]
  if (!presetDays.includes(draft.trialDays)) presetDays.push(draft.trialDays)
  const dayOptions: PillOption<string>[] = presetDays
    .sort((a, b) => a - b)
    .map((d) => ({ value: String(d), label: `${d} days` }))
  const typeOptions: PillOption<DiscountType>[] = [
    { value: 'PERCENT', label: '% off' },
    { value: 'FLAT', label: '৳ off' },
  ]
  const scopeOptions: PillOption<DiscountScope>[] = [
    { value: 'PER_MONTH', label: 'Each month' },
    { value: 'TOTAL', label: 'Total bill' },
  ]
  const lengthOptions: PillOption<Length>[] = [
    { value: 'FOREVER', label: 'Forever' },
    { value: 'MONTHS', label: 'First months' },
  ]
  const endsOptions: PillOption<Ends>[] = [
    { value: 'UNTIL_STOPPED', label: 'Until stopped' },
    { value: 'DATE', label: 'End date' },
  ]
  const terms = promotion ? promotionValue(promotion) : null

  return (
    <DialogContent className="max-h-[90dvh] overflow-y-auto rounded-2xl sm:max-w-lg">
      <form onSubmit={submit} className="grid gap-5" noValidate>
        <DialogHeader>
          <DialogTitle>{promotion ? `Edit ${promotion.name}` : 'New promotion'}</DialogTitle>
          <DialogDescription>
            {promotion
              ? `${kindLabels[promotion.kind]} · only the fields you change are saved.`
              : 'Pick the kind first: each kind has its own fields.'}
          </DialogDescription>
        </DialogHeader>

        {!promotion && (
          <div className="grid gap-2">
            <span id={`${id}-kind`} className="text-sm font-medium">
              Kind
            </span>
            <PillRadioGroup
              labelledBy={`${id}-kind`}
              options={kindOptions}
              value={draft.kind}
              onChange={(kind) => set({ kind })}
            />
          </div>
        )}

        <Field id={`${id}-name`} label="Name" error={errors.name} hint={`${draft.name.trim().length}/${PROMOTION_NAME_MAX} · shown on bills.`}>
          <Input
            id={`${id}-name`}
            value={draft.name}
            onChange={(e) => set({ name: e.target.value })}
            placeholder={trial ? 'e.g. 14-day trial' : 'e.g. Eid offer'}
            aria-invalid={errors.name ? true : undefined}
            aria-describedby={`${id}-name-hint`}
            autoComplete="off"
          />
        </Field>

        {draft.kind === 'COUPON' && (
          <Field id={`${id}-code`} label="Coupon code" error={errors.code} hint="3–32 letters, digits or dashes. Saved in capitals.">
            <Input
              id={`${id}-code`}
              value={draft.code}
              onChange={(e) => set({ code: e.target.value })}
              placeholder="e.g. EID25"
              aria-invalid={errors.code ? true : undefined}
              aria-describedby={`${id}-code-hint`}
              autoComplete="off"
              spellCheck={false}
              className="w-56 uppercase placeholder:normal-case"
            />
          </Field>
        )}

        {locked && terms ? (
          <div className="grid gap-1 rounded-2xl border bg-muted/50 px-4 py-3" data-testid="locked-terms">
            <p className="text-sm">
              <span className="font-medium">{terms.main}</span>
              <span className="text-muted-foreground"> · {terms.detail}</span>
            </p>
            <p className="text-xs text-muted-foreground">
              Clients have claimed this promotion, so its terms are locked. Name, code, plans, end date and cap stay
              editable.
            </p>
          </div>
        ) : trial ? (
          <>
            <div className="grid gap-2">
              <span id={`${id}-days`} className="text-sm font-medium">
                Trial length
              </span>
              <PillRadioGroup
                labelledBy={`${id}-days`}
                options={dayOptions}
                value={String(draft.trialDays)}
                onChange={(days) => set({ trialDays: Number(days) })}
              />
            </div>
            <Field
              id={`${id}-comments`}
              label="Trial comments"
              error={errors.trialCommentLimit}
              hint="Empty = the plan's monthly comments."
            >
              <Input
                id={`${id}-comments`}
                inputMode="numeric"
                autoComplete="off"
                value={draft.trialCommentLimit}
                onChange={(e) => set({ trialCommentLimit: e.target.value })}
                placeholder="Plan's monthly comments"
                aria-invalid={errors.trialCommentLimit ? true : undefined}
                aria-describedby={`${id}-comments-hint`}
                className="w-56"
              />
            </Field>
          </>
        ) : (
          <>
            <div className="grid gap-2">
              <span id={`${id}-type`} className="text-sm font-medium">
                Discount
              </span>
              <PillRadioGroup
                labelledBy={`${id}-type`}
                options={typeOptions}
                value={draft.discountType}
                onChange={(discountType) => set({ discountType })}
              />
            </div>
            <Field
              id={`${id}-value`}
              label={draft.discountType === 'PERCENT' ? 'Percent off' : 'Taka off (৳)'}
              error={errors.discountValue}
              hint={draft.discountType === 'PERCENT' ? '1 to 100.' : 'Whole taka. A bill never goes below ৳0.'}
            >
              <Input
                id={`${id}-value`}
                inputMode="numeric"
                autoComplete="off"
                value={draft.discountValue}
                onChange={(e) => set({ discountValue: e.target.value })}
                aria-invalid={errors.discountValue ? true : undefined}
                aria-describedby={`${id}-value-hint`}
                className="w-40"
              />
            </Field>
            <div className="grid gap-2">
              <span id={`${id}-scope`} className="text-sm font-medium">
                Comes off
              </span>
              <PillRadioGroup
                labelledBy={`${id}-scope`}
                options={scopeOptions}
                value={draft.discountScope}
                onChange={(discountScope) => set({ discountScope })}
              />
              {draft.discountScope === 'TOTAL' && (
                <p className="text-xs text-muted-foreground">Once, on the first bill.</p>
              )}
            </div>
            {draft.discountScope === 'PER_MONTH' && (
              <div className="grid gap-2">
                <span id={`${id}-length`} className="text-sm font-medium">
                  For how long
                </span>
                <PillRadioGroup
                  labelledBy={`${id}-length`}
                  options={lengthOptions}
                  value={draft.forever ? 'FOREVER' : 'MONTHS'}
                  onChange={(length) => set({ forever: length === 'FOREVER' })}
                />
                {!draft.forever && (
                  <Field id={`${id}-months`} label="Months" error={errors.durationMonths} hint="1 to 120.">
                    <Input
                      id={`${id}-months`}
                      inputMode="numeric"
                      autoComplete="off"
                      value={draft.durationMonths}
                      onChange={(e) => set({ durationMonths: e.target.value })}
                      aria-invalid={errors.durationMonths ? true : undefined}
                      aria-describedby={`${id}-months-hint`}
                      className="w-28"
                    />
                  </Field>
                )}
              </div>
            )}
          </>
        )}

        <fieldset className="grid gap-2" aria-describedby={`${id}-plans-hint`}>
          <legend className="mb-2 text-sm font-medium">Plans</legend>
          <div className="flex items-center gap-2">
            <Switch
              id={`${id}-all`}
              checked={draft.allPlans}
              onCheckedChange={(allPlans) => set({ allPlans })}
            />
            <Label htmlFor={`${id}-all`}>All plans</Label>
          </div>
          {!draft.allPlans && (
            <div className="flex flex-wrap gap-2">
              {plans.isError && <p className="text-sm text-destructive">Could not load the plans.</p>}
              {planOptions.map((plan) => {
                const checked = draft.planIds.includes(plan.id)
                return (
                  <label
                    key={plan.id}
                    className={`flex min-h-8 cursor-pointer items-center gap-2 rounded-full border px-3.5 py-1 text-sm transition-colors has-focus-visible:ring-3 has-focus-visible:ring-ring/50 ${
                      checked ? 'border-primary bg-primary/10 font-medium text-primary' : 'hover:bg-muted'
                    }`}
                  >
                    <input
                      type="checkbox"
                      className="size-3.5 accent-primary"
                      checked={checked}
                      onChange={() =>
                        set({
                          planIds: checked
                            ? draft.planIds.filter((p) => p !== plan.id)
                            : [...draft.planIds, plan.id],
                        })
                      }
                    />
                    {plan.name}
                  </label>
                )
              })}
            </div>
          )}
          <p
            id={`${id}-plans-hint`}
            className={`text-xs ${errors.plans ? 'text-destructive' : 'text-muted-foreground'}`}
            role={errors.plans ? 'alert' : undefined}
          >
            {errors.plans ?? (draft.allPlans ? 'Every plan, including plans added later.' : 'Only the ticked plans.')}
          </p>
        </fieldset>

        <div className="grid gap-2">
          <span id={`${id}-ends`} className="text-sm font-medium">
            Ends
          </span>
          <PillRadioGroup
            labelledBy={`${id}-ends`}
            options={endsOptions}
            value={draft.untilStopped ? 'UNTIL_STOPPED' : 'DATE'}
            onChange={(ends) => set({ untilStopped: ends === 'UNTIL_STOPPED', endsOn: draft.endsOn || today })}
          />
          {!draft.untilStopped && (
            <Field id={`${id}-date`} label="Last day" error={errors.endsOn} hint="Bangladesh time; it ends at midnight.">
              <Input
                id={`${id}-date`}
                type="date"
                min={today}
                value={draft.endsOn}
                onChange={(e) => set({ endsOn: e.target.value })}
                aria-invalid={errors.endsOn ? true : undefined}
                aria-describedby={`${id}-date-hint`}
                className="w-44"
              />
            </Field>
          )}
        </div>

        <Field
          id={`${id}-cap`}
          label="First N clients (optional)"
          error={errors.maxRedemptions}
          hint="Empty = no cap. Each client account can claim it once."
        >
          <Input
            id={`${id}-cap`}
            inputMode="numeric"
            autoComplete="off"
            value={draft.maxRedemptions}
            onChange={(e) => set({ maxRedemptions: e.target.value })}
            placeholder="No cap"
            aria-invalid={errors.maxRedemptions ? true : undefined}
            aria-describedby={`${id}-cap-hint`}
            className="w-40"
          />
        </Field>

        {serverError && !serverError.field && (
          <p role="alert" className="rounded-2xl bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {serverError.message}
          </p>
        )}

        <DialogFooter className="rounded-b-2xl">
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={unchanged || mutation.isPending}>
            {mutation.isPending ? 'Saving…' : promotion ? 'Save changes' : 'Create promotion'}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  )
}

function Field({
  id,
  label,
  hint,
  error,
  children,
}: {
  id: string
  label: string
  hint: string
  error: string | undefined
  children: ReactNode
}) {
  return (
    <div className="grid gap-2">
      <Label htmlFor={id}>{label}</Label>
      {children}
      <p
        id={`${id}-hint`}
        className={`text-xs ${error ? 'text-destructive' : 'text-muted-foreground'}`}
        role={error ? 'alert' : undefined}
      >
        {error ?? hint}
      </p>
    </div>
  )
}
