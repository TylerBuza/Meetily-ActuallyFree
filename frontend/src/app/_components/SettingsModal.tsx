'use client';

/**
 * Dialogs the recorder opens: transcription language (Whisper only), setting
 * up a speech model when none is ready, a recording that stopped on an error,
 * and a warning when the transcriber falls behind.
 */
import { AlertTriangle, AudioLines, Globe, OctagonAlert } from 'lucide-react';
import { LanguageSelection } from '@/components/LanguageSelection';
import { TranscriptSettings } from '@/components/TranscriptSettings';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useConfig } from '@/contexts/ConfigContext';
import { useRecordingState } from '@/contexts/RecordingStateContext';

type ModalName = 'languageSettings' | 'modelSelector' | 'errorAlert' | 'chunkDropWarning';

interface SettingsModalsProps {
  modals: Record<ModalName, boolean>;
  messages: { errorAlert: string; chunkDropWarning: string; modelSelector: string };
  onClose: (name: ModalName) => void;
}

export function SettingsModals({ modals, messages, onClose }: SettingsModalsProps) {
  const {
    selectedLanguage,
    setSelectedLanguage,
    transcriptModelConfig,
    setTranscriptModelConfig,
    showConfidenceIndicator,
    toggleConfidenceIndicator,
  } = useConfig();
  const { isRecording } = useRecordingState();

  return (
    <>
      <Dialog open={modals.languageSettings} onOpenChange={(open) => !open && onClose('languageSettings')}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Globe className="h-4 w-4 text-af-accent" />
              Transcription language
            </DialogTitle>
            <DialogDescription>The language people speak in your meetings. Auto-detect works for most calls.</DialogDescription>
          </DialogHeader>
          <LanguageSelection
            selectedLanguage={selectedLanguage}
            onLanguageChange={setSelectedLanguage}
            disabled={isRecording}
            provider={transcriptModelConfig.provider}
          />
          <DialogFooter>
            <Button onClick={() => onClose('languageSettings')}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={modals.modelSelector} onOpenChange={(open) => !open && onClose('modelSelector')}>
        <DialogContent className="flex max-h-[88vh] max-w-3xl flex-col gap-0 p-0">
          <DialogHeader className="border-b border-af-border px-6 pb-4 pt-6">
            <DialogTitle className="flex items-center gap-2">
              <AudioLines className="h-4 w-4 text-af-accent" />
              {messages.modelSelector ? 'Set up transcription to record' : 'Transcription models'}
            </DialogTitle>
            <DialogDescription>
              {messages.modelSelector
                ? 'Meetily needs a speech model on this computer before it can transcribe. Parakeet is fast and works well for live meetings.'
                : 'Choose the speech model used while recording and after the call.'}
            </DialogDescription>
          </DialogHeader>
          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
            <TranscriptSettings
              transcriptModelConfig={transcriptModelConfig}
              setTranscriptModelConfig={setTranscriptModelConfig}
              onModelSelect={() => onClose('modelSelector')}
            />
          </div>
          <DialogFooter className="items-center border-t border-af-border px-6 py-4 sm:justify-between">
            <label className="flex cursor-pointer items-center gap-3">
              <Switch checked={showConfidenceIndicator} onCheckedChange={toggleConfidenceIndicator} />
              <span>
                <span className="block text-[13px] font-medium text-af-text">Show confidence</span>
                <span className="block text-xs text-af-text-3">Mark transcript lines the model was unsure about</span>
              </span>
            </label>
            <Button variant="secondary" onClick={() => onClose('modelSelector')}>
              {messages.modelSelector ? 'Not now' : 'Done'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={modals.errorAlert} onOpenChange={(open) => !open && onClose('errorAlert')}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <OctagonAlert className="h-4 w-4 text-af-danger" />
              The recording stopped
            </DialogTitle>
            <DialogDescription className="whitespace-pre-line">{messages.errorAlert}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button onClick={() => onClose('errorAlert')}>OK</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={modals.chunkDropWarning} onOpenChange={(open) => !open && onClose('chunkDropWarning')}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-af-warning" />
              Transcription is falling behind
            </DialogTitle>
            <DialogDescription className="whitespace-pre-line">{messages.chunkDropWarning}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="secondary" onClick={() => onClose('chunkDropWarning')}>
              Got it
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
