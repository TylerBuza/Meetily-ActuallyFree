'use client';

/**
 * Time field: type a time ("930", "9:30 pm", "21:30") or pick one from a list
 * in 15-minute steps. The value is 24-hour "HH:MM", like <input type="time">.
 */
import * as React from 'react';
import { Check, ChevronDown, Clock } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { fieldClass } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { displayTime, formatTime, parseTime, parseTypedTime, usesTwelveHourClock } from '@/lib/schedule';

const STEP = 15;
const ROW_HEIGHT = 32;

export interface TimePickerProps {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  className?: string;
  'aria-label'?: string;
}

export function TimePicker({ value, onChange, disabled, className, 'aria-label': ariaLabel }: TimePickerProps) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState('');
  const [active, setActive] = React.useState(0);
  // Arrow keys after typing pick from the list instead of the typed time.
  const [browsing, setBrowsing] = React.useState(false);
  const listRef = React.useRef<HTMLDivElement | null>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);
  // Row to centre once the list is on screen.
  const initialRow = React.useRef<number | null>(null);
  const listId = React.useId();

  const current = parseTime(value);
  const twelveHour = React.useMemo(() => usesTwelveHourClock(), []);
  const typed = query.trim() ? parseTypedTime(query, twelveHour) : null;
  const invalid = query.trim() !== '' && typed === null;

  const slots = React.useMemo(() => {
    const list = Array.from({ length: 1440 / STEP }, (_, index) => index * STEP);
    if (current !== null && current % STEP !== 0) {
      const after = list.findIndex((minutes) => minutes > current);
      list.splice(after === -1 ? list.length : after, 0, current);
    }
    return list;
  }, [current]);

  const scrollToRow = React.useCallback((index: number, center: boolean) => {
    const list = listRef.current;
    if (!list) return;
    const top = index * ROW_HEIGHT;
    if (center) {
      list.scrollTop = top - (list.clientHeight - ROW_HEIGHT) / 2;
    } else if (top < list.scrollTop) {
      list.scrollTop = top;
    } else if (top + ROW_HEIGHT > list.scrollTop + list.clientHeight) {
      list.scrollTop = top + ROW_HEIGHT - list.clientHeight;
    }
  }, []);

  const attachList = React.useCallback(
    (node: HTMLDivElement | null) => {
      listRef.current = node;
      if (node && initialRow.current !== null) {
        scrollToRow(initialRow.current, true);
        initialRow.current = null;
      }
    },
    [scrollToRow],
  );

  const openAt = (next: boolean) => {
    setOpen(next);
    if (!next) return;
    setQuery('');
    setBrowsing(false);
    const start = Math.max(0, slots.indexOf(current ?? 9 * 60));
    setActive(start);
    initialRow.current = start;
  };

  const moveTo = (index: number, center = false) => {
    setActive(index);
    scrollToRow(index, center);
  };

  const commit = (minutes: number) => {
    onChange(formatTime(minutes));
    setOpen(false);
  };

  const onQueryChange = (text: string) => {
    setQuery(text);
    setBrowsing(false);
    const parsed = text.trim() ? parseTypedTime(text, twelveHour) : null;
    if (parsed === null) return;
    const index = slots.findIndex((minutes) => minutes >= parsed);
    moveTo(index === -1 ? slots.length - 1 : index, true);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    const steps: Record<string, number> = { ArrowDown: 1, ArrowUp: -1, PageDown: 4, PageUp: -4 };
    if (event.key in steps) {
      event.preventDefault();
      setBrowsing(true);
      moveTo(Math.min(slots.length - 1, Math.max(0, active + steps[event.key])));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (typed !== null && !browsing) commit(typed);
      else if (!invalid || browsing) commit(slots[active]);
    }
  };

  return (
    <Popover open={open} onOpenChange={openAt} modal>
      <PopoverTrigger asChild disabled={disabled}>
        <button
          type="button"
          aria-label={ariaLabel}
          className={cn(fieldClass, 'inline-flex w-36 items-center gap-2 px-2.5 text-left', open && 'border-af-accent ring-[3px] ring-af-accent/15', className)}
        >
          <Clock className="h-4 w-4 shrink-0 text-af-text-3" />
          <span className="flex-1 truncate tabular-nums">{current === null ? 'Pick a time' : displayTime(current)}</span>
          <ChevronDown className={cn('h-3.5 w-3.5 shrink-0 text-af-text-4 transition-transform duration-150', open && 'rotate-180')} />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-48 p-1"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          inputRef.current?.focus();
        }}
      >
        <div className="flex items-center gap-2 px-2">
          <input
            ref={inputRef}
            role="combobox"
            aria-expanded
            aria-controls={listId}
            aria-activedescendant={`${listId}-${active}`}
            aria-invalid={invalid}
            aria-label="Type a time"
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Type a time"
            className="h-8 min-w-0 flex-1 bg-transparent text-[13px] text-af-text outline-none placeholder:text-af-text-4"
          />
          {query.trim() && (
            <span className={cn('shrink-0 text-[11px] tabular-nums', invalid ? 'text-af-danger' : 'text-af-text-3')}>
              {invalid ? 'Not a time' : displayTime(typed!)}
            </span>
          )}
        </div>
        <div className="mx-1 mb-1 h-px bg-af-border" />
        <div
          ref={attachList}
          id={listId}
          role="listbox"
          aria-label="Times"
          className="relative max-h-56 overflow-y-auto overscroll-contain"
        >
          {slots.map((minutes, index) => {
            const selected = minutes === current;
            return (
              <div
                key={minutes}
                id={`${listId}-${index}`}
                role="option"
                aria-selected={selected}
                onPointerMove={() => active !== index && setActive(index)}
                onClick={() => commit(minutes)}
                style={{ height: ROW_HEIGHT }}
                className={cn(
                  'flex cursor-default select-none items-center justify-between rounded-lg px-2.5 text-[13px] tabular-nums transition-colors duration-75',
                  index === active ? 'bg-af-hover text-af-text' : 'text-af-text-2',
                  selected && 'font-medium text-af-text',
                )}
              >
                {displayTime(minutes)}
                {selected && <Check className="h-3.5 w-3.5 text-af-accent" />}
              </div>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}
