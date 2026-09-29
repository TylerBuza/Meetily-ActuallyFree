'use client';

/**
 * Action items, everywhere they appear. In a meeting they are edited in place
 * (check off, reword, assign, set a due date, add, delete). On person, group,
 * and home views the same rows show which meeting each item came from; the
 * meeting stays the source of truth.
 */
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { CalendarDays, Check, Play, Plus, Trash2, UserRound } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { Checkbox } from '@/components/ui/checkbox';
import { Avatar } from '@/components/ui/avatar';
import { Combobox } from '@/components/ui/combobox';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Input } from '@/components/ui/input';
import { Hint } from '@/components/ui/tooltip';
import { useWorkspace } from '@/contexts/WorkspaceContext';
import { useUserName } from '@/hooks/useUserName';
import {
  announceChange,
  createActionItem,
  deleteActionItem,
  updateActionItem,
  type ActionItem,
} from '@/lib/workspace-api';
import { formatShortDate, parseDate } from '@/lib/dates';
import { displayTitle } from '@/lib/meeting-titles';
import { formatPlayback } from '@/components/meeting/AudioPlayerBar';

const DUE_PICKS = ['Today', 'Tomorrow', 'Friday', 'Next week', 'End of month'];

const error = (message: string) => (reason: unknown) =>
  toast.error(message, { description: reason instanceof Error ? reason.message : String(reason) });

export interface ActionItemsListProps {
  items: ActionItem[];
  onItemsChange: (items: ActionItem[]) => void;
  /** Meeting view: enables adding and hides the per-item meeting link. */
  meetingId?: string;
  /** Plays the moment an item was discussed. */
  onSeek?: (seconds: number) => void;
  showOwner?: boolean;
  emptyText?: string;
  /** Hide the "add" row (read-mostly views). */
  allowAdd?: boolean;
  className?: string;
}

export function ActionItemsList({
  items,
  onItemsChange,
  meetingId,
  onSeek,
  showOwner = true,
  emptyText = 'No action items.',
  allowAdd = !!meetingId,
  className,
}: ActionItemsListProps) {
  const [adding, setAdding] = useState(false);

  const replace = (next: ActionItem) => onItemsChange(items.map((item) => (item.id === next.id ? next : item)));

  const save = async (item: ActionItem, patch: Partial<ActionItem>) => {
    const optimistic = { ...item, ...patch };
    replace(optimistic);
    try {
      const saved = await updateActionItem(optimistic);
      replace(saved);
      announceChange('actions', { meetingId: item.meetingId, source: 'list' });
    } catch (reason) {
      replace(item);
      error('Could not update the action item')(reason);
    }
  };

  const remove = async (item: ActionItem) => {
    onItemsChange(items.filter((entry) => entry.id !== item.id));
    try {
      await deleteActionItem(item.id);
      announceChange('actions', { meetingId: item.meetingId, source: 'list' });
    } catch (reason) {
      onItemsChange(items);
      error('Could not delete the action item')(reason);
    }
  };

  const add = async (text: string) => {
    if (!meetingId || !text.trim()) return;
    try {
      const created = await createActionItem(meetingId, { text: text.trim() });
      onItemsChange([...items, created]);
      announceChange('actions', { meetingId, source: 'list' });
    } catch (reason) {
      error('Could not add the action item')(reason);
    }
  };

  return (
    <div className={cn('space-y-0.5', className)}>
      {items.length === 0 && !adding && <p className="py-2 text-[13px] text-af-text-3">{emptyText}</p>}
      {items.map((item) => (
        <ActionItemRow
          key={item.id}
          item={item}
          inMeeting={!!meetingId}
          showOwner={showOwner}
          onSeek={onSeek}
          onSave={(patch) => save(item, patch)}
          onDelete={() => remove(item)}
        />
      ))}
      {allowAdd && (adding ? (
        <AddRow
          onSubmit={async (text) => {
            await add(text);
          }}
          onDone={() => setAdding(false)}
        />
      ) : (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="flex h-9 w-full items-center gap-2.5 rounded-lg px-2 text-[13px] text-af-text-3 transition-colors hover:bg-af-hover hover:text-af-text"
        >
          <Plus className="h-4 w-4" />
          Add an action item
        </button>
      ))}
    </div>
  );
}

function AddRow({ onSubmit, onDone }: { onSubmit: (text: string) => Promise<void>; onDone: () => void }) {
  const [text, setText] = useState('');
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => ref.current?.focus(), []);
  return (
    <div className="flex items-center gap-2.5 rounded-lg px-2 py-1.5">
      <span className="h-4 w-4 shrink-0 rounded-full border border-dashed border-af-border-strong" />
      <input
        ref={ref}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={async (event) => {
          if (event.key === 'Enter' && text.trim()) {
            event.preventDefault();
            const value = text;
            setText('');
            await onSubmit(value);
          }
          if (event.key === 'Escape') onDone();
        }}
        onBlur={() => !text.trim() && onDone()}
        placeholder="What needs doing? Press Enter to add"
        className="af-bare h-7 min-w-0 flex-1 bg-transparent text-[13px] text-af-text outline-none placeholder:text-af-text-4"
      />
    </div>
  );
}

function ActionItemRow({
  item,
  inMeeting,
  showOwner,
  onSeek,
  onSave,
  onDelete,
}: {
  item: ActionItem;
  inMeeting: boolean;
  showOwner: boolean;
  onSeek?: (seconds: number) => void;
  onSave: (patch: Partial<ActionItem>) => void;
  onDelete: () => void;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(item.text);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const meetingDate = parseDate(item.meetingCreatedAt);

  useEffect(() => {
    if (!editing) return;
    setDraft(item.text);
    requestAnimationFrame(() => {
      const element = inputRef.current;
      if (!element) return;
      element.focus();
      element.setSelectionRange(element.value.length, element.value.length);
      element.style.height = `${element.scrollHeight}px`;
    });
  }, [editing, item.text]);

  const commit = () => {
    setEditing(false);
    const next = draft.trim();
    if (next && next !== item.text) onSave({ text: next });
  };

  return (
    <div className={cn('group/item flex items-start gap-2.5 rounded-lg px-2 py-2 transition-colors hover:bg-af-hover/60', item.done && 'opacity-70')}>
      <Checkbox
        round
        checked={item.done}
        onCheckedChange={(checked) => onSave({ done: checked === true })}
        aria-label={item.done ? 'Mark as not done' : 'Mark as done'}
        className="mt-0.5 h-[18px] w-[18px]"
      />
      <div className="min-w-0 flex-1">
        {editing ? (
          <textarea
            ref={inputRef}
            value={draft}
            rows={1}
            onChange={(event) => {
              setDraft(event.target.value);
              event.target.style.height = 'auto';
              event.target.style.height = `${event.target.scrollHeight}px`;
            }}
            onBlur={commit}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                commit();
              }
              if (event.key === 'Escape') setEditing(false);
            }}
            className="af-bare w-full resize-none bg-transparent text-[13px] leading-relaxed text-af-text outline-none"
          />
        ) : (
          <p
            onClick={() => setEditing(true)}
            className={cn(
              'cursor-text text-[13px] leading-relaxed text-af-text',
              item.done && 'text-af-text-3 line-through decoration-af-text-4',
            )}
          >
            {item.text}
          </p>
        )}
        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          {showOwner && <OwnerChip item={item} onSave={onSave} />}
          <DueChip value={item.dueText ?? null} onChange={(dueText) => onSave({ dueText })} />
          {inMeeting && item.audioTime != null && onSeek && (
            <Hint label="Play where this came up">
              <button
                type="button"
                onClick={() => onSeek(item.audioTime!)}
                className="inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-[11px] tabular-nums text-af-text-3 transition-colors hover:bg-af-accent/10 hover:text-af-accent"
              >
                <Play className="h-3 w-3" fill="currentColor" />
                {formatPlayback(item.audioTime)}
              </button>
            </Hint>
          )}
          {!inMeeting && (
            <button
              type="button"
              onClick={() => {
                // Open the meeting at the moment the item came up.
                const params = new URLSearchParams({ id: item.meetingId });
                if (item.transcriptId) params.set('t', item.transcriptId);
                if (item.audioTime != null) params.set('ts', String(Math.floor(item.audioTime)));
                router.push(`/meeting-details?${params.toString()}`);
              }}
              className="inline-flex h-6 min-w-0 max-w-[16rem] items-center gap-1.5 rounded-md px-1.5 text-[11px] text-af-text-3 transition-colors hover:bg-af-hover hover:text-af-text"
            >
              <span className="truncate">{displayTitle(item.meetingTitle, item.meetingCreatedAt)}</span>
              {meetingDate && <span className="shrink-0 text-af-text-4">· {formatShortDate(meetingDate)}</span>}
            </button>
          )}
        </div>
      </div>
      <Hint label="Delete">
        <button
          type="button"
          onClick={onDelete}
          aria-label="Delete action item"
          className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-af-text-4 opacity-0 transition-[opacity,color,background-color] hover:bg-af-danger/10 hover:text-af-danger focus-visible:opacity-100 group-hover/item:opacity-100"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </Hint>
    </div>
  );
}

function OwnerChip({ item, onSave }: { item: ActionItem; onSave: (patch: Partial<ActionItem>) => void }) {
  const { people } = useWorkspace();
  const userName = useUserName();
  const owner = item.personName ?? item.ownerLabel ?? null;
  const isYou = !!owner && /^you$/i.test(owner);
  const shown = isYou ? 'You' : owner;
  const value = item.personId ? `person:${item.personId}` : isYou ? 'you' : owner ? `label:${owner}` : null;

  const options = [
    { value: 'you', label: userName ? `${userName} (you)` : 'You', icon: <Avatar name={userName || 'You'} size="xs" /> },
    ...people.map((person) => ({
      value: `person:${person.id}`,
      label: person.displayName,
      description: [person.role, person.company].filter(Boolean).join(' · ') || undefined,
      icon: <Avatar name={person.displayName} size="xs" />,
    })),
    ...(owner && !item.personId && !isYou ? [{ value: `label:${owner}`, label: owner, icon: <Avatar name={owner} size="xs" /> }] : []),
  ];

  return (
    <Combobox
      value={value}
      options={options}
      clearLabel="No owner"
      searchPlaceholder="Assign to…"
      onCreate={(name) => ({ value: `label:${name}`, label: name })}
      createLabel={(name) => `Assign to “${name}”`}
      onChange={(next, option) => {
        if (!next) return onSave({ ownerLabel: null, personId: null, personName: null });
        if (next === 'you') return onSave({ ownerLabel: 'You', personId: null, personName: null });
        if (next.startsWith('person:')) return onSave({ ownerLabel: option?.label ?? null, personId: next.slice(7), personName: option?.label ?? null });
        return onSave({ ownerLabel: next.slice(6), personId: null, personName: null });
      }}
      trigger={
        <button
          type="button"
          className={cn(
            'inline-flex h-6 max-w-[12rem] items-center gap-1.5 rounded-md px-1.5 text-[11px] transition-colors',
            shown ? 'text-af-text-2 hover:bg-af-hover hover:text-af-text' : 'text-af-text-4 opacity-0 hover:bg-af-hover hover:text-af-text-2 group-hover/item:opacity-100 focus-visible:opacity-100',
          )}
        >
          {shown ? <Avatar name={isYou ? userName || 'You' : shown} size="xs" /> : <UserRound className="h-3 w-3" />}
          <span className="truncate">{shown ?? 'Assign'}</span>
        </button>
      }
    />
  );
}

function DueChip({ value, onChange }: { value: string | null; onChange: (value: string | null) => void }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value ?? '');
  useEffect(() => {
    if (open) setDraft(value ?? '');
  }, [open, value]);
  const set = (next: string | null) => {
    onChange(next && next.trim() ? next.trim() : null);
    setOpen(false);
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            'inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-[11px] transition-colors',
            value ? 'text-af-text-2 hover:bg-af-hover hover:text-af-text' : 'text-af-text-4 opacity-0 hover:bg-af-hover hover:text-af-text-2 group-hover/item:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100',
          )}
        >
          <CalendarDays className="h-3 w-3" />
          {value ?? 'Due'}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-60 p-2">
        <Input
          value={draft}
          autoFocus
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => event.key === 'Enter' && set(draft)}
          placeholder="Friday, Oct 3, next week…"
          className="h-8 text-xs"
        />
        <div className="mt-2 flex flex-wrap gap-1">
          {DUE_PICKS.map((pick) => (
            <button
              key={pick}
              type="button"
              onClick={() => set(pick)}
              className={cn(
                'rounded-md border px-2 py-1 text-[11px] transition-colors',
                value === pick ? 'border-af-accent bg-af-accent/10 text-af-accent' : 'border-af-border text-af-text-2 hover:bg-af-hover',
              )}
            >
              {value === pick && <Check className="mr-1 inline h-3 w-3" />}
              {pick}
            </button>
          ))}
        </div>
        {value && (
          <button type="button" onClick={() => set(null)} className="mt-2 w-full rounded-md py-1 text-[11px] text-af-text-3 transition-colors hover:bg-af-hover hover:text-af-danger">
            Clear due date
          </button>
        )}
      </PopoverContent>
    </Popover>
  );
}
