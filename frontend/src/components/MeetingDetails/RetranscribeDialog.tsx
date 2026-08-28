import React, { useState, useEffect, useRef, useMemo } from 'react';
import { RefreshCw, Globe, Loader2, AlertCircle, CheckCircle2, X, Cpu, BookOpen } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import { Button } from '../ui/button';
import { Textarea } from '../ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select';
import { invoke } from '@tauri-apps/api/core';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import { toast } from 'sonner';
import { useConfig } from '@/contexts/ConfigContext';
import { useRouter } from 'next/navigation';
import { LANGUAGES } from '@/constants/languages';
import { useTranscriptionModels, ModelOption } from '@/hooks/useTranscriptionModels';
import Analytics from '@/lib/analytics';

interface RetranscribeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  meetingId: string;
  meetingFolderPath: string | null;
  onComplete?: () => void;
}

interface RetranscriptionProgress {
  meeting_id: string;
  stage: string;
  progress_percentage: number;
  message: string;
}

interface RetranscriptionResult {
  meeting_id: string;
  segments_count: number;
  duration_seconds: number;
  language: string | null;
}

interface RetranscriptionError {
  meeting_id: string;
  error: string;
}

interface VocabularyConfig {
  global: string;
  meeting: string;
}

interface PostCallTranscriptConfig {
  provider: 'live' | 'whisper' | 'parakeet';
  model: string;
}

export function RetranscribeDialog({
  open,
  onOpenChange,
  meetingId,
  meetingFolderPath,
  onComplete,
}: RetranscribeDialogProps) {
  const router = useRouter();
  const { selectedLanguage, transcriptModelConfig } = useConfig();
  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState<RetranscriptionProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedLang, setSelectedLang] = useState(selectedLanguage || 'auto');
  const [vocabularyTerms, setVocabularyTerms] = useState('');
  const [vocabularyScope, setVocabularyScope] = useState<'meeting' | 'global'>('meeting');
  const [savedMeetingVocabulary, setSavedMeetingVocabulary] = useState('');
  const [isClearingMeetingVocabulary, setIsClearingMeetingVocabulary] = useState(false);
  const [listenersReady, setListenersReady] = useState(false);

  // Use centralized model fetching hook
  const {
    availableModels,
    selectedModelKey,
    setSelectedModelKey,
    loadingModels,
    hasWhisperModel,
    hasParakeetModel,
    fetchModels,
    resetSelection,
  } = useTranscriptionModels(transcriptModelConfig);

  const openWhisperSettings = () => {
    sessionStorage.setItem('meetily-settings-tab', 'Transcriptionmodels');
    sessionStorage.setItem('meetily-settings-transcription-section', 'post-call');
    onOpenChange(false);
    router.push('/settings');
  };

  // Stable refs for callbacks to avoid listener re-registration
  const onCompleteRef = useRef(onComplete);
  const onOpenChangeRef = useRef(onOpenChange);
  useEffect(() => { onCompleteRef.current = onComplete; }, [onComplete]);
  useEffect(() => { onOpenChangeRef.current = onOpenChange; }, [onOpenChange]);

  // Track previous open state to only reset on closed→open transition
  const prevOpenRef = useRef(false);

  // Helper to get selected model details (memoized)
  const selectedModelDetails = useMemo((): ModelOption | undefined => {
    if (!selectedModelKey) return undefined;
    const colonIndex = selectedModelKey.indexOf(':');
    if (colonIndex === -1) return undefined;
    const provider = selectedModelKey.slice(0, colonIndex);
    const name = selectedModelKey.slice(colonIndex + 1);
    return availableModels.find(m => m.provider === provider && m.name === name);
  }, [selectedModelKey, availableModels]);
  const isParakeetModel = selectedModelDetails?.provider === 'parakeet';

  useEffect(() => {
    if (isParakeetModel && selectedLang !== 'auto') {
      setSelectedLang('auto');
    }
  }, [isParakeetModel, selectedLang]);

  // Reset state only when dialog transitions from closed to open
  // This prevents re-initialization when config changes while dialog is already open
  useEffect(() => {
    const wasOpen = prevOpenRef.current;
    prevOpenRef.current = open;

    if (open && !wasOpen) {
      resetSelection();
      setIsProcessing(false);
      setProgress(null);
      setError(null);
      setSelectedLang(selectedLanguage || 'auto');
      setVocabularyTerms('');
      setVocabularyScope('meeting');
      setSavedMeetingVocabulary('');

      // A post-call default is independent from the live model. Existing users
      // stay on the live model until they explicitly choose a post-call model.
      void invoke<PostCallTranscriptConfig>('api_get_post_call_transcript_config')
        .then((config) => fetchModels(config.provider === 'live'
          ? transcriptModelConfig
          : { provider: config.provider, model: config.model }))
        .catch((loadError) => {
          console.error('Failed to load post-call transcription config:', loadError);
          return fetchModels();
        });
      invoke<VocabularyConfig>('api_get_vocabulary', { meetingId })
        .then((config) => setSavedMeetingVocabulary(config.meeting || ''))
        .catch((loadError) => console.error('Failed to load meeting vocabulary:', loadError));
    }
  }, [open, selectedLanguage, transcriptModelConfig, fetchModels, meetingId]);

  // Listen for retranscription events
  useEffect(() => {
    if (!open) {
      setListenersReady(false);
      return;
    }

    setListenersReady(false);
    const unlisteners: UnlistenFn[] = [];
    const cleanedUpRef = { current: false };

    const setupListeners = async () => {
      // Progress events
      const unlistenProgress = await listen<RetranscriptionProgress>(
        'retranscription-progress',
        (event) => {
          if (event.payload.meeting_id === meetingId) {
            setProgress(event.payload);
          }
        }
      );
      if (cleanedUpRef.current) {
        unlistenProgress();
        return;
      }
      unlisteners.push(unlistenProgress);

      // Completion event
      const unlistenComplete = await listen<RetranscriptionResult>(
        'retranscription-complete',
        async (event) => {
          if (event.payload.meeting_id === meetingId) {
            await Analytics.track('enhance_transcript_completed', {
              success: 'true',
              duration_seconds: event.payload.duration_seconds.toString(),
              segments_count: event.payload.segments_count.toString()
            });

            setIsProcessing(false);
            toast.success(
              `Retranscription complete! ${event.payload.segments_count} segments created.`
            );
            onCompleteRef.current?.();
            onOpenChangeRef.current(false);
          }
        }
      );
      if (cleanedUpRef.current) {
        unlistenComplete();
        unlisteners.forEach(u => u());
        return;
      }
      unlisteners.push(unlistenComplete);

      // Error event
      const unlistenError = await listen<RetranscriptionError>(
        'retranscription-error',
        async (event) => {
          if (event.payload.meeting_id === meetingId) {
            await Analytics.trackError('enhance_transcript_failed', event.payload.error);

            setIsProcessing(false);
            setError(event.payload.error);
          }
        }
      );
      if (cleanedUpRef.current) {
        unlistenError();
        unlisteners.forEach(u => u());
        return;
      }
      unlisteners.push(unlistenError);
      setListenersReady(true);
    };

    void setupListeners().catch((listenerError) => {
      if (!cleanedUpRef.current) {
        setError(`Could not prepare retranscription events: ${String(listenerError)}`);
      }
    });

    return () => {
      cleanedUpRef.current = true;
      setListenersReady(false);
      unlisteners.forEach((unlisten) => unlisten());
    };
  }, [open, meetingId]);

  const handleStartRetranscription = async () => {
    if (!listenersReady) {
      setError('Retranscription is still initializing. Please try again.');
      return;
    }
    if (!meetingFolderPath) {
      setError('Meeting folder path not available');
      return;
    }

    setIsProcessing(true);
    setError(null);
    setProgress(null);

    try {
      const languageToSend = isParakeetModel ? null : selectedLang === 'auto' ? null : selectedLang;
      await Analytics.track('enhance_transcript_started', {
        language: isParakeetModel ? 'auto' : (selectedLang === 'auto' ? 'auto' : selectedLang),
        model_provider: selectedModelDetails?.provider || '',
        model_name: selectedModelDetails?.name || '',
        vocabulary_scope: vocabularyTerms.trim() ? vocabularyScope : 'unchanged'
      });

      await invoke('start_retranscription_command', {
        meetingId,
        meetingFolderPath,
        language: languageToSend,
        model: selectedModelDetails?.name || null,
        provider: selectedModelDetails?.provider || null,
        vocabularyTerms: vocabularyTerms.trim() || null,
        vocabularyScope,
      });
    } catch (err: any) {
      setIsProcessing(false);
      const errorMsg = typeof err === 'string' ? err : (err?.message || String(err));
      setError(errorMsg);

      await Analytics.trackError('enhance_transcript_failed', errorMsg);
    }
  };

  const handleCancel = async () => {
    if (isProcessing) {
      try {
        await invoke('cancel_retranscription_command');
        setIsProcessing(false);
        setProgress(null);
        toast.info('Retranscription cancelled');
      } catch (err) {
        console.error('Failed to cancel retranscription:', err);
      }
    }
    onOpenChange(false);
  };

  const clearMeetingVocabulary = async () => {
    setIsClearingMeetingVocabulary(true);
    try {
      await invoke<string>('api_save_meeting_vocabulary', {
        meetingId,
        vocabulary: '',
      });
      setSavedMeetingVocabulary('');
      toast.success('Meeting vocabulary cleared');
    } catch (clearError) {
      toast.error(typeof clearError === 'string' ? clearError : String(clearError));
    } finally {
      setIsClearingMeetingVocabulary(false);
    }
  };

  // Prevent closing during processing
  const handleOpenChange = (newOpen: boolean) => {
    if (!newOpen && isProcessing) {
      return;
    }
    onOpenChange(newOpen);
  };

  const handleEscapeKeyDown = (event: KeyboardEvent) => {
    if (isProcessing) {
      event.preventDefault();
    }
  };

  const handleInteractOutside = (event: Event) => {
    if (isProcessing) {
      event.preventDefault();
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className="max-h-[85vh] overflow-y-auto sm:max-w-[500px]"
        onEscapeKeyDown={handleEscapeKeyDown}
        onInteractOutside={handleInteractOutside}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {isProcessing ? (
              <>
                <Loader2 className="h-5 w-5 animate-spin text-blue-600" />
                Retranscribing...
              </>
            ) : error ? (
              <>
                <AlertCircle className="h-5 w-5 text-red-600" />
                Retranscription Failed
              </>
            ) : (
              <>
                <RefreshCw className="h-5 w-5 text-blue-600" />
                Retranscribe Meeting
              </>
            )}
          </DialogTitle>
          <DialogDescription>
            {isProcessing
              ? progress?.message || 'Processing audio...'
              : error
                ? 'An error occurred during retranscription'
                : 'Re-process the audio with a different model, language, or vocabulary hints'}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {!isProcessing && !error && (
            !isParakeetModel ? (
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <Globe className="h-4 w-4 text-muted-foreground" />
                  <span className="text-sm font-medium">Language</span>
                </div>
                <Select value={selectedLang} onValueChange={setSelectedLang}>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Select language" />
                  </SelectTrigger>
                  <SelectContent className="max-h-60">
                    {LANGUAGES.map((lang) => (
                      <SelectItem key={lang.code} value={lang.code}>
                        {lang.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  Select a specific language to improve accuracy, or use auto-detect
                </p>
              </div>
            ) : (
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <Globe className="h-4 w-4 text-muted-foreground" />
                  <span className="text-sm font-medium">Language</span>
                </div>
                <p className="text-xs text-muted-foreground">
                  Language selection isn't supported for Parakeet. It always uses automatic detection.
                </p>
              </div>
            )
          )}

          {!isProcessing && !error && (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <Cpu className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm font-medium">Model</span>
              </div>
              <Select
                value={selectedModelKey}
                onValueChange={(value) => {
                  if (value === 'install:whisper') {
                    openWhisperSettings();
                    return;
                  }
                  setSelectedModelKey(value);
                }}
                disabled={loadingModels}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder={loadingModels ? "Loading models..." : "Select model"} />
                </SelectTrigger>
                <SelectContent>
                  {availableModels.map((model) => (
                    <SelectItem key={`${model.provider}:${model.name}`} value={`${model.provider}:${model.name}`}>
                      {model.displayName} ({Math.round(model.size_mb)} MB)
                    </SelectItem>
                  ))}
                  {!hasWhisperModel && (
                    <SelectItem value="install:whisper">
                      + Install a Whisper model...
                    </SelectItem>
                  )}
                </SelectContent>
              </Select>
              {!loadingModels && (
                <div className="grid gap-2 text-xs sm:grid-cols-2">
                  <div className="rounded-md border border-border bg-muted/30 p-3">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium">Parakeet</span>
                      <span className={hasParakeetModel ? 'text-emerald-600' : 'text-muted-foreground'}>
                        {hasParakeetModel ? 'Installed' : 'Not installed'}
                      </span>
                    </div>
                    <p className="mt-1 text-muted-foreground">
                      Faster and smaller with automatic language detection and contextual vocabulary boosting.
                    </p>
                  </div>
                  <div className="rounded-md border border-border bg-muted/30 p-3">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium">Whisper</span>
                      <span className={hasWhisperModel ? 'text-emerald-600' : 'text-amber-600'}>
                        {hasWhisperModel ? 'Installed' : 'Optional'}
                      </span>
                    </div>
                    <p className="mt-1 text-muted-foreground">
                      Manual language selection, vocabulary prompting, and broad language support. Usually slower and larger.
                    </p>
                    {!hasWhisperModel && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="mt-2 h-7 w-full text-xs"
                        onClick={openWhisperSettings}
                      >
                        Install Whisper
                      </Button>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}

          {!isProcessing && !error && (
            <div className="space-y-3 rounded-lg border border-border p-3">
              <div className="flex items-center gap-2">
                <BookOpen className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm font-medium">Add vocabulary hints</span>
              </div>
              <Textarea
                value={vocabularyTerms}
                onChange={(event) => setVocabularyTerms(event.target.value)}
                maxLength={1000}
                rows={3}
                placeholder={'Participant names, company names, acronyms, or technical terms'}
              />
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>Terms are saved and applied by the selected transcription model.</span>
                <span>{vocabularyTerms.length}/1000</span>
              </div>
              {vocabularyTerms.trim() && (
                <div className="space-y-2">
                  <span className="text-xs font-medium">Use these terms for</span>
                  <Select
                    value={vocabularyScope}
                    onValueChange={(value) => setVocabularyScope(value as 'meeting' | 'global')}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="meeting">This meeting only</SelectItem>
                      <SelectItem value="global">This and future meetings</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              )}
              {savedMeetingVocabulary && (
                <div className="rounded-md bg-muted/60 px-3 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-xs font-medium">Already saved for this meeting</p>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-6 px-2 text-xs"
                      disabled={isClearingMeetingVocabulary}
                      onClick={clearMeetingVocabulary}
                    >
                      {isClearingMeetingVocabulary ? 'Clearing...' : 'Clear'}
                    </Button>
                  </div>
                  <p className="mt-1 max-h-16 overflow-y-auto whitespace-pre-wrap break-words text-xs text-muted-foreground">
                    {savedMeetingVocabulary}
                  </p>
                </div>
              )}
            </div>
          )}

          {isProcessing && progress && (
            <div className="space-y-2">
              <div className="relative">
                <div className="w-full bg-gray-200 rounded-full h-3">
                  <div
                    className="bg-blue-600 h-3 rounded-full transition-all duration-300 ease-out"
                    style={{ width: `${Math.min(progress.progress_percentage, 100)}%` }}
                  />
                </div>
                <div className="flex justify-between text-xs text-gray-600 mt-1">
                  <span>{progress.stage}</span>
                  <span>{Math.round(progress.progress_percentage)}%</span>
                </div>
              </div>
              <p className="text-sm text-muted-foreground text-center">
                {progress.message}
              </p>
            </div>
          )}

          {error && (
            <div className="bg-red-50 border border-red-200 rounded-lg p-3">
              <p className="text-sm text-red-800">{error}</p>
            </div>
          )}
        </div>

        <DialogFooter>
          {!isProcessing && !error && (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button
                onClick={handleStartRetranscription}
                className="bg-blue-600 hover:bg-blue-700"
                disabled={!meetingFolderPath || !listenersReady || isClearingMeetingVocabulary || loadingModels || !selectedModelDetails}
              >
                <RefreshCw className="h-4 w-4 mr-2" />
                Start Retranscription
              </Button>
            </>
          )}
          {isProcessing && (
            <Button variant="outline" onClick={handleCancel}>
              <X className="h-4 w-4 mr-2" />
              Cancel
            </Button>
          )}
          {error && (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Close
              </Button>
              <Button
                onClick={() => {
                  setError(null);
                  setProgress(null);
                }}
                variant="outline"
              >
                Try Again
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
