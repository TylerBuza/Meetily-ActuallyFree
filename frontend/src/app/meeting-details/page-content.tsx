"use client";

/**
 * The meeting page: header, transcript (with playback), and the meeting's
 * document (notes, action items, summary, Ask AI) side by side.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { motion } from 'framer-motion';
import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { toast } from 'sonner';
import { Check, ChevronDown, Languages, Video } from 'lucide-react';
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
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
import {
  announceChange,
  getMeetingGroup,
  getMeetingTranslations,
  setMeetingGroup,
  translateMeetingTranscript,
  type MeetingTranslation,
} from '@/lib/workspace-api';
import { deleteMeetings, renameMeeting } from '@/lib/meeting-actions';
import { displayTitle } from '@/lib/meeting-titles';
import { MEETING_IMAGES_CHANGED, type MeetingImage } from '@/lib/meeting-images';
import { cn } from '@/lib/utils';
import { displaySpeaker, speakerColorIndexMap, speakerKey } from '@/utils/speakerUtils';

const TRANSLATION_LANGUAGES = [
  'Spanish',
  'French',
  'German',
  'Italian',
  'Portuguese',
  'Japanese',
  'Chinese (Simplified)',
  'Korean',
  'Russian',
  'Arabic',
  'Hindi',
  'Dutch',
];

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
  const [showVideo, setShowVideo] = useState(true);
  const [translations, setTranslations] = useState<MeetingTranslation[]>([]);
  const [currentTranslationLang, setCurrentTranslationLang] = useState<string | null>(null);
  const [translationMode, setTranslationMode] = useState<'original' | 'translated' | 'bilingual'>('bilingual');
  const [isTranslating, setIsTranslating] = useState(false);

  // Load existing translations on meeting change
  useEffect(() => {
    let cancelled = false;
    getMeetingTranslations(meeting.id)
      .then((list) => {
        if (cancelled) return;
        setTranslations(list);
        if (list.length > 0 && !currentTranslationLang) {
          setCurrentTranslationLang(list[0].targetLanguage);
        }
      })
      .catch((err) => console.error('Failed to load translations:', err));
    return () => {
      cancelled = true;
    };
  }, [meeting.id, currentTranslationLang]);

  const activeTranslationSegments = useMemo(() => {
    if (!currentTranslationLang) return undefined;
    const match = translations.find(
      (t) => t.targetLanguage.toLowerCase() === currentTranslationLang.toLowerCase()
    );
    return match?.segments;
  }, [translations, currentTranslationLang]);

  const handleTranslate = async (lang: string) => {
    const existing = translations.find(
      (t) => t.targetLanguage.toLowerCase() === lang.toLowerCase()
    );
    if (existing) {
      setCurrentTranslationLang(existing.targetLanguage);
      setTranslationMode((m) => (m === 'original' ? 'bilingual' : m));
      toast.success(`Switched to ${existing.targetLanguage} translation`);
      return;
    }
    setIsTranslating(true);
    try {
      toast.info(`Translating transcript to ${lang} with AI...`);
      const res = await translateMeetingTranscript(meeting.id, lang);
      setTranslations((prev) => [
        ...prev.filter((t) => t.targetLanguage.toLowerCase() !== lang.toLowerCase()),
        res,
      ]);
      setCurrentTranslationLang(res.targetLanguage);
      setTranslationMode('bilingual');
      toast.success(`Translated to ${lang}!`);
    } catch (err: any) {
      toast.error('Translation failed', {
        description: err?.message || String(err),
      });
    } finally {
      setIsTranslating(false);
    }
  };

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

  useEffect(() => {
    const element = frameRef.current;
    if (!element) return;
    const frame = element.clientWidth;
    const stored = Number(localStorage.getItem(NOTES_WIDTH_KEY));
    setDocumentWidth(clampDocumentWidth(Number.isFinite(stored) && stored > 0 ? stored : Math.round(frame * 0.48), frame));
    const onResize = (width: number) => {
      // The sidebar can shrink this pane without changing the viewport width.
      // Do not force two minimum-width columns into a narrower content area.
      setStacked(window.innerWidth <= 900 || width < TRANSCRIPT_MIN + DOCUMENT_MIN + 6);
      if (width) setDocumentWidth((current) => clampDocumentWidth(current, width));
    };
    const observer = new ResizeObserver((entries) => onResize(entries[0].contentRect.width));
    observer.observe(element);
    const onWindowResize = () => onResize(element.clientWidth);
    window.addEventListener('resize', onWindowResize);
    onResize(frame);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', onWindowResize);
    };
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
      window.removeEventListener('pointercancel', stop);
      setDraggingSplit(false);
      setDocumentWidth((current) => {
        localStorage.setItem(NOTES_WIDTH_KEY, String(current));
        return current;
      });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
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
        words: t.words,
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
          {/* Video Player (if videoPath exists) */}
          {audio.videoPath && (
            <div className="mx-4 mt-3 mb-2 shrink-0 rounded-2xl border border-af-border bg-black/90 p-2.5 shadow-lg">
              <div className="flex items-center justify-between px-2 pb-2 text-xs text-af-text-3">
                <div className="flex items-center gap-2 font-medium text-af-text">
                  <Video className="h-4 w-4 text-af-accent" />
                  <span>Video Playback</span>
                </div>
                <button
                  type="button"
                  onClick={() => setShowVideo((v) => !v)}
                  className="rounded px-2 py-0.5 text-[11px] font-medium text-af-text-3 hover:text-af-text hover:bg-af-panel-2 transition-colors"
                >
                  {showVideo ? 'Hide Video' : 'Show Video'}
                </button>
              </div>
              {showVideo && (
                <video
                  ref={audio.bindVideoElement}
                  src={convertFileSrc(audio.videoPath)}
                  controls
                  playsInline
                  className="aspect-video max-h-[320px] w-full rounded-xl bg-black object-contain"
                />
              )}
            </div>
          )}

          {/* Transcript Toolbar (Translation & Quick Controls) */}
          <div className="flex items-center justify-between border-b border-af-border/60 px-4 py-2 text-xs">
            <div className="flex items-center gap-2 text-af-text-3 font-medium">
              <span>Transcript</span>
              {audio.videoPath && !showVideo && (
                <button
                  type="button"
                  onClick={() => setShowVideo(true)}
                  className="flex items-center gap-1 rounded bg-af-accent/10 px-2 py-0.5 text-[11px] text-af-accent hover:bg-af-accent/20 transition-colors"
                >
                  <Video className="h-3 w-3" />
                  <span>Show Video</span>
                </button>
              )}
            </div>

            {/* Translation Dropdown */}
            <div className="flex items-center gap-2">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    disabled={isTranslating}
                    className={cn(
                      'flex items-center gap-1.5 rounded-lg border border-af-border px-2.5 py-1 text-xs font-medium transition-colors hover:bg-af-hover',
                      currentTranslationLang ? 'bg-af-accent/[0.08] border-af-accent/40 text-af-accent' : 'text-af-text-3'
                    )}
                  >
                    {isTranslating ? (
                      <span className="flex items-center gap-1.5">
                        <span className="h-2 w-2 animate-af-breathe rounded-full bg-af-accent" />
                        Translating...
                      </span>
                    ) : (
                      <>
                        <Languages className="h-3.5 w-3.5" />
                        <span>
                          {currentTranslationLang
                            ? `${currentTranslationLang} (${translationMode === 'bilingual' ? 'Bilingual' : translationMode === 'translated' ? 'Translated' : 'Original'})`
                            : 'Translate'}
                        </span>
                        <ChevronDown className="h-3 w-3 opacity-60" />
                      </>
                    )}
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-56">
                  {currentTranslationLang && (
                    <>
                      <DropdownMenuLabel className="text-[11px] uppercase tracking-wider text-af-text-4">
                        View Mode ({currentTranslationLang})
                      </DropdownMenuLabel>
                      <DropdownMenuItem onClick={() => setTranslationMode('bilingual')} className="gap-2">
                        {translationMode === 'bilingual' && <Check className="h-3.5 w-3.5 text-af-accent" />}
                        <span className={translationMode === 'bilingual' ? 'font-semibold text-af-accent' : ''}>
                          Bilingual (Side-by-side)
                        </span>
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => setTranslationMode('translated')} className="gap-2">
                        {translationMode === 'translated' && <Check className="h-3.5 w-3.5 text-af-accent" />}
                        <span className={translationMode === 'translated' ? 'font-semibold text-af-accent' : ''}>
                          Translated Only
                        </span>
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => setTranslationMode('original')} className="gap-2">
                        {translationMode === 'original' && <Check className="h-3.5 w-3.5 text-af-accent" />}
                        <span className={translationMode === 'original' ? 'font-semibold text-af-accent' : ''}>
                          Original Only
                        </span>
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                    </>
                  )}

                  <DropdownMenuLabel className="text-[11px] uppercase tracking-wider text-af-text-4">
                    {translations.length > 0 ? 'Select or Translate Language' : 'Translate to Language'}
                  </DropdownMenuLabel>
                  {TRANSLATION_LANGUAGES.map((lang) => {
                    const isTranslated = translations.some(
                      (t) => t.targetLanguage.toLowerCase() === lang.toLowerCase()
                    );
                    const isActive = currentTranslationLang?.toLowerCase() === lang.toLowerCase();
                    return (
                      <DropdownMenuItem
                        key={lang}
                        onClick={() => void handleTranslate(lang)}
                        className="flex items-center justify-between text-xs"
                      >
                        <span className={isActive ? 'font-semibold text-af-accent' : ''}>{lang}</span>
                        {isActive ? (
                          <Check className="h-3.5 w-3.5 text-af-accent" />
                        ) : isTranslated ? (
                          <span className="text-[10px] text-af-accent/70 font-mono">Saved</span>
                        ) : null}
                      </DropdownMenuItem>
                    );
                  })}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>

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
              translations={activeTranslationSegments}
              translationMode={translationMode}
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
            aria-valuemin={TRANSCRIPT_MIN}
            aria-valuemax={Math.max(TRANSCRIPT_MIN, (frameRef.current?.clientWidth ?? 0) - 6 - DOCUMENT_MIN)}
            aria-valuenow={Math.max(TRANSCRIPT_MIN, (frameRef.current?.clientWidth ?? 0) - 6 - documentWidth)}
            tabIndex={0}
            onKeyDown={(event) => {
              if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
              event.preventDefault();
              const frame = frameRef.current?.clientWidth ?? 0;
              setDocumentWidth((current) => {
                const next = clampDocumentWidth(current + (event.key === 'ArrowLeft' ? 24 : -24), frame);
                localStorage.setItem(NOTES_WIDTH_KEY, String(next));
                return next;
              });
            }}
            onPointerDown={startSplitDrag}
            className="group relative z-10 w-1.5 shrink-0 cursor-col-resize focus-visible:outline focus-visible:outline-2 focus-visible:outline-af-accent"
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
