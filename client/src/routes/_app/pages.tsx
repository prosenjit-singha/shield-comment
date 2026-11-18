import { useMutation, useMutationState, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { ArrowRight } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { FacebookIcon } from '@/components/meta/brand-icons'
import {
  ImpersonationConnectNotice,
  MetaConnectButton,
  MetaConnectError,
} from '@/components/meta/meta-connect'
import { MetaDisconnectSection } from '@/components/meta/meta-disconnect'
import { MetaNotice, MetaReturnNotices, PagesLoadErrorNotice } from '@/components/meta/meta-notice'
import { InstagramPill, PageLimitPill } from '@/components/meta/page-identity'
import { PageToggleRow, type PageToggleError } from '@/components/meta/page-toggle-row'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { useLanguage } from '@/hooks/use-language'
import { useMetaConnect } from '@/hooks/use-meta-connect'
import type { ApiError } from '@/lib/api'
import {
  connectionBannerMessage,
  disconnectSuccessMessage,
  pageNeedsReconnectMessage,
} from '@/lib/meta-messages'
import {
  pageToggleMutationKey,
  setPageActive,
  togglePage,
  validateMetaReturnSearch,
  workspacePagesQueryKey,
  workspacePagesQueryOptions,
  type MetaDisconnectResponse,
  type MetaReturnSearch,
  type TogglePageResponse,
  type WorkspacePage,
  type WorkspacePagesResponse,
} from '@/lib/meta-pages'

/**
 * C6 connected Pages, base view (M3-T11; D14: boosted posts are Module 6). Facebook Pages + the
 * Instagram accounts linked to them (D4), protection on/off per Page with an optimistic switch, the plan's
 * `connectedPages` limit (D10), reconnect (D6 callback returns here) and needs-reconnect rows (no stored
 * Page token). M4-T11: a banner + Reconnect when the connection is NEEDS_REAUTH / REVOKED (D9), the
 * toggle's 409 `CONNECTION_NEEDS_REAUTH`, and Disconnect with a confirm dialog (D7). Impersonated sessions
 * can't reconnect or disconnect (D5/D7: backend 403) but may toggle; their empty state has no Connect CTA.
 */
export const Route = createFileRoute('/_app/pages')({
  validateSearch: (search: Record<string, unknown>): MetaReturnSearch => validateMetaReturnSearch(search),
  head: () => ({ meta: [{ title: 'Pages | ShieldComment BD' }, { name: 'robots', content: 'noindex' }] }),
  component: PagesPage,
})

interface ToggleVariables {
  page: WorkspacePage
  isActive: boolean
}

function PagesPage() {
  const { session } = Route.useRouteContext()
  const search = Route.useSearch()
  const { content } = useLanguage()
  const workspaceId = session.session.activeOrganizationId

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 py-2 sm:py-4">
      {workspaceId ? (
        <PagesView workspaceId={workspaceId} impersonated={Boolean(session.session.impersonatedBy)} search={search} />
      ) : (
        <>
          <PagesHeader />
          <MetaNotice tone="error" kind="no-workspace">
            {content(
              'Your account has no active workspace yet, so there are no Pages to show. Contact support.',
              'আপনার অ্যাকাউন্টে এখনো কোনো সক্রিয় ওয়ার্কস্পেস নেই, তাই দেখানোর মতো কোনো পেজ নেই। সাপোর্টে যোগাযোগ করুন।',
            )}
          </MetaNotice>
        </>
      )}
    </div>
  )
}

function PagesHeader({ pageLimit, action }: { pageLimit?: WorkspacePagesResponse['pageLimit']; action?: ReactNode }) {
  const { content } = useLanguage()
  return (
    <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div className="flex flex-col gap-1.5">
        <h1 className="text-2xl font-semibold text-balance sm:text-3xl">{content('Connected Pages', 'কানেক্টেড পেজ')}</h1>
        <p className="text-sm text-pretty text-muted-foreground">
          {content(
            'Choose which Facebook Pages ShieldComment protects. One switch covers the Page and its linked Instagram account.',
            'ShieldComment কোন ফেসবুক পেজগুলো সুরক্ষিত রাখবে তা বেছে নিন। একটি সুইচ পেজ ও এর সাথে যুক্ত ইনস্টাগ্রাম অ্যাকাউন্ট দুটোই চালু বা বন্ধ করে।',
          )}
        </p>
      </div>
      {pageLimit || action ? (
        <div className="flex shrink-0 flex-wrap items-center gap-3 sm:flex-col sm:items-end">
          {pageLimit ? <PageLimitPill pageLimit={pageLimit} /> : null}
          {action}
        </div>
      ) : null}
    </header>
  )
}

function PagesView({
  workspaceId,
  impersonated,
  search,
}: {
  workspaceId: string
  impersonated: boolean
  search: MetaReturnSearch
}) {
  const { content } = useLanguage()
  const queryClient = useQueryClient()
  const queryKey = workspacePagesQueryKey(workspaceId)
  const mutationKey = pageToggleMutationKey(workspaceId)
  const pages = useQuery(workspacePagesQueryOptions(workspaceId))
  const connect = useMetaConnect(workspaceId, '/pages')
  const [failures, setFailures] = useState<Record<string, PageToggleError>>({})
  const [disconnected, setDisconnected] = useState<MetaDisconnectResponse | null>(null)

  // Optimistic: the switch and `activeCount` move at once; a failure moves that one row back (other
  // toggles in flight keep theirs). The PATCH answer has no `pageLimit`, so the list is refetched once the
  // last toggle settles, after errors too (a 409 means our copy was stale). The refetch isn't awaited:
  // the row is free again (and shows its error) as soon as the PATCH answers.
  const toggle = useMutation<TogglePageResponse, ApiError, ToggleVariables>({
    mutationKey,
    mutationFn: ({ page, isActive }) => togglePage(workspaceId, page.id, isActive),
    onMutate: async ({ page, isActive }) => {
      setFailures((current) => Object.fromEntries(Object.entries(current).filter(([id]) => id !== page.id)))
      await queryClient.cancelQueries({ queryKey })
      queryClient.setQueryData<WorkspacePagesResponse>(queryKey, (data) => setPageActive(data, page.id, isActive))
    },
    onError: (error, { page, isActive }) => {
      queryClient.setQueryData<WorkspacePagesResponse>(queryKey, (data) => setPageActive(data, page.id, !isActive))
      setFailures((current) => ({ ...current, [page.id]: { error, target: isActive } }))
    },
    onSettled: () => {
      if (queryClient.isMutating({ mutationKey }) === 1) void queryClient.invalidateQueries({ queryKey })
    },
  })
  const pendingIds = useMutationState({
    filters: { mutationKey, status: 'pending' },
    select: (mutation) => (mutation.state.variables as ToggleVariables | undefined)?.page.id,
  })

  const items = pages.data?.items ?? []
  const connection = pages.data?.connection ?? null
  // D9: NEEDS_REAUTH (soft block) / REVOKED (app removed on Facebook) → banner with its own Reconnect.
  const reconnectStatus = connection && connection.status !== 'ACTIVE' ? connection.status : null

  return (
    <>
      <PagesHeader
        pageLimit={pages.data?.pageLimit}
        action={
          // Empty list: the empty state links to /onboarding instead; the banner has its own Reconnect.
          impersonated || items.length === 0 || reconnectStatus ? null : (
            <MetaConnectButton
              connect={connect}
              variant="outline"
              className="h-10 px-5"
              label={content('Reconnect Facebook', 'আবার ফেসবুক কানেক্ট করুন')}
            />
          )
        }
      />
      {/* After a disconnect, the callback's "?meta=connected" notice would contradict it. */}
      {disconnected ? (
        <MetaNotice tone="success" kind="disconnected">
          {disconnectSuccessMessage(disconnected, content)}
        </MetaNotice>
      ) : (
        <MetaReturnNotices search={search} />
      )}
      {reconnectStatus ? (
        <MetaNotice
          tone={reconnectStatus === 'REVOKED' ? 'error' : 'warning'}
          kind={`connection:${reconnectStatus}`}
          action={
            impersonated ? undefined : (
              <MetaConnectButton
                connect={connect}
                variant="outline"
                className="h-9 shrink-0 px-4"
                label={content('Reconnect Facebook', 'আবার ফেসবুক কানেক্ট করুন')}
              />
            )
          }
        >
          {connectionBannerMessage(reconnectStatus, content)}
        </MetaNotice>
      ) : null}
      {impersonated ? <ImpersonationConnectNotice /> : null}
      <MetaConnectError connect={connect} />

      {pages.isPending ? (
        <div className="flex flex-col gap-3" aria-busy="true">
          <Skeleton className="h-16 w-full rounded-2xl" />
          <Skeleton className="h-16 w-full rounded-2xl" />
        </div>
      ) : pages.isError ? (
        <PagesLoadErrorNotice error={pages.error} retrying={pages.isFetching} onRetry={() => void pages.refetch()} />
      ) : items.length === 0 ? (
        <EmptyPages impersonated={impersonated} />
      ) : (
        <Card className="gap-4 rounded-3xl">
          <CardHeader className="gap-1.5">
            <CardTitle>
              <h2 className="text-lg font-semibold">{content('Pages and Instagram accounts', 'পেজ ও ইনস্টাগ্রাম অ্যাকাউন্ট')}</h2>
            </CardTitle>
            <CardDescription className="text-pretty">
              {content(
                'Added a Page or linked an Instagram account on Facebook? Reconnect to bring it in.',
                'ফেসবুকে নতুন পেজ যোগ করেছেন বা ইনস্টাগ্রাম অ্যাকাউন্ট যুক্ত করেছেন? সেটি আনতে আবার কানেক্ট করুন।',
              )}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="flex flex-col gap-3" aria-label={content('Your Pages', 'আপনার পেজসমূহ')}>
              {items.map((page) => {
                const pending = pendingIds.includes(page.id)
                return (
                  <PageToggleRow
                    key={page.id}
                    page={page}
                    // No token = the backend refuses to switch it on (and an active Page always has one).
                    disabled={pending || (!page.hasToken && !page.isActive)}
                    pending={pending}
                    failure={pending ? null : (failures[page.id] ?? null)}
                    pills={<InstagramPill page={page} />}
                    hint={
                      page.hasToken ? null : (
                        <MetaNotice tone="warning" kind="needs-reconnect">
                          {pageNeedsReconnectMessage(content)}
                        </MetaNotice>
                      )
                    }
                    onToggle={(isActive) => toggle.mutate({ page, isActive })}
                  />
                )
              })}
            </ul>
          </CardContent>
        </Card>
      )}

      {/* D7: owner/admin only. The list itself is owner/admin-only (403 otherwise), so a loaded list means
          the role fits; a 403 anyway (role changed meanwhile) is shown in the dialog. */}
      {!impersonated && pages.isSuccess && (connection !== null || items.length > 0) ? (
        <MetaDisconnectSection workspaceId={workspaceId} onDisconnected={setDisconnected} />
      ) : null}
    </>
  )
}

/** Finding (a): impersonated sessions can't connect, so no CTA (the impersonation notice above explains). */
function EmptyPages({ impersonated }: { impersonated: boolean }) {
  const { content } = useLanguage()
  return (
    <Card className="items-center gap-4 rounded-3xl px-6 py-10 text-center" data-testid="pages-empty">
      <span className="flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary">
        <FacebookIcon className="size-6" />
      </span>
      <div className="flex max-w-md flex-col gap-1.5">
        <h2 className="text-lg font-semibold">{content('No Pages connected yet', 'এখনো কোনো পেজ কানেক্ট করা হয়নি')}</h2>
        <p className="text-sm text-pretty text-muted-foreground">
          {impersonated
            ? content(
                'The workspace owner has to connect Facebook before Pages show up here.',
                'এখানে পেজ দেখাতে হলে ওয়ার্কস্পেসের মালিককে ফেসবুক কানেক্ট করতে হবে।',
              )
            : content(
                'Connect Facebook to bring in your Pages and the Instagram accounts linked to them.',
                'আপনার পেজ ও সেগুলোর সাথে যুক্ত ইনস্টাগ্রাম অ্যাকাউন্ট আনতে ফেসবুক কানেক্ট করুন।',
              )}
        </p>
      </div>
      {impersonated ? null : (
        <Button asChild className="h-11 px-6">
          <Link to="/onboarding">
            {content('Connect Facebook', 'ফেসবুক কানেক্ট করুন')}
            <ArrowRight aria-hidden />
          </Link>
        </Button>
      )}
    </Card>
  )
}
