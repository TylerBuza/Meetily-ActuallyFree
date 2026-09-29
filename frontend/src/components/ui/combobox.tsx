"use client"

import * as React from "react"
import { Check, ChevronDown, Plus } from "lucide-react"

import { cn } from "@/lib/utils"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command"
import { fieldClass } from "@/components/ui/input"
import { groupColorVar } from "@/lib/group-colors"

export interface ComboboxOption {
  value: string
  label: string
  description?: string
  /** Extra search terms (e.g. a contact's company). */
  keywords?: string[]
  /** Leading visual, e.g. an avatar. */
  icon?: React.ReactNode
  /** Group color key, drawn as a dot when no icon is given. */
  color?: string | null
  disabled?: boolean
}

export interface ComboboxProps {
  value: string | null
  onChange: (value: string | null, option?: ComboboxOption) => void
  options: ComboboxOption[]
  placeholder?: string
  searchPlaceholder?: string
  emptyText?: string
  /** Adds a first row that clears the selection, e.g. "No group". */
  clearLabel?: string
  /** Offers "Create …" for a query that matches nothing. */
  onCreate?: (query: string) => Promise<ComboboxOption | void> | ComboboxOption | void
  createLabel?: (query: string) => string
  /** Custom trigger element; receives the Radix trigger props. */
  trigger?: React.ReactElement
  triggerClassName?: string
  contentClassName?: string
  align?: "start" | "center" | "end"
  side?: "top" | "bottom"
  disabled?: boolean
  footer?: React.ReactNode
  open?: boolean
  onOpenChange?: (open: boolean) => void
  "aria-label"?: string
}

function OptionVisual({ option }: { option: ComboboxOption }) {
  if (option.icon) return <>{option.icon}</>
  if (option.color) {
    return (
      <span
        className="af-tint-dot h-2.5 w-2.5 shrink-0 rounded-full"
        style={{ "--chip": groupColorVar(option.color) } as React.CSSProperties}
      />
    )
  }
  return null
}

/** Searchable select. Use `Select` for short fixed lists. */
export function Combobox({
  value,
  onChange,
  options,
  placeholder = "Select…",
  searchPlaceholder = "Search…",
  emptyText = "Nothing found",
  clearLabel,
  onCreate,
  createLabel = (query) => `Create “${query}”`,
  trigger,
  triggerClassName,
  contentClassName,
  align = "start",
  side = "bottom",
  disabled,
  footer,
  open: openProp,
  onOpenChange,
  "aria-label": ariaLabel,
}: ComboboxProps) {
  const [openState, setOpenState] = React.useState(false)
  const open = openProp ?? openState
  const setOpen = (next: boolean) => {
    if (openProp === undefined) setOpenState(next)
    onOpenChange?.(next)
    if (!next) setQuery("")
  }
  const [query, setQuery] = React.useState("")
  const [creating, setCreating] = React.useState(false)
  const selected = options.find((option) => option.value === value)
  const trimmed = query.trim()
  const exact = options.some((option) => option.label.toLowerCase() === trimmed.toLowerCase())

  const choose = (option: ComboboxOption | null) => {
    onChange(option ? option.value : null, option ?? undefined)
    setOpen(false)
  }

  const create = async () => {
    if (!onCreate || !trimmed || creating) return
    setCreating(true)
    try {
      const created = await onCreate(trimmed)
      if (created) choose(created)
      else setOpen(false)
    } finally {
      setCreating(false)
    }
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild disabled={disabled}>
        {trigger ?? (
          <button
            type="button"
            aria-label={ariaLabel}
            className={cn(fieldClass, "flex items-center gap-2 text-left", !selected && "text-af-text-4", triggerClassName)}
          >
            {selected && <OptionVisual option={selected} />}
            <span className="min-w-0 flex-1 truncate">{selected?.label ?? placeholder}</span>
            <ChevronDown className={cn("h-4 w-4 shrink-0 text-af-text-3 transition-transform duration-200", open && "rotate-180")} />
          </button>
        )}
      </PopoverTrigger>
      <PopoverContent align={align} side={side} className={cn("w-72 overflow-hidden p-0", contentClassName)}>
        <Command>
          <CommandInput value={query} onValueChange={setQuery} placeholder={searchPlaceholder} />
          <CommandList className="max-h-72 p-1">
            <CommandEmpty>{onCreate && trimmed ? "No match yet." : emptyText}</CommandEmpty>
            {clearLabel && !trimmed && (
              <CommandGroup className="p-0">
                <CommandItem value="__clear__" onSelect={() => choose(null)}>
                  <span className="h-2.5 w-2.5 shrink-0 rounded-full border border-dashed border-af-text-4" />
                  <span className="flex-1 truncate">{clearLabel}</span>
                  {value === null && <Check className="text-af-accent" />}
                </CommandItem>
              </CommandGroup>
            )}
            <CommandGroup className="p-0">
              {options.map((option) => (
                <CommandItem
                  key={option.value}
                  value={`${option.label} ${option.value}`}
                  keywords={option.keywords}
                  disabled={option.disabled}
                  onSelect={() => choose(option)}
                >
                  <OptionVisual option={option} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-af-text">{option.label}</span>
                    {option.description && (
                      <span className="block truncate text-[11px] text-af-text-3">{option.description}</span>
                    )}
                  </span>
                  {option.value === value && <Check className="text-af-accent" />}
                </CommandItem>
              ))}
            </CommandGroup>
            {onCreate && trimmed && !exact && (
              <>
                <CommandSeparator />
                <CommandGroup className="p-0" forceMount>
                  <CommandItem value={`__create__ ${trimmed}`} onSelect={create} forceMount disabled={creating}>
                    <Plus className="text-af-accent" />
                    <span className="truncate text-af-accent">{createLabel(trimmed)}</span>
                  </CommandItem>
                </CommandGroup>
              </>
            )}
          </CommandList>
          {footer && <div className="border-t border-af-border p-1">{footer}</div>}
        </Command>
      </PopoverContent>
    </Popover>
  )
}
