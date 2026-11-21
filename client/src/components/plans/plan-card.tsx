import { Check, Minus } from 'lucide-react'
import { useId, type ReactNode } from 'react'
import { Badge } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'
import { Switch } from '@/components/ui/switch'
import { useLanguage } from '@/hooks/use-language'
import type { SubscriptionInterval } from '@/lib/billing-summary'
import type { Language } from '@/lib/language'
import { featureLabel, formatNumber, formatTaka, limitLabel, PLAN_FEATURE_KEYS, PLAN_LIMIT_KEYS, type PublicPlan } from '@/lib/plans'
import { cn } from '@/lib/utils'

/** Monthly / Yearly switch with "Save up to N%" (PR-D14; hidden at 0). */
export function IntervalSwitch({
  interval,
  onChange,
  savePercent,
  className,
}: {
  interval: SubscriptionInterval
  onChange: (interval: SubscriptionInterval) => void
  savePercent: number
  className?: string
}) {
  const { content } = useLanguage()
  const switchId = useId()
  return (
    <div className={cn('flex flex-wrap items-center justify-center gap-3 text-sm font-medium', className)}>
      <label htmlFor={switchId} className={cn(interval === 'month' ? 'text-foreground' : 'text-muted-foreground')}>
        {content('Monthly', 'মাসিক')}
      </label>
      <Switch
        id={switchId}
        checked={interval === 'year'}
        onCheckedChange={(checked) => onChange(checked ? 'year' : 'month')}
        aria-label={content('Bill yearly', 'বার্ষিক বিল')}
      />
      <span className={cn(interval === 'year' ? 'text-foreground' : 'text-muted-foreground')}>{content('Yearly', 'বার্ষিক')}</span>
      {savePercent > 0 ? (
        <span className="text-primary" data-testid="save-up-to">
          {content(`Save up to ${savePercent}%`, `${formatNumber(savePercent, 'bn')}% পর্যন্ত সাশ্রয়`)}
        </span>
      ) : null}
    </div>
  )
}

/**
 * One plan card (PR-T6 `/plans`, shared with M8-T10 `/billing`): name, badge, description, the
 * per-month price for `interval` (struck list price + plain saving text, PR-D7), "Billed ৳N yearly",
 * the page's own button(s) as `children`, then limits and features.
 */
export function PlanCard({
  plan,
  interval,
  language,
  selected = false,
  titleAs: Title = 'h2',
  showOtherInterval = false,
  children,
}: {
  plan: PublicPlan
  interval: SubscriptionInterval
  language: Language
  /** `/billing`: the plan picked for checkout (primary ring). */
  selected?: boolean
  /** Landing (M8-T12): `h3` under the section's `h2`. */
  titleAs?: 'h2' | 'h3'
  /** Landing: also print the other interval's per-month price, so the page shows both without JS. */
  showOtherInterval?: boolean
  /** The card's button(s), under the price. */
  children?: ReactNode
}) {
  const { content } = useLanguage()
  const titleId = useId()
  const yearly = interval === 'year' && plan.yearly !== null
  const price = yearly && plan.yearly ? plan.yearly : plan.monthly
  const discounted = price.perMonthBdt !== price.listPerMonthBdt
  const pick = (text: { en: string; bn: string } | null) => (text ? (language === 'bn' ? text.bn : text.en) : null)
  const badge = pick(plan.badge)
  const description = pick(plan.description)

  return (
    <li aria-labelledby={titleId} data-testid="plan-card" data-highlighted={plan.highlighted || undefined} data-selected={selected || undefined}>
      <Card
        className={cn(
          'h-full gap-5 rounded-3xl p-6',
          plan.highlighted || selected ? 'shadow-lg ring-2 ring-primary' : 'ring-1 ring-foreground/10',
        )}
      >
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2">
            <Title id={titleId} className="text-lg font-semibold">
              {plan.name}
            </Title>
            {badge ? <Badge variant={plan.highlighted ? 'default' : 'outline'}>{badge}</Badge> : null}
          </div>
          {description ? <p className="text-sm text-pretty text-muted-foreground">{description}</p> : null}
        </div>

        <div className="flex flex-col gap-1">
          <p className="flex flex-wrap items-baseline gap-x-2">
            <span className="text-3xl font-semibold tabular-nums">{formatTaka(price.perMonthBdt, language)}</span>
            <span className="text-sm text-muted-foreground">{content('/month', '/মাস')}</span>
            {discounted ? (
              <s className="text-sm text-muted-foreground tabular-nums" data-testid="list-price">
                {formatTaka(price.listPerMonthBdt, language)}
              </s>
            ) : null}
          </p>
          {price.saving ? (
            <p className="text-sm font-medium text-primary">{content(price.saving.label, price.saving.labelBn)}</p>
          ) : null}
          {yearly ? (
            <p className="text-xs text-muted-foreground">
              {content(
                `Billed ${formatTaka(price.chargedBdt, 'en')} yearly`,
                `বছরে ${formatTaka(price.chargedBdt, 'bn')} বিল`,
              )}
            </p>
          ) : interval === 'year' ? (
            <p className="text-xs text-muted-foreground">{content('Monthly billing only', 'শুধু মাসিক বিল')}</p>
          ) : null}
          {showOtherInterval && plan.yearly ? (
            <p className="text-xs text-muted-foreground" data-testid="other-interval-price">
              {yearly
                ? content(
                    `or ${formatTaka(plan.monthly.perMonthBdt, 'en')}/month billed monthly`,
                    `অথবা মাসিক বিলে ${formatTaka(plan.monthly.perMonthBdt, 'bn')}/মাস`,
                  )
                : content(
                    `or ${formatTaka(plan.yearly.perMonthBdt, 'en')}/month billed yearly (${formatTaka(plan.yearly.chargedBdt, 'en')})`,
                    `অথবা বার্ষিক বিলে ${formatTaka(plan.yearly.perMonthBdt, 'bn')}/মাস (${formatTaka(plan.yearly.chargedBdt, 'bn')})`,
                  )}
            </p>
          ) : null}
        </div>

        {children}

        <ul className="flex flex-col gap-2 border-t pt-4 text-sm">
          {PLAN_LIMIT_KEYS.map((key) => (
            <li key={key} className="flex items-start gap-2">
              <Check className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
              {limitLabel(key, plan.limits[key], content, language)}
            </li>
          ))}
          {PLAN_FEATURE_KEYS.map((key) => {
            const included = plan.features[key]
            return (
              <li key={key} className={cn('flex items-start gap-2', !included && 'text-muted-foreground')}>
                {included ? (
                  <Check className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
                ) : (
                  <Minus className="mt-0.5 size-4 shrink-0" aria-hidden />
                )}
                <span>
                  {featureLabel(key, content)}
                  {included ? null : <span className="sr-only"> {content('(not included)', '(নেই)')}</span>}
                </span>
              </li>
            )
          })}
        </ul>
      </Card>
    </li>
  )
}
