import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Check, LoaderCircle, Unplug } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useLanguage } from '@/hooks/use-language'
import type { ApiError } from '@/lib/api'
import { disconnectErrorMessage } from '@/lib/meta-messages'
import {
  disconnectMeta,
  metaDisconnectMutationKey,
  workspacePagesQueryKey,
  type MetaDisconnectResponse,
} from '@/lib/meta-pages'
import { MetaNotice } from './meta-notice'

/**
 * `/pages` "Facebook connection" card + confirm dialog (M4-T11, D7). Confirm → `DELETE …/meta/connection`
 * → the dialog closes, `onDisconnected` gets the counts and the pages list is refetched. A failure stays
 * in the dialog (it stays open, the button is usable again). The parent hides this while impersonated
 * (backend 403) and when nothing is connected.
 */
export function MetaDisconnectSection({
  workspaceId,
  onDisconnected,
}: {
  workspaceId: string
  onDisconnected: (result: MetaDisconnectResponse) => void
}) {
  const { content } = useLanguage()
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const disconnect = useMutation<MetaDisconnectResponse, ApiError, void>({
    mutationKey: metaDisconnectMutationKey(workspaceId),
    mutationFn: () => disconnectMeta(workspaceId),
    onSuccess: (result) => {
      setOpen(false)
      onDisconnected(result)
      void queryClient.invalidateQueries({ queryKey: workspacePagesQueryKey(workspaceId) })
    },
  })

  // Each opening starts without the last error; the dialog can't be closed while the DELETE runs.
  const changeOpen = (next: boolean) => {
    if (disconnect.isPending) return
    if (next) disconnect.reset()
    setOpen(next)
  }

  const pending = disconnect.isPending
  const error = pending ? null : disconnect.error

  return (
    <>
      <Card className="gap-4 rounded-3xl" data-testid="meta-connection-card">
        <CardHeader className="gap-1.5">
          <CardTitle>
            <h2 className="text-lg font-semibold">{content('Facebook connection', 'ফেসবুক কানেকশন')}</h2>
          </CardTitle>
          <CardDescription className="text-pretty">
            {content(
              'Disconnecting removes Facebook and its Pages from this workspace. Comments already collected are kept.',
              'ডিসকানেক্ট করলে এই ওয়ার্কস্পেস থেকে ফেসবুক ও এর পেজগুলো সরে যাবে। আগে সংগ্রহ করা কমেন্টগুলো থেকে যাবে।',
            )}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button variant="destructive" className="h-10 px-5" onClick={() => changeOpen(true)}>
            <Unplug aria-hidden />
            {content('Disconnect Facebook', 'ফেসবুক ডিসকানেক্ট করুন')}
          </Button>
        </CardContent>
      </Card>

      <Dialog open={open} onOpenChange={changeOpen}>
        <DialogContent showCloseButton={false} className="gap-5 rounded-2xl p-5 sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-lg font-semibold">
              {content('Disconnect Facebook?', 'ফেসবুক ডিসকানেক্ট করবেন?')}
            </DialogTitle>
            <DialogDescription className="text-pretty">
              {content(
                'ShieldComment stops protecting your Pages. You can connect Facebook again at any time.',
                'ShieldComment আপনার পেজগুলো আর সুরক্ষিত রাখবে না। যেকোনো সময় আবার ফেসবুক কানেক্ট করতে পারবেন।',
              )}
            </DialogDescription>
          </DialogHeader>
          <ul className="flex flex-col gap-2 text-sm text-foreground" data-testid="disconnect-effects">
            {[
              content(
                'Your Pages and their linked Instagram accounts are removed from this workspace.',
                'আপনার পেজ ও সেগুলোর সাথে যুক্ত ইনস্টাগ্রাম অ্যাকাউন্ট এই ওয়ার্কস্পেস থেকে সরে যাবে।',
              ),
              content(
                'Comments ShieldComment already collected are kept.',
                'ShieldComment আগে যে কমেন্টগুলো সংগ্রহ করেছে সেগুলো থেকে যাবে।',
              ),
              content(
                'ShieldComment’s permission on your Facebook account is revoked, unless another ShieldComment workspace still uses the same Facebook account.',
                'আপনার ফেসবুক অ্যাকাউন্ট থেকে ShieldComment-এর অনুমতি তুলে নেওয়া হবে, যদি না একই ফেসবুক অ্যাকাউন্ট অন্য কোনো ShieldComment ওয়ার্কস্পেসে এখনো ব্যবহার হয়।',
              ),
            ].map((text) => (
              <li key={text} className="flex items-start gap-2">
                <Check className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
                <span className="text-pretty">{text}</span>
              </li>
            ))}
          </ul>
          {error ? (
            <MetaNotice tone="error" kind={`disconnect:${error.status}`} network={error.isNetwork}>
              {disconnectErrorMessage(error, content)}
            </MetaNotice>
          ) : null}
          <DialogFooter className="-mx-5 -mb-5 rounded-b-2xl p-5">
            <Button variant="outline" className="h-10 px-5" disabled={pending} onClick={() => changeOpen(false)}>
              {content('Cancel', 'বাতিল')}
            </Button>
            <Button
              variant="destructive"
              className="h-10 px-5"
              disabled={pending}
              aria-busy={pending || undefined}
              onClick={() => disconnect.mutate()}
            >
              {pending ? <LoaderCircle className="animate-spin motion-reduce:animate-none" aria-hidden /> : <Unplug aria-hidden />}
              {pending
                ? content('Disconnecting…', 'ডিসকানেক্ট হচ্ছে…')
                : content('Yes, disconnect', 'হ্যাঁ, ডিসকানেক্ট করুন')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
