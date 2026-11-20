import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'

/** Page title block shared by the admin screens. */
export function PageHeader({ title, description }: { title: string; description: string }) {
  return (
    <div className="flex flex-col gap-1">
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      <p className="text-sm text-muted-foreground">{description}</p>
    </div>
  )
}

/** A titled screen whose content has not been built yet: an intentional, honest empty state. */
export function PlaceholderPage({
  title,
  description,
  icon: Icon,
  emptyTitle,
  emptyBody,
  children,
}: {
  title: string
  description: string
  icon: LucideIcon
  emptyTitle: string
  emptyBody: string
  children?: ReactNode
}) {
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={title} description={description} />
      <section
        aria-labelledby="empty-state-title"
        className="flex flex-col items-center gap-3 rounded-xl bg-card px-6 py-16 text-center"
      >
        <span className="flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary">
          <Icon className="size-6" aria-hidden />
        </span>
        <h2 id="empty-state-title" className="text-base font-semibold">
          {emptyTitle}
        </h2>
        <p className="max-w-md text-sm text-balance text-muted-foreground">{emptyBody}</p>
        {children}
      </section>
    </div>
  )
}
