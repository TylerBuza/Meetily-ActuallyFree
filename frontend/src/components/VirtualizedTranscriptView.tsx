'use client';

/**
 * The transcript renderer actually used by the app — both during live recording
 * and on the meeting-details screen. (`components/TranscriptView.tsx` is dead
 * code; edit this file instead.)
 *
 * Rows are virtualized with @tanstack/react-virtual so multi-hour meetings stay
 * responsive: only visible segments are mounted.
 *
 * ## Speaker labels
 * Each segment may carry a `speaker` string, rendered above its text and given
 * a stable colour by `speakerColor()`. Two sources produce it:
 *   - live recording  → streaming diarization ("Speaker 1/2/3"), see
 *     `src-tauri/src/diarization/online.rs`
 *   - after the fact  → the Speakers action re-runs offline diarization and
 *     persists labels to the DB `transcripts.speaker` column
 *
 * ⚠️ The label only appears if every hop preserves it. Three separate
 * transcript→segment converters exist and each must copy `speaker`:
 *   1. `app/_components/TranscriptPanel.tsx`        (live)
 *   2. `components/MeetingDetails/TranscriptPanel.tsx` (non-paginated)
 *   3. `hooks/usePaginatedTranscripts.ts`            (paginated)
 * Dropping it in any one of them silently hides speakers on that screen.
 */

import { useCallback, useRef, useReducer, startTransition, useEffect, useState, useMemo, memo } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useAutoScroll } from "@/hooks/useAutoScroll";
import { useTranscriptStreaming } from "@/hooks/useTranscriptStreaming";
import { ConfidenceIndicator } from "./ConfidenceIndicator";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";
import { motion } from "framer-motion";
import { TranscriptSegmentData } from "@/types";

export interface VirtualizedTranscriptViewProps {
    /** Transcript segments to display */
    segments: TranscriptSegmentData[];
    /** Whether recording is in progress */
    isRecording?: boolean;
    /** Whether recording is paused */
    isPaused?: boolean;
    /** Whether processing/finalizing transcription */
    isProcessing?: boolean;
    /** Whether stopping */
    isStopping?: boolean;
    /** Enable streaming effect for latest segment */
    enableStreaming?: boolean;
    /** Show confidence indicators */
    showConfidence?: boolean;
    /** Completely disable auto-scroll behavior (for meeting details page) */
    disableAutoScroll?: boolean;

    // Pagination props (infinite scroll)
    hasMore?: boolean;
    isLoadingMore?: boolean;
    totalCount?: number;
    loadedCount?: number;
    onLoadMore?: () => void;

    /**
     * Called when a speaker label is clicked. When omitted, labels render as
     * plain text — the live recording view has no meeting to persist against
     * yet, so renaming is only offered on saved meetings.
     */
    onRenameSpeaker?: (speaker: string) => void;
}

// Threshold for enabling virtualization (below this, use simple rendering)
const VIRTUALIZATION_THRESHOLD = 10;

// Helper function to format seconds as recording-relative time [MM:SS]
function formatRecordingTime(seconds: number | undefined): string {
    if (seconds === undefined) return '--:--:--';

    const totalSeconds = Math.floor(seconds);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const secs = totalSeconds % 60;

    return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

// Helper function to remove filler words and repetitions
function cleanStopWords(text: string): string {
    const stopWords = ['uh', 'um', 'er', 'ah', 'hmm', 'hm', 'eh', 'oh'];

    let cleanedText = text;
    stopWords.forEach(word => {
        const pattern = new RegExp(`\\b${word}\\b[,\\s]*`, 'gi');
        cleanedText = cleanedText.replace(pattern, ' ');
    });

    return cleanedText.replace(/\s+/g, ' ').trim();
}

// Memoized transcript segment component
/**
 * Turn a raw speaker label into what the user should read.
 *
 * Diarization emits the bare marker "You" for whichever voice arrives on the
 * local microphone. The display name lives in settings (not in Rust) so it can
 * be changed without restarting, which is why substitution happens here.
 */
function displaySpeaker(speaker: string, userName: string): string {
    if (/^you\b/i.test(speaker)) {
        return userName ? `${userName} (You)` : 'You';
    }
    return speaker;
}

/** Normalize speaker keys so "You" / "you" / empty compare cleanly. */
function speakerKey(speaker?: string): string {
    return (speaker ?? '').trim().toLowerCase() || '__unknown__';
}

/**
 * Collapse back-to-back lines from the same speaker into one bubble when the
 * gap is small. Live VAD often emits many short fragments for one turn.
 */
function mergeAdjacentSameSpeaker(
    segments: TranscriptSegmentData[],
    maxGapSecs = 2.5,
): TranscriptSegmentData[] {
    if (segments.length <= 1) return segments;
    const out: TranscriptSegmentData[] = [];
    for (const seg of segments) {
        const last = out[out.length - 1];
        const lastEnd = last?.endTime ?? last?.timestamp ?? 0;
        const gap = seg.timestamp - lastEnd;
        if (
            last &&
            speakerKey(last.speaker) === speakerKey(seg.speaker) &&
            gap >= 0 &&
            gap <= maxGapSecs
        ) {
            const joined = `${last.text.trim()} ${seg.text.trim()}`.replace(/\s+/g, ' ').trim();
            last.text = joined;
            last.endTime = seg.endTime ?? seg.timestamp;
            if (seg.confidence != null && last.confidence != null) {
                last.confidence = Math.min(last.confidence, seg.confidence);
            } else if (seg.confidence != null) {
                last.confidence = seg.confidence;
            }
        } else {
            out.push({ ...seg });
        }
    }
    return out;
}

/** Dot colour on the timeline rail — same mapping as the text colour. */
function speakerDot(speaker?: string): string {
    if (!speaker) return 'bg-gray-600';
    if (/^you\b/i.test(speaker)) return 'bg-blue-500';
    if (/^guest\b/i.test(speaker)) return 'bg-purple-500';
    const palette = [
        'bg-blue-500',
        'bg-purple-500',
        'bg-emerald-500',
        'bg-amber-500',
        'bg-pink-500',
        'bg-cyan-500',
    ];
    let hash = 0;
    for (let i = 0; i < speaker.length; i++) hash = (hash * 31 + speaker.charCodeAt(i)) >>> 0;
    return palette[hash % palette.length];
}

/** Stable colour per speaker label so each speaker reads consistently. */
function speakerColor(speaker: string): string {
    if (/^you\b/i.test(speaker)) return 'text-blue-500';
    if (/^guest\b/i.test(speaker)) return 'text-purple-500';
    const palette = [
        'text-blue-500',
        'text-purple-500',
        'text-emerald-500',
        'text-amber-500',
        'text-pink-500',
        'text-cyan-500',
    ];
    let hash = 0;
    for (let i = 0; i < speaker.length; i++) hash = (hash * 31 + speaker.charCodeAt(i)) >>> 0;
    return palette[hash % palette.length];
}

const TranscriptSegment = memo(function TranscriptSegment({
    id,
    timestamp,
    text,
    confidence,
    isStreaming,
    showConfidence,
    speaker,
    userName,
    onRenameSpeaker,
}: {
    id: string;
    timestamp: number;
    text: string;
    confidence?: number;
    isStreaming: boolean;
    showConfidence: boolean;
    speaker?: string;
    userName: string;
    /** When provided, speaker labels become clickable for renaming. */
    onRenameSpeaker?: (speaker: string) => void;
}) {
    const displayText = cleanStopWords(text) || (text.trim() === '' ? '[Silence]' : text);

    // Split conversation: local user ("You" + their name) on the right in blue,
    // everyone else on the left in purple/hashed colors. Timestamps stay shared
    // so turns still line up chronologically.
    const isYou = !!(speaker && /^you\b/i.test(speaker));
    const label = speaker ? displaySpeaker(speaker, userName) : '';

    return (
        <div
            id={`segment-${id}`}
            className={`relative flex pb-4 ${isYou ? 'justify-end pl-10' : 'justify-start pr-10'}`}
        >
            <div className={`max-w-[85%] min-w-0 flex flex-col gap-1 ${isYou ? 'items-end' : 'items-start'}`}>
                <div className={`flex items-baseline gap-2 ${isYou ? 'flex-row-reverse' : 'flex-row'}`}>
                    <span
                        aria-hidden
                        className={`h-2 w-2 rounded-full shrink-0 ${speakerDot(speaker)}`}
                    />
                    {speaker && (
                        onRenameSpeaker ? (
                            <button
                                type="button"
                                onClick={() => onRenameSpeaker(speaker)}
                                title={`Rename "${speaker}" - click to say who this is`}
                                className={`text-xs font-semibold ${speakerColor(speaker)} rounded hover:underline`}
                            >
                                {label}
                            </button>
                        ) : (
                            <span className={`text-xs font-semibold ${speakerColor(speaker)}`}>
                                {label}
                            </span>
                        )
                    )}
                    <Tooltip>
                        <TooltipTrigger>
                            <span className="text-[11px] text-[var(--af-text-3)] tabular-nums">
                                {formatRecordingTime(timestamp)}
                            </span>
                        </TooltipTrigger>
                        <TooltipContent>
                            {confidence !== undefined && showConfidence && (
                                <ConfidenceIndicator confidence={confidence} showIndicator={showConfidence} />
                            )}
                        </TooltipContent>
                    </Tooltip>
                </div>

                <div
                    className={
                        isYou
                            ? 'rounded-2xl rounded-tr-sm bg-blue-500/15 border border-blue-500/25 px-3.5 py-2'
                            : 'rounded-2xl rounded-tl-sm bg-[var(--af-panel-2)] border border-[var(--af-border)] px-3.5 py-2'
                    }
                >
                    <p
                        className={`text-sm leading-relaxed ${
                            isYou ? 'text-[var(--af-text)]' : 'text-[var(--af-text-2)]'
                        } ${isStreaming ? 'opacity-80' : ''}`}
                    >
                        {displayText}
                    </p>
                </div>
            </div>
        </div>
    );
});

export const VirtualizedTranscriptView: React.FC<VirtualizedTranscriptViewProps> = ({
    segments,
    isRecording = false,
    isPaused = false,
    isProcessing = false,
    isStopping = false,
    enableStreaming = false,
    showConfidence = true,
    disableAutoScroll = false,
    hasMore = false,
    isLoadingMore = false,
    totalCount = 0,
    loadedCount = 0,
    onLoadMore,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    onRenameSpeaker,
}) => {
    // Greet the user by name when they've set one (Settings → General → Your
    // Name). Read on mount rather than at module scope so it picks up changes
    // without a reload, and guards `window` for SSR.
    const [userName, setUserName] = useState<string>('');
    useEffect(() => {
        if (typeof window !== 'undefined') {
            setUserName(localStorage.getItem('meetily_user_name')?.trim() || '');
        }
    }, []);

    // One bubble per speaking turn instead of dozens of VAD fragments.
    const displaySegments = useMemo(
        () => mergeAdjacentSameSpeaker(segments),
        [segments],
    );

    // Create scroll ref first - shared between virtualizer and auto-scroll hook
    const scrollRef = useRef<HTMLDivElement>(null);
    // Ref for infinite scroll trigger element
    const loadMoreTriggerRef = useRef<HTMLDivElement>(null);

    // Force re-render without flushSync (avoids React warning)
    const [, rerender] = useReducer((x: number) => x + 1, 0);

    // Setup virtualizer for efficient rendering of large lists
    const virtualizer = useVirtualizer({
        count: displaySegments.length,
        getScrollElement: () => scrollRef.current,
        estimateSize: () => 60, // Estimated height per segment
        overscan: 10, // Render extra items above/below viewport
        onChange: () => {
            startTransition(() => {
                rerender();
            });
        },
    });

    // Custom hook for auto-scrolling (supports both virtualized and non-virtualized)
    useAutoScroll({
        scrollRef,
        segments: displaySegments,
        isRecording,
        isPaused,
        virtualizer,
        virtualizationThreshold: VIRTUALIZATION_THRESHOLD,
        disableAutoScroll,
    });

    // Streaming text effect hook (typewriter animation for new transcripts)
    const { streamingSegmentId, getDisplayText } = useTranscriptStreaming(
        displaySegments,
        isRecording,
        enableStreaming
    );

    // Infinite scroll: IntersectionObserver to trigger loading more
    useEffect(() => {
        if (!onLoadMore || !hasMore || isLoadingMore || isRecording || displaySegments.length === 0) {
            return;
        }

        const triggerElement = loadMoreTriggerRef.current;
        if (!triggerElement) return;

        const observer = new IntersectionObserver(
            (entries) => {
                if (entries[0].isIntersecting && hasMore && !isLoadingMore) {
                    onLoadMore();
                }
            },
            {
                root: null,
                rootMargin: '100px',
                threshold: 0,
            }
        );

        observer.observe(triggerElement);

        return () => observer.disconnect();
    }, [hasMore, isLoadingMore, onLoadMore, isRecording, displaySegments.length]);

    // Scroll-based fallback for fast scrolling
    useEffect(() => {
        if (!onLoadMore || !hasMore || isLoadingMore || isRecording) return;

        const scrollElement = scrollRef.current;
        if (!scrollElement) return;

        let ticking = false;

        const handleScroll = () => {
            if (ticking || isLoadingMore || !hasMore) return;

            ticking = true;
            requestAnimationFrame(() => {
                const { scrollTop, scrollHeight, clientHeight } = scrollElement;
                const scrollBottom = scrollHeight - scrollTop - clientHeight;

                // Trigger load when within 200px of bottom
                if (scrollBottom < 200 && hasMore && !isLoadingMore) {
                    onLoadMore();
                }
                ticking = false;
            });
        };

        scrollElement.addEventListener('scroll', handleScroll, { passive: true });
        return () => scrollElement.removeEventListener('scroll', handleScroll);
    }, [onLoadMore, hasMore, isLoadingMore, isRecording]);

    // Use simple rendering for small lists, virtualization for large lists
    const useVirtualization = displaySegments.length >= VIRTUALIZATION_THRESHOLD;

    return (
        <div
            ref={scrollRef}
            className="flex flex-col h-full overflow-y-auto px-4 py-2"
            style={isRecording ? { scrollPaddingBottom: '10rem' } : undefined}
        >
            {/* Content */}
            <div className={isRecording ? 'pt-2 pb-4' : ''}>
            {displaySegments.length === 0 ? (
                // Empty state
                <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    className="text-center text-gray-500 mt-8"
                >
                    {isRecording ? (
                        <>
                            <div className="flex items-center justify-center mb-3">
                                <div className={`w-3 h-3 rounded-full ${isPaused ? 'bg-orange-500' : 'bg-blue-500 animate-pulse'}`}></div>
                            </div>
                            <p className="text-sm text-gray-600">
                                {isPaused ? 'Recording paused' : 'Listening for speech...'}
                            </p>
                            <p className="text-xs mt-1 text-gray-400">
                                {isPaused ? 'Click resume to continue recording' : 'Speak to see live transcription'}
                            </p>
                        </>
                    ) : (
                        <>
                            <p className="text-lg font-semibold">
                                {userName ? `Welcome back, ${userName}!` : 'Welcome to Meetily · Actually Free'}
                            </p>
                            <p className="text-xs mt-1">Start recording to see live transcription</p>
                        </>
                    )}
                </motion.div>
            ) : useVirtualization ? (
                // Virtualized rendering for large lists
                <>
                    <div
                        style={{
                            height: virtualizer.getTotalSize(),
                            width: "100%",
                            position: "relative",
                        }}
                    >
                        {virtualizer.getVirtualItems().map((virtualRow) => {
                            const segment = displaySegments[virtualRow.index];
                            const isStreaming = streamingSegmentId === segment.id;

                            return (
                                <div
                                    key={segment.id}
                                    data-index={virtualRow.index}
                                    ref={virtualizer.measureElement}
                                    style={{
                                        position: "absolute",
                                        top: 0,
                                        left: 0,
                                        width: "100%",
                                        transform: `translateY(${virtualRow.start}px)`,
                                    }}
                                >
                                    <TranscriptSegment
                                        id={segment.id}
                                        timestamp={segment.timestamp}
                                        text={getDisplayText(segment)}
                                        confidence={segment.confidence}
                                        isStreaming={isStreaming}
                                        showConfidence={showConfidence}
                                        speaker={segment.speaker}
                                        userName={userName}
                                        onRenameSpeaker={onRenameSpeaker}
                                    />
                                </div>
                            );
                        })}
                    </div>

                    {/* Infinite scroll trigger and loading indicator */}
                    {(hasMore || isLoadingMore) && !isRecording && displaySegments.length > 0 && (
                        <div ref={loadMoreTriggerRef} className="flex justify-center items-center py-4 mt-2">
                            {isLoadingMore ? (
                                <div className="flex items-center gap-2 text-gray-500">
                                    <div className="w-4 h-4 border-2 border-gray-300 border-t-gray-600 rounded-full animate-spin" />
                                    <span className="text-sm">Loading more...</span>
                                </div>
                            ) : hasMore && totalCount > 0 ? (
                                <span className="text-sm text-gray-400">
                                    Showing {loadedCount} of {totalCount} segments
                                </span>
                            ) : null}
                        </div>
                    )}

                    {/* Status line — always reserve space while recording so pause
                        doesn't collapse layout and shove bubbles under the bar. */}
                    {!isStopping && isRecording && !isProcessing && displaySegments.length > 0 && (
                        <div className="flex items-center gap-2 mt-4 mb-2 min-h-[1.25rem] text-gray-500">
                            {!isPaused && (
                                <>
                                    <div className="w-2 h-2 bg-blue-500 rounded-full animate-pulse" />
                                    <span className="text-sm">Listening…</span>
                                </>
                            )}
                            {isPaused && (
                                <span className="text-sm text-orange-400/80">Paused</span>
                            )}
                        </div>
                    )}
                </>
            ) : (
                // Simple rendering for small lists (better animations)
                <>
                    <div className="space-y-1">
                        {displaySegments.map((segment) => {
                            const isStreaming = streamingSegmentId === segment.id;

                            return (
                                <motion.div
                                    key={segment.id}
                                    initial={{ opacity: 0, y: 5 }}
                                    animate={{ opacity: 1, y: 0 }}
                                    transition={{ duration: 0.15 }}
                                >
                                    <TranscriptSegment
                                        id={segment.id}
                                        timestamp={segment.timestamp}
                                        text={getDisplayText(segment)}
                                        confidence={segment.confidence}
                                        isStreaming={isStreaming}
                                        showConfidence={showConfidence}
                                        speaker={segment.speaker}
                                        userName={userName}
                                        onRenameSpeaker={onRenameSpeaker}
                                    />
                                </motion.div>
                            );
                        })}
                    </div>

                    {/* Infinite scroll trigger (for small lists that grow) */}
                    {(hasMore || isLoadingMore) && !isRecording && displaySegments.length > 0 && (
                        <div ref={loadMoreTriggerRef} className="flex justify-center items-center py-4 mt-2">
                            {isLoadingMore ? (
                                <div className="flex items-center gap-2 text-gray-500">
                                    <div className="w-4 h-4 border-2 border-gray-300 border-t-gray-600 rounded-full animate-spin" />
                                    <span className="text-sm">Loading more...</span>
                                </div>
                            ) : hasMore && totalCount > 0 ? (
                                <span className="text-sm text-gray-400">
                                    Showing {loadedCount} of {totalCount} segments
                                </span>
                            ) : null}
                        </div>
                    )}

                    {!isStopping && isRecording && !isProcessing && displaySegments.length > 0 && (
                        <div className="flex items-center gap-2 mt-4 mb-2 min-h-[1.25rem] text-gray-500">
                            {!isPaused && (
                                <>
                                    <div className="w-2 h-2 bg-blue-500 rounded-full animate-pulse" />
                                    <span className="text-sm">Listening…</span>
                                </>
                            )}
                            {isPaused && (
                                <span className="text-sm text-orange-400/80">Paused</span>
                            )}
                        </div>
                    )}
                </>
            )}
            </div>
        </div>
    );
};