import { createFileRoute } from '@tanstack/react-router'
import { AlertSettingsScreen } from '@/components/alerts/alert-settings-view'
import { useLanguage } from '@/hooks/use-language'

/** C12 `/settings/alerts` (M7-T15; Module 7 D2, D12–D15, M7-D20/D21). */
export const Route = createFileRoute('/_app/settings/alerts')({
  head: () => ({ meta: [{ title: 'Alerts | ShieldComment BD' }, { name: 'robots', content: 'noindex' }] }),
  component: AlertSettings,
})

function AlertSettings() {
  const { session } = Route.useRouteContext()
  const { content } = useLanguage()
  const workspaceId = session.session.activeOrganizationId
  if (!workspaceId)
    return (
      <p className="rounded-3xl border bg-card p-6 text-sm text-muted-foreground">
        {content('No workspace is selected for this account yet.', 'এই অ্যাকাউন্টে এখনো কোনো ওয়ার্কস্পেস বেছে নেওয়া হয়নি।')}
      </p>
    )
  return <AlertSettingsScreen workspaceId={workspaceId} userId={session.user.id} impersonated={Boolean(session.session.impersonatedBy)} />
}
