"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { invoke } from "@tauri-apps/api/core"
import { listen, UnlistenFn } from "@tauri-apps/api/event"
import { toast } from "sonner"
import { Users, CheckCircle2, AlertCircle, FolderOpen, Download, Loader2 } from "lucide-react"
import { Button } from "./ui/button"

interface DownloadProgress {
  file: string;
  file_index: number;
  file_count: number;
  downloaded: number;
  total: number;
  percent: number;
  status: 'downloading' | 'verifying' | 'skipped' | 'done' | 'error' | string;
  message?: string;
}

function formatMB(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Speaker diarization status panel. Diarization ("who spoke when") runs fully
 * on-device from local ONNX models. Models can be installed with one click
 * from this fork's own GitHub release, or dropped in manually.
 */
export function DiarizationSettings() {
  const [available, setAvailable] = useState<boolean | null>(null);
  const [dir, setDir] = useState<string>('');
  const [downloadSize, setDownloadSize] = useState<number>(0);
  const [isDownloading, setIsDownloading] = useState(false);
  const [progress, setProgress] = useState<DownloadProgress | null>(null);
  const unlistenRef = useRef<UnlistenFn | null>(null);

  const refresh = useCallback(() => {
    invoke<boolean>('diarization_models_available').then(setAvailable).catch(() => setAvailable(false));
  }, []);

  useEffect(() => {
    refresh();
    invoke<string>('diarization_model_directory').then(setDir).catch(() => {});
    invoke<number>('diarization_download_size').then(setDownloadSize).catch(() => {});
  }, [refresh]);

  // Clean up the progress listener on unmount.
  useEffect(() => {
    return () => {
      if (unlistenRef.current) unlistenRef.current();
    };
  }, []);

  const handleDownload = useCallback(async () => {
    if (isDownloading) return;
    setIsDownloading(true);
    setProgress(null);

    try {
      unlistenRef.current = await listen<DownloadProgress>(
        'diarization-download-progress',
        (event) => setProgress(event.payload)
      );

      await invoke('download_diarization_models');
      toast.success('Speaker models installed', {
        description: 'You can now use Speakers on any meeting with a recording.',
      });
      refresh();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast.error('Model download failed', { description: msg });
    } finally {
      if (unlistenRef.current) {
        unlistenRef.current();
        unlistenRef.current = null;
      }
      setIsDownloading(false);
      setProgress(null);
    }
  }, [isDownloading, refresh]);

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-6 shadow-sm">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-lg font-semibold text-gray-900 mb-2 flex items-center gap-2">
            <Users className="w-5 h-5 text-blue-500" />
            Speaker Identification
          </h3>
          <p className="text-sm text-gray-600">
            Labels your transcript with <strong>Speaker 1/2/3…</strong> by analyzing voices in the
            recording. Runs entirely on-device. Open a meeting and click{' '}
            <strong>Speakers</strong> above the transcript to run it.
          </p>
        </div>
        {available !== null && (
          <span
            className={`flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-medium ${
              available ? 'bg-green-50 text-green-700' : 'bg-amber-50 text-amber-700'
            }`}
          >
            {available ? <CheckCircle2 className="w-3.5 h-3.5" /> : <AlertCircle className="w-3.5 h-3.5" />}
            {available ? 'Ready' : 'Models missing'}
          </span>
        )}
      </div>

      {available === true && (
        <p className="mt-3 text-sm text-gray-500">
          Models ship with the app — nothing to download.
        </p>
      )}

      {/* Repair path: only if the bundled models are somehow missing */}
      {available === false && !isDownloading && (
        <div className="mt-4 rounded-md bg-amber-50 p-4">
          <p className="text-sm text-amber-900 mb-3">
            The bundled speaker models couldn&apos;t be found. You can re-download them
            {downloadSize > 0 && <> (~{formatMB(downloadSize)})</>} from this app&apos;s GitHub
            release — files are verified with SHA-256.
          </p>
          <Button size="sm" onClick={handleDownload} className="bg-blue-600 text-white hover:bg-blue-700">
            <Download size={16} className="mr-1.5" />
            Re-download models
          </Button>
        </div>
      )}

      {/* Live progress */}
      {isDownloading && (
        <div className="mt-4 rounded-md border border-blue-200 bg-blue-50 p-4">
          <div className="flex items-center gap-2 text-sm font-medium text-blue-900">
            <Loader2 className="w-4 h-4 animate-spin" />
            {progress?.status === 'verifying'
              ? `Verifying ${progress.file}…`
              : progress?.file
                ? `Downloading ${progress.file} (${progress.file_index}/${progress.file_count})`
                : 'Starting download…'}
          </div>

          <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-blue-100">
            <div
              className="h-full bg-blue-600 transition-[width] duration-150"
              style={{ width: `${Math.max(2, progress?.percent ?? 0)}%` }}
            />
          </div>

          <div className="mt-1.5 flex justify-between text-xs text-blue-700">
            <span>
              {progress && progress.total > 0
                ? `${formatMB(progress.downloaded)} / ${formatMB(progress.total)}`
                : ''}
            </span>
            <span>{(progress?.percent ?? 0).toFixed(0)}%</span>
          </div>
        </div>
      )}

      {dir && (
        <div className="mt-4 p-3 border rounded-lg bg-gray-50">
          <div className="text-xs font-medium text-gray-700 mb-1 flex items-center gap-1.5">
            <FolderOpen className="w-3.5 h-3.5" />
            Model folder
          </div>
          <div className="text-xs text-gray-600 break-all font-mono">{dir}</div>
          <div className="mt-1.5 text-xs text-gray-500">
            Drop your own <code>segmentation-3.0-fp16.onnx</code>,{' '}
            <code>wespeaker-resnet34-LM.onnx</code> and <code>xvec_transform.npz</code> here to
            override the bundled models.
          </div>
        </div>
      )}

      <p className="mt-4 text-xs text-gray-400">
        Models: pyannote <code>segmentation-3.0</code> (MIT) · WeSpeaker ResNet34 (Apache-2.0) · VBx
        x-vector transform (Apache-2.0). Credit to their respective authors.
      </p>
    </div>
  );
}
