import * as React from "react"
import { cn } from "cn"

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "h-9 px-3.5 py-1 w-full min-w-0 rounded-xl border border-input bg-background text-base text-foreground transition-[color,background-color,border-color,box-shadow] duration-150 ease-out outline-none motion-reduce:transition-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/20 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-40 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm dark:border-transparent dark:bg-muted dark:focus-visible:border-ring dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 file:mr-3 file:inline-flex file:h-6 file:items-center file:rounded-full file:border-0 file:bg-muted file:px-2.5 file:text-xs file:font-medium file:text-foreground dark:file:bg-background",
        className
      )}
      {...props}
    />
  )
}

export { Input }
