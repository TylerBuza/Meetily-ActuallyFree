import * as React from "react"

import { cn } from "@/lib/utils"
import { fieldClass } from "@/components/ui/input"

const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.ComponentProps<"textarea">
>(({ className, ...props }, ref) => {
  return (
    <textarea
      className={cn(fieldClass, "h-auto min-h-[76px] py-2 leading-relaxed", className)}
      ref={ref}
      {...props}
    />
  )
})
Textarea.displayName = "Textarea"

export { Textarea }
