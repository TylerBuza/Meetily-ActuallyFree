import * as React from "react"

import { cn } from "@/lib/utils"

/** Field surface shared by inputs, selects, textareas and combobox triggers. */
export const fieldClass = cn(
  "h-9 w-full rounded-lg border border-af-border-strong bg-af-panel-2 px-3 text-sm text-af-text shadow-sm",
  "placeholder:text-af-text-4 transition-[border-color,box-shadow,background-color] duration-150",
  "hover:border-af-text-4/70 focus-visible:outline-none focus-visible:border-af-accent focus-visible:ring-[3px] focus-visible:ring-af-accent/15",
  "disabled:cursor-not-allowed disabled:opacity-50 aria-[invalid=true]:border-af-danger aria-[invalid=true]:ring-af-danger/15"
)

const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<"input">>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        className={cn(
          fieldClass,
          "file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-af-text",
          className
        )}
        ref={ref}
        {...props}
      />
    )
  }
)
Input.displayName = "Input"

export { Input }
