"use client"

import * as React from "react"
import { cn } from "cn"
import { Dialog as DialogPrimitive } from "radix-ui"

import { Button } from "@/components/ui/button"
import { XIcon } from "lucide-react"

/**
 * Callers gate the content on the same state that drives `open` (`{item && <DialogContent />}`),
 * which would unmount it before the exit animation can run. So while closing, Dialog keeps
 * rendering the children of its last open render until DialogContent has animated out.
 */
const ExitDoneContext = React.createContext<() => void>(() => {})

/** Sits inside the content: Radix unmounts it when the exit animation ends. */
function DialogExitDone() {
  const exitDone = React.useContext(ExitDoneContext)
  React.useEffect(() => exitDone, [exitDone])
  return null
}

function Dialog({
  open,
  children,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Root>) {
  const [held, setHeld] = React.useState<React.ReactNode>(null)
  if (open !== false && held !== children) setHeld(children)
  const exitDone = React.useCallback(() => setHeld(null), [])
  return (
    <ExitDoneContext value={exitDone}>
      <DialogPrimitive.Root data-slot="dialog" open={open} {...props}>
        {open === false && held !== null ? held : children}
      </DialogPrimitive.Root>
    </ExitDoneContext>
  )
}

function DialogTrigger({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Trigger>) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />
}

function DialogPortal({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Portal>) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />
}

function DialogClose({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Close>) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />
}

function DialogOverlay({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      data-slot="dialog-overlay"
      className={cn(
        "data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:duration-200 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:duration-200 data-[state=closed]:ease-[cubic-bezier(0.5,1,0.89,1)] ease-[cubic-bezier(0.23,1,0.32,1)] fixed inset-0 isolate z-50 bg-black/40 supports-backdrop-filter:backdrop-blur-sm",
        className
      )}
      {...props}
    />
  )
}

function DialogContent({
  className,
  children,
  showCloseButton = true,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & {
  showCloseButton?: boolean
}) {
  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Content
        data-slot="dialog-content"
        className={cn(
          "data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-80 data-[state=open]:duration-250 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-90 data-[state=closed]:duration-200 data-[state=closed]:ease-[cubic-bezier(0.5,1,0.89,1)] ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:zoom-in-100 motion-reduce:zoom-out-100 fixed top-1/2 left-1/2 z-50 grid w-full max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 gap-4 rounded-4xl bg-popover p-6 text-sm text-popover-foreground shadow-[0_12px_40px_rgb(0_0_0/0.16)] ring-1 ring-border-solid outline-none sm:max-w-md",
          className
        )}
        {...props}
      >
        <DialogExitDone />
        {children}
        {showCloseButton && (
          <DialogPrimitive.Close data-slot="dialog-close" asChild>
            <Button
              variant="ghost"
              className="absolute top-3 right-3 size-7 text-muted-foreground hover:text-foreground [&_svg:not([class*='size-'])]:size-4"
              size="icon-sm"
            >
              <XIcon
              />
              <span className="sr-only">Close</span>
            </Button>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPortal>
  )
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-header"
      className={cn("flex flex-col gap-2", className)}
      {...props}
    />
  )
}

function DialogFooter({
  className,
  showCloseButton = false,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  showCloseButton?: boolean
}) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn(
        "mt-2 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end",
        className
      )}
      {...props}
    >
      {children}
      {showCloseButton && (
        <DialogPrimitive.Close asChild>
          <Button variant="outline">Close</Button>
        </DialogPrimitive.Close>
      )}
    </div>
  )
}

function DialogTitle({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn(
        "font-heading pr-8 text-[17px] leading-snug font-semibold tracking-tight",
        className
      )}
      {...props}
    />
  )
}

function DialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn(
        "text-sm text-muted-foreground *:[a]:underline *:[a]:underline-offset-3 *:[a]:hover:text-foreground",
        className
      )}
      {...props}
    />
  )
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
}
