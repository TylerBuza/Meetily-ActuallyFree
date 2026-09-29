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
import { displaySpeaker, isUserSpeaker, speakerDot } from '@/utils/speakerUtils';
import { cn } from '@/lib/utils';

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
      toast.success(`${updating ? 'Updated' : 'Learned'} ${profile.name}'s voice`, {
        description: updating
          ? `Now from ${describeVoiceSource(profile)}, including this one.`
          : `From ${describeVoiceSource(profile)}. Later meetings name a matching voice after them.`,
      });
    } catch (error) {
      toast.error(`Could not ${updating ? 'update' : 'learn'} ${contact.displayName}'s voice`, { description: describeVoiceError(error) });
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
                <Avatar name={isYou ? userName || 'You' : contact!.displayName} size="lg" />
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
                    {contact.meetingCount} meeting{contact.meetingCount === 1 ? '' : 's'} together
                    {lastSeen ? ` · last ${formatRelativePast(lastSeen)}` : ''}
                  </p>
                ) : isYou ? (
                  <p className="mt-1 text-[11px] text-af-text-4">Your microphone</p>
                ) : (
                  <p className="mt-1 text-[11px] text-af-text-4">Not identified yet{lineCount ? ` · ${lineCount} line${lineCount === 1 ? '' : 's'}` : ''}</p>
                )}
              </div>
            </div>

            {canLearnVoice && voice && (
              <p className="flex items-center gap-1.5 px-4 pb-3 text-[11px] text-af-text-3">
                <Fingerprint className="h-3.5 w-3.5 text-af-accent" />
                Voice learned from {describeVoiceSource(voice)}
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
                <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-af-text-4">Open action items</p>
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
                  View profile
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
                {contact || isYou ? 'Change' : 'Identify'}
              </Button>
              {!isYou && !contact && onMarkMe && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    onClose();
                    onMarkMe(target.speaker);
                  }}
                >
                  <UserCheck />
                  This is me
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
                  Merge
                </Button>
              )}
              {canLearnVoice && (
                <Button size="sm" variant="ghost" onClick={() => void learnVoice()} loading={learning}>
                  <Fingerprint />
                  {voice ? 'Update voice' : 'Remember voice'}
                </Button>
              )}
            </div>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
