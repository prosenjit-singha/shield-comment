import { createFileRoute } from '@tanstack/react-router'
import { ServerCog } from 'lucide-react'
import { PlaceholderPage } from '@/components/placeholder-page'

export const Route = createFileRoute('/_authed/admin/system')({
  component: SystemPage,
})

function SystemPage() {
  return (
    <PlaceholderPage
      title="System"
      description="Health of the database, Redis, queues and external services."
      icon={ServerCog}
      emptyTitle="System panels are not ready yet"
      emptyBody="Database latency, Redis, queue and integration status will be shown here."
    />
  )
}
