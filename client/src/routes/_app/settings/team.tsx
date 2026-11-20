import { createFileRoute } from '@tanstack/react-router'
import { TeamScreen } from '@/components/team/team-views'
import { useLanguage } from '@/hooks/use-language'

/** C11 `/settings/team` (M7-T13; Module 7 D2, D7, D9, D10, D11). */
export const Route = createFileRoute('/_app/settings/team')({
  head: () => ({ meta: [{ title: 'Team | ShieldComment BD' }, { name: 'robots', content: 'noindex' }] }),
  component: TeamSettings,
})

function TeamSettings() {
  const { session } = Route.useRouteContext()
  const { content } = useLanguage()
  const workspaceId = session.session.activeOrganizationId
  if (!workspaceId)
    return (
      <p className="rounded-3xl border bg-card p-6 text-sm text-muted-foreground">
        {content('No workspace is selected for this account yet.', 'এই অ্যাকাউন্টে এখনো কোনো ওয়ার্কস্পেস বেছে নেওয়া হয়নি।')}
      </p>
    )
  return <TeamScreen workspaceId={workspaceId} userId={session.user.id} impersonated={Boolean(session.session.impersonatedBy)} />
}
