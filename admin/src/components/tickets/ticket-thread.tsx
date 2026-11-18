import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { cn } from 'cn'
import { ArrowLeft, ChevronDown, Lock, MessagesSquare, RotateCcw, SendHorizontal } from 'lucide-react'
import { type FormEvent, type KeyboardEvent, useEffect, useId, useRef, useState } from 'react'
import { TicketPriorityBadge, TicketStatusPill } from '@/components/tickets/ticket-badges'
import {
  OPTIMISTIC_PREFIX,
  useReplyMutation,
  useStatusMutation,
} from '@/components/tickets/use-ticket-mutations'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { ApiError } from '@/lib/api'
import {
  categoryLabels,
  formatDhakaDateTime,
  REPLY_MAX,
  replyError,
  statusLabels,
  TICKET_STATUSES,
  type TicketMessage,
  type TicketPerson,
  type TicketStatus,
  type TicketThread as Thread,
  ticketThreadQueryOptions,
} from '@/lib/admin-tickets'

/** Right pane: one ticket's conversation, its status menu and the reply box. */
export function TicketThread({ id, me }: { id: string; me: TicketPerson }) {
  const query = useQuery(ticketThreadQueryOptions(id))

  if (query.isPending) return <ThreadSkeleton />
  if (query.isError) {
    const missing = query.error instanceof ApiError && query.error.status === 404
    return (
      <div role="alert" className="flex flex-1 flex-col items-center justify-center gap-3 px-6 py-16 text-center">
        <h2 className="text-base font-semibold">
          {missing ? 'This ticket no longer exists' : "Couldn't load this ticket"}
        </h2>
        <p className="max-w-sm text-sm text-muted-foreground">
          {missing ? 'It may have been removed. Pick another ticket from the queue.' : query.error.message}
        </p>
        <div className="flex gap-2">
          <BackToQueue />
          {!missing && (
            <Button variant="outline" onClick={() => void query.refetch()}>
              <RotateCcw data-icon="inline-start" />
              Try again
            </Button>
          )}
        </div>
      </div>
    )
  }

  return (
    <>
      <ThreadHeader ticket={query.data} />
      <MessageList messages={query.data.messages} />
      {/* Keyed so a draft never carries over to another ticket. */}
      <ReplyBox key={id} ticket={query.data} me={me} />
    </>
  )
}

/** Shown in the right pane on wide screens while no ticket is open. */
export function NoTicketSelected() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 py-16 text-center">
      <span className="flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary">
        <MessagesSquare className="size-6" aria-hidden />
      </span>
      <h2 className="text-base font-semibold">Pick a ticket</h2>
      <p className="max-w-xs text-sm text-balance text-muted-foreground">
        Its conversation, internal notes and status show up here.
      </p>
    </div>
  )
}

function BackToQueue({ className }: { className?: string }) {
  return (
    <Button variant="outline" asChild className={className}>
      <Link from="/admin/tickets" to="/admin/tickets" search={(prev) => ({ ...prev, ticket: undefined })}>
        <ArrowLeft data-icon="inline-start" />
        Back to queue
      </Link>
    </Button>
  )
}

function ThreadHeader({ ticket }: { ticket: Thread }) {
  return (
    <header className="flex flex-col gap-3 border-b p-4 md:p-5">
      <div className="lg:hidden">
        <Button variant="ghost" size="sm" asChild className="-ml-2">
          <Link from="/admin/tickets" to="/admin/tickets" search={(prev) => ({ ...prev, ticket: undefined })}>
            <ArrowLeft data-icon="inline-start" />
            Queue
          </Link>
        </Button>
      </div>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 flex-col gap-1">
          <h2 className="text-lg font-semibold break-words">{ticket.subject}</h2>
          <p className="text-sm text-muted-foreground">
            <span className="font-medium text-foreground">{ticket.workspace.name}</span>
            {' · '}
            {ticket.requester.name}{' '}
            <span className="break-all">&lt;{ticket.requester.email}&gt;</span>
          </p>
        </div>
        <StatusMenu ticket={ticket} />
      </div>
      <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
        <TicketPriorityBadge priority={ticket.priority} />
        <span className="rounded-full border px-2 py-0.5 font-medium">
          {categoryLabels[ticket.category]}
        </span>
        <span>
          Opened <time dateTime={ticket.createdAt}>{formatDhakaDateTime(ticket.createdAt)}</time>
        </span>
      </div>
    </header>
  )
}

function StatusMenu({ ticket }: { ticket: Thread }) {
  const mutation = useStatusMutation()
  const change = (status: TicketStatus) => {
    // Re-picking the status on screen is not a change; don't send it.
    if (status === ticket.status) return
    mutation.mutate({ id: ticket.id, status })
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          className="shrink-0 self-start"
          aria-label={`Status: ${statusLabels[ticket.status]}`}
          disabled={mutation.isPending}
        >
          <TicketStatusPill status={ticket.status} className="-ml-1 px-2" />
          Change
          <ChevronDown data-icon="inline-end" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        <DropdownMenuLabel>Set status</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={ticket.status} onValueChange={(v) => change(v as TicketStatus)}>
          {TICKET_STATUSES.map((status) => (
            <DropdownMenuRadioItem key={status} value={status}>
              {status === 'OPEN' && ticket.status === 'RESOLVED' ? 'Reopen' : statusLabels[status]}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function MessageList({ messages }: { messages: TicketMessage[] }) {
  const scroller = useRef<HTMLOListElement>(null)
  const count = messages.length

  // Newest message is at the bottom: keep it in view when the thread opens or grows.
  useEffect(() => {
    const el = scroller.current
    if (el) el.scrollTop = el.scrollHeight
  }, [count])

  if (count === 0) {
    return (
      <div className="flex flex-1 items-center justify-center px-6 py-12 text-center text-sm text-muted-foreground">
        No messages yet. Write the first reply below.
      </div>
    )
  }

  return (
    <ol
      ref={scroller}
      aria-label="Messages"
      className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4 md:p-5"
    >
      {messages.map((message) => (
        <MessageItem key={message.id} message={message} />
      ))}
    </ol>
  )
}

function MessageItem({ message }: { message: TicketMessage }) {
  const fromAdmin = message.senderRole === 'ADMIN'
  const note = message.isInternalNote
  const sending = message.id.startsWith(OPTIMISTIC_PREFIX)

  return (
    <li
      data-internal-note={note || undefined}
      aria-label={note ? `Internal note from ${message.sender.name}` : `Message from ${message.sender.name}`}
      className={cn('flex max-w-[85%] flex-col gap-1', fromAdmin ? 'items-end self-end' : 'items-start self-start')}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 px-1 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">{message.sender.name}</span>
        <span>{fromAdmin ? 'Admin' : 'Client'}</span>
        <time dateTime={message.createdAt}>
          {sending ? 'Sending…' : formatDhakaDateTime(message.createdAt)}
        </time>
      </div>
      <div
        className={cn(
          'rounded-2xl px-4 py-2.5 text-sm break-words whitespace-pre-wrap',
          note
            ? 'border border-dashed border-chart-4 bg-chart-4/10 text-foreground'
            : fromAdmin
              ? 'bg-primary text-primary-foreground'
              : 'border bg-muted text-foreground',
          sending && 'opacity-70',
        )}
      >
        {note && (
          <span className="mb-1 flex items-center gap-1.5 text-xs font-semibold">
            <Lock className="size-3" aria-hidden />
            Internal note · only admins see this
          </span>
        )}
        {message.body}
      </div>
    </li>
  )
}

function ReplyBox({ ticket, me }: { ticket: Thread; me: TicketPerson }) {
  const mutation = useReplyMutation(me)
  const fieldId = useId()
  const [body, setBody] = useState('')
  const [internal, setInternal] = useState(false)
  const [touched, setTouched] = useState(false)
  const error = replyError(body)
  const length = body.trim().length
  const tooLong = length > REPLY_MAX
  const showError = (touched && error !== null) || tooLong

  const submit = (event?: FormEvent) => {
    event?.preventDefault()
    setTouched(true)
    if (error || mutation.isPending) return
    const draft = body
    const isInternalNote = internal
    setBody('')
    setTouched(false)
    mutation.mutate(
      { id: ticket.id, body: draft.trim(), isInternalNote },
      // Give the draft back so nothing typed is lost.
      { onError: () => setBody((current) => current || draft) },
    )
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) submit()
  }

  const hint = internal
    ? 'Only admins see notes. The status stays the same.'
    : ticket.status === 'OPEN'
      ? 'The client sees this. Replying moves the ticket to In progress.'
      : 'The client sees this reply.'

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-2 border-t p-3 md:p-4">
      <Label htmlFor={fieldId} className="sr-only">
        {internal ? 'Internal note' : 'Reply'}
      </Label>
      <Textarea
        id={fieldId}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={internal ? 'Write an internal note…' : `Reply to ${ticket.requester.name}…`}
        aria-invalid={showError || undefined}
        aria-describedby={`${fieldId}-hint`}
        rows={3}
        className={cn(
          'max-h-48 min-h-20 resize-none',
          internal && 'border-dashed border-chart-4 bg-chart-4/5 dark:bg-chart-4/5',
        )}
      />
      <div id={`${fieldId}-hint`} className="flex items-start justify-between gap-3 px-1 text-xs">
        <span
          className={showError ? 'text-destructive' : 'text-muted-foreground'}
          role={showError ? 'alert' : undefined}
        >
          {showError ? error : hint}
        </span>
        <span className={cn('shrink-0 tabular-nums', tooLong ? 'text-destructive' : 'text-muted-foreground')}>
          {length}/{REPLY_MAX}
        </span>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Switch id={`${fieldId}-internal`} checked={internal} onCheckedChange={setInternal} />
          <Label htmlFor={`${fieldId}-internal`} className="flex items-center gap-1.5 text-sm">
            <Lock className="size-3.5 text-muted-foreground" aria-hidden />
            Internal note
          </Label>
        </div>
        <Button type="submit" disabled={error !== null || mutation.isPending}>
          <SendHorizontal data-icon="inline-start" />
          {mutation.isPending ? 'Sending…' : internal ? 'Add note' : 'Send reply'}
        </Button>
      </div>
    </form>
  )
}

function ThreadSkeleton() {
  return (
    <div className="flex flex-1 flex-col" aria-busy="true" aria-label="Loading ticket">
      <div className="flex flex-col gap-2 border-b p-5">
        <Skeleton className="h-5 w-2/3 rounded-full" />
        <Skeleton className="h-4 w-1/2 rounded-full" />
        <div className="flex gap-1.5">
          <Skeleton className="h-5 w-14 rounded-full" />
          <Skeleton className="h-5 w-16 rounded-full" />
        </div>
      </div>
      <div className="flex flex-1 flex-col gap-4 p-5">
        <Skeleton className="h-16 w-3/5 rounded-2xl" />
        <Skeleton className="h-12 w-1/2 self-end rounded-2xl" />
        <Skeleton className="h-20 w-3/5 rounded-2xl" />
      </div>
    </div>
  )
}
