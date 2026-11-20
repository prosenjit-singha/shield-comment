import type { UseQueryResult } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { cn } from 'cn'
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Inbox,
  MessageSquare,
  RotateCcw,
  SearchX,
} from 'lucide-react'
import { SearchInput } from '@/components/search-input'
import { TicketPriorityBadge, TicketStatusPill } from '@/components/tickets/ticket-badges'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  categoryLabels,
  formatDhakaDateTime,
  formatQueueTime,
  lastActivity,
  priorityLabels,
  statusLabels,
  TICKET_CATEGORIES,
  TICKET_PRIORITIES,
  TICKET_SEARCH_MAX,
  TICKET_STATUSES,
  type TicketCategory,
  type TicketList,
  type TicketListItem,
  type TicketPriority,
  type TicketStatus,
  TICKETS_PAGE_SIZE,
  type TicketsSearch,
} from '@/lib/admin-tickets'

export type FilterPatch = Partial<Pick<TicketsSearch, 'status' | 'priority' | 'category' | 'q'>>

/** Left pane: filters, the ticket list (newest first) and pagination. */
export function TicketQueue({
  search,
  query,
  setFilters,
  onPage,
  className,
}: {
  search: TicketsSearch
  query: UseQueryResult<TicketList>
  setFilters: (patch: FilterPatch) => void
  onPage: (page: number) => void
  className?: string
}) {
  const hasFilters = Boolean(search.status || search.priority || search.category || search.q)
  const clearFilters = () =>
    setFilters({ status: undefined, priority: undefined, category: undefined, q: undefined })
  const page = search.page ?? 1
  const data = query.data

  return (
    <section
      aria-label="Ticket queue"
      className={cn('flex min-h-0 min-w-0 flex-col overflow-hidden rounded-xl bg-card', className)}
    >
      <QueueFilters search={search} setFilters={setFilters} hasFilters={hasFilters} onClear={clearFilters} />

      {query.isError && !data ? (
        <div role="alert" className="flex flex-col items-center gap-3 border-t px-6 py-12 text-center">
          <h2 className="text-base font-semibold">Couldn't load tickets</h2>
          <p className="max-w-xs text-sm text-muted-foreground">{query.error.message}</p>
          <Button variant="outline" onClick={() => void query.refetch()}>
            <RotateCcw data-icon="inline-start" />
            Try again
          </Button>
        </div>
      ) : data && data.items.length === 0 ? (
        <QueueEmpty filtered={hasFilters || page > 1} onClear={clearFilters} />
      ) : (
        <ul
          aria-label="Tickets"
          aria-busy={query.isFetching && query.isPlaceholderData ? true : undefined}
          className="min-h-0 flex-1 divide-y overflow-y-auto border-t transition-opacity aria-busy:opacity-60"
        >
          {data
            ? data.items.map((ticket) => (
                <QueueRow key={ticket.id} ticket={ticket} selected={ticket.id === search.ticket} />
              ))
            : Array.from({ length: 6 }, (_, i) => <QueueRowSkeleton key={i} />)}
        </ul>
      )}

      {data && data.total > 0 && (
        <QueuePagination
          page={page}
          pageCount={Math.max(1, Math.ceil(data.total / TICKETS_PAGE_SIZE))}
          total={data.total}
          shown={data.items.length}
          skip={data.skip}
          onPage={onPage}
        />
      )}
    </section>
  )
}

function QueueFilters({
  search,
  setFilters,
  hasFilters,
  onClear,
}: {
  search: TicketsSearch
  setFilters: (patch: FilterPatch) => void
  hasFilters: boolean
  onClear: () => void
}) {
  return (
    <div className="flex flex-col gap-3 p-3 md:p-4">
      <SearchInput
        value={search.q ?? ''}
        onSearch={(q) => setFilters({ q: q || undefined })}
        label="Search tickets"
        placeholder="Search subjects"
        maxLength={TICKET_SEARCH_MAX}
        className="relative min-w-0"
      />
      <Tabs
        value={search.status ?? 'ALL'}
        onValueChange={(value) =>
          setFilters({ status: value === 'ALL' ? undefined : (value as TicketStatus) })
        }
      >
        <TabsList aria-label="Status" className="grid w-full grid-cols-4 rounded-full">
          <TabsTrigger value="ALL" className="rounded-full px-2 text-xs">
            All
          </TabsTrigger>
          {TICKET_STATUSES.map((status) => (
            <TabsTrigger key={status} value={status} className="rounded-full px-2 text-xs">
              {statusLabels[status]}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      <div className="flex flex-wrap items-center gap-2">
        <FilterMenu
          name="Priority"
          value={search.priority}
          options={TICKET_PRIORITIES}
          labels={priorityLabels}
          onChange={(priority) => setFilters({ priority: priority as TicketPriority | undefined })}
        />
        <FilterMenu
          name="Category"
          value={search.category}
          options={TICKET_CATEGORIES}
          labels={categoryLabels}
          onChange={(category) => setFilters({ category: category as TicketCategory | undefined })}
        />
        {hasFilters && (
          <Button variant="ghost" size="sm" className="ml-auto" onClick={onClear}>
            <RotateCcw data-icon="inline-start" />
            Clear
          </Button>
        )}
      </div>
    </div>
  )
}

/** A filter as a radio `DropdownMenu`; `undefined` = all. */
function FilterMenu<T extends string>({
  name,
  value,
  options,
  labels,
  onChange,
}: {
  name: string
  value: T | undefined
  options: readonly T[]
  labels: Record<T, string>
  onChange: (value: T | undefined) => void
}) {
  const current = value ? labels[value] : 'All'
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          aria-label={`${name}: ${current}`}
          className={cn(value && 'border-primary/40 bg-primary/5 text-primary')}
        >
          <span className="text-muted-foreground">{name}:</span>
          {current}
          <ChevronDown data-icon="inline-end" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-40">
        <DropdownMenuLabel>{name}</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={value ?? 'ALL'}
          onValueChange={(next) => onChange(next === 'ALL' ? undefined : (next as T))}
        >
          <DropdownMenuRadioItem value="ALL">All</DropdownMenuRadioItem>
          {options.map((option) => (
            <DropdownMenuRadioItem key={option} value={option}>
              {labels[option]}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function QueueRow({ ticket, selected }: { ticket: TicketListItem; selected: boolean }) {
  const activity = lastActivity(ticket)
  return (
    <li>
      <Link
        from="/admin/tickets"
        to="/admin/tickets"
        search={(prev) => ({ ...prev, ticket: ticket.id })}
        // Link marks the open ticket's row `aria-current="page"` (its search matches the URL).
        className={cn(
          'flex flex-col gap-1.5 px-4 py-3 outline-none transition-colors hover:bg-muted focus-visible:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset',
          selected && 'bg-primary/5 shadow-[inset_3px_0_0_var(--primary)] hover:bg-primary/10',
        )}
      >
        <div className="flex items-baseline justify-between gap-3">
          <span className="truncate text-sm font-medium" title={ticket.subject}>
            {ticket.subject}
          </span>
          <time
            dateTime={activity}
            title={`Last activity ${formatDhakaDateTime(activity)}`}
            className="shrink-0 text-xs text-muted-foreground tabular-nums"
          >
            {formatQueueTime(activity)}
          </time>
        </div>
        <span className="truncate text-xs text-muted-foreground">
          {ticket.workspace.name} · {ticket.requester.name}
        </span>
        <div className="flex items-center gap-1.5">
          <TicketStatusPill status={ticket.status} />
          <TicketPriorityBadge priority={ticket.priority} />
          <span
            className="ml-auto inline-flex items-center gap-1 text-xs text-muted-foreground tabular-nums"
            aria-label={`${ticket.messageCount} ${ticket.messageCount === 1 ? 'message' : 'messages'}`}
          >
            <MessageSquare className="size-3.5" aria-hidden />
            {ticket.messageCount}
          </span>
        </div>
      </Link>
    </li>
  )
}

function QueueRowSkeleton() {
  return (
    <li className="flex flex-col gap-2 px-4 py-3" aria-hidden>
      <div className="flex justify-between gap-3">
        <Skeleton className="h-4 w-44 rounded-full" />
        <Skeleton className="h-3 w-10 rounded-full" />
      </div>
      <Skeleton className="h-3 w-32 rounded-full" />
      <div className="flex gap-1.5">
        <Skeleton className="h-5 w-16 rounded-full" />
        <Skeleton className="h-5 w-14 rounded-full" />
      </div>
    </li>
  )
}

function QueueEmpty({ filtered, onClear }: { filtered: boolean; onClear: () => void }) {
  const Icon = filtered ? SearchX : Inbox
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 border-t px-6 py-12 text-center">
      <span className="flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary">
        <Icon className="size-6" aria-hidden />
      </span>
      <h2 className="text-base font-semibold">
        {filtered ? 'No tickets match these filters' : 'No support tickets yet'}
      </h2>
      <p className="max-w-xs text-sm text-balance text-muted-foreground">
        {filtered
          ? 'Try another status, priority or a shorter search.'
          : 'Questions from client workspaces show up here, newest first.'}
      </p>
      {filtered && (
        <Button variant="outline" onClick={onClear}>
          Clear filters
        </Button>
      )}
    </div>
  )
}

function QueuePagination({
  page,
  pageCount,
  total,
  shown,
  skip,
  onPage,
}: {
  page: number
  pageCount: number
  total: number
  shown: number
  skip: number
  onPage: (page: number) => void
}) {
  const first = shown > 0 ? skip + 1 : 0
  return (
    <nav aria-label="Pagination" className="flex items-center justify-between gap-3 border-t px-4 py-2.5">
      <p className="text-xs text-muted-foreground">
        {first}–{skip + shown} of {total} {total === 1 ? 'ticket' : 'tickets'}
      </p>
      <div className="flex items-center gap-1.5">
        <Button
          variant="outline"
          size="icon-sm"
          aria-label="Previous page"
          disabled={page <= 1}
          onClick={() => onPage(page - 1)}
        >
          <ChevronLeft />
        </Button>
        <span className="text-xs tabular-nums">
          {page} / {pageCount}
        </span>
        <Button
          variant="outline"
          size="icon-sm"
          aria-label="Next page"
          disabled={page >= pageCount}
          onClick={() => onPage(page + 1)}
        >
          <ChevronRight />
        </Button>
      </div>
    </nav>
  )
}
