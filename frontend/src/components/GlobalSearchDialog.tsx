'use client';

/**
 * The command bar (Ctrl/Cmd+K, the sidebar search box, and the home page
 * search). Type to search everything, or run an action: start or return to a
 * recording, import, create a group or contact, jump to a page, or switch
 * theme. Rust does the searching, so results never depend on which transcript
 * pages happen to be loaded. Picking a transcript line or an action item opens
 * the meeting at that moment.
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { invoke } from '@tauri-apps/api/core';
import {
  ArrowUpRight,
  CalendarDays,
  Check,
  CircleCheck,
  FileAudio,
  FileText,
  Home,
  Layers,
  Library,
  MessageSquareText,
  Mic,
  Palette,
  Pause,
  Play,
  Search,
  Settings2,
  Square,
  UserPlus,
  Users,
} from 'lucide-react';
import {
  CommandDialog,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from '@/components/ui/command';
import { Avatar } from '@/components/ui/avatar';
import { Kbd } from '@/components/ui/surface';
import { Spinner } from '@/components/ui/spinner';
import { openGroupEditor } from '@/components/groups/GroupEditor';
import { useSidebar } from '@/components/Sidebar/SidebarProvider';
import { useRecordingState } from '@/contexts/RecordingStateContext';
import { useImportDialog } from '@/contexts/ImportDialogContext';
import { useWorkspace } from '@/contexts/WorkspaceContext';
import { THEMES, useAppTheme } from '@/lib/app-theme';
import { formatShortDate, parseDate } from '@/lib/dates';
import { stamp } from '@/lib/live-context';
import { displayTitle } from '@/lib/meeting-titles';
import { launchRecording, requestRecordingStop } from '@/lib/recording-launch';
import type { GlobalSearchResult } from '@/types';

type ResultKind = GlobalSearchResult['kind'] | 'group' | 'action';
type SearchResult = Omit<GlobalSearchResult, 'kind'> & { kind: ResultKind; groupId?: string; color?: string | null };

interface Command {
  id: string;
  label: string;
  /** Extra words that should find this command. */
  keywords?: string;
  icon: ReactNode;
  hint?: string;
  run: () => void;
}

const RESULT_GROUPS: Array<{ kind: ResultKind; heading: string }> = [
  { kind: 'person', heading: 'People' },
  { kind: 'group', heading: 'Groups' },
  { kind: 'meeting', heading: 'Meetings' },
  { kind: 'action', heading: 'Action items' },
  { kind: 'transcript', heading: 'Said in a meeting' },
  { kind: 'summary', heading: 'In a summary' },
];

const matches = (command: Command, query: string) => {
  const haystack = `${command.label} ${command.keywords ?? ''}`.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => haystack.includes(word));
};

function meetingLink(meetingId: string, options: { transcriptId?: string; time?: number | null } = {}) {
  const params = new URLSearchParams({ id: meetingId });
  if (options.transcriptId) params.set('t', options.transcriptId);
  if (options.time != null) params.set('ts', String(Math.floor(options.time)));
  return `/meeting-details?${params.toString()}`;
}

export default function GlobalSearchDialog() {
  const router = useRouter();
  const pathname = usePathname();
  const { isRecording, isPaused } = useRecordingState();
  const { openImportDialog } = useImportDialog();
  const { groups } = useWorkspace();
  const { meetings } = useSidebar();
  const [theme, setTheme] = useAppTheme();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestIdRef = useRef(0);

  useEffect(() => {
    const openBar = () => setOpen(true);
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setOpen((current) => !current);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('open-global-search', openBar);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('open-global-search', openBar);
    };
  }, []);

  useEffect(() => {
    // Invokes can't be cancelled; a generation number keeps a slow, stale
    // response from replacing newer results.
    requestIdRef.current += 1;
    const requestId = requestIdRef.current;
    const trimmed = query.trim();
    if (!open || trimmed.length < 2) {
      setResults([]);
      setLoading(false);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    const timer = window.setTimeout(async () => {
      try {
        const next = await invoke<SearchResult[]>('api_global_search', { query: trimmed, limit: 40 });
        if (requestId === requestIdRef.current) setResults(next ?? []);
      } catch (searchError) {
        if (requestId !== requestIdRef.current) return;
        console.error('Global search failed:', searchError);
        setResults([]);
        setError(searchError instanceof Error ? searchError.message : String(searchError));
      } finally {
        if (requestId === requestIdRef.current) setLoading(false);
      }
    }, 220);
    return () => window.clearTimeout(timer);
  }, [open, query]);

  const close = () => {
    requestIdRef.current += 1;
    setOpen(false);
    setQuery('');
    setResults([]);
    setLoading(false);
    setError(null);
  };

  /** Closes the bar, then runs the command once the dialog has let go of focus. */
  const run = (action: () => void) => {
    close();
    window.setTimeout(action, 0);
  };

  const go = (href: string) => run(() => router.push(href));

  const commands = useMemo<Command[]>(() => {
    const list: Command[] = [];
    if (isRecording) {
      if (pathname !== '/') {
        list.push({ id: 'back', label: 'Back to the recording', keywords: 'live transcript recorder', icon: <Mic />, run: () => router.push('/') });
      }
      list.push({
        id: 'pause',
        label: isPaused ? 'Resume recording' : 'Pause recording',
        keywords: 'recording pause resume',
        icon: isPaused ? <Play /> : <Pause />,
        run: () => void invoke(isPaused ? 'resume_recording' : 'pause_recording').catch(() => undefined),
      });
      list.push({
        id: 'stop',
        label: 'Stop and save the recording',
        keywords: 'end finish recording',
        icon: <Square />,
        run: () => requestRecordingStop((href) => router.push(href)),
      });
    } else {
      list.push({ id: 'record', label: 'Start recording', keywords: 'new meeting record call', icon: <Mic />, run: () => launchRecording((href) => router.push(href)) });
    }
    list.push(
      { id: 'import', label: 'Import a recording', keywords: 'audio file upload transcribe', icon: <FileAudio />, run: () => openImportDialog() },
      { id: 'new-group', label: 'New group', keywords: 'create series customer team project', icon: <Layers />, run: () => openGroupEditor({}) },
      { id: 'new-contact', label: 'New contact', keywords: 'create person add people', icon: <UserPlus />, run: () => router.push('/contacts?new=1') },
    );
    return list;
  }, [isPaused, isRecording, openImportDialog, pathname, router]);

  const destinations = useMemo<Command[]>(
    () => [
      { id: 'home', label: 'Home', keywords: 'recorder dashboard start', icon: <Home />, run: () => router.push('/') },
      { id: 'meetings', label: 'All meetings', keywords: 'library history list', icon: <Library />, run: () => router.push('/meetings') },
      { id: 'groups', label: 'Groups', keywords: 'series customers teams projects', icon: <Layers />, run: () => router.push('/groups') },
      { id: 'contacts', label: 'Contacts', keywords: 'people person', icon: <Users />, run: () => router.push('/contacts') },
      { id: 'settings', label: 'Settings', keywords: 'preferences models options', icon: <Settings2 />, run: () => router.push('/settings') },
    ],
    [router],
  );

  const themeCommands = useMemo<Command[]>(
    () =>
      THEMES.map((option) => ({
        id: `theme-${option.id}`,
        label: `Theme: ${option.label}`,
        keywords: `appearance color dark light ${option.label}`,
        icon: option.id === theme ? <Check /> : <Palette />,
        hint: option.id === theme ? 'Current' : undefined,
        run: () => setTheme(option.id),
      })),
    [setTheme, theme],
  );

  // With a query, groups can also be recorded into directly.
  const groupCommands = useMemo<Command[]>(
    () =>
      groups.map((group) => ({
        id: `record-${group.id}`,
        label: `Record a ${group.name} meeting`,
        keywords: `start new ${group.name}`,
        icon: <Mic />,
        run: () => launchRecording((href) => router.push(href), { group: { id: group.id, name: group.name } }),
      })),
    [groups, router],
  );

  const trimmed = query.trim();
  const shownCommands = trimmed ? commands.filter((command) => matches(command, trimmed)) : commands;
  const shownDestinations = trimmed ? destinations.filter((command) => matches(command, trimmed)) : destinations;
  const shownThemes = trimmed ? themeCommands.filter((command) => matches(command, trimmed)) : [];
  const shownGroupCommands = trimmed && !isRecording ? groupCommands.filter((command) => matches(command, trimmed)).slice(0, 3) : [];
  const recent = trimmed ? [] : meetings.slice(0, 5);

  const select = (result: SearchResult) => {
    switch (result.kind) {
      case 'person':
        return go(`/person?id=${encodeURIComponent(result.personId ?? result.id)}`);
      case 'group':
        return go(`/groups?id=${encodeURIComponent(result.groupId ?? result.id)}`);
      case 'transcript':
        return result.meetingId
          ? go(meetingLink(result.meetingId, { transcriptId: result.transcriptId ?? result.id, time: result.audioStartTime }))
          : undefined;
      case 'action':
        return result.meetingId ? go(meetingLink(result.meetingId, { time: result.audioStartTime })) : undefined;
      default: {
        const meetingId = result.meetingId ?? result.id;
        return go(meetingLink(meetingId));
      }
    }
  };

  const commandItem = (command: Command) => (
    <CommandItem key={command.id} value={command.id} onSelect={() => run(command.run)}>
      {command.icon}
      <span className="min-w-0 flex-1 truncate">{command.label}</span>
      {command.hint && <CommandShortcut>{command.hint}</CommandShortcut>}
    </CommandItem>
  );

  const resultItem = (result: SearchResult) => {
    const date = parseDate(result.timestamp);
    if (result.kind === 'person') {
      return (
        <CommandItem key={`person-${result.id}`} value={`person-${result.id}`} onSelect={() => select(result)}>
          <Avatar name={result.title} size="sm" />
          <span className="min-w-0 flex-1 truncate font-medium text-af-text">{result.title}</span>
          {result.meetingCount != null && (
            <CommandShortcut>
              {result.meetingCount} meeting{result.meetingCount === 1 ? '' : 's'}
            </CommandShortcut>
          )}
        </CommandItem>
      );
    }
    if (result.kind === 'group') {
      return (
        <CommandItem key={`group-${result.id}`} value={`group-${result.id}`} onSelect={() => select(result)}>
          <Layers className="text-af-text-3" />
          <span className="min-w-0 flex-1 truncate font-medium text-af-text">{result.title}</span>
          <CommandShortcut>{result.snippet}</CommandShortcut>
        </CommandItem>
      );
    }
    const icon =
      result.kind === 'transcript' ? <MessageSquareText /> : result.kind === 'summary' ? <FileText /> : result.kind === 'action' ? <CircleCheck /> : <CalendarDays />;
    const meta = [
      result.kind === 'transcript' || result.kind === 'action' ? result.speaker : null,
      result.audioStartTime != null && (result.kind === 'transcript' || result.kind === 'action') ? stamp(result.audioStartTime) : null,
      date ? formatShortDate(date) : null,
    ].filter(Boolean);
    const primary = result.kind === 'meeting' ? displayTitle(result.title, result.timestamp) : result.snippet || result.title;
    const secondary = result.kind === 'meeting' ? result.snippet : displayTitle(result.title, result.timestamp);
    return (
      <CommandItem
        key={`${result.kind}-${result.id}`}
        value={`${result.kind}-${result.id}`}
        onSelect={() => select(result)}
        className="items-start py-2"
      >
        <span className="mt-0.5 text-af-text-3">{icon}</span>
        <span className="min-w-0 flex-1">
          <span className="line-clamp-2 text-[13px] leading-snug text-af-text">{primary}</span>
          <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[11px] text-af-text-4">
            {secondary && <span className="truncate">{secondary}</span>}
            {meta.length > 0 && <span className="shrink-0">{secondary ? '· ' : ''}{meta.join(' · ')}</span>}
          </span>
        </span>
        {(result.kind === 'transcript' || result.kind === 'action') && <ArrowUpRight className="mt-0.5 text-af-text-4" />}
      </CommandItem>
    );
  };

  const nothingFound =
    trimmed.length >= 2 &&
    !loading &&
    !error &&
    results.length === 0 &&
    shownCommands.length + shownDestinations.length + shownThemes.length + shownGroupCommands.length === 0;

  return (
    <CommandDialog
      open={open}
      onOpenChange={(next) => (next ? setOpen(true) : close())}
      title="Search and commands"
      contentClassName="max-w-2xl"
      anchor="top"
      showCloseButton={false}
      commandProps={{ shouldFilter: false, loop: true }}
    >
      <div className="border-b border-af-border px-3 py-2.5">
        <CommandInput
          value={query}
          onValueChange={setQuery}
          placeholder="Search meetings, people, groups, transcripts… or type a command"
          wrapperClassName="h-10 px-1 [&>svg]:text-af-text-3"
          className="text-[15px]"
          endAdornment={loading ? <Spinner size={14} className="text-af-text-3" /> : <Kbd>Esc</Kbd>}
        />
      </div>

      <CommandList className="max-h-[min(64vh,540px)] px-1.5 py-1.5">
        {nothingFound && (
          <div className="px-6 py-12 text-center">
            <p className="text-sm font-medium text-af-text">Nothing matches “{trimmed}”</p>
            <p className="mt-1 text-xs text-af-text-3">Try a name, a topic, or fewer words.</p>
          </div>
        )}
        {error && (
          <div className="px-6 py-6 text-center">
            <p className="text-sm font-medium text-af-danger">Search is unavailable</p>
            <p className="mt-1 text-xs text-af-text-3">{error}</p>
          </div>
        )}

        {shownCommands.length > 0 && <CommandGroup heading="Actions">{shownCommands.map(commandItem)}</CommandGroup>}
        {shownGroupCommands.length > 0 && <CommandGroup heading="Record">{shownGroupCommands.map(commandItem)}</CommandGroup>}

        {RESULT_GROUPS.map(({ kind, heading }) => {
          const items = results.filter((result) => result.kind === kind);
          return items.length > 0 ? (
            <CommandGroup key={kind} heading={heading}>
              {items.map(resultItem)}
            </CommandGroup>
          ) : null;
        })}

        {recent.length > 0 && (
          <CommandGroup heading="Recent meetings">
            {recent.map((meeting) => {
              const date = parseDate(meeting.created_at);
              return (
                <CommandItem key={`recent-${meeting.id}`} value={`recent-${meeting.id}`} onSelect={() => go(meetingLink(meeting.id))}>
                  <CalendarDays className="text-af-text-3" />
                  <span className="min-w-0 flex-1 truncate">{displayTitle(meeting.title, meeting.created_at)}</span>
                  {date && <CommandShortcut>{formatShortDate(date)}</CommandShortcut>}
                </CommandItem>
              );
            })}
          </CommandGroup>
        )}

        {shownDestinations.length > 0 && <CommandGroup heading="Go to">{shownDestinations.map(commandItem)}</CommandGroup>}
        {shownThemes.length > 0 && <CommandGroup heading="Theme">{shownThemes.map(commandItem)}</CommandGroup>}

        {!trimmed && (
          <p className="flex items-center gap-2 px-3 pb-2 pt-3 text-[11px] text-af-text-4">
            <Search className="h-3 w-3" />
            Search finds names, meeting titles, anything said in a transcript, summaries and action items.
          </p>
        )}
      </CommandList>

      <div className="flex items-center gap-4 border-t border-af-border px-4 py-2 text-[11px] text-af-text-4">
        <span className="flex items-center gap-1.5">
          <Kbd>↑</Kbd>
          <Kbd>↓</Kbd>
          to move
        </span>
        <span className="flex items-center gap-1.5">
          <Kbd>Enter</Kbd>
          to open
        </span>
        <span className="ml-auto flex items-center gap-1.5">
          <Kbd>Ctrl K</Kbd>
          anywhere
        </span>
      </div>
    </CommandDialog>
  );
}
