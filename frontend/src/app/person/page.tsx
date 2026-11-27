'use client';

/**
 * A contact's page: who they are, what they owe or are owed (action items
 * from meetings, each linked back), every meeting you shared, private notes,
 * and Ask AI across their meetings.
 *
 * The ID lives in `/person?id=...` (not a dynamic segment) so the static
 * export needs no list of people at build time.
 */
import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'sonner';
import {
  ArrowLeft,
  Fingerprint,
  GitMerge,
  Mail,
  MoreHorizontal,
  Pencil,
  Phone,
  Trash2,
  UserRound,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useWorkspace } from '@/contexts/WorkspaceContext';
import { useAutosave, saveStateLabel } from '@/hooks/useAutosave';
import { useLabs } from '@/hooks/useLabs';
import { useVoiceProfiles } from '@/hooks/useVoiceProfiles';
import { Badge } from '@/components/ui/badge';
import { describeVoiceError, describeVoiceSource, forgetVoice, learnContactVoice } from '@/lib/voice-profiles';
import { Avatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { EmptyState, Skeleton, Panel } from '@/components/ui/surface';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ActionItemsList } from '@/components/actions/ActionItemsList';
import { ChatThread } from '@/components/chat/ChatThread';
import { GroupChip } from '@/components/groups/GroupBits';
import { ContactDialog } from '@/components/people/ContactDialog';
import { MergeContactsDialog } from '@/components/people/MergeContactsDialog';
import {
  announceChange,
  deletePerson,
  listActionItems,
  onWorkspaceChange,
  updatePersonNotes,
  type ActionItem,
} from '@/lib/workspace-api';
import { formatRelativePast, formatShortDate, formatWhen, parseDate } from '@/lib/dates';
import { displayTitle } from '@/lib/meeting-titles';
import type { PersonProfile } from '@/types';
import { tNow, useI18n } from '@/i18n';

const OVERVIEW_PROMPT =
  'Create a concise profile overview of this person based only on their meeting records. Cover recurring topics, decisions, commitments, collaboration patterns, and recent changes. Cite the meeting title and date for every substantive point, and keep recorded facts apart from inference.';

function speakingTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return tNow('people.durationZero');
  const minutes = Math.max(1, Math.round(seconds / 60));
  const hours = Math.floor(minutes / 60);
  return hours > 0
    ? tNow('people.durationHours', { hours, minutes: minutes % 60 })
    : tNow('people.durationMinutes', { minutes });
}

function PrivateNotes({ personId, initial }: { personId: string; initial: string }) {
  const { t } = useI18n();
  const [notes, setNotes] = useState(initial);
  const saver = useAutosave<string>(async (value) => {
    await updatePersonNotes(personId, value);
  });
  useEffect(() => setNotes(initial), [initial]);
  return (
    <Panel
      title={t('people.privateNotes')}
      action={saver.state !== 'idle' ? <span className="text-[11px] text-af-text-4">{saveStateLabel(saver.state)}</span> : undefined}
    >
      <Textarea
        value={notes}
        onChange={(event) => {
          setNotes(event.target.value);
          saver.schedule(event.target.value);
        }}
        rows={5}
        placeholder={t('people.notesPlaceholder')}
        className="resize-y text-[13px] leading-relaxed"
      />
      <p className="mt-2 text-[11px] leading-relaxed text-af-text-4">{t('people.notesHint')}</p>
    </Panel>
  );
}

/**
 * Labs voice profiles: learn this contact's voice from their meetings, so
 * later meetings name a matching speaker after them. Shown while the Labs
 * switch is on, or when a voice was learned before it was turned off.
 */
function VoicePanel({ personId, first, meetingCount }: { personId: string; first: string; meetingCount: number }) {
  const { t } = useI18n();
  const { labs } = useLabs();
  const voices = useVoiceProfiles();
  const voice = voices?.find((profile) => profile.person_id === personId);
  const [busy, setBusy] = useState<'learn' | 'forget' | null>(null);
  const who = first || t('people.them');

  if (!labs.voiceProfiles && !voice) return null;

  // Reads all their recent meetings, so an update picks up new ones.
  const learn = async () => {
    const updating = !!voice;
    setBusy('learn');
    try {
      const learned = await learnContactVoice(personId);
      toast.success(t(updating ? 'people.updatedVoice' : 'people.learnedVoice', { name: first || learned.name }), {
        description: t('people.voiceFromSource', { source: describeVoiceSource(learned) }),
      });
    } catch (error) {
      toast.error(t(updating ? 'people.couldNotUpdateVoice' : 'people.couldNotLearnVoice', { name: who }), { description: describeVoiceError(error) });
    } finally {
      setBusy(null);
    }
  };

  const forget = async () => {
    setBusy('forget');
    try {
      await forgetVoice(personId);
      toast.success(t('people.forgotVoice', { name: who }));
    } catch (error) {
      toast.error(t('people.couldNotForgetVoice'), { description: describeVoiceError(error) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <Panel title={t('people.voice')} action={<Badge variant="accent" size="xs">{t('people.labsBadge')}</Badge>}>
      {voices === null ? (
        <Skeleton className="h-16" />
      ) : voice ? (
        <>
          <p className="flex items-center gap-2 text-[13px] font-medium text-af-text">
            <Fingerprint className="h-4 w-4 shrink-0 text-af-accent" />
            {first ? t('people.knowsVoiceNamed', { name: first }) : t('people.knowsVoiceTheir')}
          </p>
          <p className="mt-1 text-xs leading-relaxed text-af-text-3">
            {labs.voiceProfiles
              ? t('people.voiceLearnedDescription', { source: describeVoiceSource(voice), name: first || voice.name })
              : t('people.voiceProfilesOff')}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            {labs.voiceProfiles && (
              <Button size="sm" variant="secondary" onClick={() => void learn()} loading={busy === 'learn'} disabled={busy !== null}>
                <Fingerprint />
                {t('people.updateVoice')}
              </Button>
            )}
            <Button size="sm" variant="danger-ghost" onClick={() => void forget()} loading={busy === 'forget'} disabled={busy !== null}>
              {t('people.forgetVoice')}
            </Button>
          </div>
        </>
      ) : (
        <>
          <p className="text-[13px] leading-relaxed text-af-text-3">
            {meetingCount > 0
              ? first
                ? t('people.learnVoiceHintNamed', { name: first })
                : t('people.learnVoiceHintTheir')
              : t('people.learnVoiceOnce', { name: who })}
          </p>
          <Button className="mt-3" size="sm" onClick={() => void learn()} loading={busy === 'learn'} disabled={meetingCount === 0 || busy !== null}>
            <Fingerprint />
            {t('people.learnVoice')}
          </Button>
        </>
      )}
    </Panel>
  );
}

function PersonPageInner() {
  const router = useRouter();
  const { t } = useI18n();
  const personId = useSearchParams().get('id');
  const { personById } = useWorkspace();
  const [profile, setProfile] = useState<PersonProfile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [items, setItems] = useState<ActionItem[] | null>(null);
  const [showDone, setShowDone] = useState(false);
  const [editing, setEditing] = useState(false);
  const [merging, setMerging] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const load = useCallback(async () => {
    if (!personId) return;
    try {
      setProfile(await invoke<PersonProfile>('api_get_person_profile', { personId }));
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, [personId]);

  const loadItems = useCallback(async () => {
    if (!personId) return;
    try {
      setItems(await listActionItems({ personId, limit: 200 }));
    } catch {
      setItems([]);
    }
  }, [personId]);

  useEffect(() => {
    setProfile(null);
    setItems(null);
    void load();
    void loadItems();
  }, [load, loadItems]);

  useEffect(
    () =>
      onWorkspaceChange(['people', 'actions', 'meetings', 'groups'], (change) => {
        if (change.kind === 'actions' && change.source === 'list') return;
        void load();
        void loadItems();
      }),
    [load, loadItems],
  );

  const shownItems = useMemo(() => (items ?? []).filter((item) => showDone || !item.done), [items, showDone]);
  const doneCount = (items ?? []).filter((item) => item.done).length;

  if (!personId) {
    return (
      <div className="h-full overflow-y-auto bg-af-panel">
        <div className="mx-auto max-w-3xl px-8 pt-16">
          <EmptyState icon={<UserRound />} title={t('people.noOneSelected')} description={t('people.noOneSelectedDescription')} />
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="h-full overflow-y-auto bg-af-panel">
        <div className="mx-auto max-w-3xl px-8 pt-16">
          <EmptyState
            icon={<UserRound />}
            title={t('people.contactCantBeShown')}
            description={error}
            action={
              <div className="flex gap-2">
                <Button variant="secondary" onClick={() => void load()}>
                  {t('common.tryAgain')}
                </Button>
                <Button variant="ghost" onClick={() => router.push('/contacts')}>
                  {t('people.allContacts')}
                </Button>
              </div>
            }
          />
        </div>
      </div>
    );
  }

  const first = profile?.displayName.split(/\s+/)[0] ?? '';
  const last = parseDate(profile?.lastSeenAt);
  const since = parseDate(profile?.firstSeenAt);
  const overviewSuggestion = t('people.overviewSuggestion');

  const ask = async (question: string) => {
    const prompt = question === overviewSuggestion ? OVERVIEW_PROMPT : question;
    return invoke<string>('ask_person', { personId, question: prompt });
  };

  return (
    <div className="h-full overflow-y-auto bg-af-panel">
      <div className="mx-auto w-full max-w-5xl px-8 pb-24 pt-8 animate-af-rise">
        <Link href="/contacts" className="inline-flex items-center gap-1.5 rounded-md px-1.5 py-1 text-xs text-af-text-3 transition-colors hover:bg-af-hover hover:text-af-text">
          <ArrowLeft className="h-3.5 w-3.5" />
          {t('people.contactsTitle')}
        </Link>

        <header className="mt-3 flex flex-wrap items-start gap-4">
          {profile ? <Avatar name={profile.displayName} size="xl" /> : <Skeleton className="h-14 w-14 rounded-full" />}
          <div className="min-w-0 flex-1">
            {profile ? (
              <>
                <h1 className="truncate text-2xl font-semibold tracking-tight text-af-text">{profile.displayName}</h1>
                {(profile.role || profile.company) && (
                  <p className="mt-0.5 text-sm text-af-text-2">{[profile.role, profile.company].filter(Boolean).join(' · ')}</p>
                )}
                <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-af-text-3">
                  {profile.email && (
                    <a href={`mailto:${profile.email}`} className="inline-flex items-center gap-1.5 hover:text-af-accent">
                      <Mail className="h-3.5 w-3.5" />
                      {profile.email}
                    </a>
                  )}
                  {profile.phone && (
                    <span className="inline-flex items-center gap-1.5">
                      <Phone className="h-3.5 w-3.5" />
                      {profile.phone}
                    </span>
                  )}
                  <span>
                    {profile.meetingCount > 0 ? (
                      <>
                        {t(profile.meetingCount === 1 ? 'people.meetingsTogetherOne' : 'people.meetingsTogetherMany', { count: profile.meetingCount })}
                        {last ? ` · ${t('people.lastSeen', { when: formatRelativePast(last) })}` : ''}
                        {since ? ` · ${t('people.sinceDate', { when: formatShortDate(since) })}` : ''}
                      </>
                    ) : (
                      t('people.notInMeetingYet')
                    )}
                  </span>
                  {profile.totalSpeakingSeconds > 0 && <span>{t('people.speaking', { duration: speakingTime(profile.totalSpeakingSeconds) })}</span>}
                </div>
                {(profile.groups ?? []).length > 0 && (
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {(profile.groups ?? []).map((group) => (
                      <GroupChip key={group.id} group={group} onClick={() => router.push(`/groups?id=${encodeURIComponent(group.id)}`)} />
                    ))}
                  </div>
                )}
              </>
            ) : (
              <>
                <Skeleton className="h-7 w-56" />
                <Skeleton className="mt-2 h-4 w-72" />
              </>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <Button variant="secondary" size="sm" onClick={() => setEditing(true)} disabled={!profile}>
              <Pencil />
              {t('common.edit')}
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-sm" aria-label={t('people.moreContactActions')} disabled={!profile}>
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-52">
                <DropdownMenuItem onSelect={() => setMerging(true)}>
                  <GitMerge />
                  {t('people.mergeIntoEllipsis')}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="danger" onSelect={() => setConfirmDelete(true)}>
                  <Trash2 />
                  {t('people.deleteContactEllipsis')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </header>

        <div className="mt-6 grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
          <div className="flex min-w-0 flex-col gap-4">
            <Panel
              title={t('people.actionItems')}
              action={
                doneCount > 0 ? (
                  <button
                    type="button"
                    onClick={() => setShowDone((value) => !value)}
                    className="rounded-md px-1.5 py-1 text-xs text-af-text-3 transition-colors hover:bg-af-hover hover:text-af-text"
                  >
                    {showDone ? t('people.hideDone') : t('people.showDone', { count: doneCount })}
                  </button>
                ) : undefined
              }
            >
              {items === null ? (
                <Skeleton className="h-16" />
              ) : shownItems.length === 0 ? (
                <p className="py-2 text-[13px] leading-relaxed text-af-text-3">
                  {items.length === 0 ? t('people.nothingAssigned', { name: first || t('people.them') }) : t('people.everythingDone')}
                </p>
              ) : (
                <ActionItemsList
                  items={shownItems}
                  onItemsChange={(next) =>
                    setItems((current) => {
                      const byId = new Map(next.map((item) => [item.id, item]));
                      const shownIds = new Set(shownItems.map((item) => item.id));
                      return (current ?? []).flatMap((item) => (shownIds.has(item.id) ? (byId.has(item.id) ? [byId.get(item.id)!] : []) : [item]));
                    })
                  }
                  showOwner={false}
                  className="-mx-2"
                />
              )}
            </Panel>

            <Panel
              title={t('people.meetingsTogether')}
              action={
                profile && profile.meetings.length > 0 ? (
                  <Link
                    href={`/meetings?person=${encodeURIComponent(profile.id)}`}
                    className="inline-flex items-center gap-1.5 rounded-md px-1.5 py-1 text-xs text-af-text-3 transition-colors hover:bg-af-hover hover:text-af-text"
                  >
                    <span className="tabular-nums text-af-text-4">{profile.meetings.length}</span>
                    {t('people.openInAllMeetings')}
                  </Link>
                ) : undefined
              }
            >
              {!profile ? (
                <Skeleton className="h-24" />
              ) : profile.meetings.length === 0 ? (
                <p className="py-2 text-[13px] text-af-text-3">{t('people.meetingsAppearOnce', { name: first || t('people.they') })}</p>
              ) : (
                <ul className="af-appear -mx-1.5">
                  {profile.meetings.map((meeting) => {
                    const date = parseDate(meeting.createdAt);
                    return (
                      <li key={meeting.meetingId}>
                        <Link
                          href={`/meeting-details?id=${encodeURIComponent(meeting.meetingId)}`}
                          className="block rounded-xl px-1.5 py-2 transition-colors hover:bg-af-hover/60"
                        >
                          <span className="flex items-baseline justify-between gap-3">
                            <span className="truncate text-[13px] font-medium text-af-text">{displayTitle(meeting.title, meeting.createdAt)}</span>
                            <span className="shrink-0 text-[11px] tabular-nums text-af-text-4">{date ? formatWhen(date) : ''}</span>
                          </span>
                          <span className="mt-0.5 block text-xs text-af-text-3">
                            {t(meeting.messageCount === 1 ? 'people.linesAndSpeakingOne' : 'people.linesAndSpeakingMany', {
                              count: meeting.messageCount,
                              duration: speakingTime(meeting.speakingSeconds),
                            })}
                          </span>
                          {meeting.excerpt && (
                            <span className="mt-1.5 block border-l-2 border-af-border-strong pl-2.5 text-xs leading-relaxed text-af-text-2">
                              “{meeting.excerpt}”
                            </span>
                          )}
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              )}
            </Panel>
          </div>

          <div className="flex min-w-0 flex-col gap-4">
            {profile && <PrivateNotes personId={profile.id} initial={profile.notes ?? ''} />}
            {profile && <VoicePanel personId={profile.id} first={first} meetingCount={profile.meetingCount} />}
            <Panel title={t('people.askAbout', { name: first || t('people.them') })} className="flex h-[28rem] flex-col p-0 pt-4 [&>header]:px-4">
              <ChatThread
                historyKey={`person:${personId}`}
                ask={ask}
                compact
                emptyTitle={t('people.personAskEmptyTitle')}
                emptyHint={t('people.personAskEmptyHint')}
                suggestions={[overviewSuggestion, t('people.suggestionCommitments'), t('people.suggestionLastTime')]}
                placeholder={t('people.askAboutPlaceholder', { name: first || t('people.them') })}
                footnote={t('people.personAskFootnote')}
                className="min-h-0 flex-1"
              />
            </Panel>
          </div>
        </div>
      </div>

      <ContactDialog
        open={editing}
        onOpenChange={setEditing}
        contact={profile ? { id: profile.id, displayName: profile.displayName, role: profile.role, company: profile.company, email: profile.email, phone: profile.phone } : null}
        onSaved={() => void load()}
      />
      <MergeContactsDialog
        open={merging}
        onOpenChange={setMerging}
        personIds={profile && personById(profile.id) ? [profile.id] : []}
        onMerged={(kept) => router.replace(`/person?id=${encodeURIComponent(kept.id)}`)}
      />
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        variant="danger"
        title={t('people.deleteContactTitle', { name: profile?.displayName ?? t('people.thisContact') })}
        description={t('people.deleteContactDescription')}
        confirmLabel={t('people.deleteContact')}
        onConfirm={async () => {
          if (!profile) return;
          try {
            await deletePerson(profile.id);
            announceChange('people');
            announceChange('actions');
            toast.success(t('people.contactDeleted'));
            router.push('/contacts');
          } catch (reason) {
            toast.error(t('people.couldNotDeleteTheContact'), { description: reason instanceof Error ? reason.message : String(reason) });
          }
        }}
      />
    </div>
  );
}

export default function PersonPage() {
  return (
    <Suspense fallback={<div className="h-full bg-af-panel" />}>
      <PersonPageInner />
    </Suspense>
  );
}
