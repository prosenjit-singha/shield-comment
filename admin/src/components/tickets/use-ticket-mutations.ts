import { type QueryClient, type QueryKey, useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { ApiError } from '@/lib/api'
import {
  adminTicketsKey,
  replyToTicket,
  statusLabels,
  type TicketList,
  type TicketListItem,
  type TicketMessage,
  type TicketPerson,
  type TicketStatus,
  type TicketThread,
  ticketListsKey,
  ticketThreadKey,
  updateTicketStatus,
} from '@/lib/admin-tickets'

/** Optimistic messages carry this id prefix until the server's message replaces them. */
export const OPTIMISTIC_PREFIX = 'optimistic:'

/** The dashboard's open-tickets KPI counts OPEN + IN_PROGRESS, so it goes stale too. */
const dashboardKey = ['admin', 'dashboard'] as const

/** `crypto.randomUUID` needs a secure context; a counter is enough to tell drafts apart. */
let optimisticSeq = 0

type ListSnapshot = Array<[QueryKey, TicketList | undefined]>

/** Writes the server's ticket into every cached list page that shows it. */
function patchLists(queryClient: QueryClient, ticket: TicketListItem) {
  queryClient.setQueriesData<TicketList>({ queryKey: ticketListsKey }, (old) =>
    old
      ? { ...old, items: old.items.map((item) => (item.id === ticket.id ? ticket : item)) }
      : old,
  )
}

function refresh(queryClient: QueryClient) {
  void queryClient.invalidateQueries({ queryKey: adminTicketsKey })
  void queryClient.invalidateQueries({ queryKey: dashboardKey })
}

function errorToast(err: Error, fallback: string, rejected: string) {
  if (err instanceof ApiError && err.status === 404) {
    toast.error('This ticket no longer exists.')
  } else if (err instanceof ApiError && err.status === 400) {
    toast.error(rejected, { description: err.message })
  } else {
    toast.error(fallback, { description: err.message })
  }
}

export interface ReplyInput {
  id: string
  body: string
  isInternalNote: boolean
}

/**
 * Reply / internal note. The message shows at once (optimistic); the server's response then
 * replaces it and supplies the ticket. The status is never flipped optimistically: only the first
 * public admin reply moves OPEN → IN_PROGRESS (M2-T14), so the status (and the "Status moved"
 * toast) always comes from the response `ticket`. On error the thread is rolled back and a toast
 * explains why.
 */
export function useReplyMutation(me: TicketPerson) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: ReplyInput) => replyToTicket(input),
    onMutate: async (input) => {
      const key = ticketThreadKey(input.id)
      await queryClient.cancelQueries({ queryKey: key })
      const previous = queryClient.getQueryData<TicketThread>(key)
      const now = new Date().toISOString()
      const optimistic: TicketMessage = {
        id: `${OPTIMISTIC_PREFIX}${(optimisticSeq += 1)}`,
        senderRole: 'ADMIN',
        sender: me,
        body: input.body,
        isInternalNote: input.isInternalNote,
        createdAt: now,
      }
      if (previous) {
        queryClient.setQueryData<TicketThread>(key, {
          ...previous,
          messages: [...previous.messages, optimistic],
          messageCount: previous.messageCount + 1,
          lastMessageAt: now,
        })
      }
      return { previous, optimisticId: optimistic.id, previousStatus: previous?.status }
    },
    onSuccess: ({ message, ticket }, input, context) => {
      queryClient.setQueryData<TicketThread>(ticketThreadKey(input.id), (old) =>
        old
          ? {
              ...old,
              ...ticket,
              messages: [...old.messages.filter((m) => m.id !== context.optimisticId), message],
            }
          : old,
      )
      patchLists(queryClient, ticket)
      const moved =
        context.previousStatus && context.previousStatus !== ticket.status
          ? `Status moved to ${statusLabels[ticket.status]}.`
          : undefined
      toast.success(input.isInternalNote ? 'Internal note added.' : 'Reply sent.', {
        description: moved,
      })
    },
    onError: (err, input, context) => {
      if (context?.previous) queryClient.setQueryData(ticketThreadKey(input.id), context.previous)
      errorToast(
        err,
        input.isInternalNote ? 'Could not add the note.' : 'Could not send the reply.',
        input.isInternalNote ? 'The note was rejected.' : 'The reply was rejected.',
      )
    },
    onSettled: () => refresh(queryClient),
  })
}

/**
 * Status change from the thread's dropdown. The new status shows at once in the thread and the
 * queue; on error both are rolled back. `changed: false` (already that status) is not a change.
 */
export function useStatusMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: { id: string; status: TicketStatus }) => updateTicketStatus(input),
    onMutate: async (input) => {
      const key = ticketThreadKey(input.id)
      await queryClient.cancelQueries({ queryKey: adminTicketsKey })
      const thread = queryClient.getQueryData<TicketThread>(key)
      const lists: ListSnapshot = queryClient.getQueriesData<TicketList>({ queryKey: ticketListsKey })
      if (thread) queryClient.setQueryData<TicketThread>(key, { ...thread, status: input.status })
      queryClient.setQueriesData<TicketList>({ queryKey: ticketListsKey }, (old) =>
        old
          ? {
              ...old,
              items: old.items.map((item) =>
                item.id === input.id ? { ...item, status: input.status } : item,
              ),
            }
          : old,
      )
      return { thread, lists, previousStatus: thread?.status }
    },
    onSuccess: ({ ticket, changed }, input, context) => {
      queryClient.setQueryData<TicketThread>(ticketThreadKey(input.id), (old) =>
        old ? { ...old, ...ticket } : old,
      )
      patchLists(queryClient, ticket)
      if (!changed) {
        toast.info(`Already ${statusLabels[ticket.status].toLowerCase()}. Nothing changed.`)
      } else if (ticket.status === 'OPEN' && context.previousStatus === 'RESOLVED') {
        toast.success('Ticket reopened.')
      } else {
        toast.success(`Marked as ${statusLabels[ticket.status].toLowerCase()}.`)
      }
    },
    onError: (err, input, context) => {
      if (context?.thread) queryClient.setQueryData(ticketThreadKey(input.id), context.thread)
      for (const [key, data] of context?.lists ?? []) queryClient.setQueryData(key, data)
      errorToast(err, 'Could not change the status.', 'The status change was rejected.')
    },
    onSettled: () => refresh(queryClient),
  })
}
