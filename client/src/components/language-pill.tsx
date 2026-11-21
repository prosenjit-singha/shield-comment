import { Link } from '@tanstack/react-router'
import { useLanguage } from '@/hooks/use-language'
import type { Language } from '@/lib/language'
import { PUBLIC_PAGES, type PublicPage } from '@/lib/seo'
import { cn } from '@/lib/utils'

/** `EN | বাং` pill: plain links to the page's fixed language URLs; the click also saves the cookie for the app. */
export function LanguagePill({ page = 'landing' }: { page?: PublicPage }) {
  const { language, setLanguage, content } = useLanguage()
  const item = (lang: Language, label: string) => (
    <Link
      to={PUBLIC_PAGES[page][lang]}
      hrefLang={lang}
      lang={lang}
      aria-current={language === lang ? 'page' : undefined}
      onClick={() => setLanguage(lang)}
      className={cn(
        'inline-flex h-8 min-w-11 items-center justify-center rounded-full px-3 text-xs font-medium transition-colors',
        language === lang ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
      )}
    >
      {label}
    </Link>
  )
  return (
    <nav aria-label={content('Language', 'ভাষা')} className="flex items-center rounded-full bg-muted p-0.5">
      {item('en', 'EN')}
      {item('bn', 'বাং')}
    </nav>
  )
}
