'use client';

/**
 * One header for a meeting: the title (edit in place), when it happened, its
 * group, the people who spoke (click one to name or open them), Export, and a
 * ⋯ menu for everything else.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'sonner';
import {
  AudioLines,
  ClipboardCopy,
  Download,
  FileText,
  FolderOpen,
  MoreHorizontal,
  Trash2,
  UserRound,
  Users,
  Wand2,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Avatar } from '@/components/ui/avatar';
import { Hint } from '@/components/ui/tooltip';
import { Spinner } from '@/components/ui/spinner';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { EditableTitle } from '@/components/ui/editable-title';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { GroupPicker } from '@/components/groups/GroupBits';
import { RetranscribeDialog } from '@/components/MeetingDetails/RetranscribeDialog';
import { useConfig } from '@/contexts/ConfigContext';
import { formatDuration, parseDate } from '@/lib/dates';
import { timeRange } from '@/lib/meeting-titles';
import { useUserName } from '@/hooks/useUserName';
import { isUserSpeaker, speakerKey } from '@/utils/speakerUtils';
import { useDiarizationEngine } from '@/hooks/useDiarizationEngine';

const isGenericSpeaker = (label: string) => /^speaker d+$/i.test(label.trim()) || /^guest$/i.test(label.trim());

export interface MeetingHeaderProps {
  meetingId: string;
  title: string;
  createdAt?: string;
  durationSeconds?: number;
  folderPath?: string | null;
  groupId: string | null;
  onGroupChange: (groupId: string | null) => void;
  onRename: (title: string) => Promise<boolean>;
  /** Speaker labels in this meeting, most talkative first. */
  people: string[];
  onPersonClick: (label: string, anchor: HTMLElement) => void;
  onExport: () => void;
  onCopyTranscript: () => void;
  onCopySummary: () => void;
  hasSummary: boolean;
  onOpenFolder: () => void;
  onDelete: () => Promise<void>;
  /** After speakers are re-identified or the transcript is enhanced. */
  onTranscriptChanged: () => Promise<void> | void;
}

export function MeetingHeader({
  meetingId,
  title,
  createdAt,
  durationSeconds,
  folderPath,
  groupId,
  onGroupChange,
  onRename,
  people,
  onPersonClick,
  onExport,
  onCopyTranscript,
  onCopySummary,
  hasSummary,
  onOpenFolder,
  onDelete,
  onTranscriptChanged,
}: MeetingHeaderProps) {
  const router = useRouter();
  const userName = useUserName();
  const [confirmDelete, setConfirmDelete] = useState(false);
  // One chip per person: every label that means the user ("You", "You (mic)")
  // and names that differ only in case collapse to their first label.
  const uniquePeople = useMemo(() => {
    const seen = new Set<string>();
    return people.filter((label) => {
      const key = speakerKey(label);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [people]);
  const [identifyOpen, setIdentifyOpen] = useState(false);
  const [expected, setExpected] = useState('');
  // Nemotron finds the speaker count itself; only pyannote takes a count.
  const { engine, isNemotron, error: engineError } = useDiarizationEngine(identifyOpen);
  const [identifying, setIdentifying] = useState(false);
  const [diarizeAvailable, setDiarizeAvailable] = useState(false);
  const [enhanceOpen, setEnhanceOpen] = useState(false);

  useEffect(() => {
    invoke<boolean>('diarization_models_available').then(setDiarizeAvailable).catch(() => setDiarizeAvailable(false));
  }, []);

  const start = parseDate(createdAt);
  const end = start && durationSeconds ? new Date(start.getTime() + durationSeconds * 1000) : null;
  const when = start
    ? `${start.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: start.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' })} · ${end ? timeRange(start, end) : start.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`
    : null;

  const identify = useCallback(async () => {
    const count = parseInt(expected, 10);
    setIdentifyOpen(false);
    setIdentifying(true);
    const toastId = toast.loading('Identifying speakers…', { description: 'Analyzing the recording on this device.' });
    try {
      const result = await invoke<{ num_speakers: number; labeled: number }>('diarize_meeting', {
        meetingId,
        numSpeakers: !isNemotron && Number.isFinite(count) && count > 0 ? count : null,
      });
      toast.success(result.num_speakers > 0 ? `Found ${result.num_speakers} speaker${result.num_speakers === 1 ? '' : 's'}` : 'No speakers detected', {
        id: toastId,
        description: `${result.labeled} lines labelled.`,
      });
      await onTranscriptChanged();
    } catch (error) {
      toast.error('Speaker identification failed', { id: toastId, description: error instanceof Error ? error.message : String(error) });
    } finally {
      setIdentifying(false);
    }
  }, [expected, isNemotron, meetingId, onTranscriptChanged]);

  return (
    <header className="shrink-0 border-b border-af-border px-5 pb-3 pt-4">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <EditableTitle value={title} onCommit={onRename} label="Meeting title" />
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-2 text-xs text-af-text-3">
            {when && <span className="tabular-nums">{when}</span>}
            {durationSeconds ? <span className="tabular-nums">{formatDuration(durationSeconds)}</span> : null}
            <GroupPicker value={groupId} onChange={onGroupChange} placeholder="Add to group" />
          </div>
          {uniquePeople.length > 0 && (
            <ul aria-label="People in this meeting" className="-ml-1 mt-2 flex flex-wrap items-center gap-0.5">
              {uniquePeople.map((label) => {
                const unnamed = isGenericSpeaker(label);
                return (
                  <li key={label}>
                    <button
                      type="button"
                      onClick={(event) => onPersonClick(label, event.currentTarget)}
                      title={unnamed ? 'Name this speaker' : undefined}
                      className={cn(
                        'inline-flex h-7 max-w-[14rem] items-center gap-1.5 rounded-full py-0.5 pl-0.5 pr-2.5 text-[13px] transition-colors hover:bg-af-hover',
                        unnamed ? 'text-af-text-3 hover:text-af-text-2' : 'text-af-text-2 hover:text-af-text',
                      )}
                    >
                      {unnamed ? (
                        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-dashed border-af-border-strong text-af-text-4">
                          <UserRound className="h-3.5 w-3.5" />
                        </span>
                      ) : (
                        <Avatar name={isUserSpeaker(label) ? userName || 'You' : label} size="sm" />
                      )}
                      <span className="truncate">{isUserSpeaker(label) ? 'You' : label}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {identifying && (
            <span className="mr-1 flex items-center gap-1.5 text-xs text-af-text-3">
              <Spinner size={13} /> Identifying…
            </span>
          )}
          <Button variant="secondary" size="sm" onClick={onExport}>
            <Download />
            Export
          </Button>
          <DropdownMenu>
            <Hint label="More">
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-sm" aria-label="More meeting actions">
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
            </Hint>
            <DropdownMenuContent align="end" className="w-60">
              <DropdownMenuItem onSelect={onCopyTranscript}>
                <ClipboardCopy />
                Copy transcript
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={onCopySummary} disabled={!hasSummary}>
                <FileText />
                Copy summary
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={onOpenFolder}>
                <FolderOpen />
                Open recording folder
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              {diarizeAvailable && (
                <DropdownMenuItem
                  onSelect={() => {
                    setExpected('');
                    setIdentifyOpen(true);
                  }}
                  disabled={identifying}
                >
                  <Users />
                  Identify speakers again
                </DropdownMenuItem>
              )}
              {folderPath && (
                <DropdownMenuItem onSelect={() => setEnhanceOpen(true)}>
                  <Wand2 />
                  Enhance transcript
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="danger" onSelect={() => setConfirmDelete(true)}>
                <Trash2 />
                Delete meeting…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        variant="danger"
        title="Delete this meeting?"
        description="The transcript, summary, notes, and action items are removed. Audio files stay in your recordings folder."
        confirmLabel="Delete"
        onConfirm={async () => {
          await onDelete();
          router.push('/');
        }}
      />

      <Dialog open={identifyOpen} onOpenChange={setIdentifyOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AudioLines className="h-4 w-4 text-af-accent" />
              Identify speakers again
            </DialogTitle>
            <DialogDescription>
              {isNemotron
                ? 'Nemotron finds up to 8 speakers on its own and refines the live labels from the full recording.'
                : 'How many people spoke, including you? Leave it blank to let the app decide.'}
            </DialogDescription>
          </DialogHeader>
          {engineError ? (
            <p role="alert" className="text-sm text-af-danger">{engineError}</p>
          ) : !engine ? (
            <p role="status" className="text-sm text-af-text-3">Loading speaker settings…</p>
          ) : !isNemotron && (
          <div className="space-y-3">
            <Input
              type="number"
              min={1}
              max={20}
              autoFocus
              value={expected}
              onChange={(event) => setExpected(event.target.value)}
              onKeyDown={(event) => event.key === 'Enter' && engine && void identify()}
              placeholder="Detect automatically"
            />
            <div className="flex flex-wrap gap-1.5">
              {[2, 3, 4, 5, 6, 8].map((count) => (
                <button
                  key={count}
                  type="button"
                  onClick={() => setExpected(String(count))}
                  className={cn(
                    'h-8 min-w-9 rounded-lg border px-2 text-xs font-medium transition-colors',
                    expected === String(count) ? 'border-af-accent bg-af-accent text-af-on-accent' : 'border-af-border text-af-text-2 hover:bg-af-hover',
                  )}
                >
                  {count}
                </button>
              ))}
            </div>
          </div>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setIdentifyOpen(false)}>
              Cancel
            </Button>
            <Button onClick={() => void identify()} disabled={!engine}>
              {!isNemotron && expected ? `Find ${expected} speakers` : 'Detect automatically'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {folderPath && (
        <RetranscribeDialog
          open={enhanceOpen}
          onOpenChange={setEnhanceOpen}
          meetingId={meetingId}
          meetingFolderPath={folderPath}
          onComplete={() => void onTranscriptChanged()}
        />
      )}
    </header>
  );
}
