'use client';

/** Every group in one list: what it is, how active it is, and when it meets next. */
import { useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { Layers, Mic, MoreHorizontal, Pencil, Plus } from 'lucide-react';
import { useWorkspace } from '@/contexts/WorkspaceContext';
import { useSidebar } from '@/components/Sidebar/SidebarProvider';
import { Button } from '@/components/ui/button';
import { EmptyState, PageHeader, Skeleton } from '@/components/ui/surface';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { openGroupEditor } from '@/components/groups/GroupEditor';
import { upcomingGroupMeetings } from '@/lib/schedule';
import { formatRelativeFuture, formatRelativePast, parseDate } from '@/lib/dates';
import { kindLabel, type GroupSummary } from '@/lib/workspace-api';
import { launchRecording } from '@/lib/recording-launch';

export function GroupsList() {
  const router = useRouter();
  const { groups, groupsLoaded } = useWorkspace();
  const { meetings } = useSidebar();

  const nextMeeting = useMemo(() => {
    const list = upcomingGroupMeetings(
      groups,
      meetings.map((meeting) => ({ groupId: meeting.group_id, startedAt: meeting.created_at ?? '' })),
      new Date(),
      31,
    );
    return new Map(list.map((entry) => [entry.group.id, entry.at]));
  }, [groups, meetings]);

  const sorted = useMemo(
    () => [...groups].sort((a, b) => (b.lastMeetingAt ?? b.createdAt).localeCompare(a.lastMeetingAt ?? a.createdAt)),
    [groups],
  );

  const create = () => openGroupEditor({ onSaved: (group) => router.push(`/groups?id=${encodeURIComponent(group.id)}`) });

  return (
    <div className="h-full overflow-y-auto bg-af-panel">
      <div className="mx-auto w-full max-w-4xl px-8 pb-24 pt-10 animate-af-rise">
        <PageHeader
          title="Groups"
          description="Keep a series of meetings together: a recurring meeting, a customer, a team or a project."
          actions={
            <Button size="sm" onClick={create}>
              <Plus />
              New group
            </Button>
          }
        />

        <div className="mt-8">
          {!groupsLoaded ? (
            <div className="space-y-2">
              {[0, 1, 2].map((index) => (
                <Skeleton key={index} className="h-14 rounded-xl" />
              ))}
            </div>
          ) : sorted.length === 0 ? (
            <EmptyState
              icon={<Layers />}
              title="No groups yet"
              description="Make one for a standup, a customer or a team, then file meetings into it from the meeting page, the sidebar or All meetings."
              action={
                <Button onClick={create}>
                  <Plus />
                  New group
                </Button>
              }
            />
          ) : (
            <>
              <div className="hidden grid-cols-[minmax(0,1fr)_8rem_8rem_2rem] gap-4 px-4 pb-2 text-xs text-af-text-4 sm:grid">
                <span>Name</span>
                <span>Last meeting</span>
                <span>Next</span>
                <span />
              </div>
              <ul className="af-appear divide-y divide-af-border overflow-hidden rounded-xl border border-af-border">
                {sorted.map((group) => (
                  <GroupRow key={group.id} group={group} next={nextMeeting.get(group.id) ?? null} />
                ))}
              </ul>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function GroupRow({ group, next }: { group: GroupSummary; next: Date | null }) {
  const router = useRouter();
  const last = parseDate(group.lastMeetingAt);
  const open = () => router.push(`/groups?id=${encodeURIComponent(group.id)}`);
  const details = [kindLabel(group.kind), `${group.meetingCount} meeting${group.meetingCount === 1 ? '' : 's'}`, group.description]
    .filter(Boolean)
    .join(' · ');

  return (
    <li
      role="link"
      tabIndex={0}
      onClick={open}
      onKeyDown={(event) => event.key === 'Enter' && open()}
      className="group/row grid cursor-pointer grid-cols-[minmax(0,1fr)_2rem] items-center gap-4 px-4 py-3 outline-none transition-colors hover:bg-af-hover/60 focus-visible:bg-af-hover/60 sm:grid-cols-[minmax(0,1fr)_8rem_8rem_2rem]"
    >
      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-af-text">{group.name}</p>
        <p className="truncate text-xs text-af-text-3">{details}</p>
      </div>
      <span className="hidden text-xs text-af-text-3 sm:block">{last ? formatRelativePast(last) : '—'}</span>
      <span className="hidden text-xs text-af-text-3 sm:block">
        {next ? `${formatRelativeFuture(next)}, ${next.toLocaleDateString(undefined, { weekday: 'short' })}` : '—'}
      </span>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            onClick={(event) => event.stopPropagation()}
            aria-label={`Actions for ${group.name}`}
            className="flex h-7 w-7 items-center justify-center rounded-md text-af-text-3 opacity-0 transition-[opacity,background-color] hover:bg-af-active hover:text-af-text focus-visible:opacity-100 group-hover/row:opacity-100 data-[state=open]:opacity-100"
          >
            <MoreHorizontal className="h-4 w-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-48" onClick={(event) => event.stopPropagation()}>
          <DropdownMenuItem onSelect={() => launchRecording((href) => router.push(href), { group: { id: group.id, name: group.name } })}>
            <Mic />
            Record a meeting
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => openGroupEditor({ groupId: group.id })}>
            <Pencil />
            Edit group
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  );
}
