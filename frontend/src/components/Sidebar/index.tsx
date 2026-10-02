'use client';

/**
 * Primary navigation rail.
 *
 * Top to bottom: brand + collapse, the recording action (New recording, or
 * "Back to recording" with a live timer while one runs), search / command
 * bar, section links, then the meeting list grouped by date or by group, with
 * inline rename, per-row actions, and multi-select for bulk moves and deletes.
 *
 * The rail collapses to icons and can be resized; SidebarProvider owns the
 * width and the meeting list.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import {
  ArrowUpRight,
  CalendarDays,
  Check,
  ChevronDown,
  Contact,
  Download,
  FolderInput,
  Layers,
  Library,
  ListFilter,
  Mic,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Plus,
  Search,
  Settings,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { useSidebar, type CurrentMeeting } from './SidebarProvider';
import { SIDEBAR_DEFAULT } from '@/hooks/useCompactChrome';
import { useRecordingState } from '@/contexts/RecordingStateContext';
import { useImportDialog } from '@/contexts/ImportDialogContext';
import { useWorkspace } from '@/contexts/WorkspaceContext';
import { useRecordingClock } from '@/components/recording/RecordingPill';
import { cn } from '@/lib/utils';
import { dateSection, formatClock, formatDuration, formatShortDate, formatTime, parseDate, useCurrentDayKey } from '@/lib/dates';
import { displayTitle } from '@/lib/meeting-titles';
import { writePendingGroup } from '@/lib/groups';
import { deleteMeetings, moveMeetingsToGroup, renameMeeting } from '@/lib/meeting-actions';
import { groupColorVar } from '@/lib/group-colors';
import { createGroupFromPicker, GroupDot, groupOptions } from '@/components/groups/GroupBits';
import { openGroupEditor } from '@/components/groups/GroupEditor';
import { Hint } from '@/components/ui/tooltip';
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { VisuallyHidden } from '@/components/ui/visually-hidden';
import { About } from '@/components/About';
import { Checkbox } from '@/components/ui/checkbox';
import { Kbd } from '@/components/ui/surface';
import { DeleteMeetingsDialog } from '@/components/meetings/DeleteMeetingsDialog';
import { Combobox } from '@/components/ui/combobox';
import { ExportMeetingsDialog } from '@/components/meetings/ExportMeetingsDialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

const RAIL_EASE = 'ease-[cubic-bezier(0.22,1,0.36,1)]';
const GROUP_BY_KEY = 'af-sidebar-group-by';

type GroupBy = 'date' | 'group';

interface Section {
  key: string;
  title: string;
  color?: string | null;
  groupId?: string;
  meetings: CurrentMeeting[];
}

function RailIcon({ children }: { children: React.ReactNode }) {
  return <span className="flex h-full w-10 shrink-0 items-center justify-center [&_svg]:size-[18px]">{children}</span>;
}

function RailLabel({ expanded, children, className }: { expanded: boolean; children: React.ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        'flex min-w-0 flex-1 items-center overflow-hidden whitespace-nowrap text-left transition-[max-width,opacity,transform] duration-300 motion-reduce:transition-none',
        RAIL_EASE,
        expanded ? 'max-w-56 translate-x-0 opacity-100' : 'max-w-0 -translate-x-1 opacity-0',
        className,
      )}
    >
      {children}
    </span>
  );
}

function RailTip({ show, label, shortcut, children }: { show: boolean; label: string; shortcut?: string; children: React.ReactElement }) {
  return show ? (
    <Hint label={label} side="right" shortcut={shortcut}>
      {children}
    </Hint>
  ) : (
    children
  );
}

const navClass = (active: boolean) =>
  cn(
    'flex h-9 w-full items-center overflow-hidden rounded-lg text-[13px] font-medium transition-colors duration-150',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-af-accent/60',
    active ? 'bg-af-active text-af-text' : 'text-af-text-2 hover:bg-af-hover hover:text-af-text',
  );

function useStoredGroupBy(): [GroupBy, (next: GroupBy) => void] {
  const [value, setValue] = useState<GroupBy>('date');
  useEffect(() => {
    try {
      if (localStorage.getItem(GROUP_BY_KEY) === 'group') setValue('group');
    } catch {
      // Storage unavailable: keep the default.
    }
  }, []);
  const set = (next: GroupBy) => {
    setValue(next);
    try {
      localStorage.setItem(GROUP_BY_KEY, next);
    } catch {
      // Not remembered, still applied.
    }
  };
  return [value, set];
}

const Sidebar: React.FC = () => {
  const router = useRouter();
  const pathname = usePathname();
  const todayKey = useCurrentDayKey();
  const { currentMeeting, setCurrentMeeting, isCollapsed, sidebarWidth, setSidebarWidth, toggleRail, previewSidebar, meetings } =
    useSidebar();
  const { isRecording, isPaused } = useRecordingState();
  const elapsed = useRecordingClock();
  const { openImportDialog } = useImportDialog();
  const { groups, groupById } = useWorkspace();
  const expanded = !isCollapsed;

  const [groupBy, setGroupBy] = useStoredGroupBy();
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [anchorId, setAnchorId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string[] | null>(null);
  const [bulkMoveOpen, setBulkMoveOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const selecting = selectedIds.size > 0;

  const activeMeetingId = pathname === '/meeting-details' ? currentMeeting?.id : undefined;

  const sections = useMemo<Section[]>(() => {
    const sorted = [...meetings].sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''));
    if (groupBy === 'group') {
      const byGroup = new Map<string, Section>();
      const loose: CurrentMeeting[] = [];
      for (const meeting of sorted) {
        const group = groupById(meeting.group_id);
        if (!group) {
          loose.push(meeting);
          continue;
        }
        const section = byGroup.get(group.id) ?? { key: group.id, title: group.name, color: group.color, groupId: group.id, meetings: [] };
        section.meetings.push(meeting);
        byGroup.set(group.id, section);
      }
      const ordered = [...byGroup.values()];
      if (loose.length) ordered.push({ key: 'no-group', title: 'No group', meetings: loose });
      return ordered;
    }
    const byDate = new Map<string, Section>();
    const now = new Date();
    for (const meeting of sorted) {
      const date = parseDate(meeting.created_at);
      const title = date ? dateSection(date, now) : 'Older';
      const section = byDate.get(title) ?? { key: title, title, meetings: [] };
      section.meetings.push(meeting);
      byDate.set(title, section);
    }
    return [...byDate.values()];
  }, [meetings, groupBy, groupById, todayKey]);

  const orderedIds = useMemo(() => sections.flatMap((section) => section.meetings.map((meeting) => meeting.id)), [sections]);

  // Selection survives list refreshes only for meetings that still exist.
  useEffect(() => {
    setSelectedIds((current) => {
      const alive = new Set([...current].filter((id) => orderedIds.includes(id)));
      return alive.size === current.size ? current : alive;
    });
  }, [orderedIds]);

  useEffect(() => {
    if (!selecting) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSelectedIds(new Set());
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selecting]);

  useEffect(() => {
    if (listRef.current) listRef.current.inert = !expanded;
  }, [expanded]);

  const toggleSelected = useCallback(
    (id: string, range: boolean) => {
      setSelectedIds((current) => {
        const next = new Set(current);
        if (range && anchorId) {
          const from = orderedIds.indexOf(anchorId);
          const to = orderedIds.indexOf(id);
          if (from !== -1 && to !== -1) {
            const [lo, hi] = from < to ? [from, to] : [to, from];
            for (let index = lo; index <= hi; index++) next.add(orderedIds[index]);
            return next;
          }
        }
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
      setAnchorId(id);
    },
    [anchorId, orderedIds],
  );

  const openMeeting = (meeting: CurrentMeeting) => {
    setCurrentMeeting({ id: meeting.id, title: meeting.title });
    router.push(`/meeting-details?id=${encodeURIComponent(meeting.id)}`);
  };

  const onRowClick = (meeting: CurrentMeeting, event: React.MouseEvent) => {
    if (event.shiftKey || event.metaKey || event.ctrlKey || selecting) {
      event.preventDefault();
      toggleSelected(meeting.id, event.shiftKey);
      return;
    }
    openMeeting(meeting);
  };

  const confirmDelete = async (deleteLocalFiles: boolean) => {
    if (!pendingDelete) return false;
    const ids = pendingDelete;
    const deleted = await deleteMeetings(ids, deleteLocalFiles);
    if (deleted > 0) {
      setSelectedIds(new Set());
      if (activeMeetingId && ids.includes(activeMeetingId)) router.push('/');
    }
    return deleted > 0;
  };

  const recordForGroup = (group: { id: string; name: string }) => {
    writePendingGroup(group);
    router.push('/');
  };

  // Resizable rail.
  const [dragging, setDragging] = useState(false);
  const startResize = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const originX = event.clientX;
    const originWidth = sidebarWidth;
    setDragging(true);
    document.documentElement.setAttribute('data-sidebar-drag', '');
    const move = (moveEvent: PointerEvent) => previewSidebar(originWidth + (moveEvent.clientX - originX));
    const stop = (endEvent: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
      const next = originWidth + (endEvent.clientX - originX);
      requestAnimationFrame(() => {
        document.documentElement.removeAttribute('data-sidebar-drag');
        setDragging(false);
        setSidebarWidth(next, originWidth);
      });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop);
  };

  const openSearch = () => window.dispatchEvent(new CustomEvent('open-global-search'));
  const isContacts = pathname === '/contacts' || pathname === '/person';
  const isGroups = pathname === '/groups';
  const isLibrary = pathname === '/meetings';
  const isSettings = pathname === '/settings';

  return (
    <div
      className={cn(
        'af-rail fixed left-0 top-0 z-20 h-screen overflow-hidden',
        dragging ? 'is-resizing' : 'transition-[width,border-color] duration-300 ease-[cubic-bezier(0.22,1.25,0.36,1)] motion-reduce:transition-none',
      )}
      style={{ width: sidebarWidth }}
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize sidebar"
        aria-valuemin={64}
        aria-valuemax={384}
        aria-valuenow={sidebarWidth}
        onPointerDown={startResize}
        className="af-rail-resize absolute inset-y-0 right-0 z-10 w-1.5 cursor-col-resize"
      />

      <div className="flex h-full w-full min-w-0 flex-col overflow-hidden">
        {/* Wordmark (opens About) and the collapse button. The button is pinned
            to the rail's right edge, so it glides with the rail as it opens and
            closes and lands in the icon column when collapsed; its two icons
            cross-fade. The row keeps its height, so nothing below it moves, and
            its empty space drags the window (the app draws its own title bar on
            Windows). */}
        <div data-tauri-drag-region="deep" className="relative flex h-14 shrink-0 items-center px-3">
          <Dialog aria-describedby={undefined}>
            <DialogTrigger asChild>
              <button
                type="button"
                aria-label="About Meetily"
                tabIndex={expanded ? undefined : -1}
                aria-hidden={expanded ? undefined : true}
                className={cn(
                  'mr-10 flex h-10 min-w-0 flex-1 items-center rounded-lg px-1 text-left transition-[opacity,background-color] hover:bg-af-hover motion-reduce:transition-none',
                  RAIL_EASE,
                  expanded ? 'opacity-100 delay-75 duration-200' : 'pointer-events-none opacity-0 duration-150',
                )}
              >
                <span className="whitespace-nowrap text-base font-bold tracking-tight text-blue-500">
                  Meetily <span className="text-blue-400/70">· Actually Free</span>
                </span>
              </button>
            </DialogTrigger>
            <DialogContent>
              <VisuallyHidden>
                <DialogTitle>About Meetily</DialogTitle>
              </VisuallyHidden>
              <About />
            </DialogContent>
          </Dialog>
          <RailTip show={!expanded} label="Expand sidebar">
            <button
              type="button"
              onClick={toggleRail}
              aria-label={expanded ? 'Collapse sidebar' : 'Expand sidebar'}
              aria-expanded={expanded}
              className={cn(
                'absolute right-3 top-1/2 flex h-9 w-10 -translate-y-1/2 items-center justify-center rounded-lg text-af-text-3 transition-colors hover:bg-af-hover hover:text-af-text',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-af-accent/60',
              )}
            >
              <span className="relative h-[18px] w-[18px]">
                <PanelLeftClose
                  className={cn('absolute inset-0 h-[18px] w-[18px] transition-opacity duration-200', expanded ? 'opacity-100' : 'opacity-0')}
                />
                <PanelLeftOpen
                  className={cn('absolute inset-0 h-[18px] w-[18px] transition-opacity duration-200', expanded ? 'opacity-0' : 'opacity-100')}
                />
              </span>
            </button>
          </RailTip>
        </div>

        <div className="flex shrink-0 flex-col gap-1.5 px-3">
          {/* Recording action */}
          {isRecording ? (
            <RailTip show={!expanded} label={`Back to recording · ${formatClock(elapsed)}`}>
              <button
                type="button"
                onClick={() => router.push('/')}
                aria-label="Back to recording"
                className={cn(
                  'group flex h-10 w-full items-center overflow-hidden rounded-xl text-sm font-semibold text-white shadow-sm transition-[background-color,transform] duration-150 active:scale-[0.98]',
                  'bg-af-record hover:bg-af-record/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-af-record/50',
                )}
              >
                <RailIcon>
                  <span className="relative flex h-2.5 w-2.5">
                    {!isPaused && <span className="absolute inset-0 animate-ping rounded-full bg-white/70" />}
                    <span className="relative h-2.5 w-2.5 rounded-full bg-white" />
                  </span>
                </RailIcon>
                <RailLabel expanded={expanded} className="justify-between pr-3">
                  <span className="truncate">{isPaused ? 'Paused' : 'Back to recording'}</span>
                  <span className="ml-2 font-medium tabular-nums text-white/85">{formatClock(elapsed)}</span>
                </RailLabel>
              </button>
            </RailTip>
          ) : (
            <div className="flex h-10 w-full items-stretch overflow-hidden rounded-xl bg-af-record text-white shadow-sm">
              <RailTip show={!expanded} label="New recording">
                <button
                  type="button"
                  onClick={() => router.push('/')}
                  aria-label="New recording"
                  className="flex min-w-0 flex-1 items-center text-sm font-semibold transition-colors hover:bg-black/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white/60"
                >
                  <RailIcon>
                    <Mic />
                  </RailIcon>
                  <RailLabel expanded={expanded}>
                    <span className="truncate">New recording</span>
                  </RailLabel>
                </button>
              </RailTip>
              {expanded && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      aria-label="More ways to start"
                      className="flex w-9 shrink-0 items-center justify-center border-l border-white/20 transition-colors hover:bg-black/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white/60 data-[state=open]:bg-black/15"
                    >
                      <ChevronDown className="h-4 w-4" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-60">
                    <DropdownMenuItem onSelect={() => openImportDialog()}>
                      <Upload />
                      Import an audio file…
                    </DropdownMenuItem>
                    {groups.length > 0 && (
                      <DropdownMenuSub>
                        <DropdownMenuSubTrigger>
                          <Layers />
                          Record for a group
                        </DropdownMenuSubTrigger>
                        <DropdownMenuSubContent className="max-h-72 w-56 overflow-y-auto">
                          {groups.map((group) => (
                            <DropdownMenuItem key={group.id} onSelect={() => recordForGroup(group)}>
                              <GroupDot color={group.color} />
                              <span className="truncate">{group.name}</span>
                            </DropdownMenuItem>
                          ))}
                        </DropdownMenuSubContent>
                      </DropdownMenuSub>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </div>
          )}

          {/* Search / command bar */}
          <RailTip show={!expanded} label="Search or run a command" shortcut="Ctrl K">
            <button
              type="button"
              onClick={openSearch}
              aria-label="Search or run a command"
              className="flex h-9 w-full items-center overflow-hidden rounded-lg border border-af-border bg-af-panel-2 text-af-text-3 transition-colors hover:border-af-border-strong hover:text-af-text-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-af-accent/60"
            >
              <RailIcon>
                <Search />
              </RailIcon>
              <RailLabel expanded={expanded} className="justify-between pr-2">
                <span className="truncate text-[13px]">Search or jump to…</span>
                <Kbd>Ctrl K</Kbd>
              </RailLabel>
            </button>
          </RailTip>

          <nav className="mt-1 flex flex-col gap-0.5" aria-label="Sections">
            <RailTip show={!expanded} label="Contacts">
              <button type="button" onClick={() => router.push('/contacts')} className={navClass(isContacts)} aria-current={isContacts ? 'page' : undefined}>
                <RailIcon>
                  <Contact />
                </RailIcon>
                <RailLabel expanded={expanded}>Contacts</RailLabel>
              </button>
            </RailTip>
            <RailTip show={!expanded} label="Groups">
              <button type="button" onClick={() => router.push('/groups')} className={navClass(isGroups)} aria-current={isGroups ? 'page' : undefined}>
                <RailIcon>
                  <Layers />
                </RailIcon>
                <RailLabel expanded={expanded}>Groups</RailLabel>
              </button>
            </RailTip>
            <RailTip show={!expanded} label="All meetings">
              <button type="button" onClick={() => router.push('/meetings')} className={navClass(isLibrary)} aria-current={isLibrary ? 'page' : undefined}>
                <RailIcon>
                  <Library />
                </RailIcon>
                <RailLabel expanded={expanded}>All meetings</RailLabel>
              </button>
            </RailTip>
          </nav>
        </div>

        {/* Meeting list */}
        <div
          ref={listRef}
          aria-hidden={!expanded}
          className={cn(
            'mt-3 flex min-h-0 flex-1 flex-col transition-[opacity,transform] duration-300 motion-reduce:transition-none',
            RAIL_EASE,
            expanded ? 'translate-x-0 opacity-100' : 'pointer-events-none -translate-x-1 opacity-0',
          )}
        >
          <div className="flex shrink-0 items-center justify-between px-4 pb-1">
            <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-af-text-4">Meetings</span>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label="Meeting list options"
                  className="flex h-6 w-6 items-center justify-center rounded-md text-af-text-3 transition-colors hover:bg-af-hover hover:text-af-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-af-accent/60 data-[state=open]:bg-af-hover"
                >
                  <ListFilter className="h-3.5 w-3.5" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-52">
                <DropdownMenuLabel>Arrange by</DropdownMenuLabel>
                <DropdownMenuRadioGroup value={groupBy} onValueChange={(value) => setGroupBy(value as GroupBy)}>
                  <DropdownMenuRadioItem value="date">Date</DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="group">Group</DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => orderedIds[0] && setSelectedIds(new Set([orderedIds[0]]))} disabled={orderedIds.length === 0}>
                  <Check />
                  Select meetings
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => router.push('/meetings')}>
                  <Library />
                  Open the library
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          <div className="custom-scrollbar min-h-0 flex-1 overflow-y-auto px-2 pb-2">
            {sections.length === 0 ? (
              <div className="mx-2 mt-2 rounded-xl border border-dashed border-af-border-strong px-3 py-5 text-center">
                <CalendarDays className="mx-auto h-5 w-5 text-af-text-4" />
                <p className="mt-2 text-xs font-medium text-af-text-2">No meetings yet</p>
                <p className="mt-0.5 text-[11px] leading-relaxed text-af-text-4">Your recordings will show up here.</p>
              </div>
            ) : (
              sections.map((section) => (
                <div key={section.key} className="mt-2 first:mt-0">
                  <div className="flex items-center gap-1.5 pb-0.5 pl-8 pr-2 pt-1.5">
                    {section.groupId ? (
                      <button
                        type="button"
                        onClick={() => router.push(`/groups?id=${encodeURIComponent(section.groupId!)}`)}
                        className="min-w-0 truncate rounded text-[11px] font-semibold text-af-text-4 transition-colors hover:text-af-text-2"
                      >
                        {section.title}
                      </button>
                    ) : (
                      <span className="truncate text-[11px] font-semibold text-af-text-4">{section.title}</span>
                    )}
                    <span className="text-[10px] tabular-nums text-af-text-4">{section.meetings.length}</span>
                  </div>
                  {section.meetings.map((meeting) => (
                    <MeetingRow
                      key={meeting.id}
                      meeting={meeting}
                      groupName={groupBy === 'date' ? groupById(meeting.group_id)?.name ?? null : null}
                      showTimeOnly={groupBy === 'date' && (section.title === 'Today' || section.title === 'Yesterday')}
                      active={meeting.id === activeMeetingId}
                      selected={selectedIds.has(meeting.id)}
                      selecting={selecting}
                      renaming={renamingId === meeting.id}
                      onClick={(event) => onRowClick(meeting, event)}
                      onOpen={() => openMeeting(meeting)}
                      onToggle={(range) => toggleSelected(meeting.id, range)}
                      onRenameStart={() => setRenamingId(meeting.id)}
                      onRenameEnd={async (title) => {
                        setRenamingId(null);
                        if (title !== null && title.trim() && title.trim() !== meeting.title) {
                          const ok = await renameMeeting(meeting.id, title);
                          if (ok && currentMeeting?.id === meeting.id) setCurrentMeeting({ id: meeting.id, title: title.trim() });
                        }
                      }}
                      onMove={(groupId, groupName) => moveMeetingsToGroup([meeting.id], groupId, groupName)}
                      onDelete={() => setPendingDelete([meeting.id])}
                    />
                  ))}
                </div>
              ))
            )}
          </div>

          {selecting && (
            <div className="mx-2 mb-2 shrink-0 animate-af-rise rounded-xl border border-af-border-strong bg-af-elevated p-1.5 shadow-lg">
              <div className="flex items-center justify-between px-1.5 pb-1">
                <span className="text-xs font-medium text-af-text">{selectedIds.size} selected</span>
                <div className="flex items-center gap-0.5">
                  <button
                    type="button"
                    onClick={() => setSelectedIds(new Set(orderedIds))}
                    className="rounded px-1.5 py-0.5 text-[11px] text-af-text-3 transition-colors hover:bg-af-hover hover:text-af-text"
                  >
                    All
                  </button>
                  <button
                    type="button"
                    onClick={() => setSelectedIds(new Set())}
                    aria-label="Clear selection"
                    className="flex h-6 w-6 items-center justify-center rounded-md text-af-text-3 transition-colors hover:bg-af-hover hover:text-af-text"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
              <div className="flex gap-1">
                <Combobox
                  value={null}
                  open={bulkMoveOpen}
                  onOpenChange={setBulkMoveOpen}
                  onChange={async (groupId, option) => {
                    const ok = await moveMeetingsToGroup([...selectedIds], groupId, option?.label);
                    if (ok) setSelectedIds(new Set());
                  }}
                  options={groupOptions(groups)}
                  clearLabel="Remove from group"
                  searchPlaceholder="Move to group…"
                  onCreate={createGroupFromPicker}
                  createLabel={(query) => `Create group “${query}”`}
                  side="top"
                  trigger={
                    <button
                      type="button"
                      className="flex h-8 flex-1 items-center justify-center gap-1.5 rounded-lg bg-af-panel-2 text-xs font-medium text-af-text transition-colors hover:bg-af-hover"
                    >
                      <FolderInput className="h-3.5 w-3.5" />
                      Move to group
                    </button>
                  }
                />
                <Hint label="Export">
                  <button
                    type="button"
                    onClick={() => setExportOpen(true)}
                    aria-label="Export selected meetings"
                    className="flex h-8 w-9 items-center justify-center rounded-lg bg-af-panel-2 text-af-text-2 transition-colors hover:bg-af-hover hover:text-af-text"
                  >
                    <Download className="h-3.5 w-3.5" />
                  </button>
                </Hint>
                <button
                  type="button"
                  onClick={() => setPendingDelete([...selectedIds])}
                  aria-label="Delete selected meetings"
                  className="flex h-8 w-9 items-center justify-center rounded-lg bg-af-danger/[0.12] text-af-danger transition-colors hover:bg-af-danger/20"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        {/* h-14 matches the meeting page's playback bar, so their top borders line up. */}
        <div className={cn('mx-3 mt-auto flex h-14 shrink-0 flex-col justify-center border-t transition-colors', expanded ? 'border-af-border' : 'border-transparent')}>
          <RailTip show={!expanded} label="Settings">
            <button type="button" onClick={() => router.push('/settings')} className={navClass(isSettings)} aria-current={isSettings ? 'page' : undefined}>
              <RailIcon>
                <Settings />
              </RailIcon>
              <RailLabel expanded={expanded}>Settings</RailLabel>
            </button>
          </RailTip>
        </div>
      </div>

      <ExportMeetingsDialog
        open={exportOpen}
        onOpenChange={setExportOpen}
        meetings={meetings
          .filter((meeting) => selectedIds.has(meeting.id))
          .map((meeting) => ({ ...meeting, groupName: groupById(meeting.group_id)?.name ?? null }))}
      />

      <DeleteMeetingsDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => !open && setPendingDelete(null)}
        count={pendingDelete?.length ?? 0}
        onDelete={confirmDelete}
      />
    </div>
  );
};

interface MeetingRowProps {
  meeting: CurrentMeeting;
  /** Shown in the details line when meetings are listed by date. */
  groupName?: string | null;
  showTimeOnly: boolean;
  active: boolean;
  selected: boolean;
  selecting: boolean;
  renaming: boolean;
  onClick: (event: React.MouseEvent) => void;
  onOpen: () => void;
  onToggle: (range: boolean) => void;
  onRenameStart: () => void;
  onRenameEnd: (title: string | null) => void;
  onMove: (groupId: string | null, groupName?: string) => void;
  onDelete: () => void;
}

function MeetingRow({
  meeting,
  groupName,
  showTimeOnly,
  active,
  selected,
  selecting,
  renaming,
  onClick,
  onOpen,
  onToggle,
  onRenameStart,
  onRenameEnd,
  onMove,
  onDelete,
}: MeetingRowProps) {
  const { groups } = useWorkspace();
  const date = parseDate(meeting.created_at);
  const title = displayTitle(meeting.title, meeting.created_at);
  const meta = [groupName, date ? (showTimeOnly ? formatTime(date) : formatShortDate(date)) : null, formatDuration(meeting.duration_seconds) || null]
    .filter(Boolean)
    .join(' · ');
  const [draft, setDraft] = useState(title);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (renaming) {
      setDraft(meeting.title);
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
    }
  }, [renaming, meeting.title]);

  return (
    <div
      role="button"
      tabIndex={0}
      aria-current={active ? 'page' : undefined}
      onClick={renaming ? undefined : onClick}
      onDoubleClick={(event) => {
        event.preventDefault();
        onRenameStart();
      }}
      onKeyDown={(event) => {
        if (renaming) return;
        if (event.key === 'Enter') onClick(event as unknown as React.MouseEvent);
        if (event.key === 'F2') onRenameStart();
      }}
      className={cn(
        'group/row relative flex min-h-[44px] cursor-pointer select-none items-center gap-2 rounded-lg px-2 py-1.5 outline-none transition-colors duration-100',
        'focus-visible:ring-2 focus-visible:ring-af-accent/60',
        selected ? 'bg-af-accent/[0.12]' : active ? 'bg-af-active' : 'hover:bg-af-hover',
      )}
    >
      <span className="flex h-4 w-4 shrink-0 items-center justify-center" onClick={(event) => event.stopPropagation()}>
        <Checkbox
          checked={selected}
          onClick={(event) => {
            event.stopPropagation();
            onToggle(event.shiftKey);
          }}
          aria-label={selected ? `Deselect ${title}` : `Select ${title}`}
          className={cn('transition-opacity', selecting || selected ? 'opacity-100' : 'opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100')}
        />
      </span>

      <div className="min-w-0 flex-1">
        {renaming ? (
          <input
            ref={inputRef}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === 'Enter') onRenameEnd(draft);
              if (event.key === 'Escape') onRenameEnd(null);
            }}
            onBlur={() => onRenameEnd(draft)}
            aria-label="Meeting title"
            className="af-bare -mx-1 h-6 w-[calc(100%+0.5rem)] rounded-md !border !border-af-accent !bg-af-panel-2 px-1 text-[13px] text-af-text outline-none"
          />
        ) : (
          <p className={cn('truncate text-[13px] leading-5', active ? 'font-medium text-af-text' : 'text-af-text-2 group-hover/row:text-af-text')} title={title}>
            {title}
          </p>
        )}
        {meta && <p className="truncate text-[11px] leading-4 text-af-text-4">{meta}</p>}
      </div>

      {!renaming && !selecting && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              onClick={(event) => event.stopPropagation()}
              aria-label={`Actions for ${title}`}
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-af-text-3 opacity-0 transition-[opacity,background-color] hover:bg-af-active hover:text-af-text focus-visible:opacity-100 group-hover/row:opacity-100 data-[state=open]:bg-af-active data-[state=open]:opacity-100"
            >
              <MoreHorizontal className="h-3.5 w-3.5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" side="right" className="w-52" onClick={(event) => event.stopPropagation()}>
            <DropdownMenuItem onSelect={onOpen}>
              <ArrowUpRight />
              Open
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onRenameStart}>
              <Pencil />
              Rename
            </DropdownMenuItem>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <FolderInput />
                Move to group
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="max-h-72 w-56 overflow-y-auto">
                {groups.map((group) => (
                  <DropdownMenuItem key={group.id} onSelect={() => onMove(group.id, group.name)}>
                    <span
                      className="af-tint-dot h-2 w-2 rounded-full"
                      style={{ '--chip': groupColorVar(group.color) } as React.CSSProperties}
                    />
                    <span className="truncate">{group.name}</span>
                    {meeting.group_id === group.id && <Check className="ml-auto !text-af-accent" />}
                  </DropdownMenuItem>
                ))}
                {groups.length > 0 && <DropdownMenuSeparator />}
                <DropdownMenuItem onSelect={() => openGroupEditor({ assignMeetingIds: [meeting.id] })}>
                  <Plus />
                  New group…
                </DropdownMenuItem>
                {meeting.group_id && (
                  <DropdownMenuItem onSelect={() => onMove(null)}>
                    <X />
                    Remove from group
                  </DropdownMenuItem>
                )}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="danger" onSelect={onDelete}>
              <Trash2 />
              Delete…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}

export default Sidebar;
