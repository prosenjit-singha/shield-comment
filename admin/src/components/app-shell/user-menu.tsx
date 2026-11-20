import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { ChevronsUpDown, LogOut, Monitor, Moon, Sun } from 'lucide-react'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem, useSidebar } from '@/components/ui/sidebar'
import { authClient } from '@/lib/auth-client'
import { type Theme, useUiStore } from '@/stores/ui-store'

const themes: { value: Theme; label: string; icon: typeof Sun }[] = [
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'system', label: 'System', icon: Monitor },
]

function initials(name: string, email: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  const letters = parts.length > 0 ? parts.slice(0, 2).map((p) => p[0]) : [email[0]]
  return letters.join('').toUpperCase()
}

/** Sidebar footer: who is signed in, theme switch and sign-out. */
export function UserMenu({ user }: { user: { name: string; email: string } }) {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const { isMobile } = useSidebar()
  const theme = useUiStore((s) => s.theme)
  const setTheme = useUiStore((s) => s.setTheme)

  const signOut = useMutation({
    mutationFn: async () => {
      const { error } = await authClient.signOut()
      if (error) throw new Error(error.message ?? 'Sign-out failed')
    },
    onSuccess: async () => {
      queryClient.clear() // drop the session and any tenant data cached under it
      await navigate({ to: '/admin/login', search: {}, replace: true })
    },
  })

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton
              size="lg"
              aria-label="Account menu"
              className="data-[state=open]:bg-sidebar-accent"
            >
              <Avatar>
                <AvatarFallback className="bg-primary/10 text-xs font-semibold text-primary">
                  {initials(user.name, user.email)}
                </AvatarFallback>
              </Avatar>
              <span className="grid min-w-0 flex-1 text-left leading-tight">
                <span className="truncate text-sm font-medium">{user.name}</span>
                <span className="truncate text-xs text-muted-foreground">{user.email}</span>
              </span>
              <ChevronsUpDown className="ml-auto" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            side={isMobile ? 'top' : 'right'}
            align="end"
            sideOffset={8}
            className="w-60"
          >
            <DropdownMenuLabel className="flex flex-col gap-0.5 py-2">
              <span className="truncate text-sm font-medium text-foreground">{user.name}</span>
              <span className="truncate text-xs font-normal">{user.email}</span>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Theme</DropdownMenuLabel>
            <DropdownMenuRadioGroup value={theme} onValueChange={(v) => setTheme(v as Theme)}>
              {themes.map(({ value, label, icon: Icon }) => (
                <DropdownMenuRadioItem key={value} value={value}>
                  <Icon />
                  {label}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              disabled={signOut.isPending}
              onSelect={() => signOut.mutate()}
            >
              <LogOut />
              {signOut.isPending ? 'Signing out…' : 'Sign out'}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}
