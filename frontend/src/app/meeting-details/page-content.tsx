"use client";
import { useState, useEffect, useRef, useCallback } from 'react';
import { motion } from 'framer-motion';
import { Summary, SummaryResponse } from '@/types';
import { useSidebar } from '@/components/Sidebar/SidebarProvider';
import Analytics from '@/lib/analytics';
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'sonner';
import { TranscriptPanel } from '@/components/MeetingDetails/TranscriptPanel';
import { SummaryPanel } from '@/components/MeetingDetails/SummaryPanel';
import { TemplateEditorModal } from '@/components/MeetingDetails/TemplateEditorModal';
import { ModelConfig } from '@/components/ModelSettingsModal';

// Custom hooks
import { useMeetingData } from '@/hooks/meeting-details/useMeetingData';
import { useSummaryGeneration } from '@/hooks/meeting-details/useSummaryGeneration';
import { useTemplates } from '@/hooks/meeting-details/useTemplates';
import { useCopyOperations } from '@/hooks/meeting-details/useCopyOperations';
import { useMeetingOperations } from '@/hooks/meeting-details/useMeetingOperations';
import { useConfig } from '@/contexts/ConfigContext';
import { PostCallProcessingDialog } from '@/components/MeetingDetails/PostCallProcessingDialog';
import { MeetingExportDialog } from '@/components/MeetingDetails/MeetingExportDialog';
import { SummaryRegenerationDialog } from '@/components/MeetingDetails/SummaryRegenerationDialog';

// Page remounts join the same backend-start attempt. Only accepted attempts are
// persisted in sessionStorage below; failed preflight attempts remain retryable.
const autoSummaryInFlight = new Map<string, Promise<boolean>>();

export default function PageContent({
  meeting,
  summaryData,
  isPostCallRecording = false,
  shouldAutoGenerate = false,
  onAutoGenerateComplete,
  onSummaryReady,
  onMeetingUpdated,
  onRefetchTranscripts,
  // Pagination props for efficient transcript loading
  segments,
  hasMore,
  isLoadingMore,
  totalCount,
  loadedCount,
  onLoadMore,
}: {
  meeting: any;
  summaryData: Summary | null;
  isPostCallRecording?: boolean;
  shouldAutoGenerate?: boolean;
  onAutoGenerateComplete?: () => void;
  /** Lift a freshly generated summary up so parent state survives remounts. */
  onSummaryReady?: (summary: Summary) => void;
  onMeetingUpdated?: () => Promise<void>;
  onRefetchTranscripts?: () => Promise<void>;
  // Pagination props
  segments?: any[];
  hasMore?: boolean;
  isLoadingMore?: boolean;
  totalCount?: number;
  loadedCount?: number;
  onLoadMore?: () => void;
}) {
  console.log('ðŸ“„ PAGE CONTENT: Initializing with data:', {
    meetingId: meeting.id,
    summaryDataKeys: summaryData ? Object.keys(summaryData) : null,
    transcriptsCount: meeting.transcripts?.length
  });

  // State
  const [customPrompt, setCustomPrompt] = useState<string>('');
  const [templateEditorOpen, setTemplateEditorOpen] = useState(false);
  const [isRecording] = useState(false);
  const [summaryResponse] = useState<SummaryResponse | null>(null);
  const [postCallProcessingCompletedMeetingId, setPostCallProcessingCompletedMeetingId] = useState<string | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [regenerationRequest, setRegenerationRequest] = useState<{
    open: boolean;
    initialContext: string;
    speakerNamesChanged: boolean;
  }>({ open: false, initialContext: '', speakerNamesChanged: false });

  // Ref to store the modal open function from SummaryGeneratorButtonGroup
  const openModelSettingsRef = useRef<(() => void) | null>(null);

  // Sidebar context
  const { serverAddress } = useSidebar();

  // Get model config from ConfigContext
  const { modelConfig, setModelConfig } = useConfig();

  // Custom hooks
  const meetingData = useMeetingData({ meeting, summaryData, onMeetingUpdated });
  const templates = useTemplates();

  // Callback to register the modal open function
  const handleRegisterModalOpen = (openFn: () => void) => {
    console.log('ðŸ“ Registering modal open function in PageContent');
    openModelSettingsRef.current = openFn;
  };

  // Callback to trigger modal open (called from error handler)
  const handleOpenModelSettings = () => {
    console.log('ðŸ”” Opening model settings from PageContent');
    if (openModelSettingsRef.current) {
      openModelSettingsRef.current();
    } else {
      console.warn('âš ï¸ Modal open function not yet registered');
    }
  };

  // Save model config to backend database and sync via event
  const handleSaveModelConfig = async (config?: ModelConfig) => {
    if (!config) return;
    try {
      await invoke('api_save_model_config', {
        provider: config.provider,
        model: config.model,
        whisperModel: config.whisperModel,
        apiKey: config.apiKey ?? null,
        ollamaEndpoint: config.ollamaEndpoint ?? null,
      });

      // Emit event so ConfigContext and other listeners stay in sync
      const { emit } = await import('@tauri-apps/api/event');
      await emit('model-config-updated', config);

      toast.success('Model settings saved successfully');
    } catch (error) {
      console.error('Failed to save model config:', error);
      toast.error('Failed to save model settings');
    }
  };

  // Wrap setAiSummary so the parent also learns about a finished summary.
  // Without this, meetingSummary in page.tsx stays null and any remount of
  // this component falls back to the empty "Generate summary" state.
  const setAiSummary = useCallback((summary: Summary | null) => {
    meetingData.setAiSummary(summary);
    if (summary && onSummaryReady) {
      onSummaryReady(summary);
    }
  }, [meetingData.setAiSummary, onSummaryReady]);

  const summaryGeneration = useSummaryGeneration({
    meeting,
    transcripts: meetingData.transcripts,
    modelConfig: modelConfig,
    isModelConfigLoading: false, // ConfigContext loads on mount
    selectedTemplate: templates.selectedTemplate,
    onMeetingUpdated,
    setAiSummary,
    onOpenModelSettings: handleOpenModelSettings,
  });

  const copyOperations = useCopyOperations({
    meeting,
    transcripts: meetingData.transcripts,
    meetingTitle: meetingData.meetingTitle,
    aiSummary: meetingData.aiSummary,
    blockNoteSummaryRef: meetingData.blockNoteSummaryRef,
  });

  const meetingOperations = useMeetingOperations({
    meeting,
  });

  // Track page view
  useEffect(() => {
    Analytics.trackPageView('meeting_details');
  }, []);

  // Auto-generate summary when flag is set
  useEffect(() => {
    const autoGenerate = async () => {
      if (
        shouldAutoGenerate &&
        meetingData.transcripts.length > 0 &&
        (!isPostCallRecording || postCallProcessingCompletedMeetingId === meeting.id)
      ) {
        if (isPostCallRecording) {
          const summaryStartKey = `post-call-summary-started:${meeting.id}`;
          if (sessionStorage.getItem(summaryStartKey)) {
            onAutoGenerateComplete?.();
            return;
          }

          let attempt = autoSummaryInFlight.get(meeting.id);
          if (!attempt) {
            console.log(`ðŸ¤– Auto-generating summary with ${modelConfig.provider}/${modelConfig.model}...`);
            attempt = summaryGeneration.handleGenerateSummary('');
            autoSummaryInFlight.set(meeting.id, attempt);
          }

          let accepted = false;
          try {
            accepted = await attempt;
          } finally {
            if (autoSummaryInFlight.get(meeting.id) === attempt) {
              autoSummaryInFlight.delete(meeting.id);
            }
          }

          if (accepted) {
            sessionStorage.setItem(summaryStartKey, 'started');
            onAutoGenerateComplete?.();
          }
          return;
        }

        console.log(`ðŸ¤– Auto-generating summary with ${modelConfig.provider}/${modelConfig.model}...`);
        await summaryGeneration.handleGenerateSummary('');
        onAutoGenerateComplete?.();
      }
    };

    void autoGenerate();
  }, [
    shouldAutoGenerate,
    meeting.id,
    meetingData.transcripts.length,
    isPostCallRecording,
    postCallProcessingCompletedMeetingId,
    modelConfig.provider,
    modelConfig.model,
    summaryGeneration.handleGenerateSummary,
    onAutoGenerateComplete,
  ]);

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, ease: 'easeOut' }}
      className="flex flex-col h-screen bg-[var(--af-bg)]"
    >
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-[var(--af-bg)] md:flex-row">
        <TranscriptPanel
          transcripts={meetingData.transcripts}
          title={meetingData.meetingTitle}
          createdAt={meeting.created_at}
          customPrompt={customPrompt}
          onPromptChange={setCustomPrompt}
          onCopyTranscript={copyOperations.handleCopyTranscript}
          onOpenExport={() => setExportOpen(true)}
          onSpeakerRenamed={({ from, to, removedName }) => {
            if (!meetingData.aiSummary) return;
            setRegenerationRequest({
              open: true,
              initialContext: removedName
                ? `The person name "${from}" was removed. Use the restored meeting-local label "${to}" and do not associate it with a person profile.`
                : `Use the updated speaker name "${to}" and the other speaker labels from the transcript when writing the summary.`,
              speakerNamesChanged: true,
            });
          }}
          onOpenMeetingFolder={meetingOperations.handleOpenMeetingFolder}
          isRecording={isRecording}
          disableAutoScroll={true}
          // Pagination props for efficient loading
          usePagination={true}
          segments={segments}
          hasMore={hasMore}
          isLoadingMore={isLoadingMore}
          totalCount={totalCount}
          loadedCount={loadedCount}
          onLoadMore={onLoadMore}
          // Retranscription props
          meetingId={meeting.id}
          meetingFolderPath={meeting.folder_path}
          onRefetchTranscripts={onRefetchTranscripts}
        />
        <SummaryPanel
          meeting={meeting}
          meetingTitle={meetingData.meetingTitle}
          onTitleChange={meetingData.handleTitleChange}
          isEditingTitle={meetingData.isEditingTitle}
          onStartEditTitle={() => meetingData.setIsEditingTitle(true)}
          onFinishEditTitle={() => meetingData.setIsEditingTitle(false)}
          isTitleDirty={meetingData.isTitleDirty}
          summaryRef={meetingData.blockNoteSummaryRef}
          isSaving={meetingData.isSaving}
          onSaveAll={meetingData.saveAllChanges}
          onCopySummary={copyOperations.handleCopySummary}
          onCopyTranscript={copyOperations.handleCopyTranscript}
          onOpenExport={() => setExportOpen(true)}
          onOpenFolder={meetingOperations.handleOpenMeetingFolder}
          aiSummary={meetingData.aiSummary}
          summaryStatus={summaryGeneration.summaryStatus}
          transcripts={meetingData.transcripts}
          modelConfig={modelConfig}
          setModelConfig={setModelConfig}
          onSaveModelConfig={handleSaveModelConfig}
          onGenerateSummary={summaryGeneration.handleGenerateSummary}
          onStopGeneration={summaryGeneration.handleStopGeneration}
          customPrompt={customPrompt}
          summaryResponse={summaryResponse}
          onSaveSummary={meetingData.handleSaveSummary}
          onSummaryChange={meetingData.handleSummaryChange}
          onDirtyChange={meetingData.setIsSummaryDirty}
          summaryError={summaryGeneration.summaryError}
          onRequestRegenerate={() => setRegenerationRequest({
            open: true,
            initialContext: '',
            speakerNamesChanged: false,
          })}
          getSummaryStatusMessage={summaryGeneration.getSummaryStatusMessage}
          availableTemplates={templates.availableTemplates}
          selectedTemplate={templates.selectedTemplate}
          onTemplateSelect={templates.handleTemplateSelection}
          onManageTemplates={() => setTemplateEditorOpen(true)}
          isModelConfigLoading={false}
          onOpenModelSettings={handleRegisterModalOpen}
        />
      </div>

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
        hasTranscript={(totalCount ?? meetingData.transcripts.length) > 0}
        hasSummary={!!meetingData.aiSummary}
        onExport={copyOperations.handleExportMeeting}
      />
      <SummaryRegenerationDialog
        open={regenerationRequest.open}
        onOpenChange={(open) => setRegenerationRequest((current) => ({ ...current, open }))}
        initialContext={regenerationRequest.initialContext}
        speakerNamesChanged={regenerationRequest.speakerNamesChanged}
        onRegenerate={summaryGeneration.handleRegenerateSummary}
      />
      <PostCallProcessingDialog
        enabled={isPostCallRecording}
        meetingId={meeting.id}
        meetingFolderPath={meeting.folder_path}
        onRefetchTranscripts={onRefetchTranscripts}
        onComplete={() => setPostCallProcessingCompletedMeetingId(meeting.id)}
      />
    </motion.div>
  );
}
