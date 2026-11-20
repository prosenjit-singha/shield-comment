import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, LoaderCircle, Send } from 'lucide-react'
import { useId, useState, type FormEvent } from 'react'
import { AttachmentPicker, AttachmentThumb } from '@/components/support/attachments'
import { usePickedImages } from '@/components/support/use-picked-images'
import { DashboardError } from '@/components/dashboard/dashboard-charts'
import { MetaNotice } from '@/components/meta/meta-notice'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { useLanguage } from '@/hooks/use-language'
import { toApiError } from '@/lib/api'
import { formatCommentTime } from '@/lib/comments-feed'
import {
  bodyError,
  categoryLabel,
  createTicket,
  loadErrorMessage,
  replyToTicket,
  statusLabel,
  SUBJECT_MAX,
  subjectError,
  supportRootKey,
  TICKET_CATEGORIES,
  type TicketCategory,
  type TicketDetail,
  ticketQueryOptions,
  type TicketStatus,
  writeErrorMessage,
} from '@/lib/support-tickets'
import { cn } from '@/lib/utils'

const STATUS_CLASS: Record<TicketStatus, string> = {
  OPEN: 'bg-primary/10 text-primary',
  IN_PROGRESS: 'bg-accent/40 text-accent-foreground',
  RESOLVED: 'bg-muted text-muted-foreground',
}

export function StatusPill({ status }: { status: TicketStatus }) {
  const { content } = useLanguage()
  return (
    <span data-status={status} className={cn('inline-flex shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium', STATUS_CLASS[status])}>
      {statusLabel(status, content)}
    </span>
  )
}

export function NewReplyBadge() {
  const { content } = useLanguage()
  return (
    <span data-testid="new-reply" className="inline-flex shrink-0 rounded-full bg-primary px-2.5 py-0.5 text-xs font-medium text-primary-foreground">
      {content('New reply', 'নতুন উত্তর')}
    </span>
  )
}

/** D2 (a): impersonated sessions read only; shown wherever writing is disabled. */
export function ReadOnlyNotice() {
  const { content } = useLanguage()
  return (
    <MetaNotice tone="info" kind="impersonation-read-only">
      {content(
        'You’re signed in as this client by support. You can read tickets, but new tickets and replies are off so nothing is sent in the client’s name.',
        'আপনি সাপোর্ট থেকে এই ক্লায়েন্ট হিসেবে লগ ইন করেছেন। টিকিট পড়তে পারবেন, কিন্তু ক্লায়েন্টের নামে কিছু যেন না যায় তাই নতুন টিকিট ও উত্তর বন্ধ।',
      )}
    </MetaNotice>
  )
}

function WriteError({ kind, error }: { kind: string; error: unknown }) {
  const { content } = useLanguage()
  const apiError = toApiError(error)
  return (
    <MetaNotice tone="error" kind={kind} network={apiError.isNetwork}>
      {writeErrorMessage(apiError, content)}
    </MetaNotice>
  )
}

const fieldClass =
  'w-full border border-input bg-transparent text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:bg-input/30'

function MessageField({
  id,
  label,
  value,
  error,
  onChange,
  disabled,
}: {
  id: string
  label: string
  value: string
  error: string | null
  onChange: (value: string) => void
  disabled?: boolean
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      <textarea
        id={id}
        rows={4}
        value={value}
        disabled={disabled}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : undefined}
        onChange={(event) => onChange(event.target.value)}
        className={cn(fieldClass, 'rounded-2xl px-4 py-2.5')}
      />
      {error ? (
        <span id={`${id}-error`} className="text-xs text-destructive">
          {error}
        </span>
      ) : null}
    </div>
  )
}

/** New ticket (D3 a: category, subject, message; D4 b screenshots). On success opens the thread. */
export function NewTicketForm({ workspaceId, onCancel, onCreated }: { workspaceId: string; onCancel: () => void; onCreated: (id: string) => void }) {
  const { content } = useLanguage()
  const queryClient = useQueryClient()
  const id = useId()
  const [category, setCategory] = useState<TicketCategory | ''>('')
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')
  const [touched, setTouched] = useState(false)
  const picked = usePickedImages()

  const create = useMutation({
    mutationFn: () =>
      createTicket(workspaceId, { category: category as TicketCategory, subject: subject.trim(), body: body.trim(), files: picked.files }),
    onSuccess: (ticket: TicketDetail) => {
      queryClient.setQueryData(ticketQueryOptions(workspaceId, ticket.id).queryKey, ticket)
      void queryClient.invalidateQueries({ queryKey: [...supportRootKey(workspaceId), 'tickets'] })
      picked.clear()
      onCreated(ticket.id)
    },
  })

  const errors = {
    category: category ? null : content('Pick a category.', 'একটি ক্যাটাগরি বেছে নিন।'),
    subject: subjectError(subject, content),
    body: bodyError(body, content),
  }
  const show = (error: string | null) => (touched ? error : null)

  const submit = (event: FormEvent) => {
    event.preventDefault()
    setTouched(true)
    if (errors.category || errors.subject || errors.body) return
    create.mutate()
  }

  return (
    <form onSubmit={submit} noValidate aria-labelledby={`${id}-title`} className="flex flex-col gap-5 rounded-3xl border bg-card p-5 sm:p-6">
      <h2 id={`${id}-title`} className="text-lg font-semibold">
        {content('New ticket', 'নতুন টিকিট')}
      </h2>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${id}-category`} className="text-sm font-medium">
          {content('Category', 'ক্যাটাগরি')}
        </label>
        <select
          id={`${id}-category`}
          value={category}
          aria-invalid={show(errors.category) ? true : undefined}
          onChange={(event) => setCategory(event.target.value as TicketCategory | '')}
          className={cn(fieldClass, 'h-10 rounded-full px-4')}
        >
          <option value="">{content('Choose…', 'বেছে নিন…')}</option>
          {TICKET_CATEGORIES.map((value) => (
            <option key={value} value={value}>
              {categoryLabel(value, content)}
            </option>
          ))}
        </select>
        {show(errors.category) ? <span className="text-xs text-destructive">{errors.category}</span> : null}
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${id}-subject`} className="text-sm font-medium">
          {content('Subject', 'বিষয়')}
        </label>
        <Input
          id={`${id}-subject`}
          value={subject}
          maxLength={SUBJECT_MAX}
          aria-invalid={show(errors.subject) ? true : undefined}
          onChange={(event) => setSubject(event.target.value)}
          className="h-10 px-4"
        />
        {show(errors.subject) ? <span className="text-xs text-destructive">{errors.subject}</span> : null}
      </div>
      <MessageField id={`${id}-body`} label={content('Message', 'মেসেজ')} value={body} error={show(errors.body)} onChange={setBody} />
      <AttachmentPicker picked={picked} />
      {create.isError ? <WriteError kind="create-error" error={create.error} /> : null}
      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="ghost" className="h-10 px-5" onClick={onCancel}>
          {content('Cancel', 'বাতিল')}
        </Button>
        <Button type="submit" className="h-10 px-5" disabled={create.isPending} aria-busy={create.isPending || undefined}>
          {create.isPending ? <LoaderCircle className="animate-spin motion-reduce:animate-none" aria-hidden /> : <Send aria-hidden />}
          {content('Send ticket', 'টিকিট পাঠান')}
        </Button>
      </div>
    </form>
  )
}

function ReplyBox({ workspaceId, ticket }: { workspaceId: string; ticket: TicketDetail }) {
  const { content } = useLanguage()
  const queryClient = useQueryClient()
  const id = useId()
  const [body, setBody] = useState('')
  const [touched, setTouched] = useState(false)
  const picked = usePickedImages()

  const reply = useMutation({
    mutationFn: () => replyToTicket(workspaceId, ticket.id, { body: body.trim(), files: picked.files }),
    onSuccess: async () => {
      setBody('')
      setTouched(false)
      picked.clear()
      await queryClient.invalidateQueries({ queryKey: supportRootKey(workspaceId) })
    },
  })

  const error = touched ? bodyError(body, content) : null
  const submit = (event: FormEvent) => {
    event.preventDefault()
    setTouched(true)
    if (bodyError(body, content)) return
    reply.mutate()
  }

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-4 rounded-3xl border bg-card p-5 sm:p-6">
      <MessageField id={`${id}-reply`} label={content('Your reply', 'আপনার উত্তর')} value={body} error={error} onChange={setBody} />
      {ticket.status === 'RESOLVED' ? (
        <p className="text-xs text-muted-foreground">
          {content('This ticket is resolved. Replying opens it again.', 'এই টিকিটটি সমাধান হয়েছে। উত্তর দিলে এটি আবার খুলবে।')}
        </p>
      ) : null}
      <AttachmentPicker picked={picked} />
      {reply.isError ? <WriteError kind="reply-error" error={reply.error} /> : null}
      <Button type="submit" className="h-10 self-end px-5" disabled={reply.isPending} aria-busy={reply.isPending || undefined}>
        {reply.isPending ? <LoaderCircle className="animate-spin motion-reduce:animate-none" aria-hidden /> : <Send aria-hidden />}
        {content('Send reply', 'উত্তর পাঠান')}
      </Button>
    </form>
  )
}

/** One ticket's public thread (the API never sends internal notes) + reply box; polls every 15 s (D5 a). */
export function TicketThread({
  workspaceId,
  ticketId,
  impersonated,
  onBack,
}: {
  workspaceId: string
  ticketId: string
  impersonated: boolean
  onBack: () => void
}) {
  const { content, language } = useLanguage()
  const thread = useQuery(ticketQueryOptions(workspaceId, ticketId))
  const ticket = thread.data

  return (
    <div className="flex flex-col gap-4">
      <Button variant="ghost" size="sm" className="self-start" onClick={onBack}>
        <ArrowLeft aria-hidden />
        {content('All tickets', 'সব টিকিট')}
      </Button>
      {thread.isError && !ticket ? (
        <DashboardError
          title={content('Couldn’t load this ticket', 'এই টিকিটটি লোড করা যায়নি')}
          message={loadErrorMessage(toApiError(thread.error), content)}
          onRetry={() => void thread.refetch()}
          retrying={thread.isFetching}
        />
      ) : !ticket ? (
        <Skeleton data-testid="thread-skeleton" className="h-48 w-full rounded-3xl" />
      ) : (
        <>
          <header className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <StatusPill status={ticket.status} />
              <span className="text-xs text-muted-foreground">{categoryLabel(ticket.category, content)}</span>
            </div>
            <h2 className="text-xl font-semibold text-balance">{ticket.subject}</h2>
          </header>
          <ol aria-label={content('Messages', 'মেসেজ')} className="flex flex-col gap-3">
            {ticket.messages.map((message) => {
              const support = message.senderRole === 'ADMIN'
              return (
                <li
                  key={message.id}
                  data-sender={message.senderRole}
                  className={cn('flex flex-col gap-2 rounded-2xl border p-4', support ? 'border-primary/20 bg-primary/5' : 'bg-card')}
                >
                  <div className="flex flex-wrap items-baseline justify-between gap-2 text-xs text-muted-foreground">
                    <span className="font-medium text-foreground">{support ? content('Support', 'সাপোর্ট') : message.sender.name}</span>
                    <time dateTime={message.createdAt}>{formatCommentTime(message.createdAt, language)}</time>
                  </div>
                  <p className="text-sm whitespace-pre-wrap">{message.body}</p>
                  {message.attachments.length > 0 ? (
                    <div className="flex flex-wrap gap-2">
                      {message.attachments.map((attachment, index) => (
                        <AttachmentThumb key={attachment.id} attachment={attachment} index={index} />
                      ))}
                    </div>
                  ) : null}
                </li>
              )
            })}
          </ol>
          {impersonated ? <ReadOnlyNotice /> : <ReplyBox key={ticket.id} workspaceId={workspaceId} ticket={ticket} />}
        </>
      )}
    </div>
  )
}
