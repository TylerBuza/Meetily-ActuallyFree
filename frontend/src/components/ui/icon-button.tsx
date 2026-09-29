"use client"

import * as React from "react"
import { X } from "lucide-react"

import { cn } from "@/lib/utils"
import { Button, type ButtonProps } from "@/components/ui/button"
import { Hint } from "@/components/ui/tooltip"

type IconSize = "icon-xs" | "icon-sm" | "icon" | "icon-lg"

export interface IconButtonProps extends Omit<ButtonProps, "size" | "children"> {
  /** Accessible name, also shown as the tooltip unless `tooltip` is false. */
  label: string
  icon: React.ReactNode
  size?: IconSize
  tooltip?: boolean
  tooltipSide?: "top" | "bottom" | "left" | "right"
  shortcut?: string
}

/** Icon-only button. Always named, and explains itself on hover and focus. */
const IconButton = React.forwardRef<HTMLButtonElement, IconButtonProps>(
  ({ label, icon, size = "icon-sm", variant = "ghost", tooltip = true, tooltipSide = "top", shortcut, className, ...props }, ref) => {
    const button = (
      <Button ref={ref} variant={variant} size={size} aria-label={label} className={className} {...props}>
        {icon}
      </Button>
    )
    return tooltip ? (
      <Hint label={label} side={tooltipSide} shortcut={shortcut}>
        {button}
      </Hint>
    ) : (
      button
    )
  }
)
IconButton.displayName = "IconButton"

/** The one close (X) control used by dialogs, panels, and popovers. */
const CloseButton = React.forwardRef<
  HTMLButtonElement,
  Omit<IconButtonProps, "icon" | "label"> & { label?: string }
>(({ label = "Close", size = "icon-sm", className, tooltip = false, ...props }, ref) => (
  <IconButton
    ref={ref}
    label={label}
    size={size}
    tooltip={tooltip}
    icon={<X className={size === "icon-xs" ? "size-3.5" : "size-4"} />}
    className={cn("text-af-text-3 hover:text-af-text", className)}
    {...props}
  />
))
CloseButton.displayName = "CloseButton"

export { IconButton, CloseButton }
