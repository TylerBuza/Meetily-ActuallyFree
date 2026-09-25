"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { invoke } from "@tauri-apps/api/core"
import { listen, UnlistenFn } from "@tauri-apps/api/event"
import { toast } from "sonner"
import {
  Users,
  CheckCircle2,
  AlertCircle,
  FolderOpen,
  Download,
  Loader2,
  Cpu,
  Sliders,
  ExternalLink,
  Check,
} from "lucide-react"
import { Button } from "./ui/button"
import { OPTIONAL_MODEL_PREFERENCES_CHANGED } from '@/lib/optional-model-activation';

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

interface DiarizationEngineStatus {
  active_engine: string;
  pyannote_available: boolean;
  nemotron_available: boolean;
  current_available: boolean;
  model_dir: string;
  nemotron_max_speakers: number;
  nemotron_threshold: number;
  pyannote_threshold: number;
  nemotron_download_size: number;
  pyannote_download_size: number;
}

function formatMB(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 MB';
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Speaker diarization status and configuration panel.
 * Supports choosing between Pyannote (bundled/lightweight) and NVIDIA Nemotron-3 (Sortformer v3).
 * Fully themed for both light and dark mode using Meetily semantic variables.
 */
export function DiarizationSettings() {
  const [status, setStatus] = useState<DiarizationEngineStatus | null>(null);
  const [isDownloading, setIsDownloading] = useState(false);
  const [progress, setProgress] = useState<DownloadProgress | null>(null);
  const [isSwitching, setIsSwitching] = useState(false);
  const unlistenRef = useRef<UnlistenFn | null>(null);
  const statusRevision = useRef(0);

  const refreshStatus = useCallback(() => {
    const revision = ++statusRevision.current;
    invoke<DiarizationEngineStatus>('diarization_get_status')
      .then(value => { if (revision === statusRevision.current) setStatus(value); })
      .catch((e) => {
        console.error('Failed to get diarization status:', e);
      });
  }, []);

  useEffect(() => {
    refreshStatus();
    window.addEventListener(OPTIONAL_MODEL_PREFERENCES_CHANGED, refreshStatus);
    return () => window.removeEventListener(OPTIONAL_MODEL_PREFERENCES_CHANGED, refreshStatus);
  }, [refreshStatus]);

  useEffect(() => {
    let disposed = false;
    let stop: UnlistenFn | undefined;
    void listen('diarization-engine-changed', refreshStatus).then(unlisten => {
      if (disposed) unlisten(); else stop = unlisten;
    }).catch(error => console.error('Could not listen for engine changes:', error));
    return () => { disposed = true; stop?.(); };
  }, [refreshStatus]);

  // Clean up download progress listener on unmount
  useEffect(() => {
    return () => {
      if (unlistenRef.current) unlistenRef.current();
    };
  }, []);

  const handleSelectEngine = async (engine: 'pyannote' | 'nemotron') => {
    if (isSwitching || status?.active_engine === engine) return;
    setIsSwitching(true);
    try {
      await invoke('set_diarization_engine', { engine });
      window.dispatchEvent(new Event(OPTIONAL_MODEL_PREFERENCES_CHANGED));
      toast.success(`Diarization engine switched to ${engine === 'nemotron' ? 'NVIDIA Nemotron-3' : 'Pyannote'}`);
      refreshStatus();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast.error('Failed to switch engine', { description: msg });
    } finally {
      setIsSwitching(false);
    }
  };

  const handleUpdateConfig = async (updates: {
    nemotronMaxSpeakers?: number;
    nemotronThreshold?: number;
    pyannoteThreshold?: number;
  }) => {
    if (!status) return;
    try {
      await invoke('set_diarization_config', {
        engine: status.active_engine,
        nemotronMaxSpeakers: updates.nemotronMaxSpeakers ?? status.nemotron_max_speakers,
        nemotronThreshold: updates.nemotronThreshold ?? status.nemotron_threshold,
        pyannoteThreshold: updates.pyannoteThreshold ?? status.pyannote_threshold,
      });
      refreshStatus();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast.error('Failed to update configuration', { description: msg });
    }
  };

  const handleDownload = useCallback(async (targetEngine?: string) => {
    if (isDownloading) return;
    setIsDownloading(true);
    setProgress(null);
    const eng = targetEngine || status?.active_engine || 'pyannote';
    let downloaded = false;

    try {
      unlistenRef.current = await listen<DownloadProgress>(
        'diarization-download-progress',
        (event) => setProgress(event.payload)
      );

      await invoke('download_diarization_models', { engine: eng });
      downloaded = true;
      toast.success(
        eng === 'nemotron' ? 'Nemotron-3 installed and enabled' : 'Speaker models installed',
        {
          description: 'You can now use Speakers on any meeting with a recording.',
        }
      );
      refreshStatus();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      downloaded ||= msg.startsWith('Model downloaded, but could not enable it:');
      toast.error(downloaded ? 'Model downloaded, but could not enable it' : 'Model download failed', { description: msg });
      refreshStatus();
    } finally {
      if (unlistenRef.current) {
        unlistenRef.current();
        unlistenRef.current = null;
      }
      setIsDownloading(false);
      setProgress(null);
    }
  }, [isDownloading, status, refreshStatus]);

  const handleOpenFolder = async () => {
    try {
      await invoke('open_diarization_model_directory');
    } catch (e) {
      toast.error('Could not open folder', { description: String(e) });
    }
  };

  const activeEngine = status?.active_engine ?? 'pyannote';
  const isPyannote = activeEngine === 'pyannote';
  const isNemotron = activeEngine === 'nemotron';

  const currentAvailable = isPyannote
    ? status?.pyannote_available ?? false
    : status?.nemotron_available ?? false;

  const downloadBytes = isPyannote
    ? status?.pyannote_download_size ?? 0
    : status?.nemotron_download_size ?? 0;

  return (
    <div className="rounded-xl border border-[var(--af-border)] bg-[var(--af-panel)] p-5 text-[var(--af-text)] shadow-sm sm:p-6 transition-colors">
      {/* Title & Top Status Badge */}
      <div className="flex items-start justify-between gap-4 mb-4">
        <div>
          <h3 className="text-lg font-semibold text-[var(--af-text)] mb-2 flex items-center gap-2">
            <Users className="w-5 h-5 text-blue-500" />
            Speaker Identification
          </h3>
          <p className="text-sm text-[var(--af-text-2)] leading-relaxed">
            Labels your transcript with <strong>Speaker 1/2/3…</strong> by analyzing voices in the
            recording. Runs entirely on-device. Open a meeting and click{' '}
            <strong>Speakers</strong> above the transcript to run it.
          </p>
        </div>
        {status !== null && (
          <span
            className={`flex items-center gap-1.5 whitespace-nowrap rounded-full px-3 py-1 text-xs font-medium border transition-colors ${
              currentAvailable
                ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                : 'border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400'
            }`}
          >
            {currentAvailable ? <CheckCircle2 className="w-3.5 h-3.5" /> : <AlertCircle className="w-3.5 h-3.5" />}
            {currentAvailable ? 'Ready' : 'Models missing'}
          </span>
        )}
      </div>

      {/* Engine Selection: Pyannote vs Nemotron-3 */}
      <div className="mt-4 mb-5">
        <label className="text-xs font-bold text-slate-700 dark:text-slate-300 mb-2.5 block uppercase tracking-wider">
          Diarization Engine
        </label>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {/* Pyannote card */}
          <button
            type="button"
            onClick={() => handleSelectEngine('pyannote')}
            disabled={isSwitching || isDownloading}
            className={`group p-4 rounded-xl text-left transition-all cursor-pointer relative ${
              isPyannote
                ? 'af-select-card-active-blue'
                : 'af-select-card'
            }`}
          >
            <div className="flex items-center justify-between mb-2.5">
              <div className="flex items-center gap-2.5">
                <span className={`p-2 rounded-lg transition-colors ${
                  isPyannote
                    ? 'bg-blue-600 text-white shadow-md shadow-blue-500/30'
                    : 'bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-200 group-hover:bg-blue-100 dark:group-hover:bg-blue-900/40 group-hover:text-blue-600 dark:group-hover:text-blue-400'
                }`}>
                  <Users className="w-4 h-4" />
                </span>
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-bold text-slate-900 dark:text-white text-base">
                      Pyannote
                    </span>
                    {status?.pyannote_available && (
                      <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full border border-emerald-500/40 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300">
                        Ready
                      </span>
                    )}
                  </div>
                  <span className="text-[11px] text-blue-600 dark:text-blue-400 font-medium">
                    Clustering Diarization
                  </span>
                </div>
              </div>
              <div className="flex items-center gap-2">
                {isPyannote ? (
                  <span className="inline-flex items-center gap-1 text-[11px] font-bold px-2.5 py-1 rounded-full bg-blue-600 text-white shadow-sm ring-2 ring-blue-400/30">
                    <Check className="w-3.5 h-3.5 stroke-[3]" /> Active
                  </span>
                ) : (
                  <span className="inline-flex items-center text-[11px] font-medium px-2.5 py-1 rounded-full border border-slate-300 dark:border-slate-600 text-slate-600 dark:text-slate-300 group-hover:border-blue-400 group-hover:text-blue-600 dark:group-hover:border-blue-400 dark:group-hover:text-blue-300 transition-colors">
                    Select
                  </span>
                )}
              </div>
            </div>
            <p className="text-xs text-slate-600 dark:text-slate-200 leading-relaxed font-normal mt-1">
              Bundled segmentation-3.0 with WeSpeaker ResNet34 embeddings & agglomerative clustering.
            </p>
            <div className="mt-3.5 pt-2.5 border-t border-slate-200/90 dark:border-slate-700 flex items-center justify-between text-[11px]">
              <span className="px-2 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-slate-700 font-medium">
                Bundled with app
              </span>
              <span className="font-semibold text-blue-600 dark:text-blue-400 px-2 py-0.5 rounded bg-blue-500/10 dark:bg-blue-500/20 border border-blue-500/30">
                  Local CPU
              </span>
            </div>
          </button>

          {/* Nemotron-3 card */}
          <button
            type="button"
            onClick={() => handleSelectEngine('nemotron')}
            disabled={isSwitching || isDownloading}
            className={`group p-4 rounded-xl text-left transition-all cursor-pointer relative ${
              isNemotron
                ? 'af-select-card-active-purple'
                : 'af-select-card'
            }`}
          >
            <div className="flex items-center justify-between mb-2.5">
              <div className="flex items-center gap-2.5">
                <span className={`p-2 rounded-lg transition-colors ${
                  isNemotron
                    ? 'bg-purple-600 text-white shadow-md shadow-purple-500/30'
                    : 'bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-200 group-hover:bg-purple-100 dark:group-hover:bg-purple-900/40 group-hover:text-purple-600 dark:group-hover:text-purple-400'
                }`}>
                  <Cpu className="w-4 h-4" />
                </span>
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-bold text-slate-900 dark:text-white text-base">
                      NVIDIA Nemotron-3
                    </span>
                    {status?.nemotron_available && (
                      <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full border border-emerald-500/40 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300">
                        Ready
                      </span>
                    )}
                  </div>
                  <span className="text-[11px] text-purple-600 dark:text-purple-400 font-medium">
                    Sortformer v3 Neural
                  </span>
                </div>
              </div>
              <div className="flex items-center gap-2">
                {isNemotron ? (
                  <span className="inline-flex items-center gap-1 text-[11px] font-bold px-2.5 py-1 rounded-full bg-purple-600 text-white shadow-sm ring-2 ring-purple-400/30">
                    <Check className="w-3.5 h-3.5 stroke-[3]" /> Active
                  </span>
                ) : (
                  <span className="inline-flex items-center text-[11px] font-medium px-2.5 py-1 rounded-full border border-slate-300 dark:border-slate-600 text-slate-600 dark:text-slate-300 group-hover:border-purple-400 group-hover:text-purple-600 dark:group-hover:border-purple-400 dark:group-hover:text-purple-300 transition-colors">
                    Select
                  </span>
                )}
              </div>
            </div>
            <p className="text-xs text-slate-600 dark:text-slate-200 leading-relaxed font-normal mt-1">
                Post-call speaker detection with overlapping speech support. Windows uses DirectML GPU acceleration when available, with CPU fallback.
            </p>
            <div className="mt-3.5 pt-2.5 border-t border-slate-200/90 dark:border-slate-700 flex items-center justify-between text-[11px]">
              <span className="px-2 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-slate-700 font-medium">
                Sortformer v3
              </span>
              <span className="font-semibold text-purple-600 dark:text-purple-400 px-2 py-0.5 rounded bg-purple-500/10 dark:bg-purple-500/20 border border-purple-500/30">
                Overlap detection
              </span>
            </div>
          </button>
        </div>
      </div>

      {/* Engine Status Details */}
      {isPyannote && (
        <>
          {status?.pyannote_available === true && (
            <p className="mt-2 text-sm text-[var(--af-text-2)]">
              Models ship with the app — nothing to download.
            </p>
          )}

          {/* Missing Pyannote models */}
          {status?.pyannote_available === false && !isDownloading && (
            <div className="mt-4 rounded-xl bg-amber-500/10 border border-amber-500/30 p-4">
              <p className="text-sm text-amber-800 dark:text-amber-200 mb-3 leading-relaxed">
                The bundled speaker models couldn&apos;t be found. You can re-download them
                {downloadBytes > 0 && <> (~{formatMB(downloadBytes)})</>} from this app&apos;s GitHub
                release — files are verified with SHA-256.
              </p>
              <Button size="sm" onClick={() => handleDownload('pyannote')} className="bg-blue-600 text-white hover:bg-blue-700">
                <Download size={16} className="mr-1.5" />
                Re-download models
              </Button>
            </div>
          )}
        </>
      )}

      {isNemotron && (
        <div className="space-y-4">
          {status?.nemotron_available === true && (
            <div className="text-sm text-[var(--af-text-2)] flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4 text-emerald-500" />
              <span>Nemotron-3 Sortformer model ready on-device.</span>
            </div>
          )}

          {/* Missing Nemotron models */}
          {status?.nemotron_available === false && !isDownloading && (
            <div className="mt-4 rounded-xl bg-amber-500/10 border border-amber-500/30 p-4">
              <p className="text-sm text-amber-800 dark:text-amber-200 mb-3 leading-relaxed">
                The Nemotron-3 Diarization model (~{formatMB(downloadBytes)}) runs fully on-device.
                Download once to install the SHA-256 verified model and its license.
              </p>
              <Button size="sm" onClick={() => handleDownload('nemotron')} className="bg-purple-600 text-white hover:bg-purple-700">
                <Download size={16} className="mr-1.5" />
                Download Nemotron-3 models (~{formatMB(downloadBytes)})
              </Button>
            </div>
          )}

          {/* Nemotron Fine-tuning / Configuration */}
          <div className="mt-3.5 p-4 sm:p-5 border border-purple-400/40 dark:border-purple-500/40 rounded-xl bg-purple-50/40 dark:bg-purple-950/25 space-y-4 transition-colors">
            <div className="text-xs font-bold text-slate-800 dark:text-slate-200 flex items-center gap-2 uppercase tracking-wide">
              <Sliders className="w-4 h-4 text-purple-600 dark:text-purple-400" />
              Nemotron-3 Detection Settings
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-xs font-semibold text-slate-700 dark:text-slate-300">Speaker channels</span>
                  <span className="text-xs font-mono font-bold px-2.5 py-0.5 rounded-md border border-purple-300 dark:border-purple-600/80 bg-white dark:bg-slate-900 text-purple-700 dark:text-purple-300 shadow-xs">
                    8
                  </span>
                </div>
                <span className="text-[11px] text-slate-500 dark:text-slate-400 block mt-1">
                  Nemotron automatically detects up to 8 speakers. Live speaker labels use Pyannote; Nemotron refines labels after recording.
                </span>
              </div>
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-xs font-semibold text-slate-700 dark:text-slate-300">Speech Threshold</span>
                  <span className="text-xs font-mono font-bold px-2.5 py-0.5 rounded-md border border-purple-300 dark:border-purple-600/80 bg-white dark:bg-slate-900 text-purple-700 dark:text-purple-300 shadow-xs">
                    {(status?.nemotron_threshold ?? 0.50).toFixed(2)}
                  </span>
                </div>
                <input
                  type="range"
                  min={0.10}
                  max={0.90}
                  step={0.05}
                  value={status?.nemotron_threshold ?? 0.50}
                  onChange={(e) => handleUpdateConfig({ nemotronThreshold: parseFloat(e.target.value) })}
                  className="w-full accent-purple-600 dark:accent-purple-400 cursor-pointer"
                />
                <span className="text-[11px] text-slate-500 dark:text-slate-400 block mt-1">
                  Sensitivity for active speech frames (default: 0.50).
                </span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Live Download Progress */}
      {isDownloading && (
        <div className="mt-4 rounded-xl border border-blue-500/30 bg-blue-500/10 dark:bg-blue-950/30 p-4 text-[var(--af-text)]">
          <div className="flex items-center gap-2 text-sm font-medium text-slate-900 dark:text-white">
            <Loader2 className="w-4 h-4 animate-spin text-blue-500" />
            {progress?.status === 'verifying'
              ? `Verifying ${progress.file}…`
              : progress?.file
                ? `Downloading ${progress.file} (${progress.file_index}/${progress.file_count})`
                : 'Starting download…'}
          </div>

          <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800 border border-slate-300 dark:border-slate-700">
            <div
              className="h-full bg-blue-600 transition-[width] duration-150"
              style={{ width: `${Math.max(2, progress?.percent ?? 0)}%` }}
            />
          </div>

          <div className="mt-1.5 flex justify-between text-xs text-slate-600 dark:text-slate-300">
            <span>
              {progress && progress.total > 0
                ? `${formatMB(progress.downloaded)} / ${formatMB(progress.total)}`
                : ''}
            </span>
            <span className="font-semibold text-blue-600 dark:text-blue-400">{(progress?.percent ?? 0).toFixed(0)}%</span>
          </div>
        </div>
      )}

      {/* Model folder info */}
      {status?.model_dir && (
        <div className="mt-4 p-4 border border-slate-200 dark:border-slate-700 rounded-xl bg-slate-50/70 dark:bg-slate-900/60 text-[var(--af-text)] transition-colors">
          <div className="flex items-center justify-between mb-1.5">
            <div className="text-xs font-bold text-slate-800 dark:text-slate-200 flex items-center gap-1.5">
              <FolderOpen className="w-4 h-4 text-blue-500" />
              Model Directory
            </div>
            <button
              type="button"
              onClick={handleOpenFolder}
              className="text-xs text-blue-600 dark:text-blue-400 hover:underline flex items-center gap-1 font-semibold cursor-pointer"
            >
              <ExternalLink className="w-3.5 h-3.5" />
              Open in Explorer
            </button>
          </div>
          <div className="text-xs text-slate-700 dark:text-slate-200 break-all font-mono p-2.5 rounded-lg bg-white dark:bg-[#0c1017] border border-slate-200 dark:border-slate-800 shadow-xs">
            {status.model_dir}
          </div>
          <div className="mt-2 text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
            {isPyannote ? (
              <>
                Drop your own <code>segmentation-3.0-fp16.onnx</code>,{' '}
                <code>wespeaker-resnet34-LM.onnx</code> and <code>xvec_transform.npz</code> here to
                override the bundled models.
              </>
            ) : (
              <>
                Drop your own <code>nemotron3_diar_v3.onnx</code> and <code>nemo128.onnx</code> here to
                override the downloaded models.
              </>
            )}
          </div>
        </div>
      )}

      {/* Attribution footer */}
      <p className="mt-4 text-xs text-[var(--af-text-3)] leading-relaxed">
        {isPyannote ? (
          <>
            Models: pyannote <code>segmentation-3.0</code> (MIT) · WeSpeaker ResNet34 (Apache-2.0) · VBx
            x-vector transform (Apache-2.0). Credit to their respective authors.
          </>
        ) : (
          <>
            Models: NVIDIA Nemotron-3 Diarization (Sortformer v3) · NeMo 128 Mel-spectrogram. Credit to
            NVIDIA Corporation.
          </>
        )}
      </p>
    </div>
  );
}
