import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * Layout pieces every page shares: a page header, section cards, empty
 * states, skeletons and keyboard hints. Pages compose these instead of
 * inventing their own shells, so the app reads as one product.
 */

export function PageHeader({
  title,
  description,
  actions,
  eyebrow,
  className,
}: {
  title: React.ReactNode
  description?: React.ReactNode
  actions?: React.ReactNode
  /** Small line above the title, e.g. a back link or breadcrumb. */
  eyebrow?: React.ReactNode
  className?: string
}) {
  return (
    <header className={cn("flex flex-wrap items-end justify-between gap-x-6 gap-y-3", className)}>
      <div className="min-w-0 flex-1">
        {eyebrow && <div className="mb-2 text-xs text-af-text-3">{eyebrow}</div>}
        <h1 className="truncate text-xl font-semibold tracking-tight text-af-text">{title}</h1>
        {description && <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-af-text-3">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </header>
  )
}

export function Section({
  title,
  description,
  actions,
  icon,
  children,
  className,
  bodyClassName,
  flush = false,
}: {
  title?: React.ReactNode
  description?: React.ReactNode
  actions?: React.ReactNode
  icon?: React.ReactNode
  children: React.ReactNode
  className?: string
  bodyClassName?: string
  /** Body without padding, for lists that run edge to edge. */
  flush?: boolean
}) {
  return (
    <section className={cn("overflow-hidden rounded-2xl border border-af-border bg-af-panel", className)}>
      {(title || actions) && (
        <div className="flex items-start justify-between gap-4 border-b border-af-border px-5 py-3.5">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              {icon && <span className="text-af-text-3 [&_svg]:size-4">{icon}</span>}
              {title && <h2 className="text-sm font-semibold text-af-text">{title}</h2>}
            </div>
            {description && <p className="mt-0.5 text-xs leading-relaxed text-af-text-3">{description}</p>}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-1.5">{actions}</div>}
        </div>
      )}
      <div className={cn(!flush && "p-5", bodyClassName)}>{children}</div>
    </section>
  )
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
  compact = false,
}: {
  icon?: React.ReactNode
  title: React.ReactNode
  description?: React.ReactNode
  action?: React.ReactNode
  className?: string
  compact?: boolean
}) {
  return (
    <div className={cn("flex flex-col items-center justify-center text-center", compact ? "px-4 py-6" : "px-6 py-12", className)}>
      {icon && (
        <span
          className={cn(
            "mb-3 flex items-center justify-center rounded-xl border border-af-border bg-af-panel-2 text-af-text-3",
            compact ? "h-9 w-9 [&_svg]:size-4" : "h-11 w-11 [&_svg]:size-5"
          )}
        >
          {icon}
        </span>
      )}
      <p className={cn("font-medium text-af-text", compact ? "text-[13px]" : "text-sm")}>{title}</p>
      {description && (
        <p className={cn("mt-1 max-w-sm leading-relaxed text-af-text-3", compact ? "text-xs" : "text-[13px]")}>{description}</p>
      )}
      {action && <div className="mt-4">{action}</div>}
    </div>
  )
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("af-skeleton rounded-md", className)} />
}

export function Kbd({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <kbd
      className={cn(
        "inline-flex h-5 min-w-5 items-center justify-center rounded-md border border-af-border-strong bg-af-panel-2 px-1.5 font-sans text-[10px] font-medium text-af-text-3",
        className
      )}
    >
      {children}
    </kbd>
  )
}

/** Small uppercase label above lists and groups. */
export function Overline({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <p className={cn("text-[11px] font-semibold uppercase tracking-[0.08em] text-af-text-4", className)}>{children}</p>
  )
}

/** A titled block on a page. The title carries it; no icon or accent needed. */
export function Panel({
  title,
  action,
  children,
  className,
}: {
  title: React.ReactNode
  action?: React.ReactNode
  children: React.ReactNode
  className?: string
}) {
  return (
    <section className={cn("rounded-2xl border border-af-border bg-af-panel-2/40 p-4", className)}>
      <header className="mb-2 flex min-h-7 items-center justify-between gap-3">
        <h2 className="text-[13px] font-semibold text-af-text">{title}</h2>
        {action}
      </header>
      {children}
    </section>
  )
}
