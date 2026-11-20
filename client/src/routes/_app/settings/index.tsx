import { createFileRoute, redirect } from '@tanstack/react-router'

/** `/settings` → `/settings/team` (M7-T11). */
export const Route = createFileRoute('/_app/settings/')({
  beforeLoad: () => {
    throw redirect({ to: '/settings/team', replace: true })
  },
})
