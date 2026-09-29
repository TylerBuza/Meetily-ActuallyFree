'use client';

import { useEffect, useRef, useState } from 'react';
import { Pencil } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * A page title you can click to rename. Enter or leaving the field saves,
 * Escape cancels. `onCommit` returns false to keep the field open (e.g. the
 * save failed).
 */
export function EditableTitle({
  value,
  onCommit,
  label = 'Title',
  className,
}: {
  value: string;
  onCommit: (next: string) => Promise<boolean> | boolean;
  label?: string;
  className?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);

  useEffect(() => {
    if (editing) requestAnimationFrame(() => ref.current?.select());
  }, [editing]);

  const commit = async () => {
    const next = draft.trim();
    if (!next || next === value) {
      setEditing(false);
      setDraft(value);
      return;
    }
    if (await onCommit(next)) setEditing(false);
  };

  if (editing) {
    return (
      <input
        ref={ref}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => void commit()}
        onKeyDown={(event) => {
          if (event.key === 'Enter') void commit();
          if (event.key === 'Escape') {
            setDraft(value);
            setEditing(false);
          }
        }}
        aria-label={label}
        className={cn(
          'af-bare -ml-1.5 w-full min-w-0 rounded-md !border !border-af-accent !bg-af-panel-2 px-1.5 py-0.5 text-lg font-semibold tracking-tight text-af-text outline-none',
          className,
        )}
      />
    );
  }
  return (
    <button
      type="button"
      onClick={() => setEditing(true)}
      className="group/title -ml-1.5 flex min-w-0 max-w-full items-center gap-2 rounded-md px-1.5 py-0.5 text-left transition-colors hover:bg-af-hover"
      aria-label={`${label}: ${value}. Click to rename`}
    >
      <h1 className={cn('truncate text-lg font-semibold tracking-tight text-af-text', className)}>{value}</h1>
      <Pencil className="h-3.5 w-3.5 shrink-0 text-af-text-4 opacity-0 transition-opacity group-hover/title:opacity-100" />
    </button>
  );
}
