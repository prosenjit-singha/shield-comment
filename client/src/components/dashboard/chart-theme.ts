import type { ModerationCategory } from '@/lib/moderation-policy'

/** Chart constants shared by C4 `/dashboard` and C9 `/analytics` (shadcn tokens only). */
export const CHART_HEIGHT = 256
export const axisProps = { tickLine: false, axisLine: false, tick: { fill: 'var(--muted-foreground)', fontSize: 12 } } as const
export const CATEGORY_COLORS: Record<ModerationCategory, string> = {
  SAFE_INQUIRY: 'var(--chart-3)',
  COMPETITOR_POACH: 'var(--chart-4)',
  SCAM_PHISHING: 'var(--chart-2)',
  SPAM_IRRELEVANT: 'var(--chart-5)',
  ABUSIVE_TOXIC: 'var(--chart-1)',
}
