"use client";

/**
 * The meeting page: header, transcript (with playback), and the meeting's
 * document (notes, action items, summary, Ask AI) side by side.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { motion } from 'framer-motion';
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'sonner';
import type { Summary, Transcript, TranscriptSegmentData } from '@/types';
import Analytics from '@/lib/analytics';
import { useSidebar } from '@/components/Sidebar/SidebarProvider';
import { useConfig } from '@/contexts/ConfigContext';
import { useWorkspace } from '@/contexts/WorkspaceContext';
import { TemplateEditorModal } from '@/components/MeetingDetails/TemplateEditorModal';
import { MeetingExportDialog } from '@/components/MeetingDetails/MeetingExportDialog';
import { PostCallProcessingDialog } from '@/components/MeetingDetails/PostCallProcessingDialog';
import { ModelConfig } from '@/components/ModelSettingsModal';
import { VirtualizedTranscriptView } from '@/components/VirtualizedTranscriptView';
import { MeetingHeader } from '@/components/meeting/MeetingHeader';
import { MeetingDocument } from '@/components/meeting/MeetingDocument';
import { AudioPlayerBar } from '@/components/meeting/AudioPlayerBar';
import { PersonCard, type PersonCardTarget } from '@/components/people/PersonCard';
import { SpeakerIdentityDialog } from '@/components/people/SpeakerIdentityDialog';
import { useMeetingData } from '@/hooks/meeting-details/useMeetingData';
import { useSummaryGeneration } from '@/hooks/meeting-details/useSummaryGeneration';
import { useTemplates } from '@/hooks/meeting-details/useTemplates';
import { useCopyOperations } from '@/hooks/meeting-details/useCopyOperations';
import { useMeetingOperations } from '@/hooks/meeting-details/useMeetingOperations';
import { PLAYBACK_RATES, SLOW_PLAYBACK_RATES, useMeetingAudio } from '@/hooks/useMeetingAudio';
import { useWaveform } from '@/hooks/useWaveform';
import { useLabs } from '@/hooks/useLabs';
import { cleanTranscriptText } from '@/lib/labs';
import { useUserName } from '@/hooks/useUserName';
import { announceChange, getMeetingGroup, setMeetingGroup } from '@/lib/workspace-api';
import { deleteMeetings, renameMeeting } from '@/lib/meeting-actions';
import { displayTitle } from '@/lib/meeting-titles';
import { MEETING_IMAGES_CHANGED, type MeetingImage } from '@/lib/meeting-images';
import { cn } from '@/lib/utils';
import { displaySpeaker, speakerColorIndexMap, speakerKey } from '@/utils/speakerUtils';

// Page remounts join the same backend-start attempt. Only accepted attempts are
// persisted in sessionStorage below; failed preflight attempts remain retryable.
const autoSummaryInFlight = new Map<string, Promise<boolean>>();
const NOTES_WIDTH_KEY = 'af-meeting-notes-width';
const TRANSCRIPT_MIN = 340;
const DOCUMENT_MIN = 380;

function clampDocumentWidth(width: number, frame: number) {
  const max = Math.max(DOCUMENT_MIN, frame - 6 - TRANSCRIPT_MIN);
  return Math.round(Math.min(max, Math.max(DOCUMENT_MIN, width)));
}

export default function PageContent({
  meeting,
  summaryData,
  summaryUserEdited = false,
  isPostCallRecording = false,
  shouldAutoGenerate = false,
  onAutoGenerateComplete,
  onSummaryReady,
  onMeetingUpdated,
  onRefetchTranscripts,
  segments,
  hasMore,
  isLoadingMore,
  totalCount,
  loadedCount,
  onLoadMore,
  focusTranscriptId,
  focusTime,
}: {
  meeting: any;
  summaryData: Summary | null;
  summaryUserEdited?: boolean;
  isPostCallRecording?: boolean;
  shouldAutoGenerate?: boolean;
  onAutoGenerateComplete?: () => void;
  onSummaryReady?: (summary: Summary) => void;
  onMeetingUpdated?: () => Promise<void>;
  onRefetchTranscripts?: () => Promise<void>;
  segments?: TranscriptSegmentData[];
  hasMore?: boolean;
  isLoadingMore?: boolean;
  totalCount?: number;
  loadedCount?: number;
  onLoadMore?: () => void;
  focusTranscriptId?: string | null;
  focusTime?: number | null;
}) {
  const { setCurrentMeeting } = useSidebar();
  const { modelConfig, setModelConfig } = useConfig();
  const { people } = useWorkspace();
  const userName = useUserName();

  const [templateEditorOpen, setTemplateEditorOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [postCallDoneFor, setPostCallDoneFor] = useState<string | null>(null);
  const [documentWidth, setDocumentWidth] = useState(520);
  const [stacked, setStacked] = useState(false);
  const [draggingSplit, setDraggingSplit] = useState(false);
  const frameRef = useRef<HTMLDivElement>(null);
  const [title, setTitle] = useState<string>(displayTitle(meeting.title, meeting.created_at));
  const [groupId, setGroupId] = useState<string | null>(null);
  const [follow, setFollow] = useState(true);
  const [cardTarget, setCardTarget] = useState<PersonCardTarget | null>(null);
  const [identity, setIdentity] = useState<{ speaker: string; transcriptId: string | null } | null>(null);
  const [regenerateRequest, setRegenerateRequest] = useState<{ open: boolean; context: string; reason?: string } | null>(null);

  const meetingData = useMeetingData({ meeting, summaryData });
  const templates = useTemplates();
  const meetingOperations = useMeetingOperations({ meeting });
  const audio = useMeetingAudio(meeting.id);
  const [meetingImages, setMeetingImages] = useState<MeetingImage[]>([]);
  useEffect(() => {
    let cancelled = false;
    setMeetingImages([]);
    const refresh = () => {
      void invoke<MeetingImage[]>('list_meeting_images', { meetingId: meeting.id, live: false })
        .then((images) => { if (!cancelled) setMeetingImages(images); })
        .catch((error) => console.error('Could not load meeting images', error));
    };
    refresh();
    window.addEventListener(MEETING_IMAGES_CHANGED, refresh);
    return () => { cancelled = true; window.removeEventListener(MEETING_IMAGES_CHANGED, refresh); };
  }, [meeting.id]);
  // Labs: waveform and slower speeds in the player, Clean/Verbatim transcript.
  const { labs, ready: labsReady } = useLabs();
  const waveform = useWaveform(audio.path, labs.transcriptScrubbing);
  const [textMode, setTextMode] = useState<'clean' | 'verbatim'>('clean');

  useEffect(() => setTitle(displayTitle(meeting.title, meeting.created_at)), [meeting.title, meeting.created_at]);

  useEffect(() => {
    Analytics.trackPageView('meeting_details');
  }, []);

  useEffect(() => {
    let cancelled = false;
    void getMeetingGroup(meeting.id)
      .then((group) => !cancelled && setGroupId(group?.id ?? null))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [meeting.id]);

  // Layout: side by side on wide windows, stacked on narrow ones.
  useEffect(() => {
    const query = window.matchMedia('(max-width: 900px)');
    const apply = () => setStacked(query.matches);
    apply();
    query.addEventListener('change', apply);
    return () => query.removeEventListener('change', apply);
  }, []);

  useEffect(() => {
    const frame = frameRef.current?.clientWidth ?? window.innerWidth;
    const stored = Number(localStorage.getItem(NOTES_WIDTH_KEY));
    setDocumentWidth(clampDocumentWidth(Number.isFinite(stored) && stored > 0 ? stored : Math.round(frame * 0.48), frame));
    const onResize = () => {
      const width = frameRef.current?.clientWidth;
      if (width) setDocumentWidth((current) => clampDocumentWidth(current, width));
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const startSplitDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const originX = event.clientX;
    const origin = documentWidth;
    setDraggingSplit(true);
    const move = (moveEvent: PointerEvent) => {
      const frame = frameRef.current?.clientWidth ?? origin + TRANSCRIPT_MIN;
      setDocumentWidth(clampDocumentWidth(origin - (moveEvent.clientX - originX), frame));
    };
    const stop = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
      setDraggingSplit(false);
      setDocumentWidth((current) => {
        localStorage.setItem(NOTES_WIDTH_KEY, String(current));
        return current;
      });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop);
  };

  // ---- Summary state ---------------------------------------------------------
  const setAiSummary = useCallback(
    (summary: Summary | null) => {
      meetingData.setAiSummary(summary);
      if (summary && onSummaryReady) onSummaryReady(summary);
    },
    [meetingData.setAiSummary, onSummaryReady],
  );

  const handleSummaryChange = useCallback(
    (summary: any, source: 'user' | 'system') => {
      meetingData.setAiSummary(summary);
      if (source === 'system' && onSummaryReady) onSummaryReady(summary);
    },
    [meetingData.setAiSummary, onSummaryReady],
  );

  const openModelSettingsRef = useRef<(() => void) | null>(null);
  const summaryGeneration = useSummaryGeneration({
    meeting,
    transcripts: meetingData.transcripts,
    modelConfig,
    isModelConfigLoading: false,
    selectedTemplate: templates.selectedTemplate,
    onMeetingUpdated,
    setAiSummary,
    onOpenModelSettings: () => openModelSettingsRef.current?.(),
    // New summaries are written from the clean text when Labs asks for it.
    cleanText: labs.cleanTranscript ? cleanTranscriptText : undefined,
  });

  const handleSaveModelConfig = async (config?: ModelConfig) => {
    if (!config) return;
    try {
      await invoke('api_save_model_config', {
        provider: config.provider,
        model: config.model,
        whisperModel: config.whisperModel,
        apiKey: config.apiKey ?? null,
        ollamaEndpoint: config.ollamaEndpoint ?? null,
        summaryMaxTokens: config.summaryMaxTokens ?? null,
        claudeCliPath: config.claudeCliPath ?? null,
      });
      const { emit } = await import('@tauri-apps/api/event');
      await emit('model-config-updated', config);
      toast.success('Summary model saved');
    } catch (error) {
      console.error('Failed to save model config:', error);
      toast.error('Could not save the summary model');
    }
  };

  const copyOperations = useCopyOperations({
    meeting,
    meetingTitle: title,
    aiSummary: meetingData.aiSummary,
  });

  // Auto-generate after a recording (or when the policy asks for it).
  useEffect(() => {
    const run = async () => {
      // The Labs choice decides which text the summary is written from.
      if (!labsReady) return;
      if (!shouldAutoGenerate || meetingData.transcripts.length === 0) return;
      if (isPostCallRecording && postCallDoneFor !== meeting.id) return;
      if (isPostCallRecording) {
        const key = `post-call-summary-started:${meeting.id}`;
        if (sessionStorage.getItem(key)) {
          onAutoGenerateComplete?.();
          return;
        }
        let attempt = autoSummaryInFlight.get(meeting.id);
        if (!attempt) {
          attempt = summaryGeneration.handleGenerateSummary('');
          autoSummaryInFlight.set(meeting.id, attempt);
        }
        let accepted = false;
        try {
          accepted = await attempt;
        } finally {
          if (autoSummaryInFlight.get(meeting.id) === attempt) autoSummaryInFlight.delete(meeting.id);
        }
        if (accepted) {
          sessionStorage.setItem(key, 'started');
          onAutoGenerateComplete?.();
        }
        return;
      }
      await summaryGeneration.handleGenerateSummary('');
      onAutoGenerateComplete?.();
    };
    void run();
  }, [
    labsReady,
    shouldAutoGenerate,
    meeting.id,
    meetingData.transcripts.length,
    isPostCallRecording,
    postCallDoneFor,
    summaryGeneration.handleGenerateSummary,
    onAutoGenerateComplete,
  ]);

  // ---- Transcript data -------------------------------------------------------
  const transcriptSegments = useMemo<TranscriptSegmentData[]>(
    () =>
      segments ??
      (meetingData.transcripts as Transcript[]).map((t) => ({
        id: t.id,
        timestamp: t.audio_start_time ?? 0,
        endTime: t.audio_end_time,
        text: t.text,
        confidence: t.confidence,
        speaker: t.speaker,
      })),
    [segments, meetingData.transcripts],
  );

  const speakers = useMemo(() => {
    const counts = new Map<string, number>();
    for (const segment of transcriptSegments) {
      const label = segment.speaker?.trim();
      if (label) counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    // Also include all distinct meeting speakers from metadata even before scrolling through paginated transcripts
    if (meetingData.speakers) {
      for (const spk of meetingData.speakers) {
        const label = spk.trim();
        if (label && !counts.has(label)) {
          counts.set(label, 0);
        }
      }
    }
    return [...counts.entries()].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count);
  }, [transcriptSegments, meetingData.speakers]);

  // One colour per speaker, in the order they first spoke, shared by the
  // transcript, the person card and the identify dialog.
  const colorIndices = useMemo(
    () => speakerColorIndexMap([
      ...(meetingData.speakers ?? []),
      ...transcriptSegments.map((segment) => segment.speaker ?? ''),
    ].filter(Boolean), String(meeting?.id || 'meeting-details')),
    [transcriptSegments, meetingData.speakers, meeting?.id],
  );
  const colorIndexOf = useCallback((label: string) => colorIndices.get(speakerKey(label)), [colorIndices]);


  // Deep link from search or an action item: the line itself, or the line
  // spoken at the linked time. Load pages until it is present, then show it.
  const focusLineId = useMemo(() => {
    if (focusTranscriptId) return focusTranscriptId;
    if (focusTime == null) return null;
    let match: string | null = null;
    for (const segment of transcriptSegments) {
      if (segment.timestamp <= focusTime + 0.5) match = segment.id;
      else break;
    }
    return match;
  }, [focusTranscriptId, focusTime, transcriptSegments]);
  const focusAttempts = useRef(0);
  useEffect(() => {
    if (!onLoadMore || (!focusTranscriptId && focusTime == null)) return;
    const last = transcriptSegments[transcriptSegments.length - 1];
    const present = focusTranscriptId
      ? transcriptSegments.some((segment) => segment.id === focusTranscriptId)
      : !!last && (last.endTime ?? last.timestamp) >= (focusTime ?? 0);
    if (present || !hasMore || isLoadingMore || focusAttempts.current > 40) return;
    focusAttempts.current += 1;
    onLoadMore();
  }, [focusTranscriptId, focusTime, transcriptSegments, hasMore, isLoadingMore, onLoadMore]);

  const focusedAudio = useRef(false);
  useEffect(() => {
    if (focusedAudio.current || focusTime == null || audio.status !== 'ready') return;
    focusedAudio.current = true;
    audio.seek(focusTime);
  }, [focusTime, audio]);

  const refreshAfterSpeakerChange = useCallback(
    async (rename?: { from: string; to: string; removedName: boolean }) => {
      await onRefetchTranscripts?.();
      announceChange('people');
      if (rename && meetingData.aiSummary) {
        setRegenerateRequest({
          open: true,
          context: rename.removedName
            ? `The name "${rename.from}" was removed. Use the meeting-local label "${rename.to}".`
            : `Use the updated speaker name "${rename.to}" and the other speaker labels from the transcript.`,
          reason: 'Speaker names changed. Regenerate the summary so it uses them?',
        });
      }
    },
    [onRefetchTranscripts, meetingData.aiSummary],
  );

  const mergeSpeakers = async (source: string, target: string) => {
    try {
      await invoke('rename_meeting_speaker', { meetingId: meeting.id, from: source, to: target });
      toast.success(`Merged ${displaySpeaker(source, userName)} into ${displaySpeaker(target, userName)}`);
      await refreshAfterSpeakerChange({ from: source, to: target, removedName: false });
    } catch (error) {
      toast.error('Could not merge the speakers', { description: error instanceof Error ? error.message : String(error) });
    }
  };

  const markMe = async (speaker: string) => {
    try {
      await invoke('rename_meeting_speaker', { meetingId: meeting.id, from: speaker, to: 'You' });
      toast.success(`${speaker} is now you`);
      await refreshAfterSpeakerChange({ from: speaker, to: 'You', removedName: false });
    } catch (error) {
      toast.error('Could not update the speaker', { description: error instanceof Error ? error.message : String(error) });
    }
  };

  const hasTranscript = (totalCount ?? meetingData.transcripts.length) > 0;

  return (
    <motion.div
      initial={isPostCallRecording ? false : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: isPostCallRecording ? 0 : 0.25, ease: [0.22, 1, 0.36, 1] }}
      className="flex h-full min-w-0 flex-col bg-af-panel"
    >
      <MeetingHeader
        meetingId={meeting.id}
        title={title}
        createdAt={meeting.created_at}
        durationSeconds={transcriptSegments.reduce((max, segment) => Math.max(max, segment.endTime ?? segment.timestamp ?? 0), 0) || undefined}
        folderPath={meeting.folder_path}
        groupId={groupId}
        onGroupChange={async (next) => {
          const previous = groupId;
          setGroupId(next);
          try {
            await setMeetingGroup(meeting.id, next);
            announceChange('meetings', { meetingId: meeting.id });
            announceChange('groups');
          } catch (error) {
            setGroupId(previous);
            toast.error('Could not change the group', { description: error instanceof Error ? error.message : String(error) });
          }
        }}
        onRename={async (next) => {
          const ok = await renameMeeting(meeting.id, next);
          if (ok) {
            setTitle(next);
            setCurrentMeeting({ id: meeting.id, title: next });
          }
          return ok;
        }}
        people={speakers.map((speaker) => speaker.label)}
        onPersonClick={(label, anchor) => setCardTarget({ speaker: label, segmentId: '', rect: anchor.getBoundingClientRect() })}
        onExport={() => setExportOpen(true)}
        onCopyTranscript={copyOperations.handleCopyTranscript}
        onCopySummary={copyOperations.handleCopySummary}
        hasSummary={!!meetingData.aiSummary}
        onOpenFolder={meetingOperations.handleOpenMeetingFolder}
        onDelete={async (deleteLocalFiles) => (await deleteMeetings([meeting.id], deleteLocalFiles)) === 1}
        onTranscriptChanged={() => refreshAfterSpeakerChange()}
      />

      <div
        ref={frameRef}
        className={cn('flex min-h-0 min-w-0 flex-1 overflow-hidden', stacked ? 'flex-col' : 'flex-row', draggingSplit && 'select-none')}
      >
        <section className="flex min-h-0 min-w-0 flex-1 flex-col" aria-label="Transcript">
          <div className="min-h-0 flex-1">
            <VirtualizedTranscriptView
              segments={transcriptSegments}
              meetingImages={meetingImages}
              disableAutoScroll
              hasMore={hasMore}
              isLoadingMore={isLoadingMore}
              totalCount={totalCount}
              loadedCount={loadedCount}
              onLoadMore={onLoadMore}
              playbackTime={audio.status === 'ready' && (audio.playing || audio.currentTime > 0) ? audio.currentTime : null}
              followPlayback={follow && audio.playing}
              onSeek={audio.status === 'ready' ? (seconds) => audio.seek(seconds, true) : undefined}
              highlightSegmentId={focusLineId}
              onSpeakerClick={(speaker, segmentId, anchor) => setCardTarget({ speaker, segmentId, rect: anchor.getBoundingClientRect() })}
              emptyState={<p className="mt-16 text-center text-sm text-af-text-3">This meeting has no transcript.</p>}
              textMode={labs.cleanTranscript ? textMode : 'tidy'}
              colorIndices={colorIndices}
            />
          </div>
          <AudioPlayerBar
            audio={audio}
            follow={follow}
            onFollowChange={setFollow}
            waveform={labs.transcriptScrubbing ? waveform : null}
            rates={labs.transcriptScrubbing ? SLOW_PLAYBACK_RATES : PLAYBACK_RATES}
            textMode={labs.cleanTranscript ? textMode : undefined}
            onTextModeChange={labs.cleanTranscript ? setTextMode : undefined}
          />
        </section>

        {!stacked && (
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize transcript and notes"
            onPointerDown={startSplitDrag}
            className="group relative z-10 w-1.5 shrink-0 cursor-col-resize"
          >
            <span className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-af-border transition-colors group-hover:bg-af-accent group-active:bg-af-accent" />
          </div>
        )}

        {/* Above the divider, so the editor's toolbar and slash menu can overlap it. */}
        <aside
          className={cn('relative z-20 flex min-h-0 min-w-0 flex-col', stacked ? 'flex-1 border-t border-af-border' : 'shrink-0')}
          style={stacked ? undefined : { width: documentWidth }}
          aria-label="Notes and summary"
        >
          <MeetingDocument
            meetingId={meeting.id}
            aiSummary={meetingData.aiSummary}
            summaryUserEdited={summaryUserEdited}
            onSummaryChange={handleSummaryChange}
            summaryStatus={summaryGeneration.summaryStatus}
            summaryError={summaryGeneration.summaryError}
            statusMessage={summaryGeneration.getSummaryStatusMessage}
            onGenerate={() => void summaryGeneration.handleGenerateSummary('')}
            onRegenerate={async (instructions) => {
              await summaryGeneration.handleRegenerateSummary(instructions);
            }}
            onStop={summaryGeneration.handleStopGeneration}
            hasTranscript={hasTranscript}
            transcript={transcriptSegments}
            onSeek={(seconds) => audio.seek(seconds, true)}
            currentTime={audio.currentTime}
            modelConfig={modelConfig}
            setModelConfig={setModelConfig}
            onSaveModelConfig={handleSaveModelConfig}
            templates={templates.availableTemplates}
            selectedTemplate={templates.selectedTemplate}
            onTemplateSelect={templates.handleTemplateSelection}
            onManageTemplates={() => setTemplateEditorOpen(true)}
            regenerateRequest={regenerateRequest}
            onRegenerateRequestHandled={() => setRegenerateRequest(null)}
          />
        </aside>
      </div>

      <PersonCard
        target={cardTarget}
        onClose={() => setCardTarget(null)}
        lineCount={cardTarget ? speakers.find((speaker) => speaker.label === cardTarget.speaker)?.count : undefined}
        onIdentify={(speaker, segmentId) => setIdentity({ speaker, transcriptId: segmentId || null })}
        onMerge={(speaker) => setIdentity({ speaker, transcriptId: null })}
        onMarkMe={markMe}
        colorIndex={cardTarget ? colorIndexOf(cardTarget.speaker) : undefined}
        meetingId={meeting.id}
      />
      <SpeakerIdentityDialog
        open={identity !== null}
        onOpenChange={(open) => !open && setIdentity(null)}
        speaker={identity?.speaker ?? null}
        transcriptId={identity?.transcriptId}
        meetingId={meeting.id}
        speakers={speakers.map((speaker) => speaker.label)}
        onRenamed={(rename) => refreshAfterSpeakerChange(rename)}
        onMerge={mergeSpeakers}
        colorIndexOf={colorIndexOf}
      />
      <TemplateEditorModal
        open={templateEditorOpen}
        onClose={() => setTemplateEditorOpen(false)}
        availableTemplates={templates.availableTemplates}
        onSave={templates.saveCustomTemplate}
        onDelete={templates.deleteCustomTemplate}
      />
      <MeetingExportDialog
        open={exportOpen}
        onOpenChange={setExportOpen}
        hasTranscript={hasTranscript}
        hasSummary={!!meetingData.aiSummary}
        onExport={copyOperations.handleExportMeeting}
      />
      <PostCallProcessingDialog
        enabled={isPostCallRecording}
        meetingId={meeting.id}
        meetingFolderPath={meeting.folder_path}
        onRefetchTranscripts={onRefetchTranscripts}
        onComplete={() => setPostCallDoneFor(meeting.id)}
      />
    </motion.div>
  );
}
