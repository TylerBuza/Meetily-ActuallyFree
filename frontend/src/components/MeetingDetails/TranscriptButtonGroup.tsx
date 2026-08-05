"use client";

import { useState, useCallback, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { ButtonGroup } from '@/components/ui/button-group';
import { Copy, FolderOpen, RefreshCw, Users, Loader2 } from 'lucide-react';
import Analytics from '@/lib/analytics';
import { RetranscribeDialog } from './RetranscribeDialog';
import { useConfig } from '@/contexts/ConfigContext';
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'sonner';


interface TranscriptButtonGroupProps {
  transcriptCount: number;
  onCopyTranscript: () => void;
  onOpenMeetingFolder: () => Promise<void>;
  meetingId?: string;
  meetingFolderPath?: string | null;
  onRefetchTranscripts?: () => Promise<void>;
}


export function TranscriptButtonGroup({
  transcriptCount,
  onCopyTranscript,
  onOpenMeetingFolder,
  meetingId,
  meetingFolderPath,
  onRefetchTranscripts,
}: TranscriptButtonGroupProps) {
  const { betaFeatures } = useConfig();
  const [showRetranscribeDialog, setShowRetranscribeDialog] = useState(false);

  // Speaker diarization ("who spoke when") — only offered when the local
  // models are installed.
  const [diarizeAvailable, setDiarizeAvailable] = useState(false);
  const [isDiarizing, setIsDiarizing] = useState(false);

  useEffect(() => {
    invoke<boolean>('diarization_models_available')
      .then(setDiarizeAvailable)
      .catch(() => setDiarizeAvailable(false));
  }, []);

  const handleRetranscribeComplete = useCallback(async () => {
    // Refetch transcripts to show the updated data
    if (onRefetchTranscripts) {
      await onRefetchTranscripts();
    }
  }, [onRefetchTranscripts]);

  const handleIdentifySpeakers = useCallback(async () => {
    if (!meetingId || isDiarizing) return;
    Analytics.trackButtonClick('identify_speakers', 'meeting_details');
    setIsDiarizing(true);
    const toastId = toast.loading('Identifying speakers…', {
      description: 'Analyzing the recording on-device. This can take a minute.',
    });
    try {
      const res = await invoke<{ num_speakers: number; labeled: number }>('diarize_meeting', {
        meetingId,
      });
      toast.success(
        res.num_speakers > 0
          ? `Found ${res.num_speakers} speaker${res.num_speakers === 1 ? '' : 's'}`
          : 'No speakers detected',
        { id: toastId, description: `${res.labeled} transcript segments labeled.` }
      );
      if (onRefetchTranscripts) {
        await onRefetchTranscripts();
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast.error('Speaker identification failed', { id: toastId, description: msg });
    } finally {
      setIsDiarizing(false);
    }
  }, [meetingId, isDiarizing, onRefetchTranscripts]);

  return (
    <div className="flex items-center justify-center w-full gap-2">
      <ButtonGroup>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            Analytics.trackButtonClick('copy_transcript', 'meeting_details');
            onCopyTranscript();
          }}
          disabled={transcriptCount === 0}
          title={transcriptCount === 0 ? 'No transcript available' : 'Copy Transcript'}
        >
          <Copy />
          <span className="hidden lg:inline">Copy</span>
        </Button>

        <Button
          size="sm"
          variant="outline"
          className="xl:px-4"
          onClick={() => {
            Analytics.trackButtonClick('open_recording_folder', 'meeting_details');
            onOpenMeetingFolder();
          }}
          title="Open Recording Folder"
        >
          <FolderOpen className="xl:mr-2" size={18} />
          <span className="hidden lg:inline">Recording</span>
        </Button>

        {diarizeAvailable && meetingId && (
          <Button
            size="sm"
            variant="outline"
            className="xl:px-4"
            onClick={handleIdentifySpeakers}
            disabled={isDiarizing || transcriptCount === 0}
            title={
              transcriptCount === 0
                ? 'No transcript available'
                : 'Identify who spoke when, using the local diarization models'
            }
          >
            {isDiarizing ? (
              <Loader2 className="animate-spin xl:mr-2" size={18} />
            ) : (
              <Users className="xl:mr-2" size={18} />
            )}
            <span className="hidden lg:inline">{isDiarizing ? 'Working…' : 'Speakers'}</span>
          </Button>
        )}

        {betaFeatures.importAndRetranscribe && meetingId && meetingFolderPath && (
          <Button
            size="sm"
            variant="outline"
            className="bg-gradient-to-r from-blue-50 to-purple-50 hover:from-blue-100 hover:to-purple-100 border-blue-200 xl:px-4"
            onClick={() => {
              Analytics.trackButtonClick('enhance_transcript', 'meeting_details');
              setShowRetranscribeDialog(true);
            }}
            title="Retranscribe to enhance your recorded audio"
          >
            <RefreshCw className="xl:mr-2" size={18} />
            <span className="hidden lg:inline">Enhance</span>
          </Button>
        )}
      </ButtonGroup>

      {betaFeatures.importAndRetranscribe && meetingId && meetingFolderPath && (
        <RetranscribeDialog
          open={showRetranscribeDialog}
          onOpenChange={setShowRetranscribeDialog}
          meetingId={meetingId}
          meetingFolderPath={meetingFolderPath}
          onComplete={handleRetranscribeComplete}
        />
      )}
    </div>
  );
}
