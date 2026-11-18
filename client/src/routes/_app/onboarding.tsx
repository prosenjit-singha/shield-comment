import { createFileRoute, Link } from '@tanstack/react-router'
import { ArrowRight, PlugZap } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { useLanguage } from '@/hooks/use-language'

/**
 * Placeholder C3 (M3-T8): where sign-up lands (decision D13). The real connect wizard is M3-T10.
 * Skippable: "Skip for now" goes to /dashboard.
 */
export const Route = createFileRoute('/_app/onboarding')({
  head: () => ({ meta: [{ title: 'Get started | ShieldComment BD' }, { name: 'robots', content: 'noindex' }] }),
  component: OnboardingPage,
})

function OnboardingPage() {
  const { content } = useLanguage()
  return (
    <div className="flex justify-center py-6 sm:py-12">
      <Card className="w-full max-w-lg rounded-3xl">
        <CardHeader className="justify-items-center gap-2 text-center">
          <span className="mb-1 flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary">
            <PlugZap className="size-6" aria-hidden />
          </span>
          <CardTitle>
            <h1 className="text-xl font-semibold text-balance">
              {content('Connect your Facebook Page', 'আপনার ফেসবুক পেজ কানেক্ট করুন')}
            </h1>
          </CardTitle>
          <CardDescription className="text-pretty">
            {content(
              'ShieldComment hides scam and abusive comments on the Pages and Instagram accounts you connect.',
              'আপনি যে পেজ ও ইনস্টাগ্রাম অ্যাকাউন্ট কানেক্ট করবেন, সেখানে ShieldComment স্ক্যাম ও আপত্তিকর কমেন্ট হাইড করবে।',
            )}
          </CardDescription>
        </CardHeader>
        <CardContent className="text-center text-sm text-muted-foreground">
          {content(
            'The setup wizard is coming soon. You can explore your dashboard in the meantime.',
            'সেটআপ উইজার্ড শিগগিরই আসছে। ততক্ষণ আপনার ড্যাশবোর্ড ঘুরে দেখতে পারেন।',
          )}
        </CardContent>
        <CardFooter className="justify-center">
          <Button asChild variant="outline" className="h-10 px-5">
            <Link to="/dashboard">
              {content('Skip for now', 'এখন থাক')}
              <ArrowRight aria-hidden />
            </Link>
          </Button>
        </CardFooter>
      </Card>
    </div>
  )
}
