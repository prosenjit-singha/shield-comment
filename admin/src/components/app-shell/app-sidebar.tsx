import { Link, useRouterState } from '@tanstack/react-router'
import { ShieldCheck } from 'lucide-react'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  useSidebar,
} from '@/components/ui/sidebar'
import { activeNavItem, navItems } from './nav-items'
import { UserMenu } from './user-menu'

export function AppSidebar({ user }: { user: { name: string; email: string } }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const active = activeNavItem(pathname)
  const { isMobile, setOpenMobile } = useSidebar()

  return (
    <Sidebar variant="floating" collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild className="hover:bg-transparent">
              <Link to="/admin/dashboard" onClick={() => isMobile && setOpenMobile(false)}>
                <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground">
                  <ShieldCheck className="size-4" aria-hidden />
                </span>
                <span className="grid min-w-0 flex-1 leading-tight">
                  <span className="truncate font-semibold">ShieldComment BD</span>
                  <span className="truncate text-xs text-muted-foreground">Super admin</span>
                </span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Platform</SidebarGroupLabel>
          <SidebarGroupContent>
            <nav aria-label="Admin">
              <SidebarMenu>
                {navItems.map((item) => {
                  const isActive = item.to === active?.to
                  return (
                    <SidebarMenuItem key={item.to}>
                      <SidebarMenuButton
                        asChild
                        isActive={isActive}
                        tooltip={item.label}
                       
                      >
                        <Link
                          to={item.to}
                          aria-current={isActive ? 'page' : undefined}
                          onClick={() => isMobile && setOpenMobile(false)}
                        >
                          <item.icon aria-hidden />
                          <span>{item.label}</span>
                        </Link>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  )
                })}
              </SidebarMenu>
            </nav>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter>
        <UserMenu user={user} />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  )
}
