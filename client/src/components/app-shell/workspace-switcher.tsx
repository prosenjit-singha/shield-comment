import { useQuery } from '@tanstack/react-query'
import { Building2, ChevronsUpDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useLanguage } from '@/hooks/use-language'
import { workspacesQueryOptions } from '@/lib/workspaces'

/**
 * Top-bar workspace switcher (M7-T11, D8 a): only for people in 2+ workspaces; nothing while the list
 * loads, fails or has one entry. The caller does the switch (set active → session → drop workspace data).
 */
export function WorkspaceSwitcher({
  activeId,
  onSwitch,
  switching,
}: {
  activeId: string | null
  onSwitch: (workspaceId: string) => void
  switching: boolean
}) {
  const { content } = useLanguage()
  const { data: workspaces } = useQuery(workspacesQueryOptions)
  if (!workspaces || workspaces.length < 2) return null

  const active = workspaces.find((w) => w.id === activeId)
  const label = active?.name ?? content('Choose a workspace', 'ওয়ার্কস্পেস বেছে নিন')

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="h-8 max-w-[11rem] min-w-0 px-3"
          disabled={switching}
          aria-label={`${content('Workspace', 'ওয়ার্কস্পেস')}: ${label}`}
        >
          <Building2 aria-hidden />
          <span className="truncate">{label}</span>
          <ChevronsUpDown className="opacity-60" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        <DropdownMenuLabel>{content('Switch workspace', 'ওয়ার্কস্পেস বদলান')}</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={activeId ?? ''}
          onValueChange={(id) => {
            if (id !== activeId) onSwitch(id)
          }}
        >
          {workspaces.map((w) => (
            <DropdownMenuRadioItem key={w.id} value={w.id}>
              <span className="truncate">{w.name}</span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
