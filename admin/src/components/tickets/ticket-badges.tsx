import { ArrowDown, ArrowUp, Minus } from 'lucide-react'
import { cn } from 'cn'
import {
  priorityLabels,
  statusLabels,
  type TicketPriority,
  type TicketStatus,
} from '@/lib/admin-tickets'

const statusStyles: Record<TicketStatus, { pill: string; dot: string }> = {
  OPEN: { pill: 'bg-primary/10 text-primary', dot: 'bg-current' },
  IN_PROGRESS: { pill: 'bg-chart-4/15 text-foreground', dot: 'bg-chart-4' },
  RESOLVED: { pill: 'bg-muted text-muted-foreground', dot: 'bg-current' },
}

/** Ticket status pill (`rounded-full`). */
export function TicketStatusPill({ status, className }: { status: TicketStatus; className?: string }) {
  const style = statusStyles[status]
  return (
    <span
      data-testid="ticket-status"
      className={cn(
        'inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium whitespace-nowrap',
        style.pill,
        className,
      )}
    >
      <span className={cn('size-1.5 rounded-full', style.dot)} aria-hidden />
      {statusLabels[status]}
    </span>
  )
}

const priorityIcons = { HIGH: ArrowUp, MEDIUM: Minus, LOW: ArrowDown } as const

/** Priority badge: HIGH is tinted so urgent tickets stand out in the queue. */
export function TicketPriorityBadge({ priority }: { priority: TicketPriority }) {
  const Icon = priorityIcons[priority]
  return (
    <span
      aria-label={`Priority: ${priorityLabels[priority]}`}
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap',
        priority === 'HIGH'
          ? 'border-transparent bg-destructive/10 text-destructive'
          : 'text-muted-foreground',
      )}
    >
      <Icon className="size-3" aria-hidden />
      {priorityLabels[priority]}
    </span>
  )
}
