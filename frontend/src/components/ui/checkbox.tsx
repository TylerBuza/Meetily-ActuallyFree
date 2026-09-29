"use client"

import * as React from "react"
import { Checkbox as CheckboxPrimitive } from "radix-ui"
import { Check, Minus } from "lucide-react"

import { cn } from "@/lib/utils"

/** Square checkbox. `round` renders the circular variant used for to-dos. */
const Checkbox = React.forwardRef<
  React.ElementRef<typeof CheckboxPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof CheckboxPrimitive.Root> & { round?: boolean }
>(({ className, round = false, ...props }, ref) => (
  <CheckboxPrimitive.Root
    ref={ref}
    className={cn(
      "peer grid h-4 w-4 shrink-0 place-items-center border border-af-border-strong bg-af-panel-2 text-af-on-accent",
      round ? "rounded-full" : "rounded-[5px]",
      "transition-[background-color,border-color,box-shadow,transform] duration-150 ease-af active:scale-90",
      "hover:border-af-text-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-af-accent/60 focus-visible:ring-offset-2 focus-visible:ring-offset-af-panel",
      "disabled:cursor-not-allowed disabled:opacity-45",
      "data-[state=checked]:border-af-accent data-[state=checked]:bg-af-accent data-[state=indeterminate]:border-af-accent data-[state=indeterminate]:bg-af-accent",
      className
    )}
    {...props}
  >
    <CheckboxPrimitive.Indicator className="grid place-items-center animate-af-pop">
      {props.checked === "indeterminate" ? (
        <Minus className="h-3 w-3" strokeWidth={3} />
      ) : (
        <Check className="h-3 w-3" strokeWidth={3} />
      )}
    </CheckboxPrimitive.Indicator>
  </CheckboxPrimitive.Root>
))
Checkbox.displayName = "Checkbox"

export { Checkbox }
