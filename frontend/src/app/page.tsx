'use client';

/**
 * The recorder. With nothing recording it is the home page (search, quick
 * actions, what's next); during a call it is the live session. The record
 * card floats at the bottom in both.
 */
import { useState, useEffect } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { RecordingControls } from '@/components/RecordingControls';
import { useSidebar } from '@/components/Sidebar/SidebarProvider';
import { usePermissionCheck } from '@/hooks/usePermissionCheck';
import { useRecordingState, RecordingStatus } from '@/contexts/RecordingStateContext';
import { useConfig } from '@/contexts/ConfigContext';
import { PostCallHandoffCard } from '@/components/PostCallHandoffCard';
import { RecordingCardSlot } from '@/components/RecordingCardSlot';
import { HomeDashboard } from '@/components/home/HomeDashboard';
import { LiveSession } from '@/components/recording/LiveSession';
import Analytics from '@/lib/analytics';
import { SettingsModals } from './_components/SettingsModal';
import { useModalState } from '@/hooks/useModalState';
import { useRecordingStateSync } from '@/hooks/useRecordingStateSync';
import { useRecordingStart } from '@/hooks/useRecordingStart';
import { useRecordingStop } from '@/hooks/useRecordingStop';
import { useTranscriptRecovery } from '@/hooks/useTranscriptRecovery';
import { TranscriptRecovery } from '@/components/TranscriptRecovery';
import { indexedDBService } from '@/services/indexedDBService';
import { useI18n } from '@/i18n';

export default function Home() {
  const { t } = useI18n();
  const [isRecording, setIsRecordingState] = useState(false);
  const [showRecoveryDialog, setShowRecoveryDialog] = useState(false);

  const { transcriptModelConfig, selectedDevices } = useConfig();
  const recordingState = useRecordingState();
  const { status, isStopping, isProcessing } = recordingState;

  const { hasMicrophone } = usePermissionCheck();
  const { setIsMeetingActive, refetchMeetings } = useSidebar();
  const { modals, messages, showModal, hideModal } = useModalState(transcriptModelConfig);
  const { isRecordingDisabled, setIsRecordingDisabled } = useRecordingStateSync(isRecording, setIsRecordingState, setIsMeetingActive);
  const { handleRecordingStart } = useRecordingStart(isRecording, setIsRecordingState, showModal);
  const { handleRecordingStop, setIsStopping } = useRecordingStop(setIsRecordingState, setIsRecordingDisabled);

  const {
    recoverableMeetings,
    checkForRecoverableTranscripts,
    recoverMeeting,
    loadMeetingTranscripts,
    deleteRecoverableMeeting,
  } = useTranscriptRecovery();

  const router = useRouter();

  useEffect(() => {
    Analytics.trackPageView('home');
  }, []);

  // On startup, tidy the crash-recovery store and look for unsaved recordings.
  useEffect(() => {
    const busy =
      recordingState.isRecording ||
      status === RecordingStatus.STOPPING ||
      status === RecordingStatus.PROCESSING_TRANSCRIPTS ||
      status === RecordingStatus.SAVING;
    if (busy) return;
    void (async () => {
      await indexedDBService.deleteOldMeetings(7).catch((error) => console.warn('Failed to clean up old meetings:', error));
      await indexedDBService.deleteSavedMeetings(24).catch((error) => console.warn('Failed to clean up saved meetings:', error));
      await checkForRecoverableTranscripts().catch((error) => console.error('Failed to check for recoverable meetings:', error));
    })();
  }, [checkForRecoverableTranscripts, recordingState.isRecording, status]);

  // Offer recovery once per session.
  useEffect(() => {
    if (recoverableMeetings.length === 0) return;
    if (!sessionStorage.getItem('recovery_dialog_shown')) {
      setShowRecoveryDialog(true);
      sessionStorage.setItem('recovery_dialog_shown', 'true');
    }
  }, [recoverableMeetings]);

  const handleRecovery = async (meetingId: string) => {
    try {
      const result = await recoverMeeting(meetingId);
      if (!result.success) return;
      toast.success(t('home.meetingRecovered'), {
        description:
          result.audioRecoveryStatus?.status === 'success'
            ? t('home.transcriptAndAudioRecovered')
            : t('home.transcriptRecoveredWithoutAudio'),
        action: result.meetingId
          ? { label: t('home.open'), onClick: () => router.push(`/meeting-details?id=${result.meetingId}`) }
          : undefined,
        duration: 10000,
      });
      await refetchMeetings();
      if (recoverableMeetings.length === 0) sessionStorage.removeItem('recovery_dialog_shown');
      if (result.meetingId) setTimeout(() => router.push(`/meeting-details?id=${result.meetingId}`), 2000);
    } catch (error) {
      toast.error(t('home.couldNotRecoverMeeting'), {
        description: error instanceof Error ? error.message : t('home.unknownError'),
      });
      throw error;
    }
  };

  const handleDialogClose = () => {
    setShowRecoveryDialog(false);
    // Let the dialog show again next session if new recordings turn up.
    if (recoverableMeetings.length === 0) sessionStorage.removeItem('recovery_dialog_shown');
  };

  const isProcessingStop = status === RecordingStatus.PROCESSING_TRANSCRIPTS || isProcessing;
  const handingOff =
    status === RecordingStatus.PROCESSING_TRANSCRIPTS ||
    status === RecordingStatus.SAVING ||
    status === RecordingStatus.COMPLETED;
  const live = recordingState.isRecording || isRecording || isStopping || handingOff;

  return (
    <div className="flex h-full flex-col bg-af-panel">
      <SettingsModals modals={modals} messages={messages} onClose={hideModal} />

      <TranscriptRecovery
        isOpen={showRecoveryDialog}
        onClose={handleDialogClose}
        recoverableMeetings={recoverableMeetings}
        onRecover={handleRecovery}
        onDelete={deleteRecoverableMeeting}
        onLoadPreview={loadMeetingTranscripts}
      />

      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={live ? 'live' : 'home'}
            className="flex min-h-0 min-w-0 flex-1"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
          >
            {live ? (
              <LiveSession
                isProcessingStop={isProcessingStop}
                isStopping={isStopping || handingOff}
                onLanguageSettings={() => showModal('languageSettings')}
              />
            ) : (
              <div className="min-w-0 flex-1">
                <HomeDashboard />
              </div>
            )}
          </motion.div>
        </AnimatePresence>

        {(hasMicrophone || isRecording) && !handingOff && (
          <RecordingCardSlot>
            <RecordingControls
              isRecording={recordingState.isRecording}
              onRecordingStop={(callApi = true) => handleRecordingStop(callApi)}
              onRecordingStart={handleRecordingStart}
              onStopInitiated={() => setIsStopping(true)}
              onTranscriptionError={(message) => showModal('errorAlert', message)}
              isRecordingDisabled={isRecordingDisabled}
              selectedDevices={selectedDevices}
            />
          </RecordingCardSlot>
        )}

        {handingOff && (
          <PostCallHandoffCard
            busy
            title={
              status === RecordingStatus.SAVING
                ? t('home.savingYourMeeting')
                : status === RecordingStatus.COMPLETED
                  ? t('home.openingYourMeeting')
                  : t('home.finishingYourRecording')
            }
            detail={recordingState.statusMessage || t('home.transcriptBeingFinished')}
          />
        )}
      </div>
    </div>
  );
}
