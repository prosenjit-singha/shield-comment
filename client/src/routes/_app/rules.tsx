import { useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { Lock } from 'lucide-react'
import { RulesForm } from '@/components/rules/rules-form'
import { DashboardError } from '@/components/dashboard/dashboard-charts'
import { Skeleton } from '@/components/ui/skeleton'
import { useLanguage } from '@/hooks/use-language'
import { toApiError } from '@/lib/api'
import { moderationPolicyQueryOptions, rulesLoadErrorMessage, rulesOwnersOnlyMessage } from '@/lib/moderation-policy'

/** C7 `/rules` (M6-T10): the workspace moderation policy (owner/admin; the API answers 403 to moderators). */
export const Route = createFileRoute('/_app/rules')({
  head: () => ({ meta: [{ title: 'Rules | ShieldComment BD' }, { name: 'robots', content: 'noindex' }] }),
  component: RulesPage,
})

function RulesPage() {
  const { session } = Route.useRouteContext()
  const { content } = useLanguage()
  const workspaceId = session.session.activeOrganizationId

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">{content('Rules', 'নিয়ম')}</h1>
        <p className="text-sm text-muted-foreground">
          {content('Decide what happens to each kind of comment.', 'কোন ধরনের কমেন্টে কী হবে তা ঠিক করুন।')}
        </p>
      </div>
      {workspaceId ? (
        <RulesView workspaceId={workspaceId} />
      ) : (
        <p className="rounded-3xl border bg-card p-6 text-sm text-muted-foreground">
          {content('No workspace is selected for this account yet.', 'এই অ্যাকাউন্টে এখনো কোনো ওয়ার্কস্পেস বেছে নেওয়া হয়নি।')}
        </p>
      )}
    </div>
  )
}

function RulesView({ workspaceId }: { workspaceId: string }) {
  const { content } = useLanguage()
  const policy = useQuery(moderationPolicyQueryOptions(workspaceId))

  if (policy.data) return <RulesForm workspaceId={workspaceId} policy={policy.data} />
  if (policy.isError) {
    const error = toApiError(policy.error)
    if (error.status === 403) {
      return (
        <p data-testid="rules-forbidden" className="flex items-start gap-3 rounded-3xl border bg-card p-6 text-sm text-muted-foreground">
          <Lock className="mt-0.5 size-4 shrink-0" aria-hidden />
          {rulesOwnersOnlyMessage(content)}
        </p>
      )
    }
    return (
      <DashboardError
        title={content('Couldn’t load your rules', 'আপনার নিয়ম লোড করা যায়নি')}
        message={rulesLoadErrorMessage(error, content)}
        onRetry={() => void policy.refetch()}
        retrying={policy.isFetching}
      />
    )
  }
  return (
    <div className="flex flex-col gap-4" aria-busy="true">
      {[0, 1, 2].map((i) => (
        <Skeleton key={i} data-testid="rules-skeleton" className="h-40 w-full rounded-3xl" />
      ))}
    </div>
  )
}
