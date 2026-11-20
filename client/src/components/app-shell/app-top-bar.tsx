import { Link } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { Languages, LogOut, Moon, ShieldCheck, Sun } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useLanguage } from '@/hooks/use-language'
import { resolveTheme, useUiStore } from '@/stores/ui-store'

/**
 * `_app` top bar (M3-T9): logo, EN/BN switch (per-router store → `shield-lang` cookie), theme toggle,
 * the signed-in email and log-out. Navigation lives in `app-nav.tsx` (M6-T8).
 * `onSignOut` is omitted while impersonating: the banner's "Exit" is the only way out then.
 * `switcher` = the workspace switcher (M7-T11), next to the logo.
 */
export function AppTopBar({
  email,
  onSignOut,
  signingOut = false,
  switcher,
}: {
  email: string
  onSignOut?: () => void
  signingOut?: boolean
  switcher?: ReactNode
}) {
  const { language, toggleLanguage, content } = useLanguage()
  const theme = useUiStore((s) => s.theme)
  const setTheme = useUiStore((s) => s.setTheme)
  const isDark = resolveTheme(theme) === 'dark'

  return (
    <header className="border-b bg-card">
      <div className="mx-auto flex w-full max-w-6xl items-center gap-2 px-4 py-3 sm:gap-3 sm:px-6">
        <Link to="/dashboard" className="flex items-center gap-2 rounded-full font-semibold" aria-label="ShieldComment BD">
          <ShieldCheck className="size-6 text-primary" aria-hidden />
          <span className="hidden min-[400px]:inline">ShieldComment BD</span>
        </Link>
        {switcher}
        <span className="ml-auto hidden max-w-[16rem] truncate text-sm text-muted-foreground md:inline" title={email}>
          {email}
        </span>
        <Button
          variant="outline"
          size="sm"
          className="ml-auto h-8 px-3 md:ml-0"
          onClick={toggleLanguage}
          aria-label={content('Switch to Bangla', 'ইংরেজিতে দেখুন')}
        >
          <Languages aria-hidden />
          {language === 'en' ? 'বাংলা' : 'English'}
        </Button>
        <Button
          variant="outline"
          size="icon"
          aria-label={isDark ? content('Switch to light theme', 'লাইট থিম') : content('Switch to dark theme', 'ডার্ক থিম')}
          onClick={() => setTheme(isDark ? 'light' : 'dark')}
        >
          {isDark ? <Sun aria-hidden /> : <Moon aria-hidden />}
        </Button>
        {onSignOut ? (
          <Button
            variant="outline"
            size="sm"
            className="h-8 px-3"
            onClick={onSignOut}
            disabled={signingOut}
            aria-label={content('Log out', 'লগ আউট')}
          >
            <LogOut aria-hidden />
            <span className="hidden sm:inline">{content('Log out', 'লগ আউট')}</span>
          </Button>
        ) : null}
      </div>
    </header>
  )
}
