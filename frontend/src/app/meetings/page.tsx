'use client';

/**
 * Every meeting in one list: search, filter by group, contact and date, sort,
 * and act on many at once (move to a group, export, delete). Built for people
 * with a long history who want to sort it into groups.
 *
 * `/meetings?person=<id>` opens it filtered to one contact.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { invoke } from '@tauri-apps/api/core';
import {
  ArrowUpRight,
  Check,
  ChevronDown,
  ChevronsDownUp,
  ChevronsUpDown,
  Download,
  FileAudio,
  FolderInput,
  Layers,
  Library,
  MoreHorizontal,
  Pencil,
  Plus,
  Search,
  Trash2,
  Users,
  X,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useSidebar, type CurrentMeeting } from '@/components/Sidebar/SidebarProvider';
import { useWorkspace } from '@/contexts/WorkspaceContext';
import { useImportDialog } from '@/contexts/ImportDialogContext';
import { Avatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Combobox } from '@/components/ui/combobox';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { EmptyState, PageHeader } from '@/components/ui/surface';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { createGroupFromPicker, GroupChip, GroupDot, groupOptions } from '@/components/groups/GroupBits';
import { openGroupEditor } from '@/components/groups/GroupEditor';
import { ExportMeetingsDialog } from '@/components/meetings/ExportMeetingsDialog';
import { dateSection, formatDuration, parseDate } from '@/lib/dates';
import { displayTitle } from '@/lib/meeting-titles';
import { deleteMeetings, moveMeetingsToGroup, renameMeeting } from '@/lib/meeting-actions';
import { onWorkspaceChange } from '@/lib/workspace-api';
import { normalizeSummary, shortTopicLabel } from '@/lib/summary-buckets';
import type { PersonProfile } from '@/types';

type Sort = 'newest' | 'oldest' | 'longest';
type Range = 'any' | 'week' | 'month' | 'year';

const RANGE_DAYS: Record<Range, number | null> = { any: null, week: 7, month: 31, year: 366 };
const ALL_GROUPS = '__all__';
const NO_GROUP = '__none__';

function totalDuration(meetings: CurrentMeeting[]): string {
  const seconds = meetings.reduce((sum, meeting) => sum + (meeting.duration_seconds ?? 0), 0);
  const hours = Math.floor(seconds / 3600);
  if (hours >= 1) return `${hours} hour${hours === 1 ? '' : 's'} recorded`;
  const minutes = Math.round(seconds / 60);
  return minutes > 0 ? `${minutes} min recorded` : '';
}

function summaryExcerpt(raw: string): string | null {
  const text = raw.split(/\r?\n/).map((line) => line.trim())
    .filter((line) => line && !/^#{1,6}\s*(AI Generated Summary|Date:)/i.test(line))
    .join(' ')
    .replace(/!?\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/^\*{0,2}Summary\*{0,2}\s*:?\s*/i, '')
    .replace(/(?:^|\s)[#>*_`~-]+(?=\S)/g, ' ')
    .replace(/\s+/g, ' ').trim();
  return text ? text.length > 360 ? `${text.slice(0, 360).trimEnd()}…` : text : null;
}

export default function MeetingsPage() {
  const router = useRouter();
  const { meetings, setCurrentMeeting, currentMeeting } = useSidebar();
  const { groups, groupById, people } = useWorkspace();
  const { openImportDialog } = useImportDialog();

  const [query, setQuery] = useState('');
  const [groupFilter, setGroupFilter] = useState<string>(ALL_GROUPS);
  const [personFilter, setPersonFilter] = useState<string | null>(null);
  // Meetings where the chosen contact is a named speaker; null while loading.
  const [personMeetings, setPersonMeetings] = useState<Set<string> | null>(null);
  const [range, setRange] = useState<Range>('any');
  const [sort, setSort] = useState<Sort>('newest');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string[] | null>(null);
  const [exportIds, setExportIds] = useState<string[] | null>(null);
  const [moveOpen, setMoveOpen] = useState(false);

  useEffect(() => {
    const requested = new URLSearchParams(window.location.search).get('person');
    if (requested) setPersonFilter(requested);
  }, []);

  const choosePerson = (personId: string | null) => {
    setPersonFilter(personId);
    // Keep the link shareable within the app, e.g. back from a meeting.
    const search = personId ? `?person=${encodeURIComponent(personId)}` : '';
    window.history.replaceState(window.history.state, '', `${window.location.pathname}${search}`);
  };

  useEffect(() => {
    if (!personFilter) {
      setPersonMeetings(null);
      return;
    }
    let cancelled = false;
    const load = () => {
      invoke<PersonProfile>('api_get_person_profile', { personId: personFilter })
        .then((profile) => !cancelled && setPersonMeetings(new Set(profile.meetings.map((meeting) => meeting.meetingId))))
        .catch(() => !cancelled && setPersonMeetings(new Set()));
    };
    setPersonMeetings(null);
    load();
    // Renames and merges change who spoke in which meeting.
    const stop = onWorkspaceChange(['people', 'meetings'], load);
    return () => {
      cancelled = true;
      stop();
    };
  }, [personFilter]);

  const personOptions = useMemo(
    () =>
      people
        .filter((person) => person.meetingCount > 0 || person.id === personFilter)
        .map((person) => ({
          value: person.id,
          label: person.displayName,
          description: [person.role, person.company, `${person.meetingCount} meeting${person.meetingCount === 1 ? '' : 's'}`]
            .filter(Boolean)
            .join(' · '),
          keywords: [person.company ?? '', person.role ?? '', person.email ?? ''].filter(Boolean),
          icon: <Avatar name={person.displayName} size="xs" />,
        })),
    [people, personFilter],
  );

  const personLoading = personFilter !== null && personMeetings === null;

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const days = RANGE_DAYS[range];
    const cutoff = days ? Date.now() - days * 86_400_000 : null;
    const list = meetings.filter((meeting) => {
      if (personFilter && personMeetings && !personMeetings.has(meeting.id)) return false;
      if (groupFilter === NO_GROUP && meeting.group_id) return false;
      if (groupFilter !== ALL_GROUPS && groupFilter !== NO_GROUP && meeting.group_id !== groupFilter) return false;
      if (cutoff !== null) {
        const date = parseDate(meeting.created_at);
        if (!date || date.getTime() < cutoff) return false;
      }
      if (needle) {
        const title = displayTitle(meeting.title, meeting.created_at).toLowerCase();
        const group = groupById(meeting.group_id)?.name.toLowerCase() ?? '';
        if (!title.includes(needle) && !group.includes(needle)) return false;
      }
      return true;
    });
    return list.sort((a, b) => {
      if (sort === 'longest') return (b.duration_seconds ?? 0) - (a.duration_seconds ?? 0);
      const order = (a.created_at ?? '').localeCompare(b.created_at ?? '');
      return sort === 'oldest' ? order : -order;
    });
  }, [meetings, query, groupFilter, personFilter, personMeetings, range, sort, groupById]);

  const sections = useMemo(() => {
    if (sort === 'longest') return [{ title: 'Longest first', meetings: filtered }];
    const now = new Date();
    const map = new Map<string, CurrentMeeting[]>();
    for (const meeting of filtered) {
      const date = parseDate(meeting.created_at);
      const title = date ? dateSection(date, now) : 'Undated';
      map.set(title, [...(map.get(title) ?? []), meeting]);
    }
    return [...map.entries()].map(([title, items]) => ({ title, meetings: items }));
  }, [filtered, sort]);

  const orderedIds = useMemo(() => filtered.map((meeting) => meeting.id), [filtered]);
  const toggleExpanded = useCallback((ids: string[]) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (ids.every((id) => next.has(id))) ids.forEach((id) => next.delete(id));
      else ids.forEach((id) => next.add(id));
      return next;
    });
  }, []);
  const selecting = selected.size > 0;
  const filtersActive = query.trim() !== '' || groupFilter !== ALL_GROUPS || personFilter !== null || range !== 'any';

  // Keep only selections that still exist in the library.
  useEffect(() => {
    const alive = new Set(meetings.map((meeting) => meeting.id));
    setSelected((current) => {
      const next = new Set([...current].filter((id) => alive.has(id)));
      return next.size === current.size ? current : next;
    });
    setExpanded((current) => {
      const next = new Set([...current].filter((id) => alive.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [meetings]);

  useEffect(() => {
    if (!selecting) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSelected(new Set());
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selecting]);

  const toggle = useCallback(
    (id: string, range: boolean) => {
      setSelected((current) => {
        const next = new Set(current);
        if (range && anchor) {
          const from = orderedIds.indexOf(anchor);
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
      setAnchor(id);
    },
    [anchor, orderedIds],
  );

  const open = (meeting: CurrentMeeting) => {
    setCurrentMeeting({ id: meeting.id, title: meeting.title });
    router.push(`/meeting-details?id=${encodeURIComponent(meeting.id)}`);
  };

  const clearFilters = () => {
    setQuery('');
    setGroupFilter(ALL_GROUPS);
    choosePerson(null);
    setRange('any');
  };

  const exportList = (ids: string[]) =>
    meetings
      .filter((meeting) => ids.includes(meeting.id))
      .map((meeting) => ({ ...meeting, groupName: groupById(meeting.group_id)?.name ?? null }));

  const summaryLine = [
    `${meetings.length} meeting${meetings.length === 1 ? '' : 's'}`,
    totalDuration(meetings),
    groups.length > 0 ? `${groups.length} group${groups.length === 1 ? '' : 's'}` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <div className="h-full overflow-y-auto bg-af-panel">
      <div className="mx-auto w-full max-w-5xl px-8 pb-32 pt-10 animate-af-rise">
        <PageHeader
          title="All meetings"
          description={summaryLine}
          actions={
            <Button variant="secondary" size="sm" onClick={() => openImportDialog()}>
              <FileAudio />
              Import a recording
            </Button>
          }
        />

        <div className="mt-6 flex flex-wrap items-center gap-2">
          <div className="relative min-w-[14rem] flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-af-text-4" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Filter by title or group"
              className="pl-9"
              aria-label="Filter meetings"
            />
          </div>
          <Select value={groupFilter} onValueChange={setGroupFilter}>
            <SelectTrigger className="w-44" aria-label="Group">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_GROUPS}>All groups</SelectItem>
              <SelectItem value={NO_GROUP}>Not in a group</SelectItem>
              {groups.map((group) => (
                <SelectItem key={group.id} value={group.id}>
                  <span className="flex items-center gap-2">
                    <GroupDot color={group.color} />
                    {group.name}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Combobox
            value={personFilter}
            onChange={(value) => choosePerson(value)}
            options={personOptions}
            placeholder="Anyone"
            clearLabel="Anyone"
            searchPlaceholder="Find a contact"
            emptyText="No contacts with meetings yet"
            triggerClassName="w-44 text-af-text"
            aria-label="Contact"
          />
          <Select value={range} onValueChange={(value) => setRange(value as Range)}>
            <SelectTrigger className="w-36" aria-label="Date range">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="any">Any time</SelectItem>
              <SelectItem value="week">Past week</SelectItem>
              <SelectItem value="month">Past month</SelectItem>
              <SelectItem value="year">Past year</SelectItem>
            </SelectContent>
          </Select>
          <Select value={sort} onValueChange={(value) => setSort(value as Sort)}>
            <SelectTrigger className="w-36" aria-label="Sort">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="newest">Newest first</SelectItem>
              <SelectItem value="oldest">Oldest first</SelectItem>
              <SelectItem value="longest">Longest first</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="mt-5">
          {meetings.length === 0 ? (
            <EmptyState
              icon={<Library />}
              title="No meetings yet"
              description="Recordings and imported audio show up here, ready to sort into groups."
              action={
                <div className="flex gap-2">
                  <Button onClick={() => router.push('/')}>Start recording</Button>
                  <Button variant="secondary" onClick={() => openImportDialog()}>
                    Import a recording
                  </Button>
                </div>
              }
            />
          ) : personLoading ? (
            <div className="space-y-2" aria-busy="true">
              <div className="af-skeleton h-12 rounded-xl" />
              <div className="af-skeleton h-12 rounded-xl" />
              <div className="af-skeleton h-12 rounded-xl" />
            </div>
          ) : filtered.length === 0 ? (
            <EmptyState
              icon={<Search />}
              title="No meetings match"
              description="Try a different word, group, contact or time range."
              action={
                <Button variant="secondary" onClick={clearFilters}>
                  Clear filters
                </Button>
              }
            />
          ) : (
            <>
              <div className="flex items-center gap-3 px-3 pb-1 text-[11px] font-medium text-af-text-4">
                <Checkbox
                  checked={selected.size > 0 && orderedIds.every((id) => selected.has(id)) ? true : selected.size > 0 ? 'indeterminate' : false}
                  onCheckedChange={(checked) => setSelected(checked === true ? new Set(orderedIds) : new Set())}
                  aria-label="Select all shown"
                />
                <span className="flex-1">
                  {filtersActive ? `${filtered.length} of ${meetings.length} shown` : `${filtered.length} meetings`}
                </span>
                {filtersActive && (
                  <button type="button" onClick={clearFilters} className="rounded px-1.5 py-0.5 transition-colors hover:bg-af-hover hover:text-af-text-2">
                    Clear filters
                  </button>
                )}
              </div>
              {sections.map((section, sectionIndex) => (
                <section key={section.title} className="mt-3 first:mt-1">
                  <div className="flex items-center gap-1 px-3 pb-1">
                    <h2 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-af-text-4">
                      {section.title}
                      <span className="ml-2 font-normal normal-case tracking-normal tabular-nums">{section.meetings.length}</span>
                    </h2>
                    <button
                      type="button"
                      onClick={() => toggleExpanded(section.meetings.map((meeting) => meeting.id))}
                      aria-expanded={section.meetings.every((meeting) => expanded.has(meeting.id))}
                      aria-controls={`meeting-day-${sectionIndex}`}
                      aria-label={`${section.meetings.every((meeting) => expanded.has(meeting.id)) ? 'Collapse' : 'Expand'} all meetings in ${section.title}`}
                      title={`${section.meetings.every((meeting) => expanded.has(meeting.id)) ? 'Collapse' : 'Expand'} all`}
                      className="ml-1 inline-flex h-6 w-6 items-center justify-center rounded-md text-af-text-4 transition-colors hover:bg-af-hover hover:text-af-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-af-accent"
                    >
                      {section.meetings.every((meeting) => expanded.has(meeting.id)) ? <ChevronsDownUp className="h-4 w-4" /> : <ChevronsUpDown className="h-4 w-4" />}
                    </button>
                  </div>
                  <ul id={`meeting-day-${sectionIndex}`} className="af-appear overflow-hidden rounded-xl border border-af-border bg-af-panel-2/40" style={{ '--af-i': sectionIndex } as React.CSSProperties}>
                    {section.meetings.map((meeting) => (
                      <LibraryRow
                        key={meeting.id}
                        meeting={meeting}
                        selected={selected.has(meeting.id)}
                        expanded={expanded.has(meeting.id)}
                        selecting={selecting}
                        renaming={renaming === meeting.id}
                        onToggle={(rangeSelect) => toggle(meeting.id, rangeSelect)}
                        onToggleExpanded={() => toggleExpanded([meeting.id])}
                        onOpen={() => open(meeting)}
                        onRenameStart={() => setRenaming(meeting.id)}
                        onRenameEnd={async (title) => {
                          setRenaming(null);
                          if (title !== null && title.trim() && title.trim() !== meeting.title) {
                            const ok = await renameMeeting(meeting.id, title);
                            if (ok && currentMeeting?.id === meeting.id) setCurrentMeeting({ id: meeting.id, title: title.trim() });
                          }
                        }}
                        onMove={(groupId, name) => moveMeetingsToGroup([meeting.id], groupId, name)}
                        onExport={() => setExportIds([meeting.id])}
                        onDelete={() => setPendingDelete([meeting.id])}
                      />
                    ))}
                  </ul>
                </section>
              ))}
            </>
          )}
        </div>
      </div>

      {selecting && (
        <div className="pointer-events-none fixed inset-x-0 bottom-6 z-40 flex justify-center" style={{ paddingLeft: 'var(--af-sidebar-width, 16rem)' }}>
          <div className="pointer-events-auto flex animate-af-rise items-center gap-1.5 rounded-2xl border border-af-border-strong bg-af-elevated/95 p-1.5 pl-4 shadow-2xl backdrop-blur-xl">
            <span className="mr-2 text-[13px] font-medium tabular-nums text-af-text">{selected.size} selected</span>
            <Combobox
              value={null}
              open={moveOpen}
              onOpenChange={setMoveOpen}
              onChange={async (groupId, option) => {
                const ok = await moveMeetingsToGroup([...selected], groupId, option?.label);
                if (ok) setSelected(new Set());
              }}
              options={groupOptions(groups)}
              clearLabel="Remove from group"
              searchPlaceholder="Move to group…"
              onCreate={createGroupFromPicker}
              createLabel={(name) => `Create group “${name}”`}
              side="top"
              trigger={
                <Button variant="secondary" size="sm">
                  <FolderInput />
                  Move to group
                </Button>
              }
            />
            <Button variant="secondary" size="sm" onClick={() => setExportIds([...selected])}>
              <Download />
              Export
            </Button>
            <Button variant="danger-ghost" size="sm" onClick={() => setPendingDelete([...selected])}>
              <Trash2 />
              Delete
            </Button>
            <Button variant="ghost" size="icon-sm" onClick={() => setSelected(new Set())} aria-label="Clear selection">
              <X />
            </Button>
          </div>
        </div>
      )}

      <ExportMeetingsDialog open={exportIds !== null} onOpenChange={(next) => !next && setExportIds(null)} meetings={exportList(exportIds ?? [])} />

      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(next) => !next && setPendingDelete(null)}
        variant="danger"
        title={pendingDelete && pendingDelete.length > 1 ? `Delete ${pendingDelete.length} meetings?` : 'Delete this meeting?'}
        description="The transcript, summary, notes, and action items are removed. Audio files stay in your recordings folder."
        confirmLabel="Delete"
        onConfirm={async () => {
          if (!pendingDelete) return;
          const deleted = await deleteMeetings(pendingDelete);
          if (deleted > 0) setSelected(new Set());
        }}
      />
    </div>
  );
}

function LibraryRow({
  meeting,
  selected,
  expanded,
  selecting,
  renaming,
  onToggle,
  onToggleExpanded,
  onOpen,
  onRenameStart,
  onRenameEnd,
  onMove,
  onExport,
  onDelete,
}: {
  meeting: CurrentMeeting;
  selected: boolean;
  expanded: boolean;
  selecting: boolean;
  renaming: boolean;
  onToggle: (range: boolean) => void;
  onToggleExpanded: () => void;
  onOpen: () => void;
  onRenameStart: () => void;
  onRenameEnd: (title: string | null) => void;
  onMove: (groupId: string | null, name?: string) => void;
  onExport: () => void;
  onDelete: () => void;
}) {
  const { groups, groupById } = useWorkspace();
  const group = groupById(meeting.group_id);
  const date = parseDate(meeting.created_at);
  const title = displayTitle(meeting.title, meeting.created_at);
  const [draft, setDraft] = useState(meeting.title);
  const buckets = normalizeSummary(meeting.summary_data ?? meeting.summary_preview);
  const excerpt = summaryExcerpt(buckets.summary.join(' ') || meeting.summary_preview || '');
  const topics = buckets.topics.map(shortTopicLabel).filter(Boolean).slice(0, 3);

  useEffect(() => {
    if (renaming) setDraft(meeting.title);
  }, [renaming, meeting.title]);

  return (
    <li
      className={cn(
        'group/row grid cursor-pointer grid-cols-[1.25rem_minmax(0,1fr)_auto_auto] items-center gap-3 border-b border-af-border px-3 py-2.5 transition-colors last:border-b-0 sm:grid-cols-[1.25rem_minmax(0,1fr)_10rem_9rem_3.5rem_1.75rem_1.75rem]',
        selected ? 'bg-af-accent/[0.1]' : 'hover:bg-af-hover/70',
      )}
      onClick={(event) => {
        if (renaming) return;
        if (event.shiftKey || event.metaKey || event.ctrlKey || selecting) onToggle(event.shiftKey);
        else onOpen();
      }}
      onDoubleClick={(event) => {
        event.preventDefault();
        onRenameStart();
      }}
    >
      <span onClick={(event) => event.stopPropagation()} className="flex items-center">
        <Checkbox
          checked={selected}
          onClick={(event) => {
            event.stopPropagation();
            onToggle(event.shiftKey);
          }}
          aria-label={selected ? `Deselect ${title}` : `Select ${title}`}
          className={cn('transition-opacity', selecting || selected ? 'opacity-100' : 'opacity-40 group-hover/row:opacity-100')}
        />
      </span>

      <div className="min-w-0">
        {renaming ? (
          <input
            autoFocus
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              if (event.key === 'Enter') onRenameEnd(draft);
              if (event.key === 'Escape') onRenameEnd(null);
            }}
            onBlur={() => onRenameEnd(draft)}
            aria-label="Meeting title"
            className="af-bare h-7 w-full rounded-md !border !border-af-accent !bg-af-panel-2 px-2 text-[13px] text-af-text outline-none"
          />
        ) : (
          <p className="truncate text-[13px] font-medium text-af-text" title={title}>
            {title}
          </p>
        )}
        <p className="truncate text-[11px] text-af-text-4 sm:hidden">
          {[group?.name, date?.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }), formatDuration(meeting.duration_seconds)]
            .filter(Boolean)
            .join(' · ')}
        </p>
      </div>

      <div className="hidden min-w-0 sm:block">{group && <GroupChip group={group} size="xs" />}</div>
      <span className="hidden truncate text-xs tabular-nums text-af-text-3 sm:block">
        {date ? `${date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, ${date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}` : ''}
      </span>
      <span className="hidden text-right text-xs tabular-nums text-af-text-3 sm:block">{formatDuration(meeting.duration_seconds)}</span>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            onClick={(event) => event.stopPropagation()}
            aria-label={`Actions for ${title}`}
            className="flex h-7 w-7 items-center justify-center rounded-md text-af-text-3 opacity-0 transition-[opacity,background-color] hover:bg-af-active hover:text-af-text focus-visible:opacity-100 group-hover/row:opacity-100 data-[state=open]:bg-af-active data-[state=open]:opacity-100"
          >
            <MoreHorizontal className="h-4 w-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52" onClick={(event) => event.stopPropagation()}>
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
              <Layers />
              Move to group
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="max-h-72 w-56 overflow-y-auto">
              {groups.map((entry) => (
                <DropdownMenuItem key={entry.id} onSelect={() => onMove(entry.id, entry.name)}>
                  <GroupDot color={entry.color} />
                  <span className="truncate">{entry.name}</span>
                  {meeting.group_id === entry.id && <Check className="ml-auto !text-af-accent" />}
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
          <DropdownMenuItem onSelect={onExport}>
            <Download />
            Export…
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="danger" onSelect={onDelete}>
            <Trash2 />
            Delete…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <button
        type="button"
        onClick={(event) => { event.stopPropagation(); onToggleExpanded(); }}
        aria-expanded={expanded}
        aria-controls={`meeting-preview-${meeting.id}`}
        aria-label={`${expanded ? 'Collapse' : 'Expand'} details for ${title}`}
        title={expanded ? 'Collapse details' : 'Expand details'}
        className="flex h-7 w-7 items-center justify-center rounded-md text-af-text-3 transition-colors hover:bg-af-active hover:text-af-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-af-accent"
      >
        <ChevronDown className={cn('h-4 w-4 transition-transform', expanded && 'rotate-180')} />
      </button>

      {expanded && (
        <div
          id={`meeting-preview-${meeting.id}`}
          className="col-span-full -mx-3 -mb-2.5 mt-1 border-t border-af-border bg-af-panel px-6 py-4"
          onClick={(event) => event.stopPropagation()}
        >
          {!!meeting.named_participants?.length && (
            <div className="mb-3 flex flex-wrap items-center gap-2 text-xs text-af-text-3">
              <Users className="h-3.5 w-3.5" aria-hidden="true" />
              {meeting.named_participants.map((name) => (
                <span key={name} className="inline-flex items-center gap-1.5 rounded-full border border-af-border bg-af-panel-2 px-2 py-1 text-af-text-2">
                  <Avatar name={name} size="xs" />{name}
                </span>
              ))}
            </div>
          )}
          <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-af-text-4">AI summary</p>
          <p className="mt-1 max-w-3xl text-[13px] leading-relaxed text-af-text-2">
            {excerpt ?? 'No AI summary yet. Open this meeting to generate one.'}
          </p>
          {topics.length > 0 && (
            <div className="mt-3">
              <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-af-text-4">Key topics</p>
              <div className="flex flex-wrap gap-1.5">
                {topics.map((topic, index) => (
                  <span key={`${topic}-${index}`} className="rounded-md border border-af-border bg-af-panel-2 px-2 py-1 text-xs text-af-text-2">{topic}</span>
                ))}
              </div>
            </div>
          )}
          <button type="button" onClick={onOpen} className="mt-3 inline-flex items-center gap-1 text-xs font-semibold text-af-accent hover:underline">
            Open meeting <ArrowUpRight className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
    </li>
  );
}
