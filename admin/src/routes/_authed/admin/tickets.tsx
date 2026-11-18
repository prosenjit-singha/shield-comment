import { useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { cn } from 'cn'
import { PageHeader } from '@/components/placeholder-page'
import { type FilterPatch, TicketQueue } from '@/components/tickets/ticket-queue'
import { NoTicketSelected, TicketThread } from '@/components/tickets/ticket-thread'
import {
  ticketsQueryOptions,
  ticketThreadQueryOptions,
  validateTicketsSearch,
} from '@/lib/admin-tickets'

export const Route = createFileRoute('/_authed/admin/tickets')({
  validateSearch: validateTicketsSearch,
  loaderDeps: ({ search }) => search,
  // Warm the cache (hover preload, first load) without blocking the screen; panes show skeletons.
  loader: ({ context, deps }) => {
    void context.queryClient.prefetchQuery(ticketsQueryOptions(deps))
    if (deps.ticket) void context.queryClient.prefetchQuery(ticketThreadQueryOptions(deps.ticket))
  },
  component: TicketsPage,
})

function TicketsPage() {
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  const { session } = Route.useRouteContext()
  const query = useQuery(ticketsQueryOptions(search))
  const me = { id: session.user.id, name: session.user.name, email: session.user.email }
  const selected = search.ticket

  /** Any filter change goes back to page 1 and keeps the open ticket; `replace` keeps typing out of history. */
  const setFilters = (patch: FilterPatch) =>
    navigate({ search: (prev) => ({ ...prev, ...patch, page: undefined }), replace: true })

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Tickets"
        description="Support requests from client workspaces, with replies and internal notes."
      />

      {/* Split pane from `lg`; below it the queue and the open thread take turns. */}
      <div className="grid min-w-0 gap-4 lg:h-[calc(100svh-11rem)] lg:min-h-[34rem] lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
        <TicketQueue
          search={search}
          query={query}
          setFilters={setFilters}
          onPage={(page) =>
            navigate({ search: (prev) => ({ ...prev, page: page > 1 ? page : undefined }) })
          }
          className={cn(selected && 'max-lg:hidden')}
        />
        <section
          aria-label="Conversation"
          className={cn(
            'flex min-h-[28rem] min-w-0 flex-col overflow-hidden rounded-2xl border bg-card lg:min-h-0',
            !selected && 'max-lg:hidden',
          )}
        >
          {selected ? <TicketThread key={selected} id={selected} me={me} /> : <NoTicketSelected />}
        </section>
      </div>
    </div>
  )
}
