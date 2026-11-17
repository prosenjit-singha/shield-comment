import { createFileRoute } from '@tanstack/react-router'
import { Building2 } from 'lucide-react'
import { PlaceholderPage } from '@/components/placeholder-page'

export const Route = createFileRoute('/_authed/admin/clients')({
  component: ClientsPage,
})

function ClientsPage() {
  return (
    <PlaceholderPage
      title="Clients"
      description="Every F-commerce workspace on ShieldComment, with plan, quota and status."
      icon={Building2}
      emptyTitle="No clients to show yet"
      emptyBody="The client table, search, suspend/activate and Login as Client are being built. Workspaces will be listed here."
    />
  )
}
