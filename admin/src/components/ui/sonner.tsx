import { useUiStore } from "@/stores/ui-store"
import { Toaster as Sonner, type ToasterProps } from "sonner"
import { CircleCheckIcon, InfoIcon, TriangleAlertIcon, OctagonXIcon, Loader2Icon } from "lucide-react"

const Toaster = ({ ...props }: ToasterProps) => {
  // Local edit: the theme comes from the admin UI store (no next-themes).
  const theme = useUiStore((s) => s.theme)

  return (
    <Sonner
      theme={theme}
      className="toaster group"
      icons={{
        success: (
          <CircleCheckIcon className="size-4" />
        ),
        info: (
          <InfoIcon className="size-4" />
        ),
        warning: (
          <TriangleAlertIcon className="size-4" />
        ),
        error: (
          <OctagonXIcon className="size-4" />
        ),
        loading: (
          <Loader2Icon className="size-4 animate-spin" />
        ),
      }}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "transparent",
          "--border-radius": "calc(var(--spacing) * 3 + 0.875rem)", // py-3 + h-7 pill radius
        } as React.CSSProperties
      }
      // Sonner's default CSS is unlayered, so it beats Tailwind's utilities layer:
      // properties Sonner already sets need the `!` modifier.
      toastOptions={{
        classNames: {
          toast:
            "cn-toast gap-2.5! px-4! py-3! bg-popover/90! backdrop-blur-xl backdrop-saturate-150 shadow-[0_4px_24px_rgb(0_0_0/0.08)]! ring-1 ring-border",
          title: "text-sm! font-medium! leading-snug! tracking-tight",
          description: "text-[13px]! leading-snug! text-muted-foreground!",
          actionButton:
            "h-7! rounded-full! px-3! bg-primary! text-primary-foreground! text-xs! font-medium! transition-[opacity,box-shadow,transform]! duration-150! ease-out active:scale-[0.97] motion-reduce:transition-none! focus-visible:ring-2! focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-popover",
          cancelButton:
            "h-7! rounded-full! px-3! bg-muted! text-foreground! text-xs! font-medium! transition-[opacity,box-shadow,transform]! duration-150! ease-out active:scale-[0.97] motion-reduce:transition-none! focus-visible:ring-2! focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-popover",
        },
      }}
      {...props}
    />
  )
}

export { Toaster }
