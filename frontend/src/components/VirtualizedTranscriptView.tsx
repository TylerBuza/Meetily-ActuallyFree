'use client';
import { splitTranscriptLines, useTranscriptLineLimit } from '@/lib/transcript-line-limit';

/**
 * The transcript renderer for both the live recorder and the meeting page.
 *
 * Rows are virtualized with @tanstack/react-virtual so multi-hour meetings
 * stay responsive: only visible turns are mounted. Consecutive lines from one
 * speaker merge into a single turn (live VAD emits many short fragments).
 *
 * On the meeting page the view is linked to playback: the turn being played
 * is highlighted (and followed if asked), timestamps seek the audio, speaker
 * names open a person card, and a search hit can be flashed into view.
 *
 * ⚠️ Speaker labels only appear if every converter copies `speaker`:
 *   1. `app/_components/TranscriptPanel.tsx`            (live)
 *   2. `components/MeetingDetails/TranscriptPanel.tsx`  (non-paginated)
 *   3. `hooks/usePaginatedTranscripts.ts`               (paginated)
 */

import { memo, startTransition, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import { useVirtualizer } from '@tanstack/react-virtual';
import { motion } from 'framer-motion';
import { Camera, ChevronDown, GitMerge, Mic } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { interleaveTranscriptImages, type ImageTranscriptSegment } from '@/lib/transcript-image-layout';
import type { MeetingImage } from '@/lib/meeting-images';
import { useAutoScroll } from '@/hooks/useAutoScroll';
import { useTranscriptStreaming } from '@/hooks/useTranscriptStreaming';
import { useTranscriptLeftAligned, useTranscriptHideSpeakerDots } from '@/lib/transcript-layout';
import { useUserName } from '@/hooks/useUserName';
import { TranscriptSegmentData } from '@/types';
import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';
import { cleanTranscriptText } from '@/lib/labs';
import { useLabs } from '@/hooks/useLabs';
import { liveTurnIdentity, mergeInterleavedSpeakerTurns, retainLiveText } from '@/lib/nearLiveCaptions';
import { displaySpeaker, isUserSpeaker, speakerColor, speakerColorIndexMap, speakerColorValue, speakerDot, speakerKey } from '@/utils/speakerUtils';

/**
 * How line text is shown. `tidy` drops filler words (the default); with Labs
 * clean transcript on, the meeting page switches between `clean` (fillers
 * and stutters dropped) and `verbatim` (every word). Saved text never changes.
 */
export type TranscriptTextMode = 'tidy' | 'clean' | 'verbatim';

export interface VirtualizedTranscriptViewProps {
  segments: TranscriptSegmentData[];
  /** Saved images shown at their recording time on the post-call transcript. */
  meetingImages?: MeetingImage[];
  isRecording?: boolean;
  nearLiveCaptions?: boolean;
  isPaused?: boolean;
  isProcessing?: boolean;
  isStopping?: boolean;
  /** Typewriter effect for the newest live line. */
  enableStreaming?: boolean;
  showConfidence?: boolean;
  /** Never auto-scroll (the meeting page scrolls on the user's terms). */
  disableAutoScroll?: boolean;

  hasMore?: boolean;
  isLoadingMore?: boolean;
  totalCount?: number;
  loadedCount?: number;
  onLoadMore?: () => void;

  /** Clicking a speaker name. Receives the element to anchor a card on. */
  onSpeakerClick?: (speaker: string, segmentId: string, anchor: HTMLElement) => void;
  /** Fallbacks used when `onSpeakerClick` is not given. */
  onRenameSpeaker?: (speaker: string, segmentId: string) => void;
  onMergeSpeaker?: (speaker: string) => void;

  /** Playback position in seconds; the matching turn is highlighted. */
  playbackTime?: number | null;
  /** Keep the playing turn in view. */
  followPlayback?: boolean;
  /** Timestamp clicked. */
  onSeek?: (seconds: number) => void;
  /** Scroll to and briefly flash the turn containing this line. */
  highlightSegmentId?: string | null;
  /** Empty state for the idle recorder (it shows its own home content). */
  emptyState?: React.ReactNode;
  /** Space kept clear under the last line, e.g. for a floating control bar (px). */
  bottomInset?: number;
  textMode?: TranscriptTextMode;
  /** Colour slot per speaker key (speakerColorIndexMap). Worked out from the lines when not given. */
  colorIndices?: Map<string, number>;
  /** Translated text mapped by transcript segment ID */
  translations?: Record<string, string>;
  /** How translations should be rendered relative to original text */
  translationMode?: 'original' | 'translated' | 'bilingual';
}

const VIRTUALIZATION_THRESHOLD = 10;

interface Turn extends TranscriptSegmentData {
  sourceId?: string;
  imagesAfter?: MeetingImage[];
  translatedText?: string;
  memberIds: string[];
}

function clock(seconds: number | undefined): string {
  if (seconds === undefined || !Number.isFinite(seconds)) return '--:--';
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

const FILLERS = /\b(?:uh|um|er|ah|hmm|hm|eh)\b[,\s]*/gi;

function cleanFillers(text: string): string {
  return text.replace(FILLERS, ' ').replace(/\s+/g, ' ').trim();
}

function shownText(text: string, mode: TranscriptTextMode): string {
  if (mode === 'verbatim') return text;
  return mode === 'clean' ? cleanTranscriptText(text) : cleanFillers(text);
}

/** One turn per speaker run, joining fragments less than 2.5s apart. */
function mergeTurns(segments: (TranscriptSegmentData & Partial<ImageTranscriptSegment>)[], maxGapSecs = 2.5, maxDurationSecs = Infinity): Turn[] {
  const out: Turn[] = [];
  for (const segment of segments) {
    const last = out[out.length - 1];
    const lastEnd = last?.endTime ?? last?.timestamp ?? 0;
    const gap = segment.timestamp - lastEnd;
    if (last && !last.imagesAfter?.length && speakerKey(last.speaker) === speakerKey(segment.speaker) && gap >= 0 && gap <= maxGapSecs && (segment.endTime ?? segment.timestamp) - last.timestamp <= maxDurationSecs) {
      last.text = `${last.text.trim()} ${segment.text.trim()}`.replace(/\s+/g, ' ').trim();
      last.endTime = segment.endTime ?? segment.timestamp;
      last.memberIds.push(segment.sourceId ?? segment.id);
      last.imagesAfter = segment.imagesAfter;
      if (segment.translatedText !== undefined) last.translatedText = [last.translatedText, segment.translatedText].filter(Boolean).join(" ");
      last.provisional = last.provisional || segment.provisional;
      if (segment.confidence != null) last.confidence = Math.min(last.confidence ?? 1, segment.confidence);
      if (last.words || segment.words) {
        last.words = [...(last.words || []), ...(segment.words || [])];
      }
    } else {
      out.push({ ...segment, memberIds: [segment.sourceId ?? segment.id] });
    }
  }
  return out;
}

function activeTurnIndex(turns: Turn[], time: number | null | undefined): number {
  if (time == null || turns.length === 0) return -1;
  let lo = 0;
  let hi = turns.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (turns[mid].timestamp <= time + 0.05) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (found === -1) return -1;
  const turn = turns[found];
  const end = turn.endTime ?? turn.timestamp;
  // Between turns, keep the last one lit until the next starts.
  return time <= end + 4 || found === turns.length - 1 || turns[found + 1].timestamp > time ? found : -1;
}

const TurnRow = memo(function TurnRow({
  turn,
  text,
  textMode,
  colorIndex,
  isStreaming,
  userName,
  leftAligned,
  hideSpeakerDots,
  active,
  activeTime,
  flash,
  onSpeakerClick,
  onRenameSpeaker,
  onMergeSpeaker,
  onSeek,
  translations,
  translationMode = 'original',
}: {
  turn: Turn;
  text: string;
  textMode: TranscriptTextMode;
  /** The speaker's colour slot in this meeting, kept through renames. */
  colorIndex?: number;
  isStreaming: boolean;
  userName: string;
  leftAligned: boolean;
  hideSpeakerDots: boolean;
  active: boolean;
  activeTime?: number | null;
  flash: boolean;
  onSpeakerClick?: VirtualizedTranscriptViewProps['onSpeakerClick'];
  onRenameSpeaker?: VirtualizedTranscriptViewProps['onRenameSpeaker'];
  onMergeSpeaker?: VirtualizedTranscriptViewProps['onMergeSpeaker'];
  onSeek?: VirtualizedTranscriptViewProps['onSeek'];
  translations?: Record<string, string>;
  translationMode?: 'original' | 'translated' | 'bilingual';
}) {
  const { labs } = useLabs();
  const speaker = turn.speaker;
  const isYou = isUserSpeaker(speaker);
  const label = speaker ? displaySpeaker(speaker, userName) : '';
  const shown = shownText(text, textMode) || (text.trim() === '' ? '[Silence]' : text);
  const clickable = !!speaker && !turn.provisional && (!!onSpeakerClick || !!onRenameSpeaker);
  const currentMs = active && activeTime != null ? activeTime * 1000 : null;
  const showWords = Boolean(labs.wordTimestamps && turn.words && turn.words.length > 0 && !isStreaming);

  const translationText = useMemo(() => {
    if (!translations || translationMode === 'original') return null;
    if (turn.translatedText !== undefined) return turn.translatedText;
    const parts = turn.memberIds
      .map((id) => translations[id])
      .filter(Boolean);
    if (parts.length > 0) return parts.join(' ');
    return translations[turn.id] || null;
  }, [translations, translationMode, turn.memberIds, turn.id, turn.translatedText]);

  const activeWordIndex = useMemo(() => {
    if (currentMs == null || !turn.words || turn.words.length === 0) return -1;
    const words = turn.words;
    let lo = 0;
    let hi = words.length - 1;
    let best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (words[mid].startTime <= currentMs) {
        best = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    if (best === -1) return -1;
    const word = words[best];
    const nextWord = best + 1 < words.length ? words[best + 1] : null;
    const graceEnd = nextWord ? Math.min(word.endTime + 150, nextWord.startTime) : word.endTime + 150;
    return currentMs <= graceEnd ? best : -1;
  }, [currentMs, turn.words]);

  return (
    <div id={`segment-${turn.id}`} className={cn('flex pb-3', leftAligned ? 'justify-start' : isYou ? 'justify-end pl-8' : 'justify-start pr-8')}>
      <div className={cn(leftAligned ? 'grid w-full min-w-0 grid-cols-[minmax(70px,110px)_minmax(0,1fr)] items-start gap-3' : 'flex min-w-0 max-w-[92%] flex-col gap-1', !leftAligned && (isYou ? 'items-end' : 'items-start'))}>
        <div className={cn(leftAligned ? 'flex min-w-0 flex-col items-start gap-1' : 'flex items-center gap-2', !leftAligned && isYou && 'flex-row-reverse')}>
          <div className={cn('flex min-w-0 items-start gap-2', !leftAligned && isYou && 'flex-row-reverse')}>
          {!hideSpeakerDots && <span aria-hidden className={cn('mt-1 h-2 w-2 shrink-0 rounded-full', speakerDot(speaker, colorIndex))} />}
          {speaker && (
            <span className="group/speaker flex min-w-0 items-center gap-1">
              {clickable ? (
                <button
                  type="button"
                  onClick={(event) =>
                    onSpeakerClick ? onSpeakerClick(speaker, turn.sourceId ?? turn.id, event.currentTarget) : onRenameSpeaker?.(speaker, turn.sourceId ?? turn.id)
                  }
                  className={cn(
                    'rounded px-0.5 text-xs font-semibold transition-colors hover:bg-af-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-af-accent/60',
                    leftAligned && 'min-w-0 break-words px-0 text-left',
                    speakerColor(speaker, colorIndex),
                  )}
                >
                  {label}
                </button>
              ) : (
                <span className={cn('text-xs font-semibold', speakerColor(speaker, colorIndex))}>{label}</span>
              )}
              {!turn.provisional && !onSpeakerClick && onMergeSpeaker && (
                <button
                  type="button"
                  onClick={() => onMergeSpeaker(speaker)}
                  aria-label={`Merge ${label} into another speaker`}
                  className="rounded p-0.5 text-af-text-4 opacity-0 transition-opacity hover:text-af-accent group-hover/speaker:opacity-100"
                >
                  <GitMerge size={12} />
                </button>
              )}
            </span>
          )}
          </div>
          <div className={cn(leftAligned && !hideSpeakerDots && 'pl-4')}>
          {onSeek ? (
            <button
              type="button"
              onClick={() => onSeek(turn.timestamp)}
              className={cn('rounded text-[11px] tabular-nums text-af-text-4 transition-colors hover:bg-af-hover hover:text-af-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-af-accent/60', leftAligned ? 'px-0' : 'px-1')}
              aria-label={`Play from ${clock(turn.timestamp)}`}
            >
              {clock(turn.timestamp)}
            </button>
          ) : (
            <span className="text-[11px] tabular-nums text-af-text-4">{clock(turn.timestamp)}</span>
          )}
          </div>
        </div>
        <div
          className={cn(
            leftAligned ? 'min-w-0 rounded-md px-1 transition-colors' : 'rounded-2xl border px-3.5 py-2 transition-[box-shadow,border-color,background-color] duration-200',
            // Others' bubbles carry a faint wash of their colour (globals.css).
            !leftAligned && (isYou ? 'rounded-tr-md border-af-accent/25 bg-af-accent/[0.12]' : 'af-speaker-bubble rounded-tl-md'),
            active && 'border-af-accent/60 shadow-[0_0_0_3px_rgb(var(--af-accent-rgb)/0.14)]',
            flash && 'animate-af-flash',
          )}
          style={isYou ? undefined : ({ '--chip': speakerColorValue(speaker, colorIndex) } as React.CSSProperties)}
        >
          {translationMode === 'translated' && translationText ? (
            <p className="text-sm leading-relaxed text-af-text whitespace-pre-wrap select-text">
              {translationText}
            </p>
          ) : showWords ? (
            <p className="text-sm leading-relaxed text-af-text whitespace-pre-wrap select-text">
              {turn.words!.map((w, idx) => {
                const isWordActive = idx === activeWordIndex;
                return (
                  <span
                    key={w.wordID}
                    onClick={
                      onSeek
                        ? (e) => {
                            e.stopPropagation();
                            onSeek(w.startTime / 1000);
                          }
                        : undefined
                    }
                    className={cn(
                      'inline transition-colors duration-75 rounded-sm',
                      onSeek && 'cursor-pointer hover:bg-af-accent/20 hover:text-af-accent',
                      isWordActive && 'bg-af-accent/25 text-af-accent font-semibold px-0.5 rounded shadow-sm'
                    )}
                    title={onSeek ? `Seek to ${clock(w.startTime / 1000)}` : undefined}
                  >
                    {w.text}
                  </span>
                );
              })}
            </p>
          ) : (
            <p className={cn('text-sm leading-relaxed text-af-text', isStreaming && 'opacity-80')}>{shown}</p>
          )}

          {translationMode === 'bilingual' && translationText && (
            <div className="mt-2 pt-2 border-t border-af-border/40 text-xs sm:text-[13px] leading-relaxed text-af-text-2 italic select-text">
              {translationText}
            </div>
          )}

          {turn.provisional && <span className="mt-1 block text-[10px] text-af-text-4">Updating…</span>}
        </div>
      </div>
    </div>
  );
});

export const VirtualizedTranscriptView: React.FC<VirtualizedTranscriptViewProps> = ({
  segments,
  meetingImages = [],
  isRecording = false,
  nearLiveCaptions = false,
  isPaused = false,
  isProcessing = false,
  isStopping = false,
  enableStreaming = false,
  disableAutoScroll = false,
  hasMore = false,
  isLoadingMore = false,
  totalCount = 0,
  loadedCount = 0,
  onLoadMore,
  onSpeakerClick,
  onRenameSpeaker,
  onMergeSpeaker,
  playbackTime,
  followPlayback = false,
  onSeek,
  highlightSegmentId,
  emptyState,
  bottomInset = 0,
  textMode = 'tidy',
  colorIndices: givenColorIndices,
  translations,
  translationMode = 'original',
}) => {
  const userName = useUserName();
  const [leftAligned] = useTranscriptLeftAligned();
  const [hideSpeakerDots] = useTranscriptHideSpeakerDots();
  const [lineLimit] = useTranscriptLineLimit();
  const maxLineSeconds = lineLimit.enabled ? lineLimit.minutes * 60 : Infinity;
  const priorLineLimit = useRef(maxLineSeconds);
  const shownLiveText = useRef(new Map<string, string>());
  const turns = useMemo(() => {
    const live = nearLiveCaptions && isRecording;
    if (priorLineLimit.current !== maxLineSeconds) { shownLiveText.current.clear(); priorLineLimit.current = maxLineSeconds; }
    const projected = splitTranscriptLines(interleaveTranscriptImages(segments, isRecording ? [] : meetingImages, hasMore, translations), maxLineSeconds);
    const merged = mergeTurns(live ? mergeInterleavedSpeakerTurns(projected, 2.5, maxLineSeconds) : projected, 2.5, maxLineSeconds);
    if (!live) {
      shownLiveText.current.clear();
      return merged;
    }
    return retainLiveText(merged, shownLiveText.current);
  }, [segments, nearLiveCaptions, isRecording, meetingImages, hasMore, translations, maxLineSeconds]);
  const [selectedImage, setSelectedImage] = useState<MeetingImage | null>(null);
  // One colour per speaker in first-spoken order, so a renamed speaker keeps theirs.
  const ownColorIndices = useMemo(
    () => speakerColorIndexMap(turns.map((turn) => turn.speaker ?? '').filter(Boolean)),
    [turns],
  );
  const colorIndices = givenColorIndices ?? ownColorIndices;
  const scrollRef = useRef<HTMLDivElement>(null);
  const loadMoreTriggerRef = useRef<HTMLDivElement>(null);
  const [, rerender] = useReducer((x: number) => x + 1, 0);

  const virtualizer = useVirtualizer({
    count: turns.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 64,
    // Heights are cached per turn, not per position. When a relabel (a
    // rename, or diarization after the call) merges two turns, the turns
    // after it move up a slot; keyed by position they kept the old slot's
    // height and overlapped the bubble above.
    getItemKey: (index) => turns[index]
      ? (nearLiveCaptions && isRecording ? liveTurnIdentity(turns[index]) : turns[index].id)
      : index,
    overscan: 10,
    onChange: () => startTransition(() => rerender()),
  });

  const { autoScroll, scrollToBottom } = useAutoScroll({
    scrollRef,
    segments: turns,
    isRecording,
    isPaused,
    virtualizer,
    virtualizationThreshold: VIRTUALIZATION_THRESHOLD,
    disableAutoScroll,
  });

  const { streamingSegmentId, getDisplayText } = useTranscriptStreaming(turns, isRecording, enableStreaming);
  const useVirtualization = turns.length >= VIRTUALIZATION_THRESHOLD;
  const activeIndex = useMemo(() => activeTurnIndex(turns, playbackTime), [turns, playbackTime]);
  const flashIndex = useMemo(
    () => (highlightSegmentId ? turns.findIndex((turn) => turn.memberIds.includes(highlightSegmentId)) : -1),
    [turns, highlightSegmentId],
  );

  const scrollToTurn = (index: number) => {
    if (index < 0) return;
    if (useVirtualization) {
      virtualizer.scrollToIndex(index, { align: 'center' });
    } else {
      document.getElementById(`segment-${turns[index].id}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  };

  // Follow playback.
  const lastFollowed = useRef(-1);
  useEffect(() => {
    if (!followPlayback || activeIndex < 0 || activeIndex === lastFollowed.current) return;
    lastFollowed.current = activeIndex;
    scrollToTurn(activeIndex);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [followPlayback, activeIndex]);

  // Deep link: bring the matching turn into view once it is loaded.
  const flashedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!highlightSegmentId || flashIndex < 0 || flashedFor.current === highlightSegmentId) return;
    flashedFor.current = highlightSegmentId;
    requestAnimationFrame(() => scrollToTurn(flashIndex));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [highlightSegmentId, flashIndex]);

  // Infinite scroll.
  useEffect(() => {
    if (!onLoadMore || !hasMore || isLoadingMore || isRecording || turns.length === 0) return;
    const trigger = loadMoreTriggerRef.current;
    if (!trigger) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && hasMore && !isLoadingMore) onLoadMore();
      },
      { root: null, rootMargin: '100px', threshold: 0 },
    );
    observer.observe(trigger);
    return () => observer.disconnect();
  }, [hasMore, isLoadingMore, onLoadMore, isRecording, turns.length]);

  useEffect(() => {
    if (!onLoadMore || !hasMore || isLoadingMore || isRecording) return;
    const element = scrollRef.current;
    if (!element) return;
    let ticking = false;
    const onScroll = () => {
      if (ticking || isLoadingMore || !hasMore) return;
      ticking = true;
      requestAnimationFrame(() => {
        const { scrollTop, scrollHeight, clientHeight } = element;
        if (scrollHeight - scrollTop - clientHeight < 200 && hasMore && !isLoadingMore) onLoadMore();
        ticking = false;
      });
    };
    element.addEventListener('scroll', onScroll, { passive: true });
    return () => element.removeEventListener('scroll', onScroll);
  }, [onLoadMore, hasMore, isLoadingMore, isRecording]);

  const row = (turn: Turn, index: number) => (<>
    {turn.text.trim() && <TurnRow
      turn={turn}
      text={getDisplayText(turn)}
      textMode={textMode}
      colorIndex={turn.speaker ? colorIndices.get(speakerKey(turn.speaker)) : undefined}
      isStreaming={streamingSegmentId === turn.id}
      userName={userName}
      leftAligned={leftAligned}
      hideSpeakerDots={hideSpeakerDots}
      active={index === activeIndex}
      activeTime={index === activeIndex ? playbackTime : null}
      flash={index === flashIndex}
      onSpeakerClick={onSpeakerClick}
      onRenameSpeaker={onRenameSpeaker}
      onMergeSpeaker={onMergeSpeaker}
      onSeek={onSeek}
      translations={translations}
      translationMode={translationMode}
    />}
    {turn.imagesAfter?.length ? (
      <div className="mb-4 ml-4 flex flex-wrap gap-2" aria-label="Images captured at this point in the meeting">
        {turn.imagesAfter?.map((image) => (
          <button key={image.id} type="button" onClick={() => setSelectedImage(image)}
            className="overflow-hidden rounded-lg border border-af-border bg-af-panel-2 text-left transition-colors hover:border-af-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-af-accent/60"
            aria-label={`Open meeting image at ${clock(image.audioTime)}`}>
            <img src={convertFileSrc(image.path)} alt={`Meeting image at ${clock(image.audioTime)}`} className="h-16 w-24 object-cover" />
            <span className="flex items-center gap-1 px-1.5 py-1 text-[11px] tabular-nums text-af-text-3"><Camera className="h-3 w-3" /> {clock(image.audioTime)}</span>
          </button>
        ))}
      </div>
    ) : null}
  </>);

  const footer = (
    <>
      {(hasMore || isLoadingMore) && !isRecording && turns.length > 0 && (
        <div ref={loadMoreTriggerRef} className="mt-2 flex items-center justify-center py-4">
          {isLoadingMore ? (
            <span className="flex items-center gap-2 text-xs text-af-text-3">
              <Spinner className="h-4 w-4" /> Loading more…
            </span>
          ) : hasMore && totalCount > 0 ? (
            <span className="text-xs text-af-text-4">
              Showing {loadedCount} of {totalCount} lines
            </span>
          ) : null}
        </div>
      )}
      {!isStopping && isRecording && !isProcessing && turns.length > 0 && (
        <div className="mb-2 mt-2 flex min-h-[1.25rem] items-center gap-2 text-af-text-3">
          {isPaused ? (
            <span className="text-xs text-af-warning">Paused</span>
          ) : (
            <>
              <span className="h-2 w-2 animate-af-breathe rounded-full bg-af-accent" />
              <span className="text-xs">Listening…</span>
            </>
          )}
        </div>
      )}
    </>
  );

  return (
    <div className="relative h-full w-full min-h-0 min-w-0">
      <div
        ref={scrollRef}
        className="flex h-full flex-col overflow-y-auto px-4 py-3"
        style={bottomInset ? { scrollPaddingBottom: bottomInset } : undefined}
      >
        <div className={isRecording ? 'pt-1' : ''} style={bottomInset ? { paddingBottom: bottomInset } : undefined}>
        {turns.length === 0 ? (
          isRecording ? (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="mt-16 flex flex-col items-center text-center">
              <span className="mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-af-accent/[0.12] text-af-accent">
                <Mic className={cn('h-4 w-4', !isPaused && 'animate-af-breathe')} />
              </span>
              <p className="text-sm font-medium text-af-text">{isPaused ? 'Recording paused' : 'Listening for speech…'}</p>
              <p className="mt-1 text-xs text-af-text-3">{isPaused ? 'Resume to keep transcribing.' : 'Lines appear here as people talk.'}</p>
            </motion.div>
          ) : (
            emptyState ?? <p className="mt-10 text-center text-sm text-af-text-3">No transcript yet.</p>
          )
        ) : useVirtualization ? (
          <>
            <div style={{ height: virtualizer.getTotalSize(), width: '100%', position: 'relative' }}>
              {virtualizer.getVirtualItems().map((item) => {
                const turn = turns[item.index];
                return (
                  <div
                    key={nearLiveCaptions && isRecording ? liveTurnIdentity(turn) : turn.id}
                    data-index={item.index}
                    ref={virtualizer.measureElement}
                    style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${item.start}px)` }}
                  >
                    {row(turn, item.index)}
                  </div>
                );
              })}
            </div>
            {footer}
          </>
        ) : (
          <>
            <div className="space-y-1">
              {turns.map((turn, index) => (
                <motion.div key={nearLiveCaptions && isRecording ? liveTurnIdentity(turn) : turn.id} initial={{ opacity: 0, y: 5 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.15 }}>
                  {row(turn, index)}
                </motion.div>
              ))}
            </div>
            {footer}
          </>
        )}
        </div>
      </div>

      {!autoScroll && turns.length > 0 && (
        <button
          type="button"
          onClick={scrollToBottom}
          className="group absolute right-6 z-20 flex items-center gap-1.5 rounded-full border border-af-border bg-af-panel/95 px-3 py-1.5 text-xs font-medium text-af-text shadow-lg backdrop-blur-md transition-all hover:bg-af-hover hover:border-af-accent/40 hover:text-af-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-af-accent animate-in fade-in-0 slide-in-from-bottom-2"
          style={{ bottom: (bottomInset || 0) + 12 }}
          aria-label="Scroll down to resume live transcript"
        >
          {isRecording && <span className="h-1.5 w-1.5 rounded-full bg-af-record animate-pulse" />}
          <span className="text-[11px] font-medium">{isRecording ? 'Resume Live' : 'Jump to latest'}</span>
          <ChevronDown className="h-3.5 w-3.5 text-af-text-3 transition-transform group-hover:translate-y-0.5 group-hover:text-af-accent" />
        </button>
      )}

      <Dialog open={selectedImage !== null} onOpenChange={(open) => !open && setSelectedImage(null)}>
        <DialogContent className="max-w-4xl">
          <DialogHeader><DialogTitle>Meeting image · {selectedImage ? clock(selectedImage.audioTime) : ''}</DialogTitle></DialogHeader>
          {selectedImage && <img src={convertFileSrc(selectedImage.path)} alt={`Meeting image at ${clock(selectedImage.audioTime)}`} className="max-h-[70vh] w-full object-contain" />}
          {selectedImage && onSeek && <div className="flex justify-end"><Button variant="secondary" onClick={() => { onSeek(selectedImage.audioTime); setSelectedImage(null); }}>Play from here</Button></div>}
        </DialogContent>
      </Dialog>
    </div>
  );
};
