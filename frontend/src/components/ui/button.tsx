import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"
import { Spinner } from "@/components/ui/spinner"

/**
 * The one button for the app. Variants map to intent, not color, so every
 * theme paints them from its own tokens. Hover lifts the fill, press settles
 * it (scale), disabled fades, and keyboard focus shows the accent ring.
 */
const buttonVariants = cva(
  [
    "relative inline-flex select-none items-center justify-center gap-2 whitespace-nowrap rounded-lg font-medium",
    "transition-[background-color,border-color,color,box-shadow,transform,opacity] duration-150 ease-af",
    "active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-af-accent/60",
    "focus-visible:ring-offset-2 focus-visible:ring-offset-af-panel",
    "disabled:pointer-events-none disabled:opacity-45",
    "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  ].join(" "),
  {
    variants: {
      variant: {
        primary: "bg-af-accent text-af-on-accent shadow-sm hover:bg-af-accent-hover",
        secondary:
          "border border-af-border bg-af-panel-2 text-af-text shadow-sm hover:border-af-border-strong hover:bg-af-hover",
        outline:
          "border border-af-border-strong bg-transparent text-af-text-2 hover:bg-af-hover hover:text-af-text",
        ghost: "text-af-text-2 hover:bg-af-hover hover:text-af-text data-[state=open]:bg-af-hover data-[state=open]:text-af-text",
        subtle: "bg-af-text/[0.06] text-af-text-2 hover:bg-af-text/[0.11] hover:text-af-text",
        soft: "bg-af-accent/[0.14] text-af-accent hover:bg-af-accent/[0.22]",
        danger: "bg-af-danger text-af-on-danger shadow-sm hover:bg-af-danger/90",
        "danger-ghost": "text-af-danger hover:bg-af-danger/10",
        record: "bg-af-record text-white shadow-sm hover:bg-af-record/90",
        link: "h-auto rounded-md px-0 text-af-accent underline-offset-4 hover:underline active:scale-100",
        // Legacy names kept so older screens keep compiling while they migrate.
        default: "bg-af-accent text-af-on-accent shadow-sm hover:bg-af-accent-hover",
        destructive: "bg-af-danger text-af-on-danger shadow-sm hover:bg-af-danger/90",
        green: "bg-af-success text-white shadow-sm hover:bg-af-success/90",
        blue: "bg-af-accent text-af-on-accent shadow-sm hover:bg-af-accent-hover",
        red: "bg-af-record text-white shadow-sm hover:bg-af-record/90",
        gray: "border border-af-border bg-af-panel-2 text-af-text shadow-sm hover:bg-af-hover",
      },
      size: {
        xs: "h-7 rounded-md px-2 text-xs",
        sm: "h-8 px-3 text-[13px]",
        default: "h-9 px-3.5 text-sm",
        lg: "h-10 px-5 text-sm",
        icon: "h-9 w-9",
        "icon-sm": "h-8 w-8",
        "icon-xs": "h-7 w-7 rounded-md",
        "icon-lg": "h-10 w-10",
      },
    },
    defaultVariants: {
      variant: "primary",
      size: "default",
    },
  }
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean
  /** Shows a spinner in place of the leading icon and blocks clicks. */
  loading?: boolean
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, loading = false, disabled, children, ...props }, ref) => {
    const Comp = asChild ? Slot : "button"
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        disabled={asChild ? undefined : disabled || loading}
        aria-busy={loading || undefined}
        {...props}
      >
        {asChild ? (
          children
        ) : (
          <>
            {loading && <Spinner size={15} />}
            {children}
          </>
        )}
      </Comp>
    )
  }
)
Button.displayName = "Button"

export { Button, buttonVariants }
