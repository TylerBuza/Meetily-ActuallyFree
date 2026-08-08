import React, { useState, useEffect } from 'react';
import { Download, X, CheckCircle2, AlertCircle, Loader2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog';
import { Button } from './ui/button';
import { updateService, UpdateInfo, UpdateProgress } from '@/services/updateService';
import { check, Update } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { toast } from 'sonner';

interface UpdateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  updateInfo: UpdateInfo | null;
}

export function UpdateDialog({ open, onOpenChange, updateInfo }: UpdateDialogProps) {
  const [isDownloading, setIsDownloading] = useState(false);
  const [progress, setProgress] = useState<UpdateProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [update, setUpdate] = useState<Update | null>(null);
  const [phase, setPhase] = useState<'idle' | 'preparing' | 'downloading' | 'installing'>('idle');

  useEffect(() => {
    if (open && updateInfo?.available) {
      // Reset state when dialog opens
      setIsDownloading(false);
      setProgress(null);
      setError(null);
      setPhase('idle');

      // Get the update object when dialog opens
      check().then((updateResult) => {
        if (updateResult?.available) {
          setUpdate(updateResult);
        } else {
          setError('Update no longer available');
        }
      }).catch((err) => {
        console.error('Failed to get update object:', err);
        setError('Failed to prepare update: ' + (err.message || 'Unknown error'));
      });
    } else {
      // Reset state when dialog closes
      setIsDownloading(false);
      setProgress(null);
      setError(null);
      setUpdate(null);
      setPhase('idle');
    }
  }, [open, updateInfo]);

  const handleDownloadAndInstall = async () => {
    // Get update object if not already available
    let updateToUse: Update | null = update;
    if (!updateToUse) {
      try {
        const updateResult = await check();
        if (updateResult?.available) {
          updateToUse = updateResult;
          setUpdate(updateResult);
        } else {
          setError('Update not available');
          return;
        }
      } catch (err: any) {
        setError('Failed to get update: ' + (err.message || 'Unknown error'));
        return;
      }
    }

    // At this point, updateToUse is guaranteed to be non-null
    if (!updateToUse) {
      return; // This should never happen, but TypeScript needs this check
    }

    setIsDownloading(true);
    setPhase('preparing');
    setError(null);
    setProgress({ downloaded: 0, total: 0, percentage: 0 });

    try {
      let downloaded = 0;
      let contentLength = 0;

      // Use the official Tauri updater API with progress callbacks
      await updateToUse.downloadAndInstall((event) => {
        switch (event.event) {
          case 'Started':
            setPhase('downloading');
            contentLength = event.data.contentLength || 0;
            console.log(`[UpdateDialog] Started downloading ${contentLength} bytes`);
            setProgress({
              downloaded: 0,
              total: contentLength,
              percentage: 0,
            });
            break;

          case 'Progress':
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
            setPhase('installing');
            console.log('[UpdateDialog] Download finished');
            setProgress({
              downloaded: contentLength,
              total: contentLength,
              percentage: 100,
            });
            break;
        }
      });

      console.log('[UpdateDialog] Update installed successfully');
      toast.success('Update installed successfully. The app will restart...');

      // Mark download as complete before closing
      setIsDownloading(false);
      setPhase('idle');

      // Close dialog before relaunch
      handleOpenChange(false);

      // Relaunch the app
      await relaunch();
    } catch (err: any) {
      console.error('Update failed:', err);
      setError(err.message || 'Failed to download or install update');
      setIsDownloading(false);
      setPhase('idle');
      toast.error('Update failed: ' + (err.message || 'Unknown error'));
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

  // Prevent closing the dialog when downloading
  const handleOpenChange = (newOpen: boolean) => {
    // If trying to close while downloading, prevent it
    if (!newOpen && isDownloading) {
      return;
    }
    // Otherwise, allow normal close behavior
    onOpenChange(newOpen);
  };

  // Prevent ESC key from closing dialog during download
  const handleEscapeKeyDown = (event: KeyboardEvent) => {
    if (isDownloading) {
      event.preventDefault();
    }
  };

  // Prevent outside clicks from closing dialog during download
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
