import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"
import { groupColorVar, type GroupColor } from "@/lib/group-colors"

const badgeVariants = cva(
  "inline-flex max-w-full items-center gap-1.5 whitespace-nowrap rounded-full border font-medium leading-none [&_svg]:size-3 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        neutral: "border-af-border bg-af-panel-2 text-af-text-2",
        outline: "border-af-border-strong bg-transparent text-af-text-3",
        accent: "border-af-accent/30 bg-af-accent/[0.12] text-af-accent",
        success: "border-af-success/30 bg-af-success/[0.12] text-af-success",
        warning: "border-af-warning/30 bg-af-warning/[0.12] text-af-warning",
        danger: "border-af-danger/30 bg-af-danger/[0.12] text-af-danger",
        tint: "af-tint",
      },
      size: {
        xs: "h-5 px-1.5 text-[10px]",
        sm: "h-6 px-2 text-[11px]",
        md: "h-7 px-2.5 text-xs",
      },
    },
    defaultVariants: { variant: "neutral", size: "sm" },
  }
)

export interface BadgeProps
  extends Omit<React.HTMLAttributes<HTMLSpanElement>, "color">,
    VariantProps<typeof badgeVariants> {
  /** A group color key; switches the badge to its tinted style. */
  color?: GroupColor | string | null
  dot?: boolean
}

function Badge({ className, variant, size, color, dot, style, children, ...props }: BadgeProps) {
  const tinted = !!color
  return (
    <span
      className={cn(badgeVariants({ variant: tinted ? "tint" : variant, size }), className)}
      style={tinted ? ({ ...style, "--chip": groupColorVar(color) } as React.CSSProperties) : style}
      {...props}
    >
      {dot && <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", tinted ? "af-tint-dot" : "bg-current")} />}
      {children}
    </span>
  )
}

export { Badge, badgeVariants }
