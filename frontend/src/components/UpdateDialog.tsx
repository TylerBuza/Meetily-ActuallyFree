import React, { useState, useEffect, useRef } from 'react';
import { Download, AlertCircle, Loader2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog';
import { Button } from './ui/button';
import { UpdateInfo, UpdateProgress } from '@/services/updateService';
import { relaunch } from '@tauri-apps/plugin-process';
import { Channel, invoke } from '@tauri-apps/api/core';
import { toast } from 'sonner';

interface UpdateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  updateInfo: UpdateInfo | null;
}

type UpdateDownloadEvent =
  | { event: 'Started'; data: { contentLength?: number } }
  | { event: 'Progress'; data: { chunkLength: number } }
  | { event: 'Finished' };

type UpdatePhase = 'idle' | 'preparing' | 'downloading' | 'installing';

export function UpdateDialog({ open, onOpenChange, updateInfo }: UpdateDialogProps) {
  const [progress, setProgress] = useState<UpdateProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState<UpdatePhase>('idle');
  const phaseRef = useRef<UpdatePhase>('idle');
  const operationRef = useRef(0);
  const requestIdRef = useRef<string | null>(null);
  const isDownloading = phase !== 'idle';
  const updateAvailable = updateInfo?.available;
  const updateVersion = updateInfo?.version;

  const updatePhase = (nextPhase: UpdatePhase) => {
    phaseRef.current = nextPhase;
    setPhase(nextPhase);
  };

  useEffect(() => {
    if (open && updateAvailable) {
      if (phaseRef.current === 'idle') {
        setProgress(null);
        setError(null);
      }
    } else {
      if (phaseRef.current === 'installing') return;
      operationRef.current += 1;
      if (phaseRef.current === 'preparing' || phaseRef.current === 'downloading') {
        void invoke('cancel_app_update_download', { requestId: requestIdRef.current }).catch((cancelError) => {
          console.error('Failed to cancel update download:', cancelError);
        });
      }
      setProgress(null);
      setError(null);
      phaseRef.current = 'idle';
      setPhase('idle');
    }
  }, [open, updateAvailable, updateVersion]);

  useEffect(() => () => {
    operationRef.current += 1;
    if (phaseRef.current === 'preparing' || phaseRef.current === 'downloading') {
      void invoke('cancel_app_update_download', { requestId: requestIdRef.current }).catch((cancelError) => {
        console.error('Failed to cancel update download during cleanup:', cancelError);
      });
    }
  }, []);

  const handleDownloadAndInstall = async () => {
    if (phaseRef.current !== 'idle') return;
    const operation = ++operationRef.current;
    const requestId = crypto.randomUUID();
    requestIdRef.current = requestId;
    updatePhase('preparing');
    setError(null);
    setProgress({ downloaded: 0, total: 0, percentage: 0 });
    let crashSessionSuspended = false;

    try {
      let downloaded = 0;
      let contentLength = 0;
      let downloadStarted = false;
      const onEvent = new Channel<UpdateDownloadEvent>();

      onEvent.onmessage = (event) => {
        if (operation !== operationRef.current || phaseRef.current === 'installing') return;
        switch (event.event) {
          case 'Started':
            updatePhase('downloading');
            downloadStarted = true;
            contentLength = event.data.contentLength || 0;
            console.log(`[UpdateDialog] Started downloading ${contentLength} bytes`);
            setProgress({
              downloaded: 0,
              total: contentLength,
              percentage: 0,
            });
            break;

          case 'Progress':
            if (!downloadStarted) {
              updatePhase('downloading');
              downloadStarted = true;
            }
            downloaded += event.data.chunkLength || 0;
            const percentage = contentLength > 0
              ? Math.round((downloaded / contentLength) * 100)
              : 0;
            console.log(`[UpdateDialog] Progress: ${downloaded} / ${contentLength} bytes (${percentage}%)`);
            setProgress({
              downloaded,
              total: contentLength,
              percentage,
            });
            break;

          case 'Finished':
            console.log('[UpdateDialog] Download finished');
            setProgress({
              downloaded: contentLength,
              total: contentLength,
              percentage: 100,
            });
            break;
        }
      };

      await invoke('download_app_update', { onEvent, requestId });
      if (operation !== operationRef.current) return;

      updatePhase('installing');
      await invoke('prepare_for_app_restart');
      crashSessionSuspended = true;
      await invoke('install_downloaded_app_update', { requestId });

      console.log('[UpdateDialog] Update installed successfully');
      toast.success('Update installed successfully. The app will restart...');

      // Mark download as complete before closing
      updatePhase('idle');

      // Close dialog before relaunch
      onOpenChange(false);

      // Relaunch the app
      await relaunch();
    } catch (err: any) {
      const message = err instanceof Error ? err.message : String(err);
      if (crashSessionSuspended) {
        await invoke('resume_crash_session').catch((resumeError) => {
          console.error('Failed to resume crash detection after update failure:', resumeError);
        });
      }
      if (operation !== operationRef.current || message.includes('Update download cancelled')) {
        return;
      }
      await invoke('cancel_app_update_download', { requestId }).catch(() => {});
      console.error('Update failed:', err);
      setError(message || 'Failed to download or install update');
      updatePhase('idle');
      toast.error('Update failed: ' + (message || 'Unknown error'));
    }
  };

  const formatDate = (dateString?: string) => {
    if (!dateString) return '';
    try {
      return new Date(dateString).toLocaleDateString();
    } catch {
      return dateString;
    }
  };

  const handleOpenChange = (newOpen: boolean) => {
    if (!newOpen && phaseRef.current === 'installing') {
      return;
    }
    if (!newOpen && (phaseRef.current === 'preparing' || phaseRef.current === 'downloading')) {
      operationRef.current += 1;
      void invoke('cancel_app_update_download', { requestId: requestIdRef.current }).catch((cancelError) => {
        console.error('Failed to cancel update download:', cancelError);
      });
    }
    onOpenChange(newOpen);
  };

  const handleEscapeKeyDown = (event: KeyboardEvent) => {
    if (phaseRef.current === 'installing') {
      event.preventDefault();
    }
  };

  const handleInteractOutside = (event: Event) => {
    if (isDownloading) {
      event.preventDefault();
    }
  };

  if (!updateInfo?.available) {
    return null;
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className="overflow-hidden border-slate-700/80 bg-[#0b1220] p-0 text-slate-100 shadow-2xl shadow-black/50 sm:max-w-[520px]"
        onEscapeKeyDown={handleEscapeKeyDown}
        onInteractOutside={handleInteractOutside}
        showCloseButton={phase !== 'installing'}
      >
        <div className="border-b border-slate-800 bg-gradient-to-br from-slate-900 via-[#0d1728] to-[#0a1c25] px-6 py-5">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-3 text-lg text-slate-100">
            {isDownloading ? (
              <>
                <span className="flex h-9 w-9 items-center justify-center rounded-full border border-cyan-400/25 bg-cyan-400/10">
                  <Loader2 className="h-5 w-5 animate-spin text-cyan-300" />
                </span>
                {phase === 'installing' ? 'Installing Update' : 'Downloading Update'}
              </>
            ) : error ? (
              <>
                <span className="flex h-9 w-9 items-center justify-center rounded-full border border-red-400/25 bg-red-400/10">
                  <AlertCircle className="h-5 w-5 text-red-300" />
                </span>
                Update Error
              </>
            ) : (
              <>
                <span className="flex h-9 w-9 items-center justify-center rounded-full border border-cyan-400/25 bg-cyan-400/10">
                  <Download className="h-5 w-5 text-cyan-300" />
                </span>
                Update Available
              </>
            )}
          </DialogTitle>
          <DialogDescription className="pl-12 text-slate-400">
            {isDownloading
              ? phase === 'installing'
                ? 'Download complete. Verifying and installing the update.'
                : phase === 'preparing'
                  ? 'Preparing the secure download...'
                  : 'Downloading the signed update package from GitHub.'
              : error
              ? 'An error occurred while updating'
              : `A new version (${updateInfo.version}) is available`}
          </DialogDescription>
        </DialogHeader>
        </div>

        <div className="space-y-5 px-6 py-5">
          {!isDownloading && !error && (
            <>
              <div className="grid grid-cols-2 gap-3 rounded-xl border border-slate-800 bg-slate-950/40 p-4">
                <div className="flex justify-between text-sm">
                  <span className="text-slate-500">Installed</span>
                  <span className="font-mono font-medium text-slate-300">v{updateInfo.currentVersion}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-slate-500">Available</span>
                  <span className="font-mono font-semibold text-cyan-300">v{updateInfo.version}</span>
                </div>
                {updateInfo.date && (
                  <div className="col-span-2 flex justify-between border-t border-slate-800 pt-3 text-sm">
                    <span className="text-slate-500">Released</span>
                    <span className="font-medium text-slate-300">{formatDate(updateInfo.date)}</span>
                  </div>
                )}
              </div>

              {updateInfo.body && (
                <div className="max-h-40 overflow-y-auto rounded-xl border border-slate-800 bg-slate-950/40 p-4">
                  <p className="whitespace-pre-wrap text-sm leading-6 text-slate-300">
                    {updateInfo.body}
                  </p>
                </div>
              )}
            </>
          )}

          {isDownloading && progress && (
            <div className="space-y-4 rounded-xl border border-slate-800 bg-slate-950/40 p-4">
              <div className="relative">
                <div className="h-2.5 w-full overflow-hidden rounded-full bg-slate-800">
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-teal-400 to-cyan-300 shadow-[0_0_18px_rgba(34,211,238,0.35)] transition-all duration-300 ease-out"
                    style={{ width: `${Math.min(progress.percentage, 100)}%` }}
                  />
                </div>
                <div className="mt-2 flex justify-between font-mono text-xs text-slate-400">
                  <span>{phase === 'installing' ? 'Installing' : `${Math.round(progress.percentage)}%`}</span>
                  {progress.total > 0 && (
                    <span>
                      {formatBytes(progress.downloaded)} / {formatBytes(progress.total)}
                    </span>
                  )}
                </div>
              </div>
              <p className="text-center text-sm text-slate-400">
                Meetily will restart automatically when the update is installed.
              </p>
            </div>
          )}

          {error && (
            <div className="rounded-xl border border-red-400/25 bg-red-400/10 p-4">
              <p className="text-sm text-red-200">{error}</p>
            </div>
          )}
        </div>

        <DialogFooter className="border-t border-slate-800 bg-slate-950/30 px-6 py-4">
          {!isDownloading && !error && (
            <>
              <Button variant="outline" className="border-slate-700 bg-transparent text-slate-300 hover:bg-slate-800 hover:text-white" onClick={() => handleOpenChange(false)}>
                Later
              </Button>
              <Button onClick={handleDownloadAndInstall} className="bg-teal-500 text-slate-950 hover:bg-teal-400">
                <Download className="h-4 w-4 mr-2" />
                Download & Install
              </Button>
            </>
          )}
          {error && (
            <Button variant="outline" className="border-slate-700 bg-transparent text-slate-300 hover:bg-slate-800 hover:text-white" onClick={() => handleOpenChange(false)}>
              Close
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
}
