import { createFileRoute } from '@tanstack/react-router'
import { Settings } from 'lucide-react'
import { PlaceholderPage } from '@/components/placeholder-page'

export const Route = createFileRoute('/_authed/admin/settings')({
  component: SettingsPage,
})

function SettingsPage() {
  return (
    <PlaceholderPage
      title="Settings"
      description="Plans, prices, offer badges and feature limits."
      icon={Settings}
      emptyTitle="No plans configured yet"
      emptyBody="The plan editor is being built. Prices in ৳, offer badges and feature limits will be edited here."
    />
  )
}
