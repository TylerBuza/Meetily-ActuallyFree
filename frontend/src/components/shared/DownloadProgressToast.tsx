'use client';

import React, { useEffect, useState, useCallback } from 'react';
import { listen } from '@tauri-apps/api/event';
import { toast } from 'sonner';
import { X, Check, ArrowBigDownDash } from 'lucide-react';
import { getDownloadTotalMb } from '@/lib/onboarding-summary-model';
import { useOnboarding } from '@/contexts/OnboardingContext';
import { useOptionalModelDownloads } from '@/contexts/OptionalModelDownloadsContext';

interface DownloadProgress {
  modelName: string;
  displayName: string;
  progress: number;
  downloadedMb?: number;
  totalMb?: number;
  speedMbps?: number;
  status: 'downloading' | 'activating' | 'completed' | 'error' | 'cancelled';
  detail?: string;
  unitLabel?: string;
  error?: string;
}

// Categorize error messages for better user experience
function categorizeError(error: string): string {
  const lowerError = error.toLowerCase();

  if (lowerError.includes('network') ||
    lowerError.includes('connection') ||
    lowerError.includes('timeout') ||
    lowerError.includes('failed to start download')) {
    return 'Network error - Check your internet connection';
  }

  if (lowerError.includes('status:') || lowerError.includes('http')) {
    return 'Server error - Download temporarily unavailable';
  }

  if (lowerError.includes('disk') ||
    lowerError.includes('write') ||
    lowerError.includes('file')) {
    return 'Storage error - Check available disk space';
  }

  if (lowerError.includes('invalid') || lowerError.includes('validation')) {
    return 'File validation failed - Please retry download';
  }

  // Fallback to original error
  return error;
}

// Custom toast component for download progress
function DownloadToastContent({
  download,
  collapsible = false,
}: {
  download: DownloadProgress;
  collapsible?: boolean;
}) {
  const isComplete = download.status === 'completed';
  const hasError = download.status === 'error';
  const isCancelled = download.status === 'cancelled';
  const unitLabel = download.unitLabel ?? 'MB';
  const detail = download.status === 'activating' ? 'Enabling model…' : download.detail ?? 'Downloading…';

  return (
    <div
      tabIndex={collapsible ? 0 : undefined}
      aria-label={collapsible ? `${download.displayName}: ${detail} ${Math.round(download.progress)}%` : undefined}
      className={collapsible
        ? 'group pointer-events-auto ml-auto flex max-h-14 w-14 items-center gap-3 overflow-hidden rounded-lg border border-af-border bg-af-panel p-3 shadow-lg transition-[width,max-height] duration-200 hover:max-h-24 hover:w-full focus:max-h-24 focus:w-full focus:outline-none'
        : 'relative flex w-full max-w-sm items-center gap-3 rounded-lg border border-af-border bg-af-panel p-3 shadow-lg'
      }
    >
      {/* Icon */}
      <div className={`flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center ${isComplete ? 'bg-af-success/10' : hasError ? 'bg-af-danger/10' : isCancelled ? 'bg-af-panel-2' : 'bg-af-panel-2'
        }`}>
        {isComplete ? (
          <Check className="w-4 h-4 text-af-success" />
        ) : hasError ? (
          <X className="w-4 h-4 text-af-danger" />
        ) : isCancelled ? (
          <X className="w-4 h-4 text-af-text-2" />
        ) : (
          <ArrowBigDownDash className="size-5 text-af-text-2" />
        )}
      </div>

      {/* Content */}
      <div className={collapsible
        ? 'w-[17rem] flex-none opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus:opacity-100'
        : 'min-w-0 flex-1'
      }>
        <div className="flex items-center justify-between gap-2 mb-1">
          <p className="text-sm font-medium text-af-text truncate">
            {download.displayName}
          </p>
        </div>

        {hasError ? (
          <p className="text-xs text-af-danger">{download.error || 'Download failed'}</p>
        ) : isComplete ? (
          <p className="text-xs text-af-success">Download complete</p>
        ) : isCancelled ? (
          <p className="text-xs text-af-text-2">Download cancelled</p>
        ) : (
          <>
            {/* Progress bar */}
            <div
              role="progressbar"
              aria-label={download.displayName}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={download.progress}
              aria-valuetext={`${detail} ${Math.round(download.progress)}%`}
              className="w-full h-1.5 bg-af-hover rounded-full overflow-hidden mb-1.5"
            >
              <div
                className="h-full bg-af-elevated rounded-full transition-all duration-300"
                style={{ width: `${download.progress}%` }}
              />
            </div>

            {/* Progress text */}
            <div className="flex items-center justify-between text-xs text-af-text-3">
              <span>
                {download.status === 'downloading' && download.downloadedMb !== undefined && download.totalMb !== undefined
                  ? `${download.downloadedMb.toFixed(1)} / ${download.totalMb.toFixed(1)} ${unitLabel}`
                  : detail}
              </span>
              <span className="flex items-center gap-1">
                {download.speedMbps !== undefined && download.speedMbps > 0 && (
                  <span>{download.speedMbps.toFixed(1)} {unitLabel}/s</span>
                )}
                <span className="text-af-text font-medium">
                  {Math.round(download.progress)}%
                </span>
              </span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// Hook to manage download progress toasts
export function useDownloadProgressToast() {
  const [downloads, setDownloads] = useState<Map<string, DownloadProgress>>(new Map());

  const updateDownload = useCallback((modelName: string, data: Partial<DownloadProgress>) => {
    setDownloads((prev) => {
      const updated = new Map(prev);
      const existing = updated.get(modelName) || {
        modelName,
        displayName: modelName,
        progress: 0,
        downloadedMb: 0,
        totalMb: 0,
        speedMbps: 0,
        status: 'downloading' as const,
      };

      updated.set(modelName, { ...existing, ...data });
      return updated;
    });
  }, []);

  const cleanupDownload = useCallback((modelName: string, expectedStatus: DownloadProgress['status'], delay: number = 4000) => {
    // A retry can begin before an old terminal toast expires. Delete only the
    // terminal state that scheduled this timer, never a newer active transfer.
    setTimeout(() => {
      setDownloads((prev) => {
        if (prev.get(modelName)?.status !== expectedStatus) return prev;
        const updated = new Map(prev);
        updated.delete(modelName);
        return updated;
      });
    }, delay);
  }, []);

  const showDownloadToast = useCallback((download: DownloadProgress) => {
    const toastId = `download-${download.modelName}`;

    // Determine duration based on status
    const getDuration = () => {
      switch (download.status) {
        case 'completed': return 3000;      // 3 seconds
        case 'cancelled': return 5000;      // 5 seconds
        case 'error': return 10000;         // 10 seconds
          case 'downloading': return Infinity; // Manual dismiss only
          case 'activating': return Infinity;
      }
    };

    toast.custom(
      () => (
        <DownloadToastContent
          download={download}
        />
      ),
      {
        id: toastId,
        duration: getDuration(),
      }
    );
  }, []);

  // Show terminal notifications; active transfers use the persistent stack.
  useEffect(() => {
    downloads.forEach((download) => {
      // Active transfers use the dedicated stacked top-right status below.
      // Sonner is reserved for terminal completion/error notifications.
      if (download.status === 'downloading' || download.status === 'activating') return;

      showDownloadToast(download);
    });
  }, [downloads, showDownloadToast]);

  // Listen to Parakeet download events
  useEffect(() => {
    const unlistenProgress = listen<{
      modelName: string;
      progress: number;
      downloaded_mb?: number;
      total_mb?: number;
      speed_mbps?: number;
      status?: string;
    }>('parakeet-model-download-progress', (event) => {
      const { modelName, progress, downloaded_mb, total_mb, speed_mbps, status } = event.payload;

      const downloadData: DownloadProgress = {
        modelName,
        displayName: `Transcription Model (${modelName})`,
        progress,
        downloadedMb: downloaded_mb ?? 0,
        totalMb: total_mb ?? 670,
        speedMbps: speed_mbps ?? 0,
        status: status === 'cancelled'
          ? 'cancelled'
          : status === 'completed'
          ? 'completed'
          : 'downloading',
      };

      updateDownload(modelName, downloadData);

      // Clean up cancelled downloads after delay to auto-dismiss toast
      if (downloadData.status === 'cancelled') {
        cleanupDownload(modelName, 'cancelled', 6000); // 5s toast + 1s buffer
      }
      // Removed direct showDownloadToast call here, handled by effect
    });

    const unlistenComplete = listen<{ modelName: string }>(
      'parakeet-model-download-complete',
      (event) => {
        const { modelName } = event.payload;
        const downloadData: DownloadProgress = {
          modelName,
          displayName: `Transcription Model (${modelName})`,
          progress: 100,
          downloadedMb: 670,
          totalMb: 670,
          speedMbps: 0,
          status: 'completed',
        };
        updateDownload(modelName, downloadData);
        // Clean up after 4 seconds (completion toast duration is 3s + 1s buffer)
        cleanupDownload(modelName, 'completed', 4000);
      }
    );

    const unlistenError = listen<{ modelName: string; error: string }>(
      'parakeet-model-download-error',
      (event) => {
        const { modelName, error } = event.payload;
        const downloadData: DownloadProgress = {
          modelName,
          displayName: `Transcription Model (${modelName})`,
          progress: 0,
          downloadedMb: 0,
          totalMb: 670,
          speedMbps: 0,
          status: 'error',
          error: categorizeError(error),
        };
        updateDownload(modelName, downloadData);
        // Clean up after 11 seconds (error toast duration is 10s + 1s buffer)
        cleanupDownload(modelName, 'error', 11000);
      }
    );

    return () => {
      unlistenProgress.then((fn) => fn());
      unlistenComplete.then((fn) => fn());
      unlistenError.then((fn) => fn());
    };
  }, [updateDownload, cleanupDownload]);

  // Listen to Built-in AI summary model download events
  useEffect(() => {
    const unlisten = listen<{
      model: string;
      progress: number;
      downloaded_mb?: number;
      total_mb?: number;
      speed_mbps?: number;
      status: string;
      error?: string;
    }>('builtin-ai-download-progress', (event) => {
      const { model, progress, downloaded_mb, total_mb, speed_mbps, status, error } = event.payload;

      const downloadData: DownloadProgress = {
        modelName: model,
        displayName: `Summary Model (${model})`,
        progress: progress ?? 0,
        downloadedMb: downloaded_mb ?? 0,
        totalMb: getDownloadTotalMb(total_mb, model),
        speedMbps: speed_mbps ?? 0,
        unitLabel: 'MiB',
        status: status === 'completed'
          ? 'completed'
          : status === 'cancelled'
            ? 'cancelled'
            : status === 'error'
              ? 'error'
              : 'downloading',
        error: status === 'error' ? categorizeError(error || 'Download failed') : undefined,
      };

      updateDownload(model, downloadData);

      // Clean up finished downloads after delay to prevent endless toasts
      if (downloadData.status === 'completed') {
        cleanupDownload(model, 'completed', 4000);  // 3s toast + 1s buffer
      } else if (downloadData.status === 'error') {
        cleanupDownload(model, 'error', 11000); // 10s toast + 1s buffer
      } else if (downloadData.status === 'cancelled') {
        cleanupDownload(model, 'cancelled', 6000);  // 5s toast + 1s buffer
      }
    });

    return () => {
      unlisten.then((fn) => fn());
    };
  }, [updateDownload, cleanupDownload]);

  return { downloads };
}

// Component to initialize download toast listeners at app level
export function DownloadProgressToastProvider() {
  const { downloads } = useDownloadProgressToast();
  const { jobs } = useOptionalModelDownloads();
  const { currentStep } = useOnboarding();
  // Reuse the app-level jobs instead of another set of native listeners. This
  // restores existing progress when the panel mounts and survives route changes;
  // optional activation and terminal notifications stay owned by the context.
  const optionalDownloads: DownloadProgress[] = (['whisper', 'nemotron'] as const).flatMap((model) => {
    const job = jobs[model];
    if (job.status !== 'downloading' && job.status !== 'activating') return [];
    return [{
      modelName: `optional-${model}`,
      displayName: model === 'whisper' ? 'Whisper · Post-call transcription' : 'Nemotron · Speaker identification',
      progress: job.progress,
      status: job.status,
      detail: job.detail,
    }];
  });
  const activeDownloads = [
    ...Array.from(downloads.values()).filter((download) => download.status === 'downloading'),
    ...optionalDownloads,
  ];

  // The download step owns its progress UI. Show this background status only
  // after the user continues to the rest of onboarding.
  if (currentStep <= 3 || activeDownloads.length === 0) return null;

  return (
    <div className="pointer-events-none fixed right-5 top-20 z-[70] flex w-[min(22rem,calc(100vw-2.5rem))] flex-col items-end gap-2">
      {activeDownloads.map((download) => (
        <div key={download.modelName} className="w-full">
          <DownloadToastContent
            download={download}
            collapsible
          />
        </div>
      ))}
    </div>
  );
}
