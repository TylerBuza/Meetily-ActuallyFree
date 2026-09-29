import * as React from "react"

import { cn } from "@/lib/utils"
import { colorForName, groupColorVar } from "@/lib/group-colors"

const SIZES = {
  xs: "h-5 w-5 text-[9px]",
  sm: "h-6 w-6 text-[10px]",
  md: "h-8 w-8 text-xs",
  lg: "h-10 w-10 text-sm",
  xl: "h-14 w-14 text-lg",
  "2xl": "h-20 w-20 text-2xl",
} as const

export function initials(name: string): string {
  const parts = name.replace(/\(.*?\)/g, "").trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return "?"
  if (parts.length === 1) return parts[0][0].toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

export interface AvatarProps extends Omit<React.HTMLAttributes<HTMLSpanElement>, "color"> {
  name: string
  size?: keyof typeof SIZES
  /** Group color key; defaults to a stable color derived from the name. */
  color?: string | null
  /** Draws a ring in the panel color so stacked avatars separate cleanly. */
  ring?: boolean
}

/** One avatar style everywhere: tinted initials, colored consistently per person. */
function Avatar({ name, size = "md", color, ring = false, className, style, ...props }: AvatarProps) {
  return (
    <span
      role="img"
      aria-label={name}
      className={cn(
        "af-tint inline-flex shrink-0 select-none items-center justify-center rounded-full border font-semibold tracking-tight",
        ring && "ring-2 ring-af-panel",
        SIZES[size],
        className
      )}
      style={{ ...style, "--chip": groupColorVar(color ?? colorForName(name)) } as React.CSSProperties}
      {...props}
    >
      {initials(name)}
    </span>
  )
}

/** Overlapping row of avatars with a "+N" overflow chip. */
function AvatarStack({
  names,
  max = 4,
  size = "sm",
  className,
}: {
  names: string[]
  max?: number
  size?: keyof typeof SIZES
  className?: string
}) {
  const shown = names.slice(0, max)
  const extra = names.length - shown.length
  return (
    <span className={cn("flex items-center -space-x-1.5", className)}>
      {shown.map((name) => (
        <Avatar key={name} name={name} size={size} ring />
      ))}
      {extra > 0 && (
        <span
          className={cn(
            "inline-flex shrink-0 items-center justify-center rounded-full border border-af-border bg-af-panel-2 font-semibold text-af-text-3 ring-2 ring-af-panel",
            SIZES[size]
          )}
        >
          +{extra}
        </span>
      )}
    </span>
  )
}

export { Avatar, AvatarStack }
