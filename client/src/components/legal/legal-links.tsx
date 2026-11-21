import { Link } from '@tanstack/react-router'
import { useLanguage } from '@/hooks/use-language'
import { LEGAL_DOCS } from '@/lib/legal'
import { PUBLIC_PAGES, type LegalPage } from '@/lib/seo'
import { cn } from '@/lib/utils'

const LEGAL_ORDER: readonly LegalPage[] = ['privacy', 'terms', 'refund']

/** Privacy / Terms / Refund Policy links in the current language (landing footer, `/login`, legal pages). */
export function LegalLinks({ current, className }: { current?: LegalPage; className?: string }) {
  const { language, content } = useLanguage()
  return (
    <nav aria-label={content('Legal', 'আইনি তথ্য')} className={cn('flex flex-wrap items-center gap-x-5 gap-y-2', className)}>
      {LEGAL_ORDER.map((page) => (
        <Link
          key={page}
          to={PUBLIC_PAGES[page][language]}
          aria-current={page === current ? 'page' : undefined}
          className="hover:text-foreground aria-[current=page]:font-medium aria-[current=page]:text-foreground"
        >
          {content(LEGAL_DOCS[page].title.en, LEGAL_DOCS[page].title.bn)}
        </Link>
      ))}
    </nav>
  )
}

/** "By creating an account you agree to our Terms of Service and Privacy Policy." (`/register`). */
export function AgreeToTerms() {
  const { language, content } = useLanguage()
  const link = (page: LegalPage) => (
    <Link to={PUBLIC_PAGES[page][language]} className="font-medium text-primary underline-offset-4 hover:underline">
      {content(LEGAL_DOCS[page].title.en, LEGAL_DOCS[page].title.bn)}
    </Link>
  )
  return (
    <p className="px-4 text-center text-xs text-pretty text-muted-foreground">
      {content('By creating an account you agree to our ', 'অ্যাকাউন্ট খুলে আপনি আমাদের ')}
      {link('terms')}
      {content(' and ', ' ও ')}
      {link('privacy')}
      {content('.', ' মেনে নিচ্ছেন।')}
    </p>
  )
}
