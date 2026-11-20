import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Eye, EyeOff, LoaderCircle, MessageSquareReply, ShieldCheck, Trash2, TriangleAlert, type LucideIcon } from 'lucide-react'
import { useId, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { useLanguage } from '@/hooks/use-language'
import type { ApiError } from '@/lib/api'
import type { ContentFn } from '@/lib/auth-errors'
import {
  availableActions,
  type CommentFeedItem,
  type CommentsFeedData,
  type CommentStatus,
  commentsFeedRootKey,
  formatCommentTime,
  overrideComment,
  type OverrideAction,
  overrideErrorMessage,
  overrideSuccessMessage,
  REPLY_MAX,
  replaceComment,
  replyTextError,
  statusLabel,
} from '@/lib/comments-feed'
import { categoryLabel, formatCount } from '@/lib/dashboard-summary'

const ACTION_ICONS: Record<OverrideAction, LucideIcon> = {
  KEEP: ShieldCheck,
  HIDE: EyeOff,
  UNHIDE: Eye,
  REPLY: MessageSquareReply,
  DELETE: Trash2,
}

function actionLabel(action: OverrideAction, content: ContentFn): string {
  switch (action) {
    case 'KEEP':
      return content('Keep visible', 'দৃশ্যমান রাখুন')
    case 'HIDE':
      return content('Hide', 'হাইড করুন')
    case 'UNHIDE':
      return content('Unhide', 'আনহাইড করুন')
    case 'REPLY':
      return content('Reply', 'উত্তর দিন')
    case 'DELETE':
      return content('Delete', 'ডিলিট করুন')
  }
}

const STATUS_STYLES: Record<CommentStatus, string> = {
  PENDING: 'border-border text-muted-foreground',
  VISIBLE: 'bg-primary/10 text-primary',
  NEEDS_REVIEW: 'bg-accent text-accent-foreground',
  HIDDEN: 'bg-secondary/10 text-secondary',
  DELETED: 'bg-destructive/10 text-destructive',
  SKIPPED: 'border-border text-muted-foreground',
  FAILED: 'bg-destructive/10 text-destructive',
}

interface OverrideVariables {
  action: OverrideAction
  replyText?: string
}

/**
 * One `/comments` row (M6-T9): pills, confidence, reasoning (`<details>`), and the D7/D8 actions.
 * Each row owns its mutation (per-row pending). Success → the answer replaces the row in every loaded
 * feed page + the feed is refetched; `onSuccess` gets the message for the page's status line.
 * Failures stay on the row (or in the open dialog).
 */
export function CommentRow({
  workspaceId,
  item,
  onSuccess,
}: {
  workspaceId: string
  item: CommentFeedItem
  onSuccess: (message: string) => void
}) {
  const { content, language } = useLanguage()
  const queryClient = useQueryClient()
  const [dialog, setDialog] = useState<'DELETE' | 'REPLY' | null>(null)
  const [replyText, setReplyText] = useState('')
  const [replyError, setReplyError] = useState<string | null>(null)
  const replyId = useId()

  const override = useMutation<CommentFeedItem, ApiError, OverrideVariables>({
    mutationFn: ({ action, replyText: text }) => overrideComment(workspaceId, item.id, action, text?.trim()),
    onSuccess: (updated, { action }) => {
      queryClient.setQueriesData<CommentsFeedData>({ queryKey: commentsFeedRootKey(workspaceId) }, (old) =>
        old && 'pages' in old ? replaceComment(old, updated) : old,
      )
      void queryClient.invalidateQueries({ queryKey: commentsFeedRootKey(workspaceId) })
      // The dashboard's "needs review" KPI may have changed.
      void queryClient.invalidateQueries({ queryKey: ['workspace', workspaceId, 'dashboard'] })
      setDialog(null)
      onSuccess(overrideSuccessMessage(action, content))
    },
  })

  const pending = override.isPending
  const error = pending ? null : override.error

  const openDialog = (next: 'DELETE' | 'REPLY') => {
    override.reset()
    setReplyText('')
    setReplyError(null)
    setDialog(next)
  }
  const changeOpen = (open: boolean) => {
    if (!open && !pending) setDialog(null)
  }
  const act = (action: OverrideAction) => {
    if (action === 'DELETE' || action === 'REPLY') openDialog(action)
    else override.mutate({ action })
  }
  const sendReply = () => {
    const problem = replyTextError(replyText, content)
    setReplyError(problem)
    if (!problem) override.mutate({ action: 'REPLY', replyText })
  }

  const confidence = item.confidence === null ? null : Math.round(item.confidence * 100)
  const meta = [
    item.page?.name ?? content('Disconnected Page', 'ডিসকানেক্ট করা পেজ'),
    item.platform === 'FACEBOOK' ? content('Facebook', 'ফেসবুক') : content('Instagram', 'ইনস্টাগ্রাম'),
    formatCommentTime(item.createdAt, language),
  ]

  return (
    <article
      data-testid={`comment-${item.id}`}
      aria-busy={pending || undefined}
      className="flex flex-col gap-3 rounded-3xl border bg-card p-4 sm:p-5"
    >
      <header className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
        <span className="text-sm font-semibold text-foreground">{item.authorName ?? content('Unknown user', 'অজানা ব্যবহারকারী')}</span>
        {meta.map((part) => (
          <span key={part} className="before:mr-2 before:content-['·']">
            {part}
          </span>
        ))}
      </header>

      <p className="text-sm break-words whitespace-pre-wrap">
        {item.message ?? <span className="text-muted-foreground italic">{content('(no text)', '(কোনো লেখা নেই)')}</span>}
      </p>

      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline" data-testid="status-pill" className={STATUS_STYLES[item.status]}>
          {statusLabel(item.status, content)}
        </Badge>
        {item.category ? (
          <Badge variant="outline" data-testid="category-pill">
            {categoryLabel(item.category, content)}
          </Badge>
        ) : null}
        {confidence !== null ? (
          <span data-testid="confidence" className="text-xs text-muted-foreground">
            {content(`${confidence}% confident`, `${formatCount(confidence, 'bn')}% নিশ্চিত`)}
          </span>
        ) : null}
      </div>

      {item.reasoning || item.ruleMatch ? (
        <details className="group rounded-2xl bg-muted px-4 py-2 text-sm">
          <summary className="cursor-pointer text-xs font-medium text-muted-foreground select-none">
            {content('Why this result?', 'কেন এই ফলাফল?')}
          </summary>
          <div className="mt-2 flex flex-col gap-1 text-pretty">
            {item.ruleMatch ? <p>{content(`Matched rule: ${item.ruleMatch}`, `মিলে যাওয়া নিয়ম: ${item.ruleMatch}`)}</p> : null}
            {item.reasoning ? <p>{item.reasoning}</p> : null}
          </div>
        </details>
      ) : null}

      {availableActions(item.status).length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {availableActions(item.status).map((action) => {
            const Icon = pending && override.variables?.action === action ? LoaderCircle : ACTION_ICONS[action]
            return (
              <Button
                key={action}
                size="sm"
                variant={action === 'DELETE' ? 'destructive' : 'outline'}
                disabled={pending}
                onClick={() => act(action)}
              >
                <Icon className={pending && override.variables?.action === action ? 'animate-spin motion-reduce:animate-none' : undefined} aria-hidden />
                {actionLabel(action, content)}
              </Button>
            )
          })}
        </div>
      ) : null}

      {error && dialog === null ? <RowError message={overrideErrorMessage(error, content)} /> : null}

      <Dialog open={dialog !== null} onOpenChange={changeOpen}>
        <DialogContent showCloseButton={false} className="gap-5 rounded-2xl p-5 sm:max-w-md">
          {dialog === 'DELETE' ? (
            <DialogHeader>
              <DialogTitle className="text-lg font-semibold">{content('Delete this comment?', 'এই কমেন্টটি ডিলিট করবেন?')}</DialogTitle>
              <DialogDescription className="text-pretty">
                {content(
                  'It is removed from Facebook for good. This can’t be undone.',
                  'এটি ফেসবুক থেকে চিরতরে মুছে যাবে। এটি আর ফেরানো যাবে না।',
                )}
              </DialogDescription>
            </DialogHeader>
          ) : (
            <>
              <DialogHeader>
                <DialogTitle className="text-lg font-semibold">{content('Reply to this comment', 'এই কমেন্টের উত্তর দিন')}</DialogTitle>
                <DialogDescription className="text-pretty">
                  {content('Your reply is posted publicly under the comment.', 'আপনার উত্তর কমেন্টের নিচে সবাই দেখতে পাবে।')}
                </DialogDescription>
              </DialogHeader>
              <div className="flex flex-col gap-2">
                <Label htmlFor={replyId}>{content('Reply', 'উত্তর')}</Label>
                <textarea
                  id={replyId}
                  rows={4}
                  value={replyText}
                  aria-invalid={replyError ? true : undefined}
                  aria-describedby={`${replyId}-count`}
                  onChange={(event) => setReplyText(event.target.value)}
                  className="w-full rounded-xl border border-input bg-transparent px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 aria-invalid:border-destructive"
                />
                <p id={`${replyId}-count`} className="text-right text-xs text-muted-foreground">
                  {language === 'bn'
                    ? `${formatCount(replyText.trim().length, 'bn')}/${formatCount(REPLY_MAX, 'bn')}`
                    : `${replyText.trim().length}/${REPLY_MAX}`}
                </p>
                {replyError ? <RowError message={replyError} /> : null}
              </div>
            </>
          )}
          {error ? <RowError message={overrideErrorMessage(error, content)} /> : null}
          <DialogFooter className="-mx-5 -mb-5 rounded-b-2xl p-5">
            <Button variant="outline" className="h-10 px-5" disabled={pending} onClick={() => setDialog(null)}>
              {content('Cancel', 'বাতিল')}
            </Button>
            <Button
              variant={dialog === 'DELETE' ? 'destructive' : 'default'}
              className="h-10 px-5"
              disabled={pending}
              aria-busy={pending || undefined}
              onClick={() => (dialog === 'DELETE' ? override.mutate({ action: 'DELETE' }) : sendReply())}
            >
              {pending ? <LoaderCircle className="animate-spin motion-reduce:animate-none" aria-hidden /> : null}
              {dialog === 'DELETE' ? content('Yes, delete', 'হ্যাঁ, ডিলিট করুন') : content('Send reply', 'উত্তর পাঠান')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </article>
  )
}

function RowError({ message }: { message: string }) {
  return (
    <p role="alert" className="flex items-start gap-2 rounded-2xl bg-destructive/10 px-3 py-2 text-sm text-destructive">
      <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
      <span className="text-pretty">{message}</span>
    </p>
  )
}
