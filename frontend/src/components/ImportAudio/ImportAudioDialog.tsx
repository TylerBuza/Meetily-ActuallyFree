import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Spinner } from '@/components/ui/spinner';
import {
  Upload,
  Globe, 
  AlertCircle,
  CheckCircle2,
  X,
  Cpu,
  FileAudio,
  Clock,
  HardDrive,
  ChevronDown,
  ChevronUp,
  Video,
  ExternalLink,
} from 'lucide-react';
import { listen } from '@tauri-apps/api/event';
import { cn } from '@/lib/utils';
import {
  fetchYoutubeInfo,
  transcribeYoutubeUrl,
  type YoutubeVideoInfo,
} from '@/lib/workspace-api';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select';
import { toast } from 'sonner';
import { useConfig } from '@/contexts/ConfigContext';
import { useImportAudio, ImportResult } from '@/hooks/useImportAudio';
import { useRouter } from 'next/navigation';
import { useSidebar } from '../Sidebar/SidebarProvider';
import { LANGUAGES } from '@/constants/languages';
import { useTranscriptionModels, ModelOption } from '@/hooks/useTranscriptionModels';


interface ImportAudioDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  preselectedFile?: string | null;
  onComplete?: () => void;
}

function formatDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);

  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
  return `${minutes}:${secs.toString().padStart(2, '0')}`;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export function ImportAudioDialog({
  open,
  onOpenChange,
  preselectedFile,
  onComplete,
}: ImportAudioDialogProps) {
  const router = useRouter();
  const { refetchMeetings } = useSidebar();
  const { selectedLanguage, transcriptModelConfig } = useConfig();

  const [title, setTitle] = useState('');
  const [selectedLang, setSelectedLang] = useState(selectedLanguage || 'auto');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [titleModifiedByUser, setTitleModifiedByUser] = useState(false);
  const [tab, setTab] = useState<'file' | 'youtube'>('file');
  const [youtubeUrl, setYoutubeUrl] = useState('');
  const [youtubeInfo, setYoutubeInfo] = useState<YoutubeVideoInfo | null>(null);
  const [isFetchingInfo, setIsFetchingInfo] = useState(false);
  const [isProcessingYoutube, setIsProcessingYoutube] = useState(false);
  const [youtubeProgress, setYoutubeProgress] = useState<{ stage: string; percent: number; message: string } | null>(null);
  const [youtubeError, setYoutubeError] = useState<string | null>(null);

  // Always start as false — represents "dialog has not yet been opened".
  // Do NOT initialize from the `open` prop: if the component mounts with open=true
  // (e.g. drag-drop path), we still need the initialization effect to run.
  const prevOpenRef = useRef(false);

  // Listen for youtube download and extraction progress
  useEffect(() => {
    let unlistenYoutube: (() => void) | null = null;
    let unlistenImport: (() => void) | null = null;
    void listen<{ stage: string; percent: number; message: string }>('youtube-progress', (event) => {
      setYoutubeProgress(event.payload);
    }).then((un) => {
      unlistenYoutube = un;
    });
    void listen<{ stage: string; progress_percentage: number; message: string }>('import-progress', (event) => {
      setYoutubeProgress({
        stage: event.payload.stage,
        percent: event.payload.progress_percentage,
        message: event.payload.message,
      });
    }).then((un) => {
      unlistenImport = un;
    });
    return () => {
      if (unlistenYoutube) unlistenYoutube();
      if (unlistenImport) unlistenImport();
    };
  }, []);

  // Use centralized model fetching hook
  const {
    availableModels,
    selectedModelKey,
    setSelectedModelKey,
    loadingModels,
    fetchModels,
    resetSelection,
  } = useTranscriptionModels(transcriptModelConfig);

  const handleImportComplete = useCallback((result: ImportResult) => {
    toast.success(`Import complete! ${result.segments_count} segments created.`);

    // Refresh meetings list then navigate to the imported meeting
    refetchMeetings();
    onComplete?.();
    onOpenChange(false);
    router.push(`/meeting-details?id=${result.meeting_id}`);
  }, [router, refetchMeetings, onComplete, onOpenChange]);

  const handleImportError = useCallback((error: string) => {
    toast.error('Import failed', { description: error });
  }, []);

  const {
    status,
    fileInfo,
    progress,
    error,
    isProcessing,
    isBusy,
    selectFile,
    validateFile,
    startImport,
    cancelImport,
    reset,
  } = useImportAudio({
    onComplete: handleImportComplete,
    onError: handleImportError,
  });

  // Reset state only when dialog transitions from closed to open
  // This prevents re-initialization when config changes while dialog is already open (Bug #4 & #5)
  useEffect(() => {
    const wasOpen = prevOpenRef.current;
    prevOpenRef.current = open;

    // Only initialize when transitioning from closed (false) to open (true)
    if (open && !wasOpen) {
      reset();
      resetSelection();
      setTitle('');
      setTitleModifiedByUser(false);
      setSelectedLang(selectedLanguage || 'auto');
      setShowAdvanced(false);
      setTab('file');
      setYoutubeUrl('');
      setYoutubeInfo(null);
      setIsFetchingInfo(false);
      setIsProcessingYoutube(false);
      setYoutubeProgress(null);
      setYoutubeError(null);

      // Validate preselected file if provided
      if (preselectedFile) {
        validateFile(preselectedFile).then((info) => {
          if (info) {
            setTitle(info.filename);
          }
        });
      }

      // Fetch available models using centralized hook
      fetchModels();
    }
  }, [open, preselectedFile, selectedLanguage, transcriptModelConfig, reset, resetSelection, validateFile, fetchModels]);

  const handleFetchYoutubeInfo = async () => {
    if (!youtubeUrl.trim()) return;
    setIsFetchingInfo(true);
    setYoutubeError(null);
    try {
      const info = await fetchYoutubeInfo(youtubeUrl.trim());
      setYoutubeInfo(info);
      if (!title || !titleModifiedByUser) {
        setTitle(info.title);
      }
      toast.success('Video details loaded');
    } catch (err: any) {
      const msg = typeof err === 'string' ? err : (err?.message || String(err) || 'Failed to get video info');
      setYoutubeError(msg);
      toast.error('Failed to get video info', { description: msg });
    } finally {
      setIsFetchingInfo(false);
    }
  };

  const handleStartYoutubeImport = async () => {
    if (!youtubeUrl.trim()) return;
    setIsProcessingYoutube(true);
    setYoutubeError(null);
    setYoutubeProgress({ stage: 'Starting download...', percent: 5, message: 'Connecting to YouTube...' });
    try {
      const result = await transcribeYoutubeUrl(
        youtubeUrl.trim(),
        title.trim() || youtubeInfo?.title || null,
        isParakeetModel ? null : selectedLang === 'auto' ? null : selectedLang,
        selectedModel?.name || null,
        selectedModel?.provider || null,
      );
      handleImportComplete(result);
    } catch (err: any) {
      setIsProcessingYoutube(false);
      const msg = typeof err === 'string' ? err : (err?.message || String(err) || 'Failed to download and transcribe YouTube video');
      setYoutubeError(msg);
      toast.error('YouTube import failed', { description: msg });
    }
  };

  // Update title when fileInfo changes
  useEffect(() => {
    if (fileInfo && !title && !titleModifiedByUser) {
      setTitle(fileInfo.filename);
    }
  }, [fileInfo, title, titleModifiedByUser]);

  const selectedModel = useMemo((): ModelOption | undefined => {
    if (!selectedModelKey) return undefined;
    const colonIndex = selectedModelKey.indexOf(':');
    if (colonIndex === -1) return undefined;
    const provider = selectedModelKey.slice(0, colonIndex);
    const name = selectedModelKey.slice(colonIndex + 1);
    return availableModels.find((m) => m.provider === provider && m.name === name);
  }, [selectedModelKey, availableModels]);
  const isParakeetModel = selectedModel?.provider === 'parakeet';

  useEffect(() => {
    if (isParakeetModel && selectedLang !== 'auto') {
      setSelectedLang('auto');
    }
  }, [isParakeetModel, selectedLang]);

  const handleSelectFile = async () => {
    const info = await selectFile();
    if (info) {
      setTitle(info.filename);
    }
  };

  const handleStartImport = async () => {
    if (!fileInfo) return;

    await startImport(
      fileInfo.path,
      title || fileInfo.filename,
      isParakeetModel ? null : selectedLang === 'auto' ? null : selectedLang,
      selectedModel?.name || null,
      selectedModel?.provider || null
    );
  };

  const isAnyProcessing = isProcessing || isProcessingYoutube;
  const hasAnyError = Boolean(error || youtubeError);

  const handleCancel = async () => {
    if (isProcessing) {
      await cancelImport();
      toast.info('Import cancelled');
    }
    if (isProcessingYoutube) {
      setIsProcessingYoutube(false);
      toast.info('YouTube process cancelled');
    }
    onOpenChange(false);
  };

  // Prevent closing during processing
  const handleOpenChange = (newOpen: boolean) => {
    if (!newOpen && isAnyProcessing) {
      return;
    }
    onOpenChange(newOpen);
  };

  const handleEscapeKeyDown = (event: KeyboardEvent) => {
    if (isAnyProcessing) {
      event.preventDefault();
    }
  };

  const handleInteractOutside = (event: Event) => {
    if (isAnyProcessing) {
      event.preventDefault();
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className="sm:max-w-[520px]"
        onEscapeKeyDown={handleEscapeKeyDown}
        onInteractOutside={handleInteractOutside}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {isAnyProcessing ? (
              <>
                <Spinner className="h-5 w-5 text-af-accent" />
                {isProcessingYoutube ? 'Transcribing YouTube Video...' : 'Importing Audio...'}
              </>
            ) : hasAnyError ? (
              <>
                <AlertCircle className="h-5 w-5 text-af-danger" />
                Import Failed
              </>
            ) : status === 'complete' ? (
              <>
                <CheckCircle2 className="h-5 w-5 text-af-success" />
                Import Complete
              </>
            ) : (
              <>
                {tab === 'youtube' ? <Video className="h-5 w-5 text-af-accent" /> : <Upload className="h-5 w-5 text-af-accent" />}
                {tab === 'youtube' ? 'YouTube URL Transcription' : 'Import Audio File'}
              </>
            )}
          </DialogTitle>
          <DialogDescription>
            {isProcessingYoutube
              ? youtubeProgress?.message || 'Downloading and transcribing YouTube video...'
              : isProcessing
              ? progress?.message || 'Processing audio...'
              : hasAnyError
              ? error || youtubeError
              : tab === 'youtube'
              ? 'Download and transcribe any YouTube video with synchronized playback'
              : 'Import an audio file to create a new meeting with transcripts'}
          </DialogDescription>
        </DialogHeader>

        {/* Tab switcher */}
        {!isAnyProcessing && !hasAnyError && (
          <div className="flex border-b border-af-border -mt-1 mb-2">
            <button
              type="button"
              onClick={() => setTab('file')}
              className={cn(
                'flex items-center gap-2 px-4 py-2 text-xs sm:text-sm font-medium border-b-2 -mb-px transition-colors',
                tab === 'file'
                  ? 'border-af-accent text-af-accent font-semibold'
                  : 'border-transparent text-af-text-3 hover:text-af-text'
              )}
            >
              <Upload className="h-4 w-4" />
              Audio / Video File
            </button>
            <button
              type="button"
              onClick={() => setTab('youtube')}
              className={cn(
                'flex items-center gap-2 px-4 py-2 text-xs sm:text-sm font-medium border-b-2 -mb-px transition-colors',
                tab === 'youtube'
                  ? 'border-af-accent text-af-accent font-semibold'
                  : 'border-transparent text-af-text-3 hover:text-af-text'
              )}
            >
              <Video className="h-4 w-4" />
              YouTube Video
            </button>
          </div>
        )}

        <div className="space-y-4 py-2">
          {/* File selection / info */}
          {!isAnyProcessing && !hasAnyError && tab === 'file' && (
            <>
              {fileInfo ? (
                <div className="bg-af-panel-2 rounded-lg p-4 space-y-3">
                  <div className="flex items-start gap-3">
                    <FileAudio className="h-8 w-8 text-af-accent flex-shrink-0" />
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-af-text truncate">{fileInfo.filename}</p>
                      <div className="flex items-center gap-4 text-sm text-af-text-3 mt-1">
                        <span className="flex items-center gap-1">
                          <Clock className="h-3.5 w-3.5" />
                          {formatDuration(fileInfo.duration_seconds)}
                        </span>
                        <span className="flex items-center gap-1">
                          <HardDrive className="h-3.5 w-3.5" />
                          {formatFileSize(fileInfo.size_bytes)}
                        </span>
                        <span className="text-af-accent font-medium">{fileInfo.format}</span>
                      </div>
                    </div>
                  </div>

                  {/* Editable title */}
                  <div className="space-y-1">
                    <label className="text-sm font-medium text-af-text-2">Meeting Title</label>
                    <Input
                      value={title}
                      onChange={(e) => {
                        setTitle(e.target.value);
                        setTitleModifiedByUser(true);
                      }}
                      placeholder="Enter meeting title"
                    />
                  </div>

                  <Button variant="outline" size="sm" onClick={handleSelectFile} className="w-full">
                    Choose Different File
                  </Button>
                </div>
              ) : (
                <div className="border-2 border-dashed border-af-border-strong rounded-lg p-8 text-center">
                  <FileAudio className="h-12 w-12 text-af-text-4 mx-auto mb-4" />
                  <Button onClick={handleSelectFile} disabled={status === 'validating'}>
                    {status === 'validating' ? (
                      <>
                        <Spinner className="h-4 w-4 mr-2 " />
                        Validating...
                      </>
                    ) : (
                      <>
                        <Upload className="h-4 w-4 mr-2" />
                        Select Audio File
                      </>
                    )}
                  </Button>
                  <p className="text-sm text-af-text-3 mt-2">MP4, WAV, MP3, FLAC, OGG, MKV, WebM, WMA</p>
                </div>
              )}

              {/* Advanced options (collapsible) */}
              {fileInfo && (
                <div className="border rounded-lg">
                  <button
                    onClick={() => setShowAdvanced(!showAdvanced)}
                    className="w-full flex items-center justify-between p-3 text-sm font-medium text-af-text-2 hover:bg-af-panel-2"
                  >
                    <span>Advanced Options</span>
                    {showAdvanced ? (
                      <ChevronUp className="h-4 w-4" />
                    ) : (
                      <ChevronDown className="h-4 w-4" />
                    )}
                  </button>

                  {showAdvanced && (
                    <div className="p-3 pt-0 space-y-4 border-t">
                      {/* Language selector */}
                      {!isParakeetModel ? (
                        <div className="space-y-2">
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
                        </div>
                      ) : (
                        <div className="space-y-2">
                          <div className="flex items-center gap-2">
                            <Globe className="h-4 w-4 text-muted-foreground" />
                            <span className="text-sm font-medium">Language</span>
                          </div>
                          <p className="text-xs text-muted-foreground">
                            Language selection isn't supported for Parakeet. It always uses automatic detection.
                          </p>
                        </div>
                      )}

                      {/* Model selector */}
                      {availableModels.length > 0 && (
                        <div className="space-y-2">
                          <div className="flex items-center gap-2">
                            <Cpu className="h-4 w-4 text-muted-foreground" />
                            <span className="text-sm font-medium">Model</span>
                          </div>
                          <Select
                            value={selectedModelKey}
                            onValueChange={setSelectedModelKey}
                            disabled={loadingModels}
                          >
                            <SelectTrigger className="w-full">
                              <SelectValue placeholder={loadingModels ? 'Loading models...' : 'Select model'} />
                            </SelectTrigger>
                            <SelectContent>
                              {availableModels.map((model) => (
                                <SelectItem
                                  key={`${model.provider}:${model.name}`}
                                  value={`${model.provider}:${model.name}`}
                                >
                                  {model.displayName} ({Math.round(model.size_mb)} MB)
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </>
          )}

          {/* YouTube ingestion tab */}
          {!isAnyProcessing && !hasAnyError && tab === 'youtube' && (
            <div className="space-y-3">
              <div className="space-y-1.5">
                <label className="text-xs font-semibold uppercase tracking-wider text-af-text-3">YouTube URL</label>
                <div className="flex gap-2">
                  <Input
                    value={youtubeUrl}
                    onChange={(e) => setYoutubeUrl(e.target.value)}
                    placeholder="https://www.youtube.com/watch?v=... or https://youtu.be/..."
                    className="flex-1 text-sm font-mono"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        void handleFetchYoutubeInfo();
                      }
                    }}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    onClick={handleFetchYoutubeInfo}
                    disabled={isFetchingInfo || !youtubeUrl.trim()}
                    className="shrink-0"
                  >
                    {isFetchingInfo ? <Spinner className="h-4 w-4" /> : 'Fetch Info'}
                  </Button>
                </div>
              </div>

              {/* YouTube video preview card */}
              {youtubeInfo && (
                <div className="bg-af-panel-2 rounded-xl p-3.5 space-y-3 border border-af-border">
                  <div className="flex gap-3">
                    {(youtubeInfo.thumbnail_url || youtubeInfo.thumbnailUrl) ? (
                      <div className="relative h-20 w-32 shrink-0 overflow-hidden rounded-lg bg-black">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={(youtubeInfo.thumbnail_url || youtubeInfo.thumbnailUrl)!}
                          alt={youtubeInfo.title}
                          className="h-full w-full object-cover"
                        />
                        <span className="absolute bottom-1 right-1 rounded bg-black/80 px-1 py-0.5 text-[10px] font-mono text-white">
                          {formatDuration(youtubeInfo.duration_seconds ?? youtubeInfo.durationSeconds ?? 0)}
                        </span>
                      </div>
                    ) : (
                      <div className="flex h-20 w-32 shrink-0 items-center justify-center rounded-lg bg-af-panel border border-af-border">
                        <Video className="h-8 w-8 text-af-accent" />
                      </div>
                    )}
                    <div className="flex-1 min-w-0">
                      <p className="font-semibold text-sm text-af-text line-clamp-2">{youtubeInfo.title}</p>
                      <p className="text-xs text-af-text-3 mt-1 truncate">{youtubeInfo.channel}</p>
                      <div className="flex items-center gap-1.5 mt-2 text-xs text-af-accent">
                        <Video className="h-3.5 w-3.5" />
                        <span>Saves video to meeting folder with synchronized player</span>
                      </div>
                    </div>
                  </div>

                  {/* Title input */}
                  <div className="space-y-1 pt-2 border-t border-af-border/60">
                    <label className="text-xs font-medium text-af-text-2">Meeting Title</label>
                    <Input
                      value={title}
                      onChange={(e) => {
                        setTitle(e.target.value);
                        setTitleModifiedByUser(true);
                      }}
                      placeholder="Meeting title"
                    />
                  </div>
                </div>
              )}

              {/* Model selector for YouTube */}
              {availableModels.length > 0 && (
                <div className="space-y-1.5 pt-1">
                  <div className="flex items-center gap-2">
                    <Cpu className="h-4 w-4 text-af-text-3" />
                    <span className="text-xs font-semibold text-af-text-2 uppercase tracking-wider">Transcription Model</span>
                  </div>
                  <Select
                    value={selectedModelKey}
                    onValueChange={setSelectedModelKey}
                    disabled={loadingModels}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder={loadingModels ? 'Loading models...' : 'Select model'} />
                    </SelectTrigger>
                    <SelectContent>
                      {availableModels.map((model) => (
                        <SelectItem
                          key={`${model.provider}:${model.name}`}
                          value={`${model.provider}:${model.name}`}
                        >
                          {model.displayName} ({Math.round(model.size_mb)} MB)
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
            </div>
          )}

          {/* YouTube Progress display */}
          {isProcessingYoutube && (
            <div className="space-y-2 py-2">
              <div className="relative">
                <div className="w-full bg-af-hover rounded-full h-3">
                  <div
                    className="bg-af-accent h-3 rounded-full transition-all duration-300 ease-out"
                    style={{ width: `${Math.max(5, Math.min(youtubeProgress?.percent ?? 5, 100))}%` }}
                  />
                </div>
                <div className="flex justify-between text-xs text-af-text-2 mt-1">
                  <span>{youtubeProgress?.stage || 'Downloading...'}</span>
                  <span>{Math.round(youtubeProgress?.percent ?? 5)}%</span>
                </div>
              </div>
              <p className="text-sm text-muted-foreground text-center">
                {youtubeProgress?.message || 'Downloading video and preparing audio stream...'}
              </p>
            </div>
          )}

          {/* File Progress display */}
          {isProcessing && progress && (
            <div className="space-y-2 py-2">
              <div className="relative">
                <div className="w-full bg-af-hover rounded-full h-3">
                  <div
                    className="bg-af-accent h-3 rounded-full transition-all duration-300 ease-out"
                    style={{ width: `${Math.min(progress.progress_percentage, 100)}%` }}
                  />
                </div>
                <div className="flex justify-between text-xs text-af-text-2 mt-1">
                  <span>{progress.stage}</span>
                  <span>{Math.round(progress.progress_percentage)}%</span>
                </div>
              </div>
              <p className="text-sm text-muted-foreground text-center">{progress.message}</p>
            </div>
          )}

          {/* Error display */}
          {hasAnyError && (
            <div className="bg-af-danger/10 border border-af-danger/35 rounded-lg p-3">
              <p className="text-sm text-af-danger">{error || youtubeError}</p>
            </div>
          )}
        </div>

        <DialogFooter>
          {!isAnyProcessing && !hasAnyError && (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              {tab === 'file' ? (
                <Button
                  onClick={handleStartImport}
                  className="bg-af-accent hover:bg-af-accent-hover"
                  disabled={!fileInfo}
                >
                  <Upload className="h-4 w-4 mr-2" />
                  Import
                </Button>
              ) : (
                <Button
                  onClick={handleStartYoutubeImport}
                  className="bg-af-accent hover:bg-af-accent-hover"
                  disabled={!youtubeUrl.trim()}
                >
                  <Video className="h-4 w-4 mr-2" />
                  Download & Transcribe
                </Button>
              )}
            </>
          )}
          {isAnyProcessing && (
            <Button variant="outline" onClick={handleCancel}>
              <X className="h-4 w-4 mr-2" />
              Cancel
            </Button>
          )}
          {hasAnyError && (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Close
              </Button>
              <Button
                onClick={() => {
                  reset();
                  setYoutubeError(null);
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
