import { useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { Plus } from 'lucide-react'
import { useState } from 'react'
import { DashboardError } from '@/components/dashboard/dashboard-charts'
import { NewReplyBadge, NewTicketForm, ReadOnlyNotice, StatusPill, TicketThread } from '@/components/support/ticket-views'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { useLanguage } from '@/hooks/use-language'
import { toApiError } from '@/lib/api'
import { formatCommentTime } from '@/lib/comments-feed'
import { categoryLabel, loadErrorMessage, ticketsQueryOptions, validateSupportSearch } from '@/lib/support-tickets'

/**
 * C13 `/support` (M7-T12; Module 7 D1–D5). `?ticket=<id>` opens a thread (the reply email links there).
 * D1: the API decides what each role sees. D2: impersonated = read-only. D5: list polls 60 s, thread 15 s.
 */
export const Route = createFileRoute('/_app/support')({
  head: () => ({ meta: [{ title: 'Support | ShieldComment BD' }, { name: 'robots', content: 'noindex' }] }),
  validateSearch: validateSupportSearch,
  component: SupportPage,
})

function SupportPage() {
  const { session } = Route.useRouteContext()
  const { content } = useLanguage()
  const workspaceId = session.session.activeOrganizationId
  const impersonated = Boolean(session.session.impersonatedBy)
  const { ticket } = Route.useSearch()
  const navigate = Route.useNavigate()
  const open = (id: string | undefined) => void navigate({ search: { ticket: id } })

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">{content('Support', 'সাপোর্ট')}</h1>
        <p className="text-sm text-muted-foreground">
          {content('Ask our team for help and follow the replies.', 'আমাদের টিমের কাছে সাহায্য চান এবং উত্তরগুলো দেখুন।')}
        </p>
      </div>
      {!workspaceId ? (
        <p className="rounded-3xl border bg-card p-6 text-sm text-muted-foreground">
          {content('No workspace is selected for this account yet.', 'এই অ্যাকাউন্টে এখনো কোনো ওয়ার্কস্পেস বেছে নেওয়া হয়নি।')}
        </p>
      ) : ticket ? (
        <TicketThread workspaceId={workspaceId} ticketId={ticket} impersonated={impersonated} onBack={() => open(undefined)} />
      ) : (
        <TicketList workspaceId={workspaceId} impersonated={impersonated} onOpen={open} />
      )}
    </div>
  )
}

function TicketList({ workspaceId, impersonated, onOpen }: { workspaceId: string; impersonated: boolean; onOpen: (id: string) => void }) {
  const { content, language } = useLanguage()
  const list = useQuery(ticketsQueryOptions(workspaceId))
  const [creating, setCreating] = useState(false)
  const items = list.data?.items ?? []

  return (
    <>
      {impersonated ? (
        <ReadOnlyNotice />
      ) : creating ? (
        <NewTicketForm workspaceId={workspaceId} onCancel={() => setCreating(false)} onCreated={onOpen} />
      ) : (
        <Button className="h-10 self-start px-5" onClick={() => setCreating(true)}>
          <Plus aria-hidden />
          {content('New ticket', 'নতুন টিকিট')}
        </Button>
      )}

      {list.isError && !list.data ? (
        <DashboardError
          title={content('Couldn’t load your tickets', 'আপনার টিকিট লোড করা যায়নি')}
          message={loadErrorMessage(toApiError(list.error), content)}
          onRetry={() => void list.refetch()}
          retrying={list.isFetching}
        />
      ) : list.isPending ? (
        <div className="flex flex-col gap-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} data-testid="ticket-skeleton" className="h-20 w-full rounded-3xl" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <p className="rounded-3xl border bg-card p-6 text-center text-sm text-muted-foreground">
          {content('No tickets yet. Open one when you need help.', 'এখনো কোনো টিকিট নেই। সাহায্য দরকার হলে একটি টিকিট খুলুন।')}
        </p>
      ) : (
        <ul aria-label={content('Tickets', 'টিকিট')} className="flex flex-col gap-3">
          {items.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                onClick={() => onOpen(item.id)}
                className="flex w-full flex-col gap-2 rounded-3xl border bg-card p-4 text-left transition-colors outline-none hover:bg-muted/50 focus-visible:ring-3 focus-visible:ring-ring/50 sm:p-5"
              >
                <span className="flex flex-wrap items-center gap-2">
                  <StatusPill status={item.status} />
                  {item.hasNewReply ? <NewReplyBadge /> : null}
                  <span className="text-xs text-muted-foreground">{categoryLabel(item.category, content)}</span>
                </span>
                <span className="font-medium text-balance">{item.subject}</span>
                <span className="text-xs text-muted-foreground">
                  {item.requester.name} · {formatCommentTime(item.lastMessageAt ?? item.createdAt, language)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  )
}
