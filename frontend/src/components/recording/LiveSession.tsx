'use client';

/**
 * The recorder while a call is on: a header with the meeting's title, group
 * and the people heard so far, the live transcript, and the Speakers | Notes
 * | Ask AI panel. The record card floats over the transcript column.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { Copy, Globe, PanelRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useTranscripts } from '@/contexts/TranscriptContext';
import { useRecordingState } from '@/contexts/RecordingStateContext';
import { useConfig } from '@/contexts/ConfigContext';
import { useWorkspace } from '@/contexts/WorkspaceContext';
import { useSidebar } from '@/components/Sidebar/SidebarProvider';
import { usePendingGroup } from '@/hooks/usePendingGroup';
import { VirtualizedTranscriptView } from '@/components/VirtualizedTranscriptView';
import { SpeakerIdentityDialog } from '@/components/people/SpeakerIdentityDialog';
import { GroupPicker } from '@/components/groups/GroupBits';
import { Button } from '@/components/ui/button';
import { AvatarStack } from '@/components/ui/avatar';
import { EditableTitle } from '@/components/ui/editable-title';
import { Hint } from '@/components/ui/tooltip';
import { useRecordingClock } from '@/components/recording/RecordingPill';
import { LivePanel, type LivePanelTab } from '@/components/recording/LivePanel';
import { automaticTitle, onLiveSessionChange, readLiveTitle, writeLiveTitle, type LiveTitle } from '@/lib/live-session';
import { formatClock } from '@/lib/dates';
import type { LiveLine } from '@/lib/live-context';
import { useLabs } from '@/hooks/useLabs';
import { isDuplicatedMicCaption, previewHasFinalTurn } from '@/lib/nearLiveCaptions';

const PANEL_KEY = 'af-live-panel-open';
const PANEL_WIDTH = 340;
/** Narrower than this and the panel opens over the transcript instead of beside it. */
const MIN_TRANSCRIPT_WIDTH = 480;
/** Room under the last line for the floating record card. */
const RECORD_CARD_CLEARANCE = 150;
const isGeneric = (name: string) => /^speaker \d+$/i.test(name.trim());
type PreviewCaption = { source: 'microphone' | 'system'; start_time: number; end_time: number; text: string };
type PreviewFinalized = { source: PreviewCaption['source']; end_time: number };

export function LiveSession({
  isProcessingStop,
  isStopping,
  onLanguageSettings,
}: {
  isProcessingStop: boolean;
  isStopping: boolean;
  onLanguageSettings: () => void;
}) {
  const {
    transcripts,
    detectedSpeakers,
    renameSpeaker,
    reassignSegment,
    mergeSpeakers,
    copyTranscript,
    meetingTitle,
    setMeetingTitle,
  } = useTranscripts();
  const { isRecording, isPaused } = useRecordingState();
  const { transcriptModelConfig } = useConfig();
  const { groupById } = useWorkspace();
  const { meetings } = useSidebar();
  const [pendingGroup, chooseGroup] = usePendingGroup();
  const elapsed = useRecordingClock();
  const { labs } = useLabs();
  const [previews, setPreviews] = useState<Partial<Record<PreviewCaption['source'], PreviewCaption>>>({});
  const finalizedUntil = useRef({ microphone: -Infinity, system: -Infinity });
  const previewExpiry = useRef<Partial<Record<PreviewCaption['source'], ReturnType<typeof setTimeout>>>>({});

  useEffect(() => {
    if (!isRecording || !labs.nearLiveCaptions || isPaused) { setPreviews({}); return; }
    finalizedUntil.current = { microphone: -Infinity, system: -Infinity };
    let disposed = false;
    const stops: Array<() => void> = [];
    const attach = async () => {
      const captionStop = await listen<PreviewCaption>('near-live-caption', ({ payload }) => {
        if (disposed || payload.end_time <= finalizedUntil.current[payload.source]) return;
        if (previewExpiry.current[payload.source]) clearTimeout(previewExpiry.current[payload.source]);
        setPreviews((current) => ({ ...current, [payload.source]: payload }));
      });
      stops.push(captionStop);
      const finalStop = await listen<PreviewFinalized>('near-live-finalized', ({ payload }) => {
        if (disposed) return;
        finalizedUntil.current[payload.source] = Math.max(finalizedUntil.current[payload.source], payload.end_time);
        // Native emits the final line first, but React may not have committed
        // TranscriptContext's update yet. Keep the preview until that line
        // arrives so a whole live bubble never vanishes between the two events.
        if (previewExpiry.current[payload.source]) clearTimeout(previewExpiry.current[payload.source]);
        previewExpiry.current[payload.source] = setTimeout(() => {
          setPreviews((current) => {
            const preview = current[payload.source];
            if (!preview || preview.end_time > payload.end_time + 0.05) return current;
            const next = { ...current };
            delete next[payload.source];
            return next;
          });
        }, 1500);
      });
      stops.push(finalStop);
      if (disposed) stops.forEach((stop) => stop());
    };
    void attach().catch(console.error);
    return () => {
      disposed = true;
      stops.forEach((stop) => stop());
      Object.values(previewExpiry.current).forEach((timer) => { if (timer) clearTimeout(timer); });
      previewExpiry.current = {};
    };
  }, [isRecording, isPaused, labs.nearLiveCaptions]);

  useEffect(() => {
    setPreviews((current) => {
      let next: typeof current | null = null;
      for (const source of ['microphone', 'system'] as const) {
        const preview = current[source];
        if (!preview || finalizedUntil.current[source] < preview.end_time - 0.05) continue;
        if (!previewHasFinalTurn({ ...preview, source }, transcripts)) continue;
        next ??= { ...current };
        delete next[source];
      }
      return next ?? current;
    });
  }, [transcripts]);

  const [live, setLive] = useState<LiveTitle | null>(null);
  const [panelOpen, setPanelOpen] = useState(true);
  const [tab, setTab] = useState<LivePanelTab>('speakers');
  const [identity, setIdentity] = useState<{ speaker: string; transcriptId: string | null } | null>(null);
  const [highlight, setHighlight] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const [narrow, setNarrow] = useState(false);
  const [overlayOpen, setOverlayOpen] = useState(false);

  useEffect(() => {
    const element = rootRef.current;
    if (!element) return;
    const read = () => setNarrow(element.clientWidth < PANEL_WIDTH + MIN_TRANSCRIPT_WIDTH);
    read();
    const observer = new ResizeObserver(read);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const sync = () => setLive(readLiveTitle());
    sync();
    return onLiveSessionChange(sync);
  }, []);

  // Open unless you closed it last time.
  useEffect(() => {
    try {
      setPanelOpen(localStorage.getItem(PANEL_KEY) !== '0');
    } catch {
      setPanelOpen(true);
    }
  }, []);

  const docked = panelOpen && !narrow;
  const shown = narrow ? overlayOpen : panelOpen;

  const showPanel = (next: LivePanelTab) => {
    setTab(next);
    if (narrow) setOverlayOpen(true);
    else setPanelOpen(true);
  };

  const togglePanel = () => {
    if (narrow) {
      setOverlayOpen((open) => !open);
      return;
    }
    setPanelOpen((open) => {
      try {
        localStorage.setItem(PANEL_KEY, open ? '0' : '1');
      } catch {
        // Only this session remembers it.
      }
      return !open;
    });
  };

  // The floating record card centres itself over the transcript column.
  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty('--af-speakers-width', docked ? `${PANEL_WIDTH}px` : '0px');
    return () => {
      root.style.removeProperty('--af-speakers-width');
    };
  }, [docked]);

  const title = live?.title ?? meetingTitle;
  const existingTitles = useMemo(() => meetings.map((meeting) => meeting.title), [meetings]);

  const rename = (next: string) => {
    writeLiveTitle({ title: next, manual: true, startedAt: live?.startedAt ?? Date.now() });
    setMeetingTitle(next);
    return true;
  };

  // Picking a group mid-call also retitles the meeting, unless you named it yourself.
  const changeGroup = (groupId: string | null, name?: string) => {
    chooseGroup(groupId, name);
    if (!live || live.manual) return;
    const groupName = groupId ? groupById(groupId)?.name ?? name ?? null : null;
    const next = automaticTitle(new Date(live.startedAt), groupName, existingTitles);
    writeLiveTitle({ ...live, title: next });
    setMeetingTitle(next);
  };

  const segments = useMemo(() => {
    const saved = transcripts.map((t) => ({
      id: t.id,
      timestamp: t.audio_start_time ?? 0,
      endTime: t.audio_end_time,
      text: t.text,
      confidence: t.confidence,
      speaker: t.speaker,
    }));
    if (!isRecording || isPaused || !labs.nearLiveCaptions) return saved;
    const active = Object.values(previews).filter((preview): preview is PreviewCaption => !!preview)
      .filter((preview) => !(labs.micPlaybackSuppression && preview.source === 'microphone' && previews.system
        && isDuplicatedMicCaption(preview, previews.system)))
      .map((preview) => ({
        id: `preview-${preview.source}`,
        timestamp: preview.start_time,
        endTime: preview.end_time,
        text: `${preview.text} …`,
        speaker: preview.source === 'microphone' ? 'You' : 'Remote voice',
        provisional: true,
      }));
    return [...saved, ...active].sort((a, b) => a.timestamp - b.timestamp);
  }, [transcripts, previews, isRecording, isPaused, labs.nearLiveCaptions, labs.micPlaybackSuppression]);
  const lines = useMemo<LiveLine[]>(
    () => transcripts.map((t) => ({ id: t.id, time: t.audio_start_time ?? 0, speaker: t.speaker, text: t.text })),
    [transcripts],
  );

  const named = detectedSpeakers.filter((speaker) => !speaker.isUser && !isGeneric(speaker.name)).map((speaker) => speaker.name);
  const unnamed = detectedSpeakers.filter((speaker) => isGeneric(speaker.name)).length;

  /** A free "Speaker N" label, for when a name is removed. */
  const genericLabel = useCallback(() => {
    const used = new Set(detectedSpeakers.map((speaker) => speaker.name.trim().toLowerCase()));
    let index = 1;
    while (used.has(`speaker ${index}`)) index++;
    return `Speaker ${index}`;
  }, [detectedSpeakers]);

  const jumpTo = (lineId: string) => {
    setHighlight(null);
    requestAnimationFrame(() => setHighlight(lineId));
  };

  return (
    <div ref={rootRef} className="relative flex h-full min-w-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="shrink-0 border-b border-af-border px-5 pb-3 pt-4">
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <EditableTitle value={title} onCommit={rename} label="Meeting title" />
              <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-2 text-xs text-af-text-3">
                <span className="inline-flex items-center gap-1.5 font-medium">
                  <span
                    className={cn(
                      'h-2 w-2 rounded-full',
                      isStopping ? 'bg-af-text-4' : isPaused ? 'bg-af-warning' : 'animate-af-breathe bg-af-record',
                    )}
                  />
                  <span className={isStopping ? 'text-af-text-3' : isPaused ? 'text-af-warning' : 'text-af-record'}>
                    {isStopping || isProcessingStop ? 'Finishing' : isPaused ? 'Paused' : 'Recording'}
                  </span>
                  <span className="tabular-nums text-af-text-3">{formatClock(elapsed)}</span>
                </span>
                <GroupPicker value={pendingGroup?.id ?? null} onChange={changeGroup} placeholder="Add to group" />
                {detectedSpeakers.length > 0 && (
                  <button
                    type="button"
                    onClick={() => showPanel('speakers')}
                    className="flex items-center gap-2 rounded-md px-1 py-0.5 transition-colors hover:bg-af-hover hover:text-af-text-2"
                  >
                    {named.length > 0 && <AvatarStack names={named} max={4} size="sm" />}
                    <span>
                      {[
                        named.length > 0 ? `${named.length} named` : null,
                        unnamed > 0 ? `${unnamed} to name` : null,
                      ]
                        .filter(Boolean)
                        .join(' · ') || 'Just you so far'}
                    </span>
                  </button>
                )}
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              {transcriptModelConfig.provider === 'localWhisper' && (
                <Button variant="ghost" size="sm" onClick={onLanguageSettings}>
                  <Globe />
                  Language
                </Button>
              )}
              <Hint label="Copy transcript">
                <Button variant="ghost" size="icon-sm" onClick={copyTranscript} disabled={transcripts.length === 0} aria-label="Copy transcript">
                  <Copy />
                </Button>
              </Hint>
              <Hint label={shown ? 'Hide the side panel' : 'Speakers, notes and Ask AI'}>
                <Button
                  variant={shown ? 'soft' : 'ghost'}
                  size="icon-sm"
                  onClick={togglePanel}
                  aria-pressed={shown}
                  aria-label="Toggle the side panel"
                >
                  <PanelRight />
                </Button>
              </Hint>
            </div>
          </div>
        </header>

        <div className="min-h-0 flex-1">
          <VirtualizedTranscriptView
            segments={segments}
            nearLiveCaptions={labs.nearLiveCaptions}
            isRecording={isRecording}
            isPaused={isPaused}
            isProcessing={isProcessingStop}
            isStopping={isStopping}
            enableStreaming={isRecording && !isPaused && !labs.nearLiveCaptions}
            showConfidence
            onRenameSpeaker={(speaker, segmentId) => setIdentity({ speaker, transcriptId: segmentId || null })}
            onMergeSpeaker={(speaker) => setIdentity({ speaker, transcriptId: null })}
            highlightSegmentId={highlight}
            bottomInset={RECORD_CARD_CLEARANCE}
          />
        </div>
      </div>

      {narrow && overlayOpen && (
        <button
          type="button"
          aria-label="Close the side panel"
          onClick={() => setOverlayOpen(false)}
          className="absolute inset-0 z-40 bg-[var(--af-scrim-color)] animate-in fade-in-0"
        />
      )}
      <aside
        aria-label="Speakers, notes and Ask AI"
        aria-hidden={!shown}
        className={cn(
          'h-full shrink-0 overflow-hidden bg-af-panel motion-reduce:transition-none',
          narrow
            ? cn(
                'absolute inset-y-0 right-0 z-50 max-w-[92%] border-l border-af-border shadow-2xl transition-transform duration-300 ease-af',
                overlayOpen ? 'translate-x-0' : 'pointer-events-none translate-x-full',
              )
            : cn(
                'border-l transition-[width,border-color] duration-[400ms] ease-af',
                docked ? 'border-af-border' : 'pointer-events-none border-transparent',
              ),
        )}
        style={{ width: narrow ? PANEL_WIDTH : docked ? PANEL_WIDTH : 0 }}
      >
        <div className="h-full" style={{ width: PANEL_WIDTH, maxWidth: '100%' }}>
          <LivePanel
            tab={tab}
            onTabChange={setTab}
            speakers={detectedSpeakers}
            lines={lines}
            sessionKey={String(live?.startedAt ?? 'current')}
            onIdentify={(speaker) => setIdentity({ speaker, transcriptId: null })}
            onMarkMe={(speaker) => renameSpeaker(speaker, 'You')}
            onJumpTo={jumpTo}
          />
        </div>
      </aside>

      <SpeakerIdentityDialog
        open={identity !== null}
        onOpenChange={(open) => !open && setIdentity(null)}
        speaker={identity?.speaker ?? null}
        transcriptId={identity?.transcriptId}
        speakers={detectedSpeakers.map((speaker) => speaker.name)}
        onRenameLive={(from, to, scope) => {
          const target = to.trim() || genericLabel();
          if (scope === 'line' && identity?.transcriptId) reassignSegment(identity.transcriptId, target);
          else renameSpeaker(from, target);
        }}
        onMerge={(source, target) => mergeSpeakers(source, target)}
        colorIndexOf={(label) => detectedSpeakers.find((speaker) => speaker.name === label)?.colorIndex}
      />

    </div>
  );
}

