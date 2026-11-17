import { createFileRoute } from '@tanstack/react-router'
import { LifeBuoy } from 'lucide-react'
import { PlaceholderPage } from '@/components/placeholder-page'

export const Route = createFileRoute('/_authed/admin/tickets')({
  component: TicketsPage,
})

function TicketsPage() {
  return (
    <PlaceholderPage
      title="Tickets"
      description="Support requests from client workspaces, with replies and internal notes."
      icon={LifeBuoy}
      emptyTitle="No support tickets yet"
      emptyBody="The ticket inbox is being built. Client questions will show up here, newest first."
    />
  )
}
