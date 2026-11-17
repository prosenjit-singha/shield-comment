import { LoaderCircle } from 'lucide-react'

/** Route `pendingComponent` while a guard checks the session (shown after the router's pending delay). */
export function FullPageLoader({ label = 'Checking your session…' }: { label?: string }) {
  return (
    <main
      className="flex min-h-svh items-center justify-center bg-muted p-6"
      aria-busy="true"
      aria-live="polite"
    >
      <span className="flex items-center gap-2 text-sm text-muted-foreground">
        <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" aria-hidden />
        {label}
      </span>
    </main>
  )
}
