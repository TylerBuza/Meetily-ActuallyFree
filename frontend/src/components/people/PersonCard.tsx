'use client';

/**
 * The card that opens when you click a speaker. For a known contact: who they
 * are, how often you meet, their groups and open action items, and a link to
 * their profile. For an unidentified voice: identify, "this is me", or merge.
 * With Labs voice profiles on, a contact's voice can be learned from here.
 */
import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowUpRight, CheckCircle2, Circle, Fingerprint, GitMerge, UserCheck, UserRoundSearch } from 'lucide-react';
import { toast } from 'sonner';
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover';
import { Avatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { GroupChip } from '@/components/groups/GroupBits';
import { useWorkspace } from '@/contexts/WorkspaceContext';
import { useUserName } from '@/hooks/useUserName';
import { useLabs } from '@/hooks/useLabs';
import { useVoiceProfiles } from '@/hooks/useVoiceProfiles';
import { describeVoiceError, describeVoiceSource, learnSpeakerVoice } from '@/lib/voice-profiles';
import { listActionItems, type ActionItem } from '@/lib/workspace-api';
import { formatRelativePast, parseDate } from '@/lib/dates';
import { displaySpeaker, isUserSpeaker, speakerDot, splitSpeakerLabel } from '@/utils/speakerUtils';
import { cn } from '@/lib/utils';
import { useI18n } from '@/i18n';

export interface PersonCardTarget {
  speaker: string;
  segmentId: string;
  rect: DOMRect;
}

export function PersonCard({
  target,
  onClose,
  lineCount,
  onIdentify,
  onMerge,
  onMarkMe,
  colorIndex,
  meetingId,
}: {
  target: PersonCardTarget | null;
  onClose: () => void;
  /** The speaker's colour slot in this meeting. */
  colorIndex?: number;
  /** A saved meeting, where a contact's voice can be learned. */
  meetingId?: string;
  /** Lines this speaker has in the meeting. */
  lineCount?: number;
  onIdentify: (speaker: string, segmentId: string) => void;
  onMerge?: (speaker: string) => void;
  onMarkMe?: (speaker: string) => void;
}) {
  const router = useRouter();
  const { t } = useI18n();
  const { people } = useWorkspace();
  const userName = useUserName();
  const [openItems, setOpenItems] = useState<ActionItem[]>([]);
  const { labs } = useLabs();
  const voices = useVoiceProfiles(labs.voiceProfiles && !!meetingId);
  const [learning, setLearning] = useState(false);
  const speaker = target?.speaker ?? '';
  const isYou = isUserSpeaker(speaker);
  const contact = useMemo(
    () => (isYou ? undefined : people.find((person) => person.displayName.toLowerCase() === speaker.trim().toLowerCase())),
    [people, speaker, isYou],
  );

  useEffect(() => {
    setOpenItems([]);
    if (!contact) return;
    let cancelled = false;
    void listActionItems({ personId: contact.id, openOnly: true, limit: 4 })
      .then((items) => !cancelled && setOpenItems(items))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [contact]);

  const lastSeen = parseDate(contact?.lastSeenAt);
  const label = displaySpeaker(speaker, userName);
  const voice = contact ? voices?.find((profile) => profile.person_id === contact.id) : undefined;
  const canLearnVoice = !!contact && !!meetingId && labs.voiceProfiles && voices !== null;

  // Adds this meeting's audio to the voice (or starts it).
  const learnVoice = async () => {
    if (!contact || !meetingId || learning) return;
    const updating = !!voice;
    setLearning(true);
    try {
      const profile = await learnSpeakerVoice(meetingId, speaker);
      toast.success(t(updating ? 'people.updatedVoice' : 'people.learnedVoice', { name: profile.name }), {
        description: updating
          ? t('people.voiceNowFromSource', { source: describeVoiceSource(profile) })
          : t('people.voiceFromSourceLater', { source: describeVoiceSource(profile) }),
      });
    } catch (error) {
      toast.error(t(updating ? 'people.couldNotUpdateVoice' : 'people.couldNotLearnVoice', { name: contact.displayName }), {
        description: describeVoiceError(error),
      });
    } finally {
      setLearning(false);
    }
  };

  return (
    <Popover open={!!target} onOpenChange={(open) => !open && onClose()}>
      {target && (
        <PopoverAnchor asChild>
          <span
            aria-hidden
            className="pointer-events-none fixed"
            style={{ left: target.rect.left, top: target.rect.top, width: target.rect.width, height: target.rect.height }}
          />
        </PopoverAnchor>
      )}
      <PopoverContent align="start" side="bottom" className="w-80 p-0">
        {target && (
          <div className="animate-af-pop">
            <div className="flex items-start gap-3 p-4">
              {contact || isYou ? (
                <Avatar name={isYou ? userName || t('people.you') : contact!.displayName} size="lg" />
              ) : (
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-dashed border-af-border-strong">
                  <span className={cn('h-3 w-3 rounded-full', speakerDot(speaker, colorIndex))} />
                </span>
              )}
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold text-af-text">{label}</p>
                {contact && (contact.role || contact.company) && (
                  <p className="truncate text-xs text-af-text-3">{[contact.role, contact.company].filter(Boolean).join(' · ')}</p>
                )}
                {contact ? (
                  <p className="mt-1 text-[11px] text-af-text-4">
                    {t(contact.meetingCount === 1 ? 'people.meetingsTogetherOne' : 'people.meetingsTogetherMany', { count: contact.meetingCount })}
                    {lastSeen ? ` · ${t('people.lastSeen', { when: formatRelativePast(lastSeen) })}` : ''}
                  </p>
                ) : isYou ? (
                  <p className="mt-1 text-[11px] text-af-text-4">{t('people.yourMicrophone')}</p>
                ) : (
                  <p className="mt-1 text-[11px] text-af-text-4">
                    {t('people.notIdentifiedYet')}
                    {lineCount ? ` · ${t(lineCount === 1 ? 'people.lineCountOne' : 'people.lineCountMany', { count: lineCount })}` : ''}
                  </p>
                )}
              </div>
            </div>

            {canLearnVoice && voice && (
              <p className="flex items-center gap-1.5 px-4 pb-3 text-[11px] text-af-text-3">
                <Fingerprint className="h-3.5 w-3.5 text-af-accent" />
                {t('people.voiceLearnedFrom', { source: describeVoiceSource(voice) })}
              </p>
            )}

            {contact && contact.groups.length > 0 && (
              <div className="flex flex-wrap gap-1.5 px-4 pb-3">
                {contact.groups.slice(0, 4).map((group) => (
                  <GroupChip key={group.id} group={group} size="xs" onClick={() => router.push(`/groups?id=${encodeURIComponent(group.id)}`)} />
                ))}
              </div>
            )}

            {contact && openItems.length > 0 && (
              <div className="border-t border-af-border px-4 py-3">
                <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-af-text-4">{t('people.openActionItems')}</p>
                <ul className="space-y-1.5">
                  {openItems.map((item) => (
                    <li key={item.id} className="flex items-start gap-2 text-xs text-af-text-2">
                      {item.done ? <CheckCircle2 className="mt-px h-3.5 w-3.5 shrink-0 text-af-success" /> : <Circle className="mt-px h-3.5 w-3.5 shrink-0 text-af-text-4" />}
                      <span className="line-clamp-2">{item.text}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div className="flex flex-wrap items-center gap-1.5 border-t border-af-border p-2.5">
              {contact && (
                <Button
                  size="sm"
                  onClick={() => {
                    onClose();
                    router.push(`/person?id=${encodeURIComponent(contact.id)}`);
                  }}
                >
                  {t('people.viewProfile')}
                  <ArrowUpRight />
                </Button>
              )}
              <Button
                size="sm"
                variant={contact || isYou ? 'ghost' : 'primary'}
                onClick={() => {
                  onClose();
                  onIdentify(target.speaker, target.segmentId);
                }}
              >
                <UserRoundSearch />
                {contact || isYou ? t('people.change') : t('people.identify')}
              </Button>
              {!isYou && !contact && splitSpeakerLabel(speaker).length === 1 && onMarkMe && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    onClose();
                    onMarkMe(target.speaker);
                  }}
                >
                  <UserCheck />
                  {t('people.thisIsMe')}
                </Button>
              )}
              {onMerge && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    onClose();
                    onMerge(target.speaker);
                  }}
                >
                  <GitMerge />
                  {t('people.merge')}
                </Button>
              )}
              {canLearnVoice && (
                <Button size="sm" variant="ghost" onClick={() => void learnVoice()} loading={learning}>
                  <Fingerprint />
                  {voice ? t('people.updateVoice') : t('people.rememberVoice')}
                </Button>
              )}
            </div>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
