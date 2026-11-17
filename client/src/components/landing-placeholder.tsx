import { Link } from '@tanstack/react-router'
import { ShieldCheck } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { useLanguage } from '@/hooks/use-language'

/**
 * Server-rendered placeholder for `/` and `/bn` (SW-T7). The 9-section landing page replaces it later
 * (docs/design/client.md §3). Language comes from the URL, set in __root.tsx beforeLoad.
 */
export function LandingPlaceholder() {
  const { language, setLanguage, content } = useLanguage()
  const other = language === 'en' ? 'bn' : 'en'

  return (
    <div className="flex min-h-svh flex-col">
      <header className="mx-auto flex w-full max-w-6xl items-center gap-3 px-4 py-4 sm:px-6">
        <ShieldCheck className="size-7 text-primary" aria-hidden />
        <span className="font-semibold">ShieldComment BD</span>
        <nav className="ml-auto flex items-center gap-2">
          <Button variant="outline" size="sm" asChild>
            {/* Also saves the cookie, so the app pages after login use the same language. */}
            <Link to={other === 'bn' ? '/bn' : '/'} hrefLang={other} onClick={() => setLanguage(other)}>
              {language === 'en' ? 'বাংলা' : 'English'}
            </Link>
          </Button>
          <Button variant="ghost" size="sm" asChild>
            <Link to="/login">{content('Log in', 'লগ ইন')}</Link>
          </Button>
        </nav>
      </header>

      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col items-center justify-center gap-6 px-4 py-16 text-center sm:px-6">
        <Badge variant="secondary">{content('Coming soon', 'শীঘ্রই আসছে')}</Badge>
        <h1 className="text-balance text-4xl font-bold tracking-tight sm:text-5xl">
          {content(
            'Stop Losing Facebook & TikTok Ad Sales to Scam Comments',
            'ফেসবুক ও টিকটক অ্যাডের স্ক্যাম কমেন্টে সেল হারানো বন্ধ করুন',
          )}
        </h1>
        <p className="max-w-xl text-pretty text-lg text-muted-foreground">
          {content(
            'AI that hides bKash/Nagad scams, competitor poaching and abuse on your ads. It understands Bangla, Banglish and English.',
            'এআই আপনার অ্যাডের বিকাশ/নগদ স্ক্যাম, প্রতিযোগীর কমেন্ট আর গালিগালাজ লুকিয়ে দেয়। বাংলা, বাংলিশ ও ইংরেজি বোঝে।',
          )}
        </p>
        <Button size="lg" asChild>
          <Link to="/login">{content('Start Free', 'ফ্রি শুরু করুন')}</Link>
        </Button>
      </main>
    </div>
  )
}
