'use client';

/**
 * Settings → Local stack. Live snapshot of what is loaded on this machine:
 * Whisper/Parakeet STT, disk use, idle unload, free-all memory.
 */

import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'sonner';
import { Cpu, HardDrive, RefreshCw, Trash2, Zap, Shield, Network } from 'lucide-react';
import {
  formatWhisperBackend,
  getWhisperBackend,
  type TranscriptionAccelerationStatus,
} from '@/lib/transcription-acceleration';
import { tNow, useI18n } from '@/i18n';

type StackStatus = TranscriptionAccelerationStatus & {
  recording: boolean;
  whisper: { loaded: boolean; model: string | null };
  parakeet: { loaded: boolean; model: string | null; backend: 'CPU' | 'DirectML' };
  sttIdleUnloadSecs: number;
  llmIdleUnloadSecs: number;
  sttLastUnloadSecs?: number;
  llmLastUnloadSecs?: number;
  modelsDirBytes?: number;
  dataDirBytes?: number;
  modelsDir?: string;
  vramHintMb?: number;
  networkPolicy?: string;
  networkNote?: string;
};

function Pill({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
        ok
          ? 'bg-af-success/15 text-af-success'
          : 'bg-[var(--af-panel-2)] text-[var(--af-text-3)]'
      }`}
    >
      {label}
    </span>
  );
}

function formatBytes(n?: number): string {
  if (n == null || n <= 0) return '—';
  const gb = n / (1024 ** 3);
  if (gb >= 1) return `${gb.toFixed(2)} GB`;
  const mb = n / (1024 ** 2);
  return `${mb.toFixed(0)} MB`;
}

function formatAgo(unixSecs?: number): string {
  if (!unixSecs) return tNow('models.agoNever');
  const ago = Math.max(0, Math.floor(Date.now() / 1000) - unixSecs);
  if (ago < 60) return tNow('models.agoSeconds', { seconds: ago });
  if (ago < 3600) return tNow('models.agoMinutes', { minutes: Math.floor(ago / 60) });
  if (ago < 86400) return tNow('models.agoHours', { hours: Math.floor(ago / 3600) });
  return tNow('models.agoDays', { days: Math.floor(ago / 86400) });
}

export function LocalStackStatus() {
  const { t } = useI18n();
  const [status, setStatus] = useState<StackStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const whisperBackend = getWhisperBackend(status);
  const whisperBackendLabel = whisperBackend
    ? formatWhisperBackend(whisperBackend)
    : t('models.detecting');
  const parakeetBackend = status?.parakeet.backend ?? 'CPU';

  const refresh = useCallback(async () => {
    try {
      const s = await invoke<StackStatus>('get_local_stack_status');
      setStatus(s);
    } catch (e) {
      console.error('get_local_stack_status failed', e);
      toast.error(t('models.couldNotReadLocalStackStatus'));
    }
  }, [t]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => clearInterval(timer);
  }, [refresh]);

  const unloadStt = async () => {
    setBusy(true);
    try {
      await invoke('force_unload_stt_models');
      toast.success(t('models.sttModelsUnloaded'));
      await refresh();
    } catch (e) {
      toast.error(typeof e === 'string' ? e : t('models.unloadFailed'));
    } finally {
      setBusy(false);
    }
  };

  const freeAll = async () => {
    setBusy(true);
    try {
      await invoke('force_unload_all_models');
      toast.success(t('models.freedMemory'));
      await refresh();
    } catch (e) {
      toast.error(typeof e === 'string' ? e : t('models.freeAllFailed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-base font-semibold text-[var(--af-text)]">{t('models.localStackTitle')}</h3>
        <p className="mt-1 text-sm text-[var(--af-text-3)]">
          {t('models.localStackDescription')}
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-2xl border border-af-border bg-af-panel-2/40 p-4">
          <div className="mb-2 flex items-center gap-2 text-sm font-medium text-[var(--af-text)]">
            <Zap size={16} className="text-af-warning" /> {t('models.liveStt')}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Pill
              ok={!!status?.parakeet.loaded}
              label={status?.parakeet.loaded ? t('models.loaded') : t('models.unloaded')}
            />
            <Pill ok={parakeetBackend === 'DirectML'} label={parakeetBackend === 'DirectML' ? t('models.directMlEncoder') : 'CPU'} />
            {status?.parakeet.model && (
              <span className="text-xs text-[var(--af-text-2)]">{status.parakeet.model}</span>
            )}
          </div>
        </div>

        <div className="rounded-2xl border border-af-border bg-af-panel-2/40 p-4">
          <div className="mb-2 flex items-center gap-2 text-sm font-medium text-[var(--af-text)]">
            <Cpu size={16} className="text-af-accent" /> {t('models.postCallStt')}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Pill
              ok={!!status?.whisper.loaded}
              label={status?.whisper.loaded ? t('models.loaded') : t('models.unloaded')}
            />
            <Pill ok={whisperBackend != null && whisperBackend !== 'CPU'} label={whisperBackendLabel} />
            {status?.whisper.model && (
              <span className="text-xs text-[var(--af-text-2)]">{status.whisper.model}</span>
            )}
          </div>
        </div>

        <div className="rounded-2xl border border-af-border bg-af-panel-2/40 p-4">
          <div className="mb-2 flex items-center gap-2 text-sm font-medium text-[var(--af-text)]">
            <HardDrive size={16} className="text-af-accent" /> {t('models.disk')}
          </div>
          <p className="text-xs text-[var(--af-text-2)]">
            {t('models.diskModelsLabel')} <strong>{formatBytes(status?.modelsDirBytes)}</strong>
            {' · '}
            {t('models.diskAppDataLabel')} <strong>{formatBytes(status?.dataDirBytes)}</strong>
          </p>
          {status?.modelsDir && (
            <p className="mt-1 truncate text-[11px] text-[var(--af-text-3)]" title={status.modelsDir}>
              {status.modelsDir}
            </p>
          )}
        </div>

        <div className="rounded-2xl border border-af-border bg-af-panel-2/40 p-4">
          <div className="mb-2 flex items-center gap-2 text-sm font-medium text-[var(--af-text)]">
            <Cpu size={16} className="text-af-accent" /> {t('models.transcriptionAcceleration')}
          </div>
          <div className="space-y-2 text-xs text-[var(--af-text-2)]">
            <div className="flex items-center justify-between gap-3">
              <span>Whisper</span>
              <Pill
                ok={whisperBackend != null && whisperBackend !== 'CPU'}
                label={status?.whisper.loaded ? t('models.backendActive', { backend: whisperBackendLabel }) : whisperBackendLabel}
              />
            </div>
            <div className="flex items-center justify-between gap-3">
              <span>Parakeet</span>
              <Pill ok={parakeetBackend === 'DirectML'} label={parakeetBackend === 'DirectML' ? t('models.directMlEncoder') : 'CPU'} />
            </div>
          </div>
          <p className="mt-2 text-[11px] text-[var(--af-text-3)]">
            {t('models.accelerationDescription', { memoryMb: status?.vramHintMb ?? 0 })}
          </p>
          {parakeetBackend === 'DirectML' && <p className="mt-1 text-[11px] text-[var(--af-text-3)]">
            {t('models.parakeetDirectMlDescription')}
          </p>}
        </div>

        <div className="rounded-2xl border border-af-border bg-af-panel-2/40 p-4">
          <div className="mb-2 flex items-center gap-2 text-sm font-medium text-[var(--af-text)]">
            <RefreshCw size={16} className="text-[var(--af-text-3)]" /> {t('models.idleUnload')}
          </div>
          <p className="text-xs text-[var(--af-text-2)]">
            {t('models.idleUnloadTimes', {
              sttSeconds: status?.sttIdleUnloadSecs ?? '—',
              llmSeconds: status?.llmIdleUnloadSecs ?? '—',
            })}
          </p>
          <p className="mt-1 text-[11px] text-[var(--af-text-3)]">
            {t('models.lastUnloads', {
              stt: formatAgo(status?.sttLastUnloadSecs),
              llm: formatAgo(status?.llmLastUnloadSecs),
            })}
          </p>
          {status?.recording && (
            <p className="mt-1 text-xs text-af-warning">{t('models.recordingUnloadPaused')}</p>
          )}
        </div>

        <div className="rounded-2xl border border-af-border bg-af-panel-2/40 p-4">
          <div className="mb-2 flex items-center gap-2 text-sm font-medium text-[var(--af-text)]">
            <Network size={16} className="text-af-success" /> {t('models.network')}
          </div>
          <div className="flex items-center gap-2">
            <Shield size={14} className="text-af-success" />
            <Pill ok label={t('models.localFirstNoTelemetry')} />
          </div>
          <p className="mt-2 text-xs text-[var(--af-text-3)]">
            {status?.networkNote || t('models.networkNoteDefault')}
          </p>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => void refresh()}
          className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--af-border-strong)] px-3 py-2 text-sm text-[var(--af-text-2)] hover:bg-[var(--af-hover)]"
        >
          <RefreshCw size={14} /> {t('models.refresh')}
        </button>
        <button
          type="button"
          disabled={busy || !!status?.recording}
          onClick={() => void unloadStt()}
          className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--af-border-strong)] px-3 py-2 text-sm text-[var(--af-text-2)] hover:bg-[var(--af-hover)] disabled:opacity-40"
        >
          <Trash2 size={14} /> {t('models.unloadStt')}
        </button>
        <button
          type="button"
          disabled={busy || !!status?.recording}
          onClick={() => void freeAll()}
          className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--af-accent)] px-3 py-2 text-sm font-medium text-white hover:brightness-110 disabled:opacity-40"
        >
          <Trash2 size={14} /> {t('models.freeAllMemory')}
        </button>
      </div>
    </div>
  );
}

export default LocalStackStatus;
