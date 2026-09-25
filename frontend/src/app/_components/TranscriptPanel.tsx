/**
 * Transcript panel for the LIVE recording screen (`app/page.tsx`).
 *
 * ⚠️ There are TWO components named `TranscriptPanel`. This is the live one.
 * The meeting-details screen uses `components/MeetingDetails/TranscriptPanel.tsx`.
 * Editing the wrong file is a common trap — the change compiles and appears to
 * do nothing, because the screen you are looking at renders the other one.
 *
 * Transcripts arrive from `TranscriptContext`, which maps the Rust event's
 * `source` field onto `speaker`. The converter below must keep `speaker` or
 * live speaker labels silently disappear.
 */

import { VirtualizedTranscriptView } from '@/components/VirtualizedTranscriptView';
import { PermissionWarning } from '@/components/PermissionWarning';
import { Button } from '@/components/ui/button';
import { ButtonGroup } from '@/components/ui/button-group';
import { Copy, GlobeIcon, Users } from 'lucide-react';
import { useTranscripts } from '@/contexts/TranscriptContext';
import { useConfig } from '@/contexts/ConfigContext';
import { useRecordingState } from '@/contexts/RecordingStateContext';
import { usePermissionCheck } from '@/hooks/usePermissionCheck';
import { ModalType } from '@/hooks/useModalState';
import { useIsLinux } from '@/hooks/usePlatform';
import { useMemo, useState, useEffect } from 'react';
import { SpeakersSidebar } from '@/components/SpeakersSidebar';
import { SpeakerRenameDialog } from '@/components/MeetingDetails/SpeakerRenameDialog';
import { MergeSpeakerDialog } from '@/components/MergeSpeakerDialog';

/**
 * TranscriptPanel Component
 *
 * Displays transcript content with controls for copying and language settings.
 * Uses TranscriptContext, ConfigContext, and RecordingStateContext internally.
 */

interface TranscriptPanelProps {
  // indicates stop-processing state for transcripts; derived from backend statuses.
  isProcessingStop: boolean;
  isStopping: boolean;
  showModal: (name: ModalType, message?: string) => void;
}

export function TranscriptPanel({
  isProcessingStop,
  isStopping,
  showModal
}: TranscriptPanelProps) {
  // Contexts
  const {
    transcripts,
    transcriptContainerRef,
    copyTranscript,
    detectedSpeakers,
    renameSpeaker,
    mergeSpeakers,
  } = useTranscripts();
  const { transcriptModelConfig, showSpeakersPanel } = useConfig();
  const { isRecording, isPaused } = useRecordingState();
  const { requestPermissions, isChecking, hasSystemAudio, hasMicrophone } = usePermissionCheck();
  const isLinux = useIsLinux();

  // Sidebar and dialog states
  const [showSpeakersSidebar, setShowSpeakersSidebar] = useState(showSpeakersPanel);
  const [renameTarget, setRenameTarget] = useState<string | null>(null);
  const [mergeTarget, setMergeTarget] = useState<string | null>(null);
  const [userName, setUserName] = useState('');

  useEffect(() => {
    setShowSpeakersSidebar(showSpeakersPanel);
  }, [showSpeakersPanel]);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      setUserName(localStorage.getItem('meetily_user_name')?.trim() || '');
    }
  }, []);

  // Convert transcripts to segments for virtualized view
  const segments = useMemo(() =>
    transcripts.map(t => ({
      id: t.id,
      timestamp: t.audio_start_time ?? 0,
      endTime: t.audio_end_time,
      text: t.text,
      confidence: t.confidence,
      speaker: t.speaker,
    })),
    [transcripts]
  );

  return (
    <div className="flex flex-1 overflow-hidden w-full h-full">
      <div ref={transcriptContainerRef} className="flex-1 border-r border-gray-200 bg-white flex flex-col overflow-y-auto">
        {/* Title area - Sticky header */}
        <div className="sticky top-0 z-10 bg-white p-4 border-gray-200">
          <div className="flex flex-col space-y-3">
            <div className="flex flex-col space-y-2">
              <div className="flex justify-center items-center space-x-2">
                <ButtonGroup>
                  {transcripts?.length > 0 && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={copyTranscript}
                      title="Copy Transcript"
                    >
                      <Copy size={16} />
                      <span className='hidden md:inline ml-1.5'>
                        Copy
                      </span>
                    </Button>
                  )}
                  {transcriptModelConfig.provider === "localWhisper" &&
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => showModal('languageSettings')}
                      title="Language"
                    >
                      <GlobeIcon size={16} />
                      <span className='hidden md:inline ml-1.5'>
                        Language
                      </span>
                    </Button>
                  }
                  <Button
                    variant={showSpeakersSidebar ? "secondary" : "outline"}
                    size="sm"
                    onClick={() => setShowSpeakersSidebar((prev) => !prev)}
                    title="Toggle detected speakers"
                    className={showSpeakersSidebar ? "bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-900/30 dark:text-blue-300" : ""}
                  >
                    <Users size={16} />
                    <span className='hidden md:inline ml-1.5'>
                      Speakers
                    </span>
                    {detectedSpeakers.length > 0 && (
                      <span className="ml-1.5 px-1.5 py-0.2 rounded-full text-xs font-semibold bg-blue-500/15 text-blue-600 dark:text-blue-400">
                        {detectedSpeakers.length}
                      </span>
                    )}
                  </Button>
                </ButtonGroup>
              </div>
            </div>
          </div>
        </div>

        {/* Permission Warning - Not needed on Linux */}
        {!isRecording && !isChecking && !isLinux && (
          <div className="flex justify-center px-4 pt-4">
            <PermissionWarning
              hasMicrophone={hasMicrophone}
              hasSystemAudio={hasSystemAudio}
              onRecheck={requestPermissions}
              isRechecking={isChecking}
            />
          </div>
        )}

        {/* Transcript content */}
        <div
          className={isRecording ? 'pb-40' : 'pb-20'}
          style={isRecording ? { scrollPaddingBottom: '10rem' } : undefined}
        >
          <div className="flex justify-center">
            <div className="w-2/3 max-w-[750px]">
              <VirtualizedTranscriptView
                segments={segments}
                isRecording={isRecording}
                isPaused={isPaused}
                isProcessing={isProcessingStop}
                isStopping={isStopping}
                enableStreaming={isRecording && !isPaused}
                showConfidence={true}
                onRenameSpeaker={(speaker) => setRenameTarget(speaker)}
                onMergeSpeaker={(speaker) => setMergeTarget(speaker)}
              />
            </div>
          </div>
        </div>
      </div>

      {/* Speakers Sidebar (MacWhisper feature) */}
      <SpeakersSidebar
        speakers={detectedSpeakers}
        userName={userName}
        isOpen={showSpeakersSidebar}
        onClose={() => setShowSpeakersSidebar(false)}
        onRenameSpeaker={renameSpeaker}
        onMergeSpeaker={mergeSpeakers}
        isRecording={isRecording}
      />

      {/* Inline Quick Rename Modal */}
      <SpeakerRenameDialog
        open={renameTarget !== null}
        speaker={renameTarget}
        onOpenChange={(open) => !open && setRenameTarget(null)}
        onRenameLive={async (from, to) => {
          renameSpeaker(from, to);
          setRenameTarget(null);
        }}
        onMergeClick={() => {
          if (renameTarget) {
            const target = renameTarget;
            setRenameTarget(null);
            setMergeTarget(target);
          }
        }}
      />

      {/* Inline Quick Merge Modal */}
      <MergeSpeakerDialog
        open={mergeTarget !== null}
        sourceSpeaker={mergeTarget}
        onOpenChange={(open) => !open && setMergeTarget(null)}
        availableSpeakers={detectedSpeakers.map(s => ({
          id: s.id,
          name: s.name,
          isUser: s.isUser,
          segmentCount: s.segmentCount,
        }))}
        onMerge={async (source, target) => {
          mergeSpeakers(source, target);
          setMergeTarget(null);
        }}
      />
    </div>
  );
}

