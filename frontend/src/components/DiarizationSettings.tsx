"use client"

import { Spinner } from '@/components/ui/spinner';
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
  Cpu,
  Sliders,
  ExternalLink,
  Check,
} from "lucide-react"
import { Button } from "./ui/button"
import { OPTIONAL_MODEL_PREFERENCES_CHANGED } from '@/lib/optional-model-activation';
import { useOptionalModelDownloads } from '@/contexts/OptionalModelDownloadsContext';
import { useI18n } from '@/i18n';

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
  const { t } = useI18n();
  const [status, setStatus] = useState<DiarizationEngineStatus | null>(null);
  const [isPyannoteDownloading, setIsDownloading] = useState(false);
  const { jobs, startDownload } = useOptionalModelDownloads();
  const nemotronJob = jobs.nemotron;
  const isNemotronDownloading = nemotronJob.status === 'downloading' || nemotronJob.status === 'activating';
  const isDownloading = isPyannoteDownloading || isNemotronDownloading || nemotronJob.status === 'uninstalling';
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
    if (nemotronJob.status === 'ready' || nemotronJob.status === 'idle' || nemotronJob.status === 'activation-error') refreshStatus();
  }, [nemotronJob.status, refreshStatus]);

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
      toast.success(t('models.engineSwitched', { engine: engine === 'nemotron' ? 'NVIDIA Nemotron-3' : 'Pyannote' }));
      refreshStatus();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast.error(t('models.failedToSwitchEngine'), { description: msg });
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
      toast.error(t('models.failedToUpdateConfiguration'), { description: msg });
    }
  };

  const handleDownload = useCallback(async (targetEngine?: string) => {
    if (isDownloading) return;
    const eng = targetEngine || status?.active_engine || 'pyannote';
    // Settings and onboarding share the same app-owned Nemotron job. Leaving
    // this page must not discard progress or create a second transfer owner.
    if (eng === 'nemotron') {
      startDownload('nemotron');
      return;
    }
    setIsDownloading(true);
    setProgress(null);
    let downloaded = false;

    try {
      unlistenRef.current = await listen<DownloadProgress>(
        'diarization-download-progress',
        (event) => setProgress(event.payload)
      );

      await invoke('download_diarization_models', { engine: eng });
      downloaded = true;
      toast.success(
        eng === 'nemotron' ? t('models.nemotronInstalled') : t('models.speakerModelsInstalled'),
        {
          description: t('models.speakersAvailable'),
        }
      );
      refreshStatus();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      downloaded ||= msg.startsWith('Model downloaded, but could not enable it:');
      toast.error(downloaded ? t('models.modelDownloadedNotEnabled') : t('models.modelDownloadFailed'), { description: msg });
      refreshStatus();
    } finally {
      if (unlistenRef.current) {
        unlistenRef.current();
        unlistenRef.current = null;
      }
      setIsDownloading(false);
      setProgress(null);
    }
  }, [isDownloading, status, refreshStatus, startDownload, t]);

  const handleOpenFolder = async () => {
    try {
      await invoke('open_diarization_model_directory');
    } catch (e) {
      toast.error(t('models.couldNotOpenFolder'), { description: String(e) });
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
    <div className="rounded-2xl border border-af-border bg-af-panel-2/40 p-5 text-af-text">
      {/* Title & Top Status Badge */}
      <div className="flex flex-wrap items-start justify-between gap-4 mb-4">
        <div className="min-w-0 flex-1 basis-64">
          <h3 className="text-[15px] font-semibold text-af-text mb-2 flex items-center gap-2">
            <Users className="w-5 h-5 text-af-accent" />
            {t('models.speakerIdentification')}
          </h3>
          <p className="text-sm text-af-text-2">
            {t('models.speakerIdDescriptionBefore')}
            <strong>{t('models.speakerIdExample')}</strong>
            {t('models.speakerIdDescriptionMiddle')}
            <strong>{t('models.speakersLabel')}</strong>
            {t('models.speakerIdDescriptionAfter')}
          </p>
        </div>
        {status !== null && (
          <span
            className={`flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-medium ${
              currentAvailable ? 'bg-af-success/10 text-af-success' : 'bg-af-warning/10 text-af-warning'
            }`}
          >
            {currentAvailable ? <CheckCircle2 className="w-3.5 h-3.5" /> : <AlertCircle className="w-3.5 h-3.5" />}
            {currentAvailable ? t('models.ready') : t('models.modelsMissing')}
          </span>
        )}
      </div>

      {/* Engine Selection: Pyannote vs Nemotron-3 */}
      <div className="mt-4 mb-5">
        <label className="text-[11px] font-semibold text-af-text-3 mb-2.5 block uppercase tracking-wider">
          {t('models.diarizationEngine')}
        </label>
        <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,16rem),1fr))] gap-3">
          {/* Pyannote card */}
          <button
            type="button"
            onClick={() => handleSelectEngine('pyannote')}
            disabled={isSwitching || isDownloading}
            className={`group flex min-w-0 flex-col items-stretch p-4 rounded-xl text-left cursor-pointer relative disabled:cursor-default ${
              isPyannote
                ? 'af-select-card-active-blue'
                : 'af-select-card'
            }`}
          >
            <div className="flex flex-wrap items-center justify-between gap-2 mb-2.5">
              <div className="flex min-w-0 flex-1 basis-44 items-center gap-2.5">
                <span className={`shrink-0 p-2 rounded-lg transition-colors ${
                  isPyannote
                    ? 'bg-af-accent text-af-on-accent'
                    : 'bg-af-active text-af-text-2 group-hover:text-af-text'
                }`}>
                  <Users className="w-4 h-4" />
                </span>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold text-af-text">
                      Pyannote
                    </span>
                    {status?.pyannote_available && (
                      <span className="rounded-full bg-af-success/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-af-success">
                        {t('models.ready')}
                      </span>
                    )}
                  </div>
                  <span className="text-[11px] text-af-text-3 font-medium">
                    {t('models.clusteringDiarization')}
                  </span>
                </div>
              </div>
              <div className="ml-auto flex shrink-0 items-center gap-2 whitespace-nowrap">
                {isPyannote ? (
                  <span className="inline-flex items-center gap-1 rounded-full border border-af-accent/40 bg-af-accent/10 px-2.5 py-1 text-[11px] font-medium text-af-accent">
                    <Check className="w-3.5 h-3.5" /> {t('models.active')}
                  </span>
                ) : (
                  <span className="inline-flex items-center rounded-full border border-af-border-strong px-2.5 py-1 text-[11px] font-medium text-af-text-2 transition-colors group-hover:text-af-text">
                    {t('models.select')}
                  </span>
                )}
              </div>
            </div>
            <p className="text-xs text-af-text-2 leading-relaxed mt-1">
              {t('models.pyannoteDescription')}
            </p>
            <div className="mt-3.5 pt-2.5 border-t border-af-border flex flex-wrap items-center justify-between gap-2 text-[11px]">
              <span className="px-2 py-0.5 rounded bg-af-panel text-af-text-3 border border-af-border font-medium">
                {t('models.bundledWithApp')}
              </span>
              <span className="font-medium text-af-accent px-2 py-0.5 rounded bg-af-accent/10">
                  {t('models.localCpu')}
              </span>
            </div>
          </button>

          {/* Nemotron-3 card */}
          <button
            type="button"
            onClick={() => handleSelectEngine('nemotron')}
            disabled={isSwitching || isDownloading}
            className={`group flex min-w-0 flex-col items-stretch p-4 rounded-xl text-left cursor-pointer relative disabled:cursor-default ${
              isNemotron
                ? 'af-select-card-active-purple'
                : 'af-select-card'
            }`}
          >
            <div className="flex flex-wrap items-center justify-between gap-2 mb-2.5">
              <div className="flex min-w-0 flex-1 basis-44 items-center gap-2.5">
                <span className={`shrink-0 p-2 rounded-lg transition-colors ${
                  isNemotron
                    ? 'bg-af-accent text-af-on-accent'
                    : 'bg-af-active text-af-text-2 group-hover:text-af-text'
                }`}>
                  <Cpu className="w-4 h-4" />
                </span>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold text-af-text">
                      NVIDIA Nemotron-3
                    </span>
                    {status?.nemotron_available && !isNemotronDownloading && (
                      <span className="rounded-full bg-af-success/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-af-success">
                        {t('models.ready')}
                      </span>
                    )}
                  </div>
                  <span className="text-[11px] text-af-text-3 font-medium">
                    {t('models.sortformerV3Neural')}
                  </span>
                </div>
              </div>
              <div className="ml-auto flex shrink-0 items-center gap-2 whitespace-nowrap">
                {isNemotron ? (
                  <span className="inline-flex items-center gap-1 rounded-full border border-af-accent/40 bg-af-accent/10 px-2.5 py-1 text-[11px] font-medium text-af-accent">
                    <Check className="w-3.5 h-3.5" /> {t('models.active')}
                  </span>
                ) : (
                  <span className="inline-flex items-center rounded-full border border-af-border-strong px-2.5 py-1 text-[11px] font-medium text-af-text-2 transition-colors group-hover:text-af-text">
                    {t('models.select')}
                  </span>
                )}
              </div>
            </div>
            <p className="text-xs text-af-text-2 leading-relaxed mt-1">
                {t('models.nemotronCardDescription')}
            </p>
            <div className="mt-3.5 pt-2.5 border-t border-af-border flex flex-wrap items-center justify-between gap-2 text-[11px]">
              <span className="px-2 py-0.5 rounded bg-af-panel text-af-text-3 border border-af-border font-medium">
                Sortformer v3
              </span>
              <span className="font-medium text-af-accent px-2 py-0.5 rounded bg-af-accent/10">
                {t('models.overlapDetection')}
              </span>
            </div>
            {isNemotronDownloading && (
              <div className="mt-4 border-t border-af-border pt-3">
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs font-medium text-af-text">
                  <span>{nemotronJob.status === 'activating' ? t('models.enablingModel') : nemotronJob.detail ?? t('models.downloadingEllipsis')}</span>
                  <span className="tabular-nums">{Math.round(nemotronJob.progress)}%</span>
                </div>
                {nemotronJob.file && <p className="mt-1 break-all text-[11px] text-af-text-3">{nemotronJob.file}</p>}
                {nemotronJob.totalBytes !== undefined && nemotronJob.totalBytes > 0 && nemotronJob.downloadedBytes !== undefined && (
                  <p className="mt-1 text-[11px] text-af-text-3">
                    {t('models.currentFile', {
                      downloaded: (nemotronJob.downloadedBytes / 1024 / 1024).toFixed(1),
                      total: (nemotronJob.totalBytes / 1024 / 1024).toFixed(1),
                    })}
                  </p>
                )}
                <div role="progressbar" aria-label={t('models.nemotronDownloadProgress')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={nemotronJob.progress} className="mt-2 h-1.5 overflow-hidden rounded-full bg-af-hover">
                  <div className="h-full rounded-full bg-af-accent transition-[width] duration-150" style={{ width: `${nemotronJob.progress}%` }} />
                </div>
              </div>
            )}
            {nemotronJob.error && <p className="mt-3 break-words text-xs text-af-danger">{nemotronJob.error}</p>}
          </button>
        </div>
      </div>

      {/* Engine Status Details */}
      {isPyannote && (
        <>
          {status?.pyannote_available === true && (
            <p className="mt-2 text-sm text-af-text-3">
              {t('models.modelsShipWithApp')}
            </p>
          )}

          {/* Missing Pyannote models */}
          {status?.pyannote_available === false && !isDownloading && (
            <div className="mt-4 rounded-xl bg-af-warning/10 p-4">
              <p className="text-sm text-af-text mb-3 leading-relaxed">
                {downloadBytes > 0
                  ? t('models.bundledModelsMissingWithSize', { size: formatMB(downloadBytes) })
                  : t('models.bundledModelsMissing')}
              </p>
              <Button size="sm" onClick={() => handleDownload('pyannote')} className="bg-af-accent text-af-on-accent hover:bg-af-accent-hover">
                <Download size={16} className="mr-1.5" />
                {t('models.redownloadModels')}
              </Button>
            </div>
          )}
        </>
      )}

      {isNemotron && (
        <div className="space-y-4">
          {status?.nemotron_available === true && (
            <div className="text-sm text-af-text-2 flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4 text-af-success" />
              <span>{t('models.nemotronReady')}</span>
            </div>
          )}

          {/* Missing Nemotron models */}
          {status?.nemotron_available === false && !isDownloading && (
            <div className="mt-4 rounded-xl bg-af-warning/10 p-4">
              <p className="text-sm text-af-text mb-3 leading-relaxed">
                {t('models.nemotronMissingDescription', { size: formatMB(downloadBytes) })}
              </p>
              <Button size="sm" onClick={() => handleDownload('nemotron')} className="h-auto min-h-9 whitespace-normal bg-af-accent text-af-on-accent hover:bg-af-accent-hover">
                <Download size={16} className="mr-1.5" />
                {t('models.downloadNemotronModels', { size: formatMB(downloadBytes) })}
              </Button>
            </div>
          )}

          {/* Nemotron Fine-tuning / Configuration */}
          <div className="mt-3.5 p-4 border border-af-border rounded-xl bg-af-panel-2 space-y-4">
            <div className="text-[11px] font-semibold text-af-text-3 flex items-center gap-2 uppercase tracking-wider">
              <Sliders className="w-4 h-4 text-af-accent" />
              {t('models.nemotronDetectionSettings')}
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-xs font-medium text-af-text-2">{t('models.speakerChannels')}</span>
                  <span className="text-xs font-mono font-medium px-2 py-0.5 rounded-md bg-af-active text-af-text tabular-nums">
                    8
                  </span>
                </div>
                <span className="text-[11px] text-af-text-3 block mt-1">
                  {t('models.nemotronChannelsDescription')}
                </span>
              </div>
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-xs font-medium text-af-text-2">{t('models.speechThreshold')}</span>
                  <span className="text-xs font-mono font-medium px-2 py-0.5 rounded-md bg-af-active text-af-text tabular-nums">
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
                  className="af-volume"
                  style={{ '--fill': `${(((status?.nemotron_threshold ?? 0.50) - 0.10) / 0.80) * 100}%` } as React.CSSProperties}
                />
                <span className="text-[11px] text-af-text-3 block mt-1">
                  {t('models.speechThresholdDescription')}
                </span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Live Download Progress */}
      {isPyannoteDownloading && (
        <div className="mt-4 rounded-xl border border-af-accent/40 bg-af-accent/10 p-4">
          <div className="flex items-center gap-2 text-sm font-medium text-af-accent">
            <Spinner className="w-4 h-4" />
            {progress?.status === 'verifying'
              ? t('models.verifyingFile', { file: progress.file })
              : progress?.file
                ? t('models.downloadingFile', { file: progress.file, index: progress.file_index, count: progress.file_count })
                : t('models.startingDownload')}
          </div>

          <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-af-accent/10">
            <div
              className="h-full bg-af-accent transition-[width] duration-150"
              style={{ width: `${Math.max(2, progress?.percent ?? 0)}%` }}
            />
          </div>

          <div className="mt-1.5 flex justify-between text-xs text-af-accent">
            <span>
              {progress && progress.total > 0
                ? `${formatMB(progress.downloaded)} / ${formatMB(progress.total)}`
                : ''}
            </span>
            <span className="font-semibold tabular-nums">{(progress?.percent ?? 0).toFixed(0)}%</span>
          </div>
        </div>
      )}

      {/* Model folder info */}
      {status?.model_dir && (
        <div className="mt-4 p-3 border border-af-border rounded-xl bg-af-panel-2">
          <div className="flex items-center justify-between mb-1.5">
            <div className="text-xs font-medium text-af-text-2 flex items-center gap-1.5">
              <FolderOpen className="w-3.5 h-3.5" />
              {t('models.modelDirectory')}
            </div>
            <button
              type="button"
              onClick={handleOpenFolder}
              className="text-xs text-af-accent hover:text-af-accent-hover flex items-center gap-1 font-medium cursor-pointer transition-colors"
            >
              <ExternalLink className="w-3.5 h-3.5" />
              {t('models.openInExplorer')}
            </button>
          </div>
          <div className="text-xs text-af-text-2 break-all font-mono p-2 rounded-lg bg-af-panel border border-af-border">
            {status.model_dir}
          </div>
          <div className="mt-2 text-xs text-af-text-3 leading-relaxed">
            {isPyannote ? (
              <>
                {t('models.dropOwnModelsPrefix')}<code>segmentation-3.0-fp16.onnx</code>{t('models.dropModelsSeparator')}
                <code>wespeaker-resnet34-LM.onnx</code>{t('models.dropModelsAnd')}<code>xvec_transform.npz</code>{t('models.dropPyannoteModelsSuffix')}
              </>
            ) : (
              <>
                {t('models.dropOwnModelsPrefix')}<code>nemotron3_diar_v3.onnx</code>{t('models.dropModelsAnd')}<code>nemo128.onnx</code>{t('models.dropNemotronModelsSuffix')}
              </>
            )}
          </div>
        </div>
      )}

      {/* Attribution footer */}
      <p className="mt-4 text-xs text-af-text-4 leading-relaxed">
        {isPyannote ? (
          <>
            {t('models.attributionPyannotePrefix')}<code>segmentation-3.0</code>{t('models.attributionPyannoteSuffix')}
          </>
        ) : (
          <>
            {t('models.attributionNemotron')}
          </>
        )}
      </p>
    </div>
  );
}
