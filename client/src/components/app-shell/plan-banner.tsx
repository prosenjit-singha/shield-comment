import { useQuery } from '@tanstack/react-query'
import { CirclePause, Gauge, Hourglass } from 'lucide-react'
import { useId } from 'react'
import { useLanguage } from '@/hooks/use-language'
import type { ContentFn } from '@/lib/auth-errors'
import { billingSummaryQueryOptions, planBanner, type PlanBannerState } from '@/lib/billing-summary'
import { formatDhakaDayMonth } from '@/lib/data-deletion'
import { bnNumber, type Language } from '@/lib/language'
import { cn } from '@/lib/utils'

function bannerCopy(state: PlanBannerState, content: ContentFn, language: Language): { title: string; body: string } {
  switch (state.kind) {
    case 'trial':
      return {
        title: state.endsToday
          ? content('Trial ends today', 'ট্রায়াল আজ শেষ হবে')
          : content(
              `Trial ends in ${state.daysLeft} ${state.daysLeft === 1 ? 'day' : 'days'}`,
              `ট্রায়াল শেষ হবে ${bnNumber(state.daysLeft)} দিনে`,
            ),
        body: content(
          'After that, moderation pauses until you choose a plan.',
          'এরপর প্ল্যান বেছে না নেওয়া পর্যন্ত মডারেশন বন্ধ থাকবে।',
        ),
      }
    case 'paused':
      return {
        title: content('Moderation paused: choose a plan', 'মডারেশন বন্ধ আছে: একটি প্ল্যান বেছে নিন'),
        body: content(
          'New comments aren’t checked. Your comments stay visible and your Pages stay connected.',
          'নতুন কমেন্ট যাচাই করা হচ্ছে না। আপনার কমেন্টগুলো দেখা যাবে এবং পেজগুলো কানেক্টেড থাকবে।',
        ),
      }
    case 'limit_reached': {
      const title = content('Comment limit reached', 'কমেন্টের সীমা শেষ')
      if (state.trial) {
        return {
          title,
          body: content(
            'You’ve used all the comments in your trial. New comments aren’t checked until you choose a plan.',
            'ট্রায়ালের সব কমেন্ট ব্যবহার হয়ে গেছে। প্ল্যান বেছে না নেওয়া পর্যন্ত নতুন কমেন্ট যাচাই করা হবে না।',
          ),
        }
      }
      if (state.resetsAt) {
        const date = formatDhakaDayMonth(state.resetsAt, language)
        return {
          title,
          body: content(
            `New comments aren’t checked until your limit resets on ${date}.`,
            `${date} সীমা রিসেট না হওয়া পর্যন্ত নতুন কমেন্ট যাচাই করা হবে না।`,
          ),
        }
      }
      return {
        title,
        body: content(
          'New comments aren’t checked until your limit resets.',
          'সীমা রিসেট না হওয়া পর্যন্ত নতুন কমেন্ট যাচাই করা হবে না।',
        ),
      }
    }
  }
}

const ICONS = { trial: Hourglass, paused: CirclePause, limit_reached: Gauge } as const

/**
 * Plan status banner in the `_app` shell (PW-T8, plan §3.7, PW-D9): "Trial ends in N days" while on
 * the sign-up trial, "Moderation paused: choose a plan" without a live plan, "Comment limit reached"
 * when the wallet is used up. Read from the workspace billing summary; nothing shows while it loads,
 * when it fails, or for a paid plan with comments left (it never blocks the shell). No link yet:
 * choosing a plan is Module 8 (`/billing`).
 */
export function PlanStatusBanner({ workspaceId }: { workspaceId: string }) {
  const { content, language } = useLanguage()
  const summary = useQuery(billingSummaryQueryOptions(workspaceId))
  const titleId = useId()

  const state = summary.data ? planBanner(summary.data) : null
  if (!state) return null
  const { title, body } = bannerCopy(state, content, language)
  const Icon = ICONS[state.kind]
  const urgent = state.kind !== 'trial'

  return (
    <div className="mx-auto w-full max-w-6xl px-4 pt-4 sm:px-6">
      <div
        role="status"
        aria-labelledby={titleId}
        data-testid="plan-banner"
        data-kind={state.kind}
        className={cn(
          'flex items-start gap-2.5 rounded-2xl border px-4 py-3 text-sm text-foreground',
          urgent ? 'border-destructive/30 bg-destructive/10' : 'border-primary/20 bg-primary/5',
        )}
      >
        <Icon className={cn('mt-0.5 size-4 shrink-0', urgent ? 'text-destructive' : 'text-primary')} aria-hidden />
        <p className="min-w-0 text-pretty">
          <strong id={titleId} className="font-semibold">
            {title}
          </strong>{' '}
          <span>{body}</span>
        </p>
      </div>
    </div>
  )
}
