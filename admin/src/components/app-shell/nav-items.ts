import type { LucideIcon } from 'lucide-react'
import {
  Building2,
  CreditCard,
  LayoutDashboard,
  LifeBuoy,
  ServerCog,
  Settings,
  TicketPercent,
} from 'lucide-react'

export interface NavItem {
  label: string
  to:
    | '/admin/dashboard'
    | '/admin/clients'
    | '/admin/billing'
    | '/admin/promotions'
    | '/admin/tickets'
    | '/admin/system'
    | '/admin/settings'
  icon: LucideIcon
}

/** Sidebar navigation for screens A2–A7 + Promotions (PR-T5b) (`docs/design/admin.md`). */
export const navItems: readonly NavItem[] = [
  { label: 'Dashboard', to: '/admin/dashboard', icon: LayoutDashboard },
  { label: 'Clients', to: '/admin/clients', icon: Building2 },
  { label: 'Billing', to: '/admin/billing', icon: CreditCard },
  { label: 'Promotions', to: '/admin/promotions', icon: TicketPercent },
  { label: 'Tickets', to: '/admin/tickets', icon: LifeBuoy },
  { label: 'System', to: '/admin/system', icon: ServerCog },
  { label: 'Settings', to: '/admin/settings', icon: Settings },
]

/** The nav item that owns `pathname` (exact match or a nested path below it). */
export function activeNavItem(pathname: string): NavItem | undefined {
  return navItems.find((item) => pathname === item.to || pathname.startsWith(`${item.to}/`))
}
