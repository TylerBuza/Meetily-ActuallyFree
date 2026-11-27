'use client';

/**
 * One group: when it meets, what is still open from earlier meetings, its
 * meetings (searchable, and existing ones can be added), who comes, and Ask
 * AI across its recent meetings.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'sonner';
import {
  ArrowLeft,
  CalendarClock,
  MoreHorizontal,
  Mic,
  Pencil,
  Plus,
  Search,
  Trash2,
  Users,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useSidebar } from '@/components/Sidebar/SidebarProvider';
import { Button } from '@/components/ui/button';
import { Avatar } from '@/components/ui/avatar';
import { Input } from '@/components/ui/input';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { EmptyState, Skeleton, Panel } from '@/components/ui/surface';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ActionItemsList } from '@/components/actions/ActionItemsList';
import { ChatThread } from '@/components/chat/ChatThread';
import { openGroupEditor } from '@/components/groups/GroupEditor';
import { AddMeetingsDialog } from '@/components/groups/AddMeetingsDialog';
import { kindLabelKey } from '@/components/groups/GroupBits';
import {
  announceChange,
  deleteGroup,
  getGroup,
  getMeetingNotes,
  listActionItems,
  onWorkspaceChange,
  type ActionItem,
  type GroupDetail,
  type GroupMember,
} from '@/lib/workspace-api';
import { describeSchedule, effectiveSchedule, nextOccurrence } from '@/lib/schedule';
import { formatDuration, formatRelativeFuture, formatShortDate, formatWhen, parseDate } from '@/lib/dates';
import { displayTitle } from '@/lib/meeting-titles';
import { completeSummaryMarkdown, parseSummaryData } from '@/lib/summary-markdown';
import { launchRecording } from '@/lib/recording-launch';
import { useI18n } from '@/i18n';

/** Recent summaries, notes and open items: what Ask AI reads for a group. */
async function groupContext(detail: GroupDetail, openItems: ActionItem[]): Promise<string> {
  const parts: string[] = [];
  for (const meeting of detail.meetings.slice(0, 8)) {
    const [summaryResponse, notes] = await Promise.all([
      invoke<{ data?: unknown }>('api_get_summary', { meetingId: meeting.meetingId }).catch(() => null),
      getMeetingNotes(meeting.meetingId).catch(() => null),
    ]);
    const summary = completeSummaryMarkdown(parseSummaryData(summaryResponse?.data)).trim();
    const date = parseDate(meeting.createdAt);
    const lines = [`### ${displayTitle(meeting.title, meeting.createdAt)}${date ? ` (${formatShortDate(date)})` : ''}`];
    if (meeting.present.length) lines.push(`People: ${meeting.present.join(', ')}`);
    lines.push(summary ? summary.slice(0, 2_400) : 'No summary.');
    if (notes?.markdown?.trim()) lines.push(`Notes: ${notes.markdown.trim().slice(0, 800)}`);
    parts.push(lines.join('\n'));
  }
  if (openItems.length) {
    parts.push(
      `### Open action items\n${openItems
        .map((item) => `- ${item.text}${item.personName ?? item.ownerLabel ? ` (${item.personName ?? item.ownerLabel})` : ''}, from ${displayTitle(item.meetingTitle, item.meetingCreatedAt)}`)
        .join('\n')}`,
    );
  }
  return parts.join('\n\n');
}

export function GroupDetailView({ groupId }: { groupId: string }) {
  const router = useRouter();
  const { t } = useI18n();
  const { meetings } = useSidebar();
  const [detail, setDetail] = useState<GroupDetail | null>(null);
  const [missing, setMissing] = useState(false);
  const [query, setQuery] = useState('');
  const [openItems, setOpenItems] = useState<ActionItem[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const contextCache = useRef<{ key: string; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      setDetail(await getGroup(groupId, query.trim() || undefined));
      setMissing(false);
    } catch (error) {
      console.error('Could not load the group', error);
      setMissing(true);
    }
  }, [groupId, query]);

  const loadItems = useCallback(async () => {
    try {
      setOpenItems(await listActionItems({ groupId, openOnly: true, limit: 100 }));
    } catch {
      setOpenItems([]);
    }
  }, [groupId]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), query ? 180 : 0);
    return () => window.clearTimeout(timer);
  }, [load, query]);

  useEffect(() => {
    void loadItems();
  }, [loadItems]);

  useEffect(
    () =>
      onWorkspaceChange(['groups', 'meetings', 'people', 'actions'], (change) => {
        if (change.kind === 'actions' && change.source === 'list') return;
        void load();
        if (change.kind !== 'groups') void loadItems();
      }),
    [load, loadItems],
  );

  const schedule = useMemo(() => {
    if (!detail) return null;
    const starts = meetings.filter((meeting) => meeting.group_id === groupId).map((meeting) => meeting.created_at ?? '');
    const effective = effectiveSchedule(detail.schedule, starts);
    if (!effective) return null;
    return { ...effective, next: nextOccurrence(effective.schedule, new Date(), { heldAt: starts, horizonDays: 31 }) };
  }, [detail, meetings, groupId]);

  if (missing) {
    return (
      <div className="h-full overflow-y-auto bg-af-panel">
        <div className="mx-auto max-w-3xl px-8 pt-16">
          <EmptyState
            icon={<Users />}
            title={t('people.groupGoneTitle')}
            description={t('people.groupGoneDescription')}
            action={<Button variant="secondary" onClick={() => router.push('/groups')}>{t('people.allGroups')}</Button>}
          />
        </div>
      </div>
    );
  }

  const record = () => detail && launchRecording((href) => router.push(href), { group: { id: detail.id, name: detail.name } });
  const members: Array<GroupMember & { frequent: boolean }> = [
    ...(detail?.frequent ?? []).map((member) => ({ ...member, frequent: true })),
    ...(detail?.rare ?? []).map((member) => ({ ...member, frequent: false })),
  ];

  const ask = async (question: string, history: Array<{ question: string; answer: string }>) => {
    if (!detail) throw new Error(t('people.groupStillLoading'));
    const key = `${detail.id}:${detail.meetings.map((meeting) => meeting.meetingId).join(',')}:${openItems?.length ?? 0}`;
    if (contextCache.current?.key !== key) contextCache.current = { key, text: await groupContext(detail, openItems ?? []) };
    if (!contextCache.current.text.trim()) throw new Error(t('people.groupNoMeetingsToRead'));
    const guidance = [
      `The context is a series of meetings in the group "${detail.name}", newest first, with their summaries, notes and the group's open action items. Name the meeting and date when you rely on one.`,
      history.length
        ? `Earlier in this conversation:\n${history.slice(-4).map((turn) => `Q: ${turn.question}\nA: ${turn.answer.slice(0, 800)}`).join('\n\n')}`
        : '',
    ]
      .filter(Boolean)
      .join('\n\n');
    return invoke<string>('ask_live_assistant', { question, transcriptContext: contextCache.current.text, persona: guidance });
  };

  return (
    <div className="h-full overflow-y-auto bg-af-panel">
      <div className="mx-auto w-full max-w-5xl px-8 pb-24 pt-8 animate-af-rise">
        <Link href="/groups" className="inline-flex items-center gap-1.5 rounded-md px-1.5 py-1 text-xs text-af-text-3 transition-colors hover:bg-af-hover hover:text-af-text">
          <ArrowLeft className="h-3.5 w-3.5" />
          {t('people.groupsTitle')}
        </Link>

        <header className="mt-3 flex flex-wrap items-start gap-4">
          <div className="min-w-0 flex-1">
            {detail ? (
              <>
                <h1 className="truncate text-2xl font-semibold tracking-tight text-af-text">{detail.name}</h1>
                <p className="mt-1 text-sm text-af-text-3">
                  {[
                    kindLabelKey(detail.kind) ? t(kindLabelKey(detail.kind)!) : null,
                    t(detail.meetingCount === 1 ? 'people.meetingCountOne' : 'people.meetingCountMany', { count: detail.meetingCount }),
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </p>
                {detail.description && <p className="mt-2 max-w-2xl text-sm leading-relaxed text-af-text-2">{detail.description}</p>}
              </>
            ) : (
              <>
                <Skeleton className="h-7 w-56" />
                <Skeleton className="mt-2 h-4 w-40" />
              </>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <Button variant="record" size="sm" onClick={record} disabled={!detail}>
              <Mic />
              {t('people.record')}
            </Button>
            <Button variant="secondary" size="sm" onClick={() => openGroupEditor({ groupId })} disabled={!detail}>
              <Pencil />
              {t('common.edit')}
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-sm" aria-label={t('people.moreGroupActions')} disabled={!detail}>
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-52">
                <DropdownMenuItem onSelect={() => setAdding(true)}>
                  <Plus />
                  {t('people.addMeetingsEllipsis')}
                </DropdownMenuItem>
                <DropdownMenuItem variant="danger" onSelect={() => setConfirmDelete(true)}>
                  <Trash2 />
                  {t('people.deleteGroupEllipsis')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </header>

        {detail && (
          <div className="mt-5 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-af-border bg-af-panel-2/50 px-4 py-3 text-[13px]">
            <CalendarClock className="h-4 w-4 text-af-text-3" />
            {schedule ? (
              <>
                <span className="text-af-text">{describeSchedule(schedule.schedule)}</span>
                {schedule.next && (
                  <span className="text-af-text-3">
                    · {t('people.nextMeeting', { relative: formatRelativeFuture(schedule.next), when: formatWhen(schedule.next) })}
                  </span>
                )}
                {schedule.source === 'detected' && (
                  <span className="rounded-full bg-af-hover px-2 py-0.5 text-[11px] text-af-text-3">
                    {t('people.detectedFrom', { occurrences: schedule.detected?.occurrences ?? t('people.several') })}
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => openGroupEditor({ groupId, suggestedSchedule: schedule.source === 'detected' ? schedule.detected : undefined })}
                  className="ml-auto rounded-md px-2 py-1 text-xs text-af-text-3 transition-colors hover:bg-af-hover hover:text-af-text"
                >
                  {schedule.source === 'detected' ? t('people.confirmOrChange') : t('people.change')}
                </button>
              </>
            ) : (
              <>
                <span className="text-af-text-3">{t('people.noRegularTime')}</span>
                <button
                  type="button"
                  onClick={() => openGroupEditor({ groupId })}
                  className="ml-auto rounded-md px-2 py-1 text-xs text-af-text-3 transition-colors hover:bg-af-hover hover:text-af-text"
                >
                  {t('people.setSchedule')}
                </button>
              </>
            )}
          </div>
        )}

        <div className="mt-5 grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
          <div className="flex min-w-0 flex-col gap-4">
            <Panel
              title={t('people.stillOpen')}
              action={openItems && openItems.length > 0 ? <span className="text-xs tabular-nums text-af-text-4">{openItems.length}</span> : undefined}
            >
              {openItems === null ? (
                <Skeleton className="h-16" />
              ) : openItems.length === 0 ? (
                <p className="py-2 text-[13px] leading-relaxed text-af-text-3">{t('people.nothingOpen')}</p>
              ) : (
                <ActionItemsList items={openItems} onItemsChange={setOpenItems} className="-mx-2" />
              )}
            </Panel>

            <Panel
              title={t('people.meetingsTitle')}
              action={
                <Button size="xs" variant="ghost" onClick={() => setAdding(true)} disabled={!detail}>
                  <Plus />
                  {t('people.addMeetings')}
                </Button>
              }
            >
              <div className="relative mb-2">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-af-text-4" />
                <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('people.searchGroupMeetings')} className="h-8 pl-9 text-xs" />
              </div>
              {!detail ? (
                <Skeleton className="h-24" />
              ) : detail.meetings.length === 0 ? (
                <p className="py-3 text-[13px] text-af-text-3">
                  {query.trim() ? t('people.noMeetingsMatch') : t('people.noMeetingsYet')}
                </p>
              ) : (
                <ul className="af-appear -mx-1.5">
                  {detail.meetings.map((meeting) => {
                    const date = parseDate(meeting.createdAt);
                    return (
                      <li key={meeting.meetingId}>
                        <Link
                          href={`/meeting-details?id=${encodeURIComponent(meeting.meetingId)}`}
                          className="flex items-center gap-3 rounded-xl px-1.5 py-2 transition-colors hover:bg-af-hover/60"
                        >
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-[13px] font-medium text-af-text">{displayTitle(meeting.title, meeting.createdAt)}</span>
                            <span className="block truncate text-xs text-af-text-3">
                              {[date ? formatWhen(date) : null, formatDuration(meeting.durationSeconds) || null, meeting.present.length ? meeting.present.join(', ') : null]
                                .filter(Boolean)
                                .join(' · ')}
                            </span>
                          </span>
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              )}
            </Panel>
          </div>

          <div className="flex min-w-0 flex-col gap-4">
            <Panel title={t('people.peopleTitle')}>
              {!detail ? (
                <Skeleton className="h-16" />
              ) : members.length === 0 ? (
                <p className="py-2 text-[13px] leading-relaxed text-af-text-3">{t('people.peopleShowUp')}</p>
              ) : (
                <ul className="af-appear -mx-1.5">
                  {members.map((member) => (
                    <li key={member.personId}>
                      <Link
                        href={`/person?id=${encodeURIComponent(member.personId)}`}
                        className="flex items-center gap-2.5 rounded-xl px-1.5 py-1.5 transition-colors hover:bg-af-hover/60"
                      >
                        <Avatar name={member.displayName} size="sm" />
                        <span className="min-w-0 flex-1 truncate text-[13px] text-af-text">{member.displayName}</span>
                        <span className="shrink-0 text-[11px] tabular-nums text-af-text-4">
                          {member.frequent ? t('people.usuallyHere') : `${member.meetingCount}×`}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>

            <Panel title={t('people.askAboutGroup')} className="flex h-[26rem] flex-col p-0 pt-4 [&>header]:px-4">
              <ChatThread
                historyKey={`group:${groupId}`}
                ask={ask}
                compact
                emptyTitle={t('people.groupAskEmptyTitle')}
                emptyHint={t('people.groupAskEmptyHint')}
                suggestions={[t('people.suggestionWhatHappened'), t('people.suggestionStillOpen'), t('people.suggestionDecided')]}
                placeholder={t('people.askAboutGroupPlaceholder')}
                className="min-h-0 flex-1"
              />
            </Panel>
          </div>
        </div>
      </div>

      {detail && <AddMeetingsDialog open={adding} onOpenChange={setAdding} group={{ id: detail.id, name: detail.name }} />}

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        variant="danger"
        title={t('people.deleteGroupTitle', { name: detail?.name ?? t('people.thisGroup') })}
        description={t('people.deleteGroupDescription')}
        confirmLabel={t('people.deleteGroup')}
        onConfirm={async () => {
          try {
            await deleteGroup(groupId);
            announceChange('groups');
            announceChange('meetings');
            toast.success(t('people.groupDeleted'));
            router.push('/groups');
          } catch (error) {
            toast.error(t('people.couldNotDeleteGroup'), { description: error instanceof Error ? error.message : String(error) });
          }
        }}
      />
    </div>
  );
}
