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

import { useMemo, useState, useEffect } from 'react';
import { Transcript, TranscriptSegmentData, DetectedSpeaker } from '@/types';
import { Calendar, Clock, Users } from 'lucide-react';
import { SpeakerRenameDialog } from './SpeakerRenameDialog';
import { VirtualizedTranscriptView } from '@/components/VirtualizedTranscriptView';
import { TranscriptButtonGroup } from './TranscriptButtonGroup';
import { SpeakersSidebar } from '@/components/SpeakersSidebar';
import { MergeSpeakerDialog } from '@/components/MergeSpeakerDialog';
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'sonner';
import { isUserSpeaker, speakerPaletteIndex } from '@/utils/speakerUtils';
import { useConfig } from '@/contexts/ConfigContext';

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
  onSpeakerRenamed?: (rename: { from: string; to: string; count: number; removedName: boolean }) => void;
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
  const { showSpeakersPanel } = useConfig();
  const [renameTarget, setRenameTarget] = useState<string | null>(null);
  const [mergeTarget, setMergeTarget] = useState<string | null>(null);
  const [showSpeakersSidebar, setShowSpeakersSidebar] = useState<boolean>(showSpeakersPanel);
  const [userName, setUserName] = useState<string>('');

  useEffect(() => {
    setShowSpeakersSidebar(showSpeakersPanel);
  }, [showSpeakersPanel]);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      setUserName(localStorage.getItem('meetily_user_name')?.trim() || '');
    }
  }, []);

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

  // Derived speakers list from converted segments
  const detectedSpeakers = useMemo<DetectedSpeaker[]>(() => {
    const map = new Map<string, { count: number; lastTime?: number }>();
    for (const seg of convertedSegments) {
      const spk = seg.speaker?.trim() || 'Speaker 1';
      const existing = map.get(spk);
      if (existing) {
        existing.count += 1;
        if (seg.timestamp !== undefined) {
          existing.lastTime = Math.max(existing.lastTime ?? 0, seg.timestamp);
        }
      } else {
        map.set(spk, {
          count: 1,
          lastTime: seg.timestamp,
        });
      }
    }
    return Array.from(map.entries()).map(([name, data]) => ({
      id: name,
      name,
      isUser: isUserSpeaker(name),
      segmentCount: data.count,
      lastSpokeAt: data.lastTime,
      colorIndex: speakerPaletteIndex(name),
    }));
  }, [convertedSegments]);

  const handleMergeSpeaker = async (source: string, target: string) => {
    if (!meetingId || !source || !target || source === target) return;
    try {
      await invoke('rename_meeting_speaker', {
        meetingId,
        from: source,
        to: target,
      });
      toast.success(`Merged "${source}" into "${target}"`);
      await onRefetchTranscripts?.();
      onSpeakerRenamed?.({
        from: source,
        to: target,
        count: 0,
        removedName: false,
      });
    } catch (e: any) {
      toast.error(`Merge failed: ${e?.message || e}`);
    }
  };

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

      {/* The action container owns its responsive breakpoint, since this column
          can be narrow even when the overall window is wide. */}
      <div className="mt-4 flex min-w-0 shrink-0 flex-wrap items-center gap-2 border-b border-[var(--af-border)] px-4 sm:mt-5 sm:gap-3 sm:px-6 lg:px-8">
        <span className="relative -mb-px shrink-0 py-2 text-sm font-medium text-[var(--af-accent)]">
          Transcript
          <span className="absolute inset-x-0 -bottom-px h-0.5 rounded-full bg-[var(--af-accent)]" />
        </span>
        <div className="transcript-actions-container ml-auto min-w-0 flex-[1_1_190px] py-1 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={() => setShowSpeakersSidebar((prev) => !prev)}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-medium transition-colors ${
              showSpeakersSidebar
                ? 'border-blue-400 bg-blue-500/10 text-blue-600 dark:text-blue-400 font-semibold'
                : 'border-[var(--af-border)] hover:bg-[var(--af-panel-2)] text-[var(--af-text-2)]'
            }`}
            title="Toggle detected speakers sidebar"
          >
            <Users size={14} />
            <span>Speakers</span>
            {detectedSpeakers.length > 0 && (
              <span className="px-1.5 py-0.2 rounded-full text-[10px] bg-blue-500/15 text-blue-600 dark:text-blue-400 font-semibold">
                {detectedSpeakers.length}
              </span>
            )}
          </button>
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
        onMergeClick={() => {
          if (renameTarget) {
            const t = renameTarget;
            setRenameTarget(null);
            setMergeTarget(t);
          }
        }}
      />

      <MergeSpeakerDialog
        open={mergeTarget !== null}
        sourceSpeaker={mergeTarget}
        onOpenChange={(open) => !open && setMergeTarget(null)}
        availableSpeakers={detectedSpeakers.map((s) => ({
          id: s.id,
          name: s.name,
          isUser: s.isUser,
          segmentCount: s.segmentCount,
        }))}
        onMerge={async (source, target) => {
          await handleMergeSpeaker(source, target);
          setMergeTarget(null);
        }}
      />

      {/* Transcript content + Speakers sidebar */}
      <div className="flex flex-1 overflow-hidden min-h-0">
        <div className="flex-1 overflow-hidden px-4 pb-4">
          <VirtualizedTranscriptView
            onRenameSpeaker={meetingId ? setRenameTarget : undefined}
            onMergeSpeaker={meetingId ? setMergeTarget : undefined}
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

        <SpeakersSidebar
          speakers={detectedSpeakers}
          userName={userName}
          isOpen={showSpeakersSidebar}
          onClose={() => setShowSpeakersSidebar(false)}
          onRenameSpeaker={async (from, to) => {
            if (!meetingId) return;
            try {
              await invoke('rename_meeting_speaker', {
                meetingId,
                from,
                to,
              });
              await onRefetchTranscripts?.();
              onSpeakerRenamed?.({ from, to, count: 0, removedName: false });
            } catch (e: any) {
              toast.error(`Rename failed: ${e?.message || e}`);
            }
          }}
          onMergeSpeaker={handleMergeSpeaker}
          isRecording={false}
        />
      </div>
    </div>
  );
}
