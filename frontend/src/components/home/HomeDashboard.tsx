'use client';

/**
 * What sits behind the record card while nothing is recording. It is meant to
 * read as a backdrop, not a dashboard: the time and date, the next meetings of
 * recurring groups (or recent meetings when nothing is scheduled), and what is
 * still open. Everything is quiet until you point at it.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useWorkspace } from '@/contexts/WorkspaceContext';
import { useSidebar } from '@/components/Sidebar/SidebarProvider';
import { usePermissionCheck } from '@/hooks/usePermissionCheck';
import { PermissionWarning } from '@/components/PermissionWarning';
import { listActionItems, onWorkspaceChange, type ActionItem } from '@/lib/workspace-api';
import { upcomingGroupMeetings } from '@/lib/schedule';
import { formatRelativeFuture, formatWhen, parseDate } from '@/lib/dates';
import { displayTitle } from '@/lib/meeting-titles';
import { launchRecording } from '@/lib/recording-launch';

const LIST_LENGTH = 3;

/** Re-renders on the minute so the clock and relative times stay true. */
function useNow(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    let timer = 0;
    const tick = () => {
      setNow(new Date());
      timer = window.setTimeout(tick, 60_000 - (Date.now() % 60_000));
    };
    timer = window.setTimeout(tick, 60_000 - (Date.now() % 60_000));
    return () => window.clearTimeout(timer);
  }, []);
  return now;
}

function Column({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="min-w-0">
      <h2 className="af-appear mb-2 text-xs font-medium text-af-text-4">{title}</h2>
      <ul className="space-y-0.5">{children}</ul>
    </section>
  );
}

/** Rows rise in one after another as their data arrives. */
const appearAt = (index: number) => ({ className: 'af-appear', style: { '--af-i': index } as React.CSSProperties });

const rowClass =
  'group/row -mx-2 flex min-w-0 items-baseline gap-3 rounded-lg px-2 py-1.5 text-[13px] text-af-text-3 transition-colors hover:bg-af-hover/60 hover:text-af-text';

function useOpenItems() {
  const [items, setItems] = useState<ActionItem[] | null>(null);
  const load = useCallback(async () => {
    try {
      setItems(await listActionItems({ openOnly: true, limit: 60 }));
    } catch {
      setItems([]);
    }
  }, []);
  useEffect(() => {
    void load();
    return onWorkspaceChange(['actions', 'meetings', 'people'], () => void load());
  }, [load]);
  return items;
}

export function HomeDashboard() {
  const now = useNow();
  const { groups } = useWorkspace();
  const { meetings } = useSidebar();
  const openItems = useOpenItems();
  const { hasMicrophone, hasSystemAudio, isChecking, requestPermissions } = usePermissionCheck();

  const upcoming = useMemo(
    () =>
      upcomingGroupMeetings(
        groups,
        meetings.map((meeting) => ({ groupId: meeting.group_id, startedAt: meeting.created_at ?? '' })),
        now,
      ).slice(0, LIST_LENGTH),
    [groups, meetings, now],
  );
  const recent = useMemo(
    () => [...meetings].sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? '')).slice(0, LIST_LENGTH),
    [meetings],
  );

  const time = now.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }).replace(/ /g, ' ');
  const date = now.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  const hasHistory = meetings.length > 0;

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex min-h-full w-full max-w-3xl flex-col px-10 pb-44 pt-[12vh]">
        {!isChecking && (
          <PermissionWarning
            hasMicrophone={hasMicrophone}
            hasSystemAudio={hasSystemAudio}
            onRecheck={requestPermissions}
            isRechecking={isChecking}
            className="mb-10"
          />
        )}

        <div className="af-appear text-center">
          <p className="text-7xl font-extralight tracking-tight text-af-text/85 tabular-nums">{time}</p>
          <p className="mt-2 text-base text-af-text-3">{date}</p>
        </div>

        {hasHistory ? (
          <div className="mt-16 grid gap-10 sm:grid-cols-2">
            {upcoming.length > 0 ? (
              <Column title="Up next">
                {upcoming.map(({ group, at }, index) => {
                  const soon = at.getTime() - now.getTime() <= 10 * 60_000;
                  return (
                    <li key={group.id} {...appearAt(index + 1)}>
                      <button
                        type="button"
                        onClick={() => launchRecording(() => undefined, { group: { id: group.id, name: group.name } })}
                        className={`${rowClass} w-full text-left`}
                        title={`Record a ${group.name} meeting`}
                      >
                        <span className="min-w-0 flex-1 truncate">{group.name}</span>
                        <span className={`shrink-0 text-xs tabular-nums group-hover/row:hidden ${soon ? 'text-af-accent' : 'text-af-text-4'}`}>
                          {soon ? 'Now' : formatRelativeFuture(at, now)}
                        </span>
                        <span className="hidden shrink-0 text-xs font-medium text-af-record group-hover/row:inline">Record</span>
                      </button>
                    </li>
                  );
                })}
              </Column>
            ) : (
              <Column title="Recent">
                {recent.map((meeting, index) => {
                  const started = parseDate(meeting.created_at);
                  return (
                    <li key={meeting.id} {...appearAt(index + 1)}>
                      <Link href={`/meeting-details?id=${encodeURIComponent(meeting.id)}`} className={rowClass}>
                        <span className="min-w-0 flex-1 truncate">{displayTitle(meeting.title, meeting.created_at)}</span>
                        <span className="shrink-0 text-xs text-af-text-4">{started ? formatWhen(started, now) : ''}</span>
                      </Link>
                    </li>
                  );
                })}
              </Column>
            )}

            <Column title={openItems && openItems.length > LIST_LENGTH ? `Open action items · ${openItems.length}` : 'Open action items'}>
              {openItems === null ? null : openItems.length === 0 ? (
                <li className="af-appear py-1.5 text-[13px] text-af-text-4">Nothing open</li>
              ) : (
                openItems.slice(0, LIST_LENGTH).map((item, index) => {
                  const params = new URLSearchParams({ id: item.meetingId });
                  if (item.transcriptId) params.set('t', item.transcriptId);
                  if (item.audioTime != null) params.set('ts', String(Math.floor(item.audioTime)));
                  const owner = item.personName ?? item.ownerLabel;
                  return (
                    <li key={item.id} {...appearAt(index + 2)}>
                      <Link href={`/meeting-details?${params.toString()}`} className={rowClass} title={displayTitle(item.meetingTitle, item.meetingCreatedAt)}>
                        <span className="min-w-0 flex-1 truncate">{item.text}</span>
                        {owner && <span className="shrink-0 text-xs text-af-text-4">{/^you$/i.test(owner) ? 'You' : owner}</span>}
                      </Link>
                    </li>
                  );
                })
              )}
            </Column>
          </div>
        ) : (
          <p className="af-appear mx-auto mt-14 max-w-sm text-center text-[13px] leading-relaxed text-af-text-3">
            Press the red button to record your first meeting. Meetily transcribes it on this computer and writes a summary when you stop.
          </p>
        )}
      </div>
    </div>
  );
}
