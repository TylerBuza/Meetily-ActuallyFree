"use client";

/**
 * Transcript column for the MEETING-DETAILS screen — the wide middle column.
 *
 * ⚠️ There are TWO components named `TranscriptPanel`. This is the
 * meeting-details one; the live recording screen uses
 * `app/_components/TranscriptPanel.tsx`. Editing the wrong file is a common
 * trap — it compiles and appears to do nothing.
 *
 * Both data paths feeding the virtualized view must carry `speaker` or speaker
 * labels vanish here:
 *   - paginated  → `segments` prop, built by `hooks/usePaginatedTranscripts.ts`
 *   - otherwise  → converted inline from `transcripts` below
 */

import { useMemo, useState } from 'react';
import { Transcript, TranscriptSegmentData } from '@/types';
import { Calendar, Clock } from 'lucide-react';
import { SpeakerRenameDialog } from './SpeakerRenameDialog';
import { VirtualizedTranscriptView } from '@/components/VirtualizedTranscriptView';
import { TranscriptButtonGroup } from './TranscriptButtonGroup';

interface TranscriptPanelProps {
  transcripts: Transcript[];
  title?: string;
  createdAt?: string;
  customPrompt: string;
  onPromptChange: (value: string) => void;
  onCopyTranscript: () => void;
  onOpenExport?: () => void;
  onOpenMeetingFolder: () => Promise<void>;
  isRecording: boolean;
  disableAutoScroll?: boolean;

  // Optional pagination props (when using virtualization)
  usePagination?: boolean;
  segments?: TranscriptSegmentData[];
  hasMore?: boolean;
  isLoadingMore?: boolean;
  totalCount?: number;
  loadedCount?: number;
  onLoadMore?: () => void;

  // Retranscription props
  meetingId?: string;
  meetingFolderPath?: string | null;
  onRefetchTranscripts?: () => Promise<void>;
  onSpeakerRenamed?: (rename: { from: string; to: string; count: number }) => void;
}

function fmtDate(d: Date): string {
  return d.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' });
}
function fmtTime(d: Date): string {
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

export function TranscriptPanel({
  transcripts,
  title,
  createdAt,
  customPrompt,
  onPromptChange,
  onCopyTranscript,
  onOpenExport,
  onOpenMeetingFolder,
  isRecording,
  disableAutoScroll = false,
  usePagination = false,
  segments,
  hasMore,
  isLoadingMore,
  totalCount,
  loadedCount,
  onLoadMore,
  meetingId,
  meetingFolderPath,
  onRefetchTranscripts,
  onSpeakerRenamed,
}: TranscriptPanelProps) {
  const [renameTarget, setRenameTarget] = useState<string | null>(null);

  const convertedSegments = useMemo(() => {
    if (usePagination && segments) return segments;
    return transcripts.map(t => ({
      id: t.id,
      timestamp: t.audio_start_time ?? 0,
      endTime: t.audio_end_time,
      text: t.text,
      confidence: t.confidence,
      speaker: t.speaker,
    }));
  }, [transcripts, usePagination, segments]);

  // Date + time range for the header. Start comes from the meeting timestamp;
  // the end is derived from the furthest transcript position we know about.
  const { dateLabel, timeLabel } = useMemo(() => {
    const start = createdAt ? new Date(createdAt) : null;
    if (!start || isNaN(start.getTime())) return { dateLabel: '', timeLabel: '' };
    const durationSec = convertedSegments.reduce(
      (max, s) => Math.max(max, (s as any).endTime ?? s.timestamp ?? 0),
      0,
    );
    const end = durationSec > 0 ? new Date(start.getTime() + durationSec * 1000) : null;
    return {
      dateLabel: fmtDate(start),
      timeLabel: end ? `${fmtTime(start)} — ${fmtTime(end)}` : fmtTime(start),
    };
  }, [createdAt, convertedSegments]);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-[var(--af-bg)]">
      {/* Header: title + date/time */}
      <div className="min-w-0 px-4 pt-5 sm:px-6 sm:pt-6 lg:px-8">
        <h1 className="truncate text-xl font-bold text-[var(--af-text)] sm:text-2xl">
          {title || 'Untitled meeting'}
        </h1>
        {(dateLabel || timeLabel) && (
          <div className="mt-2 flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1 text-sm text-[var(--af-text-2)]">
            {dateLabel && (
              <span className="inline-flex min-w-0 items-center gap-1.5">
                <Calendar size={15} className="shrink-0 text-[var(--af-text-3)]" />
                <span className="truncate">{dateLabel}</span>
              </span>
            )}
            {timeLabel && (
              <span className="inline-flex min-w-0 items-center gap-1.5">
                <Clock size={15} className="shrink-0 text-[var(--af-text-3)]" />
                <span className="truncate">{timeLabel}</span>
              </span>
            )}
          </div>
        )}
      </div>

      {/* "Transcript" tab + actions — wrap/scroll on narrow columns so buttons
          never spill into the AI Summary panel. */}
      <div className="mt-4 flex min-w-0 flex-wrap items-center gap-2 border-b border-[var(--af-border)] px-4 sm:mt-5 sm:gap-3 sm:px-6 lg:px-8">
        <span className="relative -mb-px shrink-0 py-2 text-sm font-medium text-[var(--af-accent)]">
          Transcript
          <span className="absolute inset-x-0 -bottom-px h-0.5 rounded-full bg-[var(--af-accent)]" />
        </span>
        <div className="ml-auto min-w-0 max-w-full overflow-x-auto pb-1 no-scrollbar">
          <TranscriptButtonGroup
            transcriptCount={usePagination ? (totalCount ?? convertedSegments.length) : (transcripts?.length || 0)}
            onCopyTranscript={onCopyTranscript}
            onOpenExport={onOpenExport}
            onOpenMeetingFolder={onOpenMeetingFolder}
            meetingId={meetingId}
            meetingFolderPath={meetingFolderPath}
            onRefetchTranscripts={onRefetchTranscripts}
          />
        </div>
      </div>

      <SpeakerRenameDialog
        open={renameTarget !== null}
        speaker={renameTarget}
        meetingId={meetingId}
        onOpenChange={(open) => !open && setRenameTarget(null)}
        onRenamed={async (rename) => {
          await onRefetchTranscripts?.();
          onSpeakerRenamed?.(rename);
        }}
      />

      {/* Transcript content */}
      <div className="flex-1 overflow-hidden px-4 pb-4">
        <VirtualizedTranscriptView
          onRenameSpeaker={meetingId ? setRenameTarget : undefined}
          segments={convertedSegments}
          isRecording={isRecording}
          isPaused={false}
          isProcessing={false}
          isStopping={false}
          enableStreaming={false}
          showConfidence={true}
          disableAutoScroll={disableAutoScroll}
          hasMore={hasMore}
          isLoadingMore={isLoadingMore}
          totalCount={totalCount}
          loadedCount={loadedCount}
          onLoadMore={onLoadMore}
        />
      </div>
    </div>
  );
}
