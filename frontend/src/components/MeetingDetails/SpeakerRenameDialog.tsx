"use client";

import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'sonner';
import { Unlink, UserRound } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';

interface SpeakerRenameDialogProps {
  open: boolean;
  /** The current label being renamed, e.g. "Speaker 2". */
  speaker: string | null;
  meetingId?: string;
  onOpenChange: (open: boolean) => void;
  /** Called after a successful rename/removal so transcript and summary state can refresh. */
  onRenamed?: (rename: { from: string; to: string; count: number; removedName: boolean }) => Promise<void> | void;
}

interface SpeakerRenameResult {
  speaker: string;
  count: number;
  removedName: boolean;
}

function isGeneratedSpeakerLabel(value: string | null): boolean {
  return !!value && /^speaker \d+$/i.test(value.trim());
}

/**
 * Rename one speaker across an entire meeting.
 *
 * Automatic speaker identification is a heuristic — it can mislabel people, and
 * it cannot know who anyone is in meetings recorded before it existed. This lets
 * the user correct it directly, which is both more reliable and more useful than
 * "Speaker 2" ever is.
 *
 * Naming someone "You" marks them as the local user; the transcript then renders
 * that with the display name from Settings. Custom names create/link a durable
 * cross-meeting person. Blank Save and Remove name reverse only this meeting's
 * assignment and ask Rust for a collision-free generated `Speaker N` label.
 */
export function SpeakerRenameDialog({
  open,
  speaker,
  meetingId,
  onOpenChange,
  onRenamed,
}: SpeakerRenameDialogProps) {
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [userName, setUserName] = useState('');

  useEffect(() => {
    if (typeof window !== 'undefined') {
      setUserName(localStorage.getItem('meetily_user_name')?.trim() || '');
    }
  }, []);

  const canRemoveName = !!speaker && !isGeneratedSpeakerLabel(speaker);

  // Start from an assigned name; generated labels remain an empty name field.
  useEffect(() => {
    if (open) setName(canRemoveName ? speaker ?? '' : '');
  }, [canRemoveName, open, speaker]);

  const submit = async (value: string) => {
    const next = value.trim();
    if (!meetingId || !speaker || (!next && !canRemoveName) || saving) return;

    setSaving(true);
    try {
      const result = await invoke<SpeakerRenameResult>('rename_meeting_speaker', {
        meetingId,
        from: speaker,
        to: next,
      });
      if (result.removedName) {
        toast.success('Name removed', {
          description: `${result.speaker} is now meeting-local and no longer linked to a person. ${result.count} transcript ${result.count === 1 ? 'segment' : 'segments'} updated.`,
        });
      } else {
        const displayName = result.speaker === 'You' && userName ? `${userName} (You)` : result.speaker;
        toast.success(`Renamed to ${displayName}`, {
          description: `${result.count} transcript ${result.count === 1 ? 'segment' : 'segments'} updated.`,
        });
      }
      onOpenChange(false);
      await onRenamed?.({
        from: speaker,
        to: result.speaker,
        count: result.count,
        removedName: result.removedName,
      });
    } catch (e) {
      toast.error('Rename failed', {
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-describedby={undefined} className="sm:max-w-md">
        <DialogTitle className="flex items-center gap-2 text-base">
          <UserRound size={18} className="text-blue-500" />
          Who is {speaker}?
        </DialogTitle>

        <div className="mt-2 space-y-3">
          <p className="text-sm text-gray-500">
            Changes every line spoken by <strong>{speaker}</strong> in this meeting.
            Clear the field and save to remove an assigned name.
          </p>

          <input
            type="text"
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                submit(name);
              }
            }}
            placeholder="e.g. Dima"
            className="w-full rounded-md border border-[var(--af-border,#d1d5db)] bg-[var(--af-panel-2,#fff)] px-3 py-2 text-sm text-[var(--af-text,#111827)] outline-none focus:ring-2 focus:ring-blue-500"
          />

          {/* One-click "this is me" — the common case, and it also teaches the
              offline diarization pass which speaker is the user. */}
          <button
            type="button"
            onClick={() => submit('You')}
            disabled={saving}
            className="flex w-full items-center gap-2 rounded-md border border-[var(--af-border,#e5e7eb)] px-3 py-2 text-left text-sm text-gray-600 transition-colors hover:border-blue-400 hover:text-blue-500"
          >
            <UserRound size={15} />
            This is me{userName ? ` — ${userName}` : ''}
          </button>

          {canRemoveName && (
            <button
              type="button"
              onClick={() => submit('')}
              disabled={saving}
              className="flex w-full items-center gap-2 rounded-md border border-red-500/30 px-3 py-2 text-left text-sm text-red-500 transition-colors hover:border-red-500/60 hover:bg-red-500/10"
            >
              <Unlink size={15} />
              Remove name
            </button>
          )}
        </div>

        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            size="sm"
            className="bg-blue-600 text-white hover:bg-blue-700"
            disabled={(!name.trim() && !canRemoveName) || saving}
            onClick={() => submit(name)}
          >
            {saving ? 'Saving…' : name.trim() ? 'Rename' : 'Remove name'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
