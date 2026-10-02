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
import { DeleteMeetingsDialog } from '@/components/meetings/DeleteMeetingsDialog';
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
  /** Directly launch renaming for a specific speaker */
  onQuickIdentify?: (label: string) => void;
  onExport: () => void;
  onCopyTranscript: () => void;
  onCopySummary: () => void;
  hasSummary: boolean;
  onOpenFolder: () => void;
  onDelete: (deleteLocalFiles: boolean) => Promise<boolean>;
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
  onQuickIdentify,
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
  const { engine, isNemotron, error: engineError, nemotronAvailable, pyannoteAvailable } = useDiarizationEngine(true);
  const [selectedEngine, setSelectedEngine] = useState<string | null>(null);
  const [identifying, setIdentifying] = useState(false);
  const [diarizeAvailable, setDiarizeAvailable] = useState(false);
  const [enhanceOpen, setEnhanceOpen] = useState(false);

  useEffect(() => {
    if (engine) setSelectedEngine(engine);
  }, [engine]);

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
    const activeEng = selectedEngine || engine || (isNemotron ? 'nemotron' : 'pyannote');
    const toastId = toast.loading('Separating speakers…', {
      description: `Analyzing recording with ${activeEng === 'nemotron' ? 'NVIDIA Nemotron-3' : 'Pyannote'}…`,
    });
    try {
      const result = await invoke<{ num_speakers: number; labeled: number }>('diarize_meeting', {
        meetingId,
        numSpeakers: activeEng !== 'nemotron' && Number.isFinite(count) && count > 0 ? count : null,
        engine: activeEng,
      });
      toast.success(result.num_speakers > 0 ? `Found ${result.num_speakers} speaker${result.num_speakers === 1 ? '' : 's'}` : 'No speakers detected', {
        id: toastId,
        description: `${result.labeled} lines labelled. Click any speaker to edit their name.`,
      });
      await onTranscriptChanged();
    } catch (error) {
      toast.error('Speaker separation failed', { id: toastId, description: error instanceof Error ? error.message : String(error) });
    } finally {
      setIdentifying(false);
    }
  }, [expected, selectedEngine, engine, isNemotron, meetingId, onTranscriptChanged]);

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
          {uniquePeople.length === 0 ? (
            diarizeAvailable && (
              <div className="mt-2.5 flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setExpected('');
                    setIdentifyOpen(true);
                  }}
                  disabled={identifying}
                  className="h-7 gap-1.5 rounded-full border-af-accent/40 bg-af-accent/[0.06] px-3 text-xs font-medium text-af-accent hover:bg-af-accent/15 transition-all shadow-sm"
                >
                  <Users className="h-3.5 w-3.5" />
                  <span>{identifying ? 'Separating speakers…' : 'Separate Speakers'}</span>
                </Button>
                <span className="text-[11px] text-af-text-3">
                  Identify who spoke using {engine === 'nemotron' ? 'NVIDIA Nemotron-3' : 'Pyannote'}
                </span>
              </div>
            )
          ) : (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <ul aria-label="People in this meeting" className="-ml-1 flex flex-wrap items-center gap-1">
                {uniquePeople.map((label) => {
                  const unnamed = isGenericSpeaker(label);
                  return (
                    <li key={label}>
                      <button
                        type="button"
                        onClick={(event) => {
                          if (unnamed && onQuickIdentify) {
                            onQuickIdentify(label);
                          } else {
                            onPersonClick(label, event.currentTarget);
                          }
                        }}
                        title={unnamed ? `Name ${label}` : undefined}
                        className={cn(
                          'inline-flex h-7 max-w-[14rem] items-center gap-1.5 rounded-full py-0.5 pl-1 pr-2.5 text-[12px] font-medium transition-colors hover:bg-af-hover border',
                          unnamed
                            ? 'border-dashed border-af-accent/40 bg-af-accent/[0.04] text-af-accent hover:border-af-accent hover:bg-af-accent/10'
                            : 'border-af-border/60 text-af-text-2 hover:text-af-text',
                        )}
                      >
                        {unnamed ? (
                          <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-af-accent/10 text-af-accent">
                            <UserRound className="h-3 w-3" />
                          </span>
                        ) : (
                          <Avatar name={isUserSpeaker(label) ? userName || 'You' : label} size="sm" />
                        )}
                        <span className="truncate">{isUserSpeaker(label) ? 'You' : label}</span>
                        {unnamed && (
                          <span className="text-[10px] opacity-75 font-normal">
                            (edit name)
                          </span>
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
              {diarizeAvailable && (
                <button
                  type="button"
                  onClick={() => {
                    setExpected('');
                    setIdentifyOpen(true);
                  }}
                  disabled={identifying}
                  title="Re-run speaker separation with a different model or speaker count"
                  className="inline-flex h-6 items-center gap-1 rounded-full border border-dashed border-af-border px-2 text-[11px] font-medium text-af-text-4 hover:border-af-accent/40 hover:text-af-accent transition-colors"
                >
                  <Users className="h-3 w-3" />
                  <span>Re-separate</span>
                </button>
              )}
            </div>
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

      <DeleteMeetingsDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        count={1}
        onDelete={async (deleteLocalFiles) => {
          const deleted = await onDelete(deleteLocalFiles);
          if (deleted) router.push('/');
          return deleted;
        }}
      />

      <Dialog open={identifyOpen} onOpenChange={setIdentifyOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AudioLines className="h-4 w-4 text-af-accent" />
              Separate Speakers
            </DialogTitle>
            <DialogDescription>
              {(selectedEngine || engine) === 'nemotron'
                ? 'NVIDIA Nemotron-3 automatically separates up to 8 speakers on this device.'
                : 'How many people spoke, including you? Leave it blank to detect automatically.'}
            </DialogDescription>
          </DialogHeader>

          {/* Model indicator & picker */}
          <div className="flex items-center justify-between p-2 rounded-lg bg-af-panel-2 border border-af-border text-xs">
            <span className="text-af-text-3 font-medium">Model:</span>
            {nemotronAvailable && pyannoteAvailable ? (
              <div className="flex items-center gap-1 bg-af-panel rounded-md p-0.5 border border-af-border">
                <button
                  type="button"
                  onClick={() => setSelectedEngine('nemotron')}
                  className={cn(
                    'px-2 py-0.5 rounded text-[11px] font-medium transition-colors',
                    (selectedEngine || engine) === 'nemotron' ? 'bg-af-accent text-af-on-accent' : 'text-af-text-3 hover:text-af-text'
                  )}
                >
                  Nemotron-3
                </button>
                <button
                  type="button"
                  onClick={() => setSelectedEngine('pyannote')}
                  className={cn(
                    'px-2 py-0.5 rounded text-[11px] font-medium transition-colors',
                    (selectedEngine || engine) === 'pyannote' ? 'bg-af-accent text-af-on-accent' : 'text-af-text-3 hover:text-af-text'
                  )}
                >
                  Pyannote
                </button>
              </div>
            ) : (
              <span className="font-semibold text-af-accent">
                {(selectedEngine || engine) === 'nemotron' ? 'NVIDIA Nemotron-3' : 'Pyannote (Bundled)'}
              </span>
            )}
          </div>

          {engineError ? (
            <p role="alert" className="text-sm text-af-danger">{engineError}</p>
          ) : !engine ? (
            <p role="status" className="text-sm text-af-text-3">Loading speaker settings…</p>
          ) : (selectedEngine || engine) !== 'nemotron' && (
          <div className="space-y-3">
            <label className="text-xs text-af-text-3">Expected speaker count (optional):</label>
            <Input
              type="number"
              min={1}
              max={20}
              autoFocus
              value={expected}
              onChange={(event) => setExpected(event.target.value)}
              onKeyDown={(event) => event.key === 'Enter' && void identify()}
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
            <Button onClick={() => void identify()} disabled={identifying}>
              {(selectedEngine || engine) !== 'nemotron' && expected ? `Find ${expected} speakers` : 'Separate Speakers'}
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
