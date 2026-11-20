import { ImageOff, ImagePlus, X } from 'lucide-react'
import { useRef } from 'react'
import { Button } from '@/components/ui/button'
import { useLanguage } from '@/hooks/use-language'
import type { usePickedImages } from '@/components/support/use-picked-images'
import { ATTACHMENT_TYPES, ATTACHMENTS_MAX, type TicketAttachment } from '@/lib/support-tickets'
import { cn } from '@/lib/utils'

const tile = 'size-24 overflow-hidden rounded-2xl border bg-muted'

/** A sent image: fixed-size tile (no layout shift), opens full size in a new tab. */
export function AttachmentThumb({ attachment, index }: { attachment: TicketAttachment; index: number }) {
  const { content } = useLanguage()
  if (!attachment.url) {
    return (
      <div className={cn(tile, 'flex flex-col items-center justify-center gap-1 p-2 text-center text-xs text-muted-foreground')}>
        <ImageOff className="size-4" aria-hidden />
        {content('Image unavailable', 'ছবি পাওয়া যাচ্ছে না')}
      </div>
    )
  }
  return (
    <a
      href={attachment.url}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(tile, 'block outline-none focus-visible:ring-2 focus-visible:ring-ring/50')}
    >
      <img
        src={attachment.url}
        alt={content(`Screenshot ${index + 1} (opens full size)`, `স্ক্রিনশট ${index + 1} (পূর্ণ আকারে খোলে)`)}
        width={96}
        height={96}
        loading="lazy"
        className="size-full object-cover"
      />
    </a>
  )
}

/** "Add screenshot" button + previews (D4 b: up to 3 PNG/JPEG/WebP, 5 MB each, checked before upload). */
export function AttachmentPicker({ picked, disabled }: { picked: ReturnType<typeof usePickedImages>; disabled?: boolean }) {
  const { content } = useLanguage()
  const input = useRef<HTMLInputElement>(null)
  return (
    <div className="flex flex-col gap-2">
      {picked.images.length > 0 ? (
        <ul className="flex flex-wrap gap-2" aria-label={content('Screenshots to send', 'যে স্ক্রিনশট পাঠানো হবে')}>
          {picked.images.map((image, index) => (
            <li key={image.url} className="relative">
              <img src={image.url} alt={image.file.name} width={96} height={96} className={cn(tile, 'object-cover')} />
              <button
                type="button"
                onClick={() => picked.remove(image.url)}
                aria-label={content(`Remove screenshot ${index + 1} (${image.file.name})`, `স্ক্রিনশট ${index + 1} সরান (${image.file.name})`)}
                className="absolute -top-1.5 -right-1.5 flex size-6 items-center justify-center rounded-full border bg-background text-foreground shadow-sm"
              >
                <X className="size-3.5" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <input
          ref={input}
          type="file"
          multiple
          accept={ATTACHMENT_TYPES.join(',')}
          className="hidden"
          data-testid="ticket-files"
          onChange={(event) => {
            picked.add(Array.from(event.target.files ?? []))
            // Picking the same file again after removing it must fire `change` again.
            event.target.value = ''
          }}
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled || picked.images.length >= ATTACHMENTS_MAX}
          onClick={() => input.current?.click()}
        >
          <ImagePlus aria-hidden />
          {content('Add screenshot', 'স্ক্রিনশট যোগ করুন')}
        </Button>
        <span className="text-xs text-muted-foreground">
          {content('Up to 3 images · PNG, JPEG or WebP · 5 MB each', 'সর্বোচ্চ ৩টি ছবি · PNG, JPEG বা WebP · প্রতিটি ৫ MB')}
        </span>
      </div>
      {picked.error ? (
        <p role="alert" data-kind="attachment-error" className="text-xs text-destructive">
          {picked.error}
        </p>
      ) : null}
    </div>
  )
}
