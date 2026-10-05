'use client';

/**
 * "Who is Speaker 2?" One searchable list: yourself, your contacts (with role
 * and company so namesakes are easy to tell apart), "add as a new contact" for
 * a typed name, and the other speakers in the meeting to merge with. Works for
 * saved meetings (Rust relabels and links the contact) and live recordings.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'sonner';
import { GitMerge, Unlink, UserPlus, UserRound } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { PossibleVoiceMatch } from '@/components/people/PossibleVoiceMatch';
import { Avatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { useWorkspace } from '@/contexts/WorkspaceContext';
import { useUserName } from '@/hooks/useUserName';
import { announceChange } from '@/lib/workspace-api';
import { displaySpeaker, isUserSpeaker, speakerDot, splitSpeakerLabel } from '@/utils/speakerUtils';

export interface SpeakerRenameResult {
  from: string;
  to: string;
  count: number;
  removedName: boolean;
}

export interface SpeakerIdentityDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The label being identified, e.g. "Speaker 2". */
  speaker: string | null;
  /** Set when opened from one line; offers "just this line". */
  transcriptId?: string | null;
  /** Saved meeting. Without it the change applies to the live recording. */
  meetingId?: string;
  /** Other speaker labels in this meeting, offered for merging. */
  speakers?: string[];
  onRenamed?: (rename: SpeakerRenameResult) => Promise<void> | void;
  onRenameLive?: (from: string, to: string, scope: 'all' | 'line' | 'future') => Promise<void> | void;
  onMerge?: (source: string, target: string) => Promise<void> | void;
  canSeparateLive?: boolean;
  speakerChannel?: string;
  /** Colour slot of a speaker in this meeting. */
  colorIndexOf?: (speaker: string) => number | undefined;
}

const isGenerated = (value: string | null) => !!value && /^speaker \d+$/i.test(value.trim());

export function SpeakerIdentityDialog({
  open,
  onOpenChange,
  speaker,
  transcriptId,
  meetingId,
  speakers = [],
  onRenamed,
  onRenameLive,
  onMerge,
  colorIndexOf,
  canSeparateLive = false,
  speakerChannel,
}: SpeakerIdentityDialogProps) {
  const { people } = useWorkspace();
  const userName = useUserName();
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState<'all' | 'line' | 'future'>('all');
  const [selectedSpeaker, setSelectedSpeaker] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setScope(!meetingId && transcriptId ? 'line' : 'all');
    setSelectedSpeaker(splitSpeakerLabel(speaker ?? '')[0] ?? '');
  }, [open, transcriptId, speaker]);

  const components = splitSpeakerLabel(speaker ?? '');
  const current = components.length > 1 ? selectedSpeaker : (speaker ?? '');
  const canRemove = !!current && !isGenerated(current) && !isUserSpeaker(current);
  const trimmed = query.trim();
  const exact = people.some((person) => person.displayName.toLowerCase() === trimmed.toLowerCase());
  const mergeTargets = useMemo(() => [...new Set(speakers.flatMap(splitSpeakerLabel))].filter((label) => label !== current), [speakers, current]);

  const apply = async (target: string) => {
    if (!speaker || saving) return;
    const next = target.trim();
    if (!next && !canRemove) return;
    setSaving(true);
    try {
      if (!meetingId) {
        await onRenameLive?.(current, next, scope);
        toast.success(scope === 'line' ? 'Speaker on this line changed' : `${current} is now ${next === 'You' ? displaySpeaker('You', userName) : next}`, {
          description: next && next !== 'You' ? 'Saved as a contact when the recording ends.' : undefined,
        });
        await onRenamed?.({ from: current, to: next, count: 0, removedName: !next });
        onOpenChange(false);
        return;
      }
      const result =
        scope === 'line' && transcriptId
          ? await invoke<{ speaker: string; count: number; removedName: boolean }>('reassign_transcript_speaker', { meetingId, transcriptId, from: current, to: next })
          : await invoke<{ speaker: string; count: number; removedName: boolean }>('rename_meeting_speaker', { meetingId, from: current, to: next });
      announceChange('people');
      if (result.removedName) {
        const kept = people.some((person) => person.displayName.toLowerCase() === current.toLowerCase());
        toast.success('Name removed', {
          description: `Lines are now labelled ${result.speaker}.${kept ? ` ${current} is still in your contacts.` : ''}`,
        });
      } else {
        const shown = result.speaker === 'You' ? displaySpeaker('You', userName) : result.speaker;
        toast.success(scope === 'line' ? `Speaker on this line is now ${shown}` : `${current} is now ${shown}`, {
          description: scope === 'line' ? undefined : `${result.count} line${result.count === 1 ? '' : 's'} updated.`,
        });
      }
      await onRenamed?.({ from: current, to: result.speaker, count: result.count, removedName: result.removedName });
      onOpenChange(false);
    } catch (error) {
      toast.error('Could not update the speaker', { description: error instanceof Error ? error.message : String(error) });
    } finally {
      setSaving(false);
    }
  };

  const merge = async (target: string) => {
    if (!speaker || !onMerge || saving) return;
    setSaving(true);
    try {
      await onMerge(current, target);
      onOpenChange(false);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !saving && onOpenChange(next)}>
      <DialogContent onOpenAutoFocus={event => { event.preventDefault(); inputRef.current?.focus(); }} className="max-w-md gap-0 overflow-hidden p-0">
        <div className="space-y-1 px-5 pb-3 pt-5 pr-12">
          <DialogTitle className="flex items-center gap-2">
            <span aria-hidden className={cn('h-2.5 w-2.5 rounded-full', speakerDot(current, colorIndexOf?.(current)))} />
            {transcriptId && scope === 'line' ? 'Who said this line?' : `Who is ${displaySpeaker(current, userName)}?`}
          </DialogTitle>
          <DialogDescription>Pick a contact, type a new name, or merge with another voice.</DialogDescription>
        </div>

        {open && <PossibleVoiceMatch speaker={current} speakerChannel={speakerChannel} meetingId={meetingId} disabled={saving} onAccept={name => void apply(name)} />}

        {components.length > 1 && (
          <div className="px-5 pb-3">
            <label className="block text-xs text-af-text-3">
              Speaker to change
              <select aria-label="Speaker to change" value={current} onChange={event => setSelectedSpeaker(event.target.value)} disabled={saving} className="mt-1 w-full rounded border border-af-border bg-af-panel p-2 text-af-text">
                {components.map(part => <option key={part} value={part}>{displaySpeaker(part, userName)}</option>)}
              </select>
            </label>
            <p className="mt-1 text-xs text-af-text-3">The other speakers on this line will be kept.</p>
          </div>
        )}

        {transcriptId && (
          <div className="px-5 pb-3">
            <div className="inline-flex w-full rounded-lg border border-af-border bg-af-panel-2 p-[3px]">
              {(['all', 'line', ...(canSeparateLive ? ['future' as const] : [])] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setScope(value)}
                  className={cn(
                    'h-7 flex-1 rounded-md text-xs font-medium transition-colors',
                    scope === value ? 'bg-af-raised text-af-text shadow-sm' : 'text-af-text-3 hover:text-af-text',
                  )}
                >
                  {value === 'all' ? `Every line from ${displaySpeaker(current, userName)}` : value === 'line' ? 'Just this line' : 'From this line onward'}
                </button>
              ))}
            </div>
          </div>
        )}

        {scope === 'future' && <p className="px-5 pb-3 text-xs text-af-text-3">Earlier lines stay unchanged. This channel will stop matching saved voices for the rest of this recording.</p>}
        <Command className="border-t border-af-border" loop>
          <CommandInput
            ref={inputRef}
            autoFocus
            value={query}
            onValueChange={setQuery}
            placeholder="Search contacts or type a name"
            onKeyDown={(event) => {
              // Typed Enter always chooses an exact name, or creates the typed contact.
              // Stop cmdk's highlighted partial match from consuming the same keystroke.
              if (event.key === 'Enter' && trimmed && !event.nativeEvent.isComposing) {
                event.preventDefault(); event.stopPropagation();
                const contact = people.find(person => person.displayName.toLowerCase() === trimmed.toLowerCase());
                void apply(contact?.displayName ?? trimmed);
              }
            }}
          />
          <CommandList className="max-h-[min(22rem,50vh)] p-1.5">
            <CommandEmpty>No matching contacts.</CommandEmpty>
            {!isUserSpeaker(current) && (
              <CommandGroup heading="You">
                <CommandItem value={`me you ${userName}`} onSelect={() => apply('You')} disabled={saving}>
                  <Avatar name={userName || 'You'} size="sm" />
                  <span className="flex-1 truncate text-af-text">This is me{userName ? ` · ${userName}` : ''}</span>
                </CommandItem>
              </CommandGroup>
            )}
            {people.length > 0 && (
              <CommandGroup heading="Contacts">
                {people.map((person) => (
                  <CommandItem
                    key={person.id}
                    value={`${person.displayName} ${person.id}`}
                    keywords={[person.company ?? '', person.role ?? '', person.email ?? ''].filter(Boolean)}
                    onSelect={() => apply(person.displayName)}
                    disabled={saving}
                  >
                    <Avatar name={person.displayName} size="sm" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-af-text">{person.displayName}</span>
                      {(person.role || person.company) && (
                        <span className="block truncate text-[11px] text-af-text-3">
                          {[person.role, person.company].filter(Boolean).join(' · ')}
                        </span>
                      )}
                    </span>
                    <span className="text-[11px] tabular-nums text-af-text-4">
                      {person.meetingCount} meeting{person.meetingCount === 1 ? '' : 's'}
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
            {trimmed && !exact && (
              <CommandGroup heading="New contact" forceMount>
                <CommandItem value={`__new__ ${trimmed}`} onSelect={() => apply(trimmed)} disabled={saving} forceMount>
                  <span className="flex h-6 w-6 items-center justify-center rounded-full bg-af-accent/[0.12] text-af-accent">
                    <UserPlus className="!size-3.5" />
                  </span>
                  <span className="truncate text-af-accent">Add “{trimmed}” as a new contact</span>
                </CommandItem>
              </CommandGroup>
            )}
            {onMerge && mergeTargets.length > 0 && scope === 'all' && (
              <CommandGroup heading="Same person as another voice?">
                {mergeTargets.map((label) => (
                  <CommandItem key={label} value={`merge ${label}`} onSelect={() => merge(label)} disabled={saving}>
                    <GitMerge className="text-af-text-3" />
                    <span className={cn('h-2 w-2 shrink-0 rounded-full', speakerDot(label, colorIndexOf?.(label)))} />
                    <span className="flex-1 truncate">Merge into {displaySpeaker(label, userName)}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
          </CommandList>
        </Command>

        <div className="flex items-center justify-between gap-2 border-t border-af-border px-4 py-3">
          {canRemove ? (
            <Button variant="danger-ghost" size="sm" onClick={() => apply('')} disabled={saving}>
              <Unlink />
              Remove name
            </Button>
          ) : (
            <span className="flex items-center gap-1.5 text-[11px] text-af-text-4">
              <UserRound className="h-3.5 w-3.5" />
              Names you add become contacts.
            </span>
          )}
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
