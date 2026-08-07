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
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';


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
  const [showSpeakerDialog, setShowSpeakerDialog] = useState(false);
  const [expectedSpeakers, setExpectedSpeakers] = useState<string>('');

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

  const handleIdentifySpeakers = useCallback(async (expected?: number) => {
    if (!meetingId || isDiarizing) return;
    Analytics.trackButtonClick('identify_speakers', 'meeting_details');
    setShowSpeakerDialog(false);
    setIsDiarizing(true);
    const toastId = toast.loading('Identifying speakers…', {
      description: 'Analyzing the recording on-device. This can take a minute.',
    });
    try {
      const res = await invoke<{ num_speakers: number; labeled: number }>('diarize_meeting', {
        meetingId,
        numSpeakers: expected ?? null,
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
    <div className="flex w-max max-w-full shrink-0 items-center justify-end">
      <ButtonGroup className="shrink-0">
        <Button
          variant="outline"
          size="sm"
          className="h-8 w-8 shrink-0 px-0 sm:h-9 sm:w-auto sm:px-3"
          onClick={() => {
            Analytics.trackButtonClick('copy_transcript', 'meeting_details');
            onCopyTranscript();
          }}
          disabled={transcriptCount === 0}
          title={transcriptCount === 0 ? 'No transcript available' : 'Copy Transcript'}
        >
          <Copy size={16} />
          <span className="ml-1.5 hidden xl:inline">Copy</span>
        </Button>

        <Button
          size="sm"
          variant="outline"
          className="h-8 w-8 shrink-0 px-0 sm:h-9 sm:w-auto sm:px-3"
          onClick={() => {
            Analytics.trackButtonClick('open_recording_folder', 'meeting_details');
            onOpenMeetingFolder();
          }}
          title="Open Recording Folder"
        >
          <FolderOpen size={16} />
          <span className="ml-1.5 hidden xl:inline">Recording</span>
        </Button>

        {diarizeAvailable && meetingId && (
          <Button
            size="sm"
            variant="outline"
            className="h-8 w-8 shrink-0 px-0 sm:h-9 sm:w-auto sm:px-3"
            onClick={() => {
              setExpectedSpeakers('');
              setShowSpeakerDialog(true);
            }}
            disabled={isDiarizing || transcriptCount === 0}
            title={
              transcriptCount === 0
                ? 'No transcript available'
                : 'Identify who spoke when, using the local diarization models'
            }
          >
            {isDiarizing ? (
              <Loader2 className="animate-spin" size={16} />
            ) : (
              <Users size={16} />
            )}
            <span className="ml-1.5 hidden xl:inline">{isDiarizing ? 'Working…' : 'Speakers'}</span>
          </Button>
        )}

        {betaFeatures.importAndRetranscribe && meetingId && meetingFolderPath && (
          <Button
            size="sm"
            variant="outline"
            className="h-8 w-8 shrink-0 border-blue-500/30 bg-blue-500/10 px-0 text-blue-300 hover:bg-blue-500/20 sm:h-9 sm:w-auto sm:px-3"
            onClick={() => {
              Analytics.trackButtonClick('enhance_transcript', 'meeting_details');
              setShowRetranscribeDialog(true);
            }}
            title="Retranscribe to enhance your recorded audio"
          >
            <RefreshCw size={16} />
            <span className="ml-1.5 hidden xl:inline">Enhance</span>
          </Button>
        )}
      </ButtonGroup>

      {/* Ask how many speakers to expect before diarizing */}
      <Dialog open={showSpeakerDialog} onOpenChange={setShowSpeakerDialog}>
        <DialogContent aria-describedby={undefined} className="sm:max-w-md">
          <DialogTitle className="flex items-center gap-2 text-base">
            <Users size={18} className="text-blue-500" />
            Identify speakers
          </DialogTitle>
          <div className="mt-2 space-y-3">
            <p className="text-sm text-gray-500">
              How many people spoke in this meeting? Telling us is far more accurate than letting
              the app guess — leave it blank to auto-detect.
            </p>
            <input
              type="number"
              min={1}
              max={20}
              autoFocus
              value={expectedSpeakers}
              onChange={(e) => setExpectedSpeakers(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  const n = parseInt(expectedSpeakers, 10);
                  handleIdentifySpeakers(Number.isFinite(n) && n > 0 ? n : undefined);
                }
              }}
              placeholder="Auto-detect"
              className="w-full rounded-md border border-[var(--af-border,#d1d5db)] bg-[var(--af-panel-2,#fff)] px-3 py-2 text-sm text-[var(--af-text,#111827)] outline-none focus:ring-2 focus:ring-blue-500"
            />
            <div className="flex flex-wrap gap-1.5">
              {[2, 3, 4, 5, 6, 8].map((n) => (
                <button
                  key={n}
                  type="button"
                  onClick={() => setExpectedSpeakers(String(n))}
                  className={`rounded-full border px-3 py-1 text-xs transition-colors ${
                    expectedSpeakers === String(n)
                      ? 'border-blue-500 bg-blue-50 text-blue-600'
                      : 'border-[var(--af-border,#e5e7eb)] text-gray-500 hover:border-blue-400 hover:text-blue-500'
                  }`}
                >
                  {n}
                </button>
              ))}
            </div>
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={() => setShowSpeakerDialog(false)}>
              Cancel
            </Button>
            <Button
              size="sm"
              className="bg-blue-600 text-white hover:bg-blue-700"
              onClick={() => {
                const n = parseInt(expectedSpeakers, 10);
                handleIdentifySpeakers(Number.isFinite(n) && n > 0 ? n : undefined);
              }}
            >
              <Users size={16} className="mr-1.5" />
              {expectedSpeakers ? `Find ${expectedSpeakers} speakers` : 'Auto-detect'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

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
