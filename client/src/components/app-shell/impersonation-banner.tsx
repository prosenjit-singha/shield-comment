import { CircleAlert, LogOut, RotateCw, UserRoundCog, WifiOff } from 'lucide-react'
import { useId } from 'react'
import { Button } from '@/components/ui/button'
import { useLanguage } from '@/hooks/use-language'
import { authErrorMessage, type AuthError } from '@/lib/auth-errors'

/**
 * Persistent "Admin Impersonation Mode" bar on every `_app` page while a super admin is signed in as
 * the workspace owner (decision D11, client.md §5). "Exit" signs the impersonated session out; a failed
 * sign-out shows the reason and turns the button into "Try again".
 */
export function ImpersonationBanner({
  ownerEmail,
  onExit,
  pending,
  error,
}: {
  ownerEmail: string
  onExit: () => void
  pending: boolean
  error: AuthError | null
}) {
  const { content } = useLanguage()
  const titleId = useId()
  const ErrorIcon = error?.kind === 'network' ? WifiOff : CircleAlert

  return (
    <div
      role="status"
      aria-labelledby={titleId}
      data-testid="impersonation-banner"
      className="sticky top-0 z-40 border-b border-secondary/30 bg-secondary text-secondary-foreground"
    >
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-3 px-4 py-2.5 sm:flex-row sm:items-center sm:px-6">
        <div className="flex min-w-0 flex-1 items-start gap-2.5">
          <UserRoundCog className="mt-0.5 size-5 shrink-0" aria-hidden />
          <p className="min-w-0 text-sm text-pretty">
            <strong id={titleId} className="font-semibold">
              {content('Admin Impersonation Mode', 'অ্যাডমিন ইমপারসোনেশন মোড')}
            </strong>{' '}
            <span className="break-words">
              {content(
                `You are viewing this workspace as its owner (${ownerEmail}) via Admin Impersonation. Changes you make here are real.`,
                `আপনি অ্যাডমিন ইমপারসোনেশনের মাধ্যমে এই ওয়ার্কস্পেসটি এর মালিক (${ownerEmail}) হিসেবে দেখছেন। এখানে করা পরিবর্তনগুলো আসল।`,
              )}
            </span>
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          className="h-8 self-start border-transparent bg-background px-3 text-foreground hover:bg-background/90 sm:self-auto"
          onClick={onExit}
          disabled={pending}
        >
          {error ? <RotateCw aria-hidden /> : <LogOut aria-hidden />}
          {pending
            ? content('Exiting…', 'বের হচ্ছে…')
            : error
              ? content('Try again', 'আবার চেষ্টা করুন')
              : content('Exit impersonation', 'ইমপারসোনেশন থেকে বের হন')}
        </Button>
      </div>
      {error && !pending ? (
        <div
          role="alert"
          data-kind={error.kind}
          className="mx-auto flex w-full max-w-6xl items-start gap-2 px-4 pb-2.5 text-sm sm:px-6"
        >
          <ErrorIcon className="mt-0.5 size-4 shrink-0" aria-hidden />
          <p>
            {content('Couldn’t end the impersonated session.', 'ইমপারসোনেশন সেশন শেষ করা যায়নি।')}{' '}
            {authErrorMessage(error, content)}
          </p>
        </div>
      ) : null}
    </div>
  )
}
