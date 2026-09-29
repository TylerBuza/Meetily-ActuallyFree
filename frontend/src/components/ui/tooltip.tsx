"use client"

import * as React from "react"
import * as TooltipPrimitive from "@radix-ui/react-tooltip"

import { cn } from "@/lib/utils"

const TooltipProvider = ({ delayDuration = 300, skipDelayDuration = 200, ...props }: React.ComponentProps<typeof TooltipPrimitive.Provider>) => (
  <TooltipPrimitive.Provider delayDuration={delayDuration} skipDelayDuration={skipDelayDuration} {...props} />
)

const Tooltip = TooltipPrimitive.Root

const TooltipTrigger = TooltipPrimitive.Trigger

/** The app's single tooltip style (also used by AppTooltipGuard for `title`). */
export const tooltipSurface =
  "z-[80] max-w-xs rounded-md border border-af-border-strong bg-af-elevated px-2.5 py-1.5 text-xs font-medium leading-snug text-af-text shadow-lg"

/** How every tooltip opens and closes. */
export const tooltipMotion = cn(
  "origin-[--radix-tooltip-content-transform-origin] animate-in fade-in-0 zoom-in-95 duration-150",
  "data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95",
  "data-[side=bottom]:slide-in-from-top-1 data-[side=left]:slide-in-from-right-1 data-[side=right]:slide-in-from-left-1 data-[side=top]:slide-in-from-bottom-1"
)

const TooltipContent = React.forwardRef<
  React.ElementRef<typeof TooltipPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>
>(({ className, sideOffset = 6, ...props }, ref) => (
  <TooltipPrimitive.Portal>
    <TooltipPrimitive.Content
      ref={ref}
      sideOffset={sideOffset}
      className={cn(tooltipSurface, tooltipMotion, className)}
      {...props}
    />
  </TooltipPrimitive.Portal>
))
TooltipContent.displayName = TooltipPrimitive.Content.displayName

/** Wraps any element in a tooltip. Pass `label={null}` to render the child bare. */
function Hint({
  label,
  side = "top",
  children,
  shortcut,
}: {
  label: React.ReactNode
  side?: "top" | "bottom" | "left" | "right"
  shortcut?: string
  children: React.ReactElement
}) {
  if (label == null || label === "") return children
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side={side}>
        <span className="flex items-center gap-2">
          {label}
          {shortcut && (
            <kbd className="rounded border border-af-border-strong bg-af-panel-2 px-1 py-px text-[10px] font-medium text-af-text-3">
              {shortcut}
            </kbd>
          )}
        </span>
      </TooltipContent>
    </Tooltip>
  )
}

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider, Hint }
