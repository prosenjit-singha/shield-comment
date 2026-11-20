import * as React from "react"
import { cn } from "cn"
import { Switch as SwitchPrimitive } from "@animate-ui/react/primitives/radix-ui"

function Switch({
  className,
  size = "default",
  ...props
}: React.ComponentProps<typeof SwitchPrimitive.Root> & {
  size?: "sm" | "default"
}) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      data-size={size}
      className={cn(
        "peer group/switch relative inline-flex shrink-0 items-center rounded-full p-0.5 outline-none transition-colors duration-200 ease-out motion-reduce:transition-none after:absolute after:-inset-x-3 after:-inset-y-2 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background group-has-[:focus-visible]/field-label:ring-0 aria-invalid:ring-3 aria-invalid:ring-destructive/20 data-[size=default]:h-6 data-[size=default]:w-10 data-[size=sm]:h-5 data-[size=sm]:w-8 data-checked:bg-primary data-unchecked:bg-input dark:data-unchecked:bg-foreground/20 data-disabled:pointer-events-none data-disabled:opacity-40",
        className
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        transition={{ type: "spring", duration: 0.2, bounce: 0 }}
        className="pointer-events-none block rounded-full bg-white shadow-[0_1px_3px_rgb(0_0_0/0.2)] group-data-[size=default]/switch:size-5 group-data-[size=sm]/switch:size-4 group-data-[size=default]/switch:data-checked:translate-x-4 group-data-[size=sm]/switch:data-checked:translate-x-3 data-unchecked:translate-x-0"
      />
    </SwitchPrimitive.Root>
  )
}

export { Switch }
