import { LoaderCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useLanguage } from '@/hooks/use-language'
import type { MetaConnectMutation } from '@/hooks/use-meta-connect'
import { connectErrorMessage, impersonationConnectNotice } from '@/lib/meta-messages'
import { cn } from '@/lib/utils'
import { FacebookIcon } from './brand-icons'
import { MetaNotice } from './meta-notice'

/**
 * Connect UI shared by `/onboarding` and `/pages` (mutation: `useMetaConnect`). Impersonated sessions get
 * `ImpersonationConnectNotice` instead of the button (D5: the backend answers 403) and make no call.
 */

/** Stays in the "Opening Facebook…" state after success: the page is about to unload. */
export function MetaConnectButton({
  connect,
  label,
  variant = 'default',
  className,
}: {
  connect: MetaConnectMutation
  label: string
  variant?: 'default' | 'outline'
  className?: string
}) {
  const { content } = useLanguage()
  const opening = connect.isPending || connect.isSuccess
  return (
    <Button variant={variant} className={cn('h-11 px-6', className)} disabled={opening} onClick={() => connect.mutate()}>
      {opening ? (
        <LoaderCircle className="animate-spin motion-reduce:animate-none" aria-hidden />
      ) : (
        <FacebookIcon className="size-4" />
      )}
      {opening ? content('Opening Facebook…', 'ফেসবুক খোলা হচ্ছে…') : label}
    </Button>
  )
}

export function MetaConnectError({ connect }: { connect: MetaConnectMutation }) {
  const { content } = useLanguage()
  if (!connect.error || connect.isPending) return null
  return (
    <MetaNotice tone="error" kind={`connect:${connect.error.status}`} network={connect.error.isNetwork}>
      {connectErrorMessage(connect.error, content)}
    </MetaNotice>
  )
}

export function ImpersonationConnectNotice() {
  const { content } = useLanguage()
  return (
    <MetaNotice tone="info" kind="impersonation-connect-blocked">
      {impersonationConnectNotice(content)}
    </MetaNotice>
  )
}
