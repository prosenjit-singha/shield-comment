import { CircleCheck, Languages } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { useLanguage } from '@/hooks/use-language'

/**
 * Shown after "Exit impersonation" signed the impersonated session out (D11). No redirect to /login:
 * the tab was opened from the admin panel, whose own session (another origin) is untouched.
 */
export function ImpersonationEnded() {
  const { language, toggleLanguage, content } = useLanguage()
  return (
    <main className="flex min-h-svh flex-col items-center justify-center bg-muted p-4 sm:p-6">
      <Card className="relative w-full max-w-md gap-4 rounded-3xl border bg-card py-8 shadow-sm ring-0">
        <Button
          variant="ghost"
          size="sm"
          className="absolute top-4 right-4 h-9 px-3"
          onClick={toggleLanguage}
          aria-label={content('Switch to Bangla', 'ইংরেজিতে দেখুন')}
        >
          <Languages aria-hidden />
          {language === 'en' ? 'বাংলা' : 'English'}
        </Button>
        <CardHeader className="justify-items-center gap-2 px-6 text-center sm:px-8">
          <span className="mb-1 flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary">
            <CircleCheck className="size-6" aria-hidden />
          </span>
          <CardTitle>
            <h1 className="text-xl font-semibold text-balance">
              {content('You can close this tab', 'এখন এই ট্যাবটি বন্ধ করতে পারেন')}
            </h1>
          </CardTitle>
          <CardDescription className="text-pretty">
            {content(
              'The impersonated session has ended. Go back to the admin panel to continue.',
              'ইমপারসোনেশন সেশন শেষ হয়েছে। কাজ চালিয়ে যেতে অ্যাডমিন প্যানেলে ফিরে যান।',
            )}
          </CardDescription>
        </CardHeader>
      </Card>
    </main>
  )
}
