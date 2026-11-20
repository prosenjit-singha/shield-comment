import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { ArrowUp, CheckCircle2, LoaderCircle, Search } from 'lucide-react'
import { useState } from 'react'
import { CommentRow } from '@/components/comments/comment-row'
import { DashboardError } from '@/components/dashboard/dashboard-charts'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { useLanguage } from '@/hooks/use-language'
import { toApiError } from '@/lib/api'
import {
  activeFilters,
  COMMENT_STATUSES,
  type CommentsFeedData,
  commentsFeedQueryKey,
  commentsFeedQueryOptions,
  type CommentsFeedSearch,
  FEED_SEARCH_MAX,
  feedLoadErrorMessage,
  mergeNewComments,
  MODERATION_CATEGORIES,
  newCommentsQueryOptions,
  statusLabel,
  unseenComments,
  validateCommentsFeedSearch,
} from '@/lib/comments-feed'
import { categoryLabel, formatCount } from '@/lib/dashboard-summary'

/** C5 `/comments` (M6-T9; D1 polling, D7 every member acts, D8 "Keep visible"). */
export const Route = createFileRoute('/_app/comments')({
  head: () => ({ meta: [{ title: 'Comments | ShieldComment BD' }, { name: 'robots', content: 'noindex' }] }),
  validateSearch: validateCommentsFeedSearch,
  component: CommentsPage,
})

function CommentsPage() {
  const { session } = Route.useRouteContext()
  const { content } = useLanguage()
  const workspaceId = session.session.activeOrganizationId

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">{content('Comments', 'কমেন্ট')}</h1>
        <p className="text-sm text-muted-foreground">
          {content('Every comment the AI checked, newest first.', 'AI যে কমেন্টগুলো যাচাই করেছে, নতুনগুলো আগে।')}
        </p>
      </div>
      {workspaceId ? (
        <CommentsView workspaceId={workspaceId} />
      ) : (
        <p className="rounded-3xl border bg-card p-6 text-sm text-muted-foreground">
          {content('No workspace is selected for this account yet.', 'এই অ্যাকাউন্টে এখনো কোনো ওয়ার্কস্পেস বেছে নেওয়া হয়নি।')}
        </p>
      )}
    </div>
  )
}

const pillClass =
  'shrink-0 rounded-full px-3.5 py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground aria-pressed:bg-primary aria-pressed:text-primary-foreground'

function CommentsView({ workspaceId }: { workspaceId: string }) {
  const { content, language } = useLanguage()
  const queryClient = useQueryClient()
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  const filters = activeFilters(search)
  const [notice, setNotice] = useState<string | null>(null)

  const feed = useInfiniteQuery(commentsFeedQueryOptions(workspaceId, filters))
  const newest = feed.data?.pages[0]?.items[0]?.createdAt
  const fresh = useQuery({ ...newCommentsQueryOptions(workspaceId, filters, newest ?? ''), enabled: newest !== undefined })
  const unseen = feed.data && fresh.data ? unseenComments(feed.data, fresh.data.items) : []
  const items = feed.data?.pages.flatMap((page) => page.items) ?? []

  const setFilter = (patch: CommentsFeedSearch) => {
    setNotice(null)
    void navigate({ search: (prev) => ({ ...prev, ...patch }) })
  }

  const showNew = () => {
    const key = commentsFeedQueryKey(workspaceId, filters)
    // More than one poll page arrived: reload from the top instead of leaving a gap.
    if (fresh.data?.nextCursor) void queryClient.resetQueries({ queryKey: key, exact: true })
    else queryClient.setQueryData<CommentsFeedData>(key, (old) => old && mergeNewComments(old, unseen))
  }

  const newCount = `${formatCount(unseen.length, language)}${fresh.data?.nextCursor ? '+' : ''}`

  return (
    <>
      <div className="flex flex-col gap-3">
        <div role="group" aria-label={content('Status', 'স্ট্যাটাস')} className="flex gap-1 overflow-x-auto rounded-full border bg-card p-1">
          <button type="button" aria-pressed={!filters.status} onClick={() => setFilter({ status: undefined })} className={pillClass}>
            {content('All', 'সব')}
          </button>
          {COMMENT_STATUSES.map((status) => (
            <button key={status} type="button" aria-pressed={filters.status === status} onClick={() => setFilter({ status })} className={pillClass}>
              {statusLabel(status, content)}
            </button>
          ))}
        </div>
        <div role="group" aria-label={content('Category', 'ক্যাটাগরি')} className="flex gap-1 overflow-x-auto rounded-full border bg-card p-1">
          <button type="button" aria-pressed={!filters.category} onClick={() => setFilter({ category: undefined })} className={pillClass}>
            {content('All', 'সব')}
          </button>
          {MODERATION_CATEGORIES.map((category) => (
            <button
              key={category}
              type="button"
              aria-pressed={filters.category === category}
              onClick={() => setFilter({ category })}
              className={pillClass}
            >
              {categoryLabel(category, content)}
            </button>
          ))}
        </div>
        <SearchForm key={filters.q ?? ''} initial={filters.q ?? ''} onSearch={(q) => setFilter({ q })} />
        {Object.keys(filters).length > 0 ? (
          <Button variant="ghost" size="sm" className="self-start" onClick={() => void navigate({ search: {} })}>
            {content('Clear filters', 'ফিল্টার মুছুন')}
          </Button>
        ) : null}
      </div>

      <p role="status" data-testid="feed-notice" className="empty:hidden">
        {notice ? (
          <span className="flex items-center gap-2 rounded-2xl bg-primary/10 px-4 py-2 text-sm text-primary">
            <CheckCircle2 className="size-4 shrink-0" aria-hidden />
            {notice}
          </span>
        ) : null}
      </p>

      {unseen.length > 0 ? (
        <Button className="self-center shadow-sm" onClick={showNew}>
          <ArrowUp aria-hidden />
          {unseen.length === 1 && !fresh.data?.nextCursor
            ? content('1 new comment', '১টি নতুন কমেন্ট')
            : content(`${newCount} new comments`, `${newCount}টি নতুন কমেন্ট`)}
        </Button>
      ) : null}

      {feed.isError && !feed.data ? (
        <DashboardError
          title={content('Couldn’t load comments', 'কমেন্ট লোড করা যায়নি')}
          message={feedLoadErrorMessage(toApiError(feed.error), content)}
          onRetry={() => void feed.refetch()}
          retrying={feed.isFetching}
        />
      ) : feed.isPending ? (
        <div className="flex flex-col gap-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} data-testid="comment-skeleton" className="h-36 w-full rounded-3xl" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <p className="rounded-3xl border bg-card p-6 text-center text-sm text-muted-foreground">
          {Object.keys(filters).length > 0
            ? content('No comments match these filters.', 'এই ফিল্টারে কোনো কমেন্ট নেই।')
            : content(
                'No comments yet. They show up here as soon as your Pages get comments.',
                'এখনো কোনো কমেন্ট নেই। আপনার পেজে কমেন্ট এলেই এখানে দেখা যাবে।',
              )}
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {items.map((item) => (
            <CommentRow key={item.id} workspaceId={workspaceId} item={item} onSuccess={setNotice} />
          ))}
          {feed.hasNextPage ? (
            <Button variant="outline" className="self-center" disabled={feed.isFetchingNextPage} onClick={() => void feed.fetchNextPage()}>
              {feed.isFetchingNextPage ? <LoaderCircle className="animate-spin motion-reduce:animate-none" aria-hidden /> : null}
              {content('Load more', 'আরও দেখুন')}
            </Button>
          ) : null}
        </div>
      )}
    </>
  )
}

function SearchForm({ initial, onSearch }: { initial: string; onSearch: (q: string | undefined) => void }) {
  const { content } = useLanguage()
  const [value, setValue] = useState(initial)
  return (
    <form
      role="search"
      className="flex gap-2"
      onSubmit={(event) => {
        event.preventDefault()
        onSearch(value.trim() || undefined)
      }}
    >
      <Input
        type="search"
        value={value}
        maxLength={FEED_SEARCH_MAX}
        onChange={(event) => setValue(event.target.value)}
        aria-label={content('Search comments', 'কমেন্ট খুঁজুন')}
        placeholder={content('Search comment text', 'কমেন্টের লেখা খুঁজুন')}
        className="h-10 px-4"
      />
      <Button type="submit" variant="outline" className="h-10 px-4">
        <Search aria-hidden />
        {content('Search', 'খুঁজুন')}
      </Button>
    </form>
  )
}
