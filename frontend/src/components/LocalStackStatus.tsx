'use client';

/**
 * Settings → Local stack. Live snapshot of what is loaded on this machine:
 * Whisper/Parakeet STT, disk use, idle unload, free-all memory.
 */

import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'sonner';
import { Cpu, HardDrive, RefreshCw, Trash2, Zap, Shield, Network } from 'lucide-react';

type StackStatus = {
  recording: boolean;
  whisper: { loaded: boolean; model: string | null };
  parakeet: { loaded: boolean; model: string | null };
  sttIdleUnloadSecs: number;
  llmIdleUnloadSecs: number;
  sttLastUnloadSecs?: number;
  llmLastUnloadSecs?: number;
  modelsDirBytes?: number;
  dataDirBytes?: number;
  modelsDir?: string;
  vramHintMb?: number;
  cuda: boolean;
  vulkan?: boolean;
  sttBackend?: string;
  networkPolicy?: string;
  networkNote?: string;
};

function Pill({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
        ok
          ? 'bg-emerald-500/15 text-emerald-300'
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
  if (!unixSecs) return 'never';
  const ago = Math.max(0, Math.floor(Date.now() / 1000) - unixSecs);
  if (ago < 60) return `${ago}s ago`;
  if (ago < 3600) return `${Math.floor(ago / 60)}m ago`;
  if (ago < 86400) return `${Math.floor(ago / 3600)}h ago`;
  return `${Math.floor(ago / 86400)}d ago`;
}

export function LocalStackStatus() {
  const [status, setStatus] = useState<StackStatus | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const s = await invoke<StackStatus>('get_local_stack_status');
      setStatus(s);
    } catch (e) {
      console.error('get_local_stack_status failed', e);
      toast.error('Could not read local stack status');
    }
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 5000);
    return () => clearInterval(t);
  }, [refresh]);

  const unloadStt = async () => {
    setBusy(true);
    try {
      await invoke('force_unload_stt_models');
      toast.success('STT models unloaded');
      await refresh();
    } catch (e) {
      toast.error(typeof e === 'string' ? e : 'Unload failed (recording in progress?)');
    } finally {
      setBusy(false);
    }
  };

  const freeAll = async () => {
    setBusy(true);
    try {
      await invoke('force_unload_all_models');
      toast.success('Freed STT + local LLM memory');
      await refresh();
    } catch (e) {
      toast.error(typeof e === 'string' ? e : 'Free-all failed (recording in progress?)');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-base font-semibold text-[var(--af-text)]">Local stack</h3>
        <p className="mt-1 text-sm text-[var(--af-text-3)]">
          What is loaded on this PC. STT and the local LLM never stay loaded together —
          loading one frees the other so VRAM is not shared.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-xl border border-[var(--af-border)] bg-[var(--af-panel)] p-4">
          <div className="mb-2 flex items-center gap-2 text-sm font-medium text-[var(--af-text)]">
            <Zap size={16} className="text-amber-400" /> Live STT (Parakeet preferred)
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Pill
              ok={!!status?.parakeet.loaded}
              label={status?.parakeet.loaded ? 'Loaded' : 'Unloaded'}
            />
            {status?.parakeet.model && (
              <span className="text-xs text-[var(--af-text-2)]">{status.parakeet.model}</span>
            )}
          </div>
        </div>

        <div className="rounded-xl border border-[var(--af-border)] bg-[var(--af-panel)] p-4">
          <div className="mb-2 flex items-center gap-2 text-sm font-medium text-[var(--af-text)]">
            <Cpu size={16} className="text-cyan-400" /> Post-call STT (Whisper)
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Pill
              ok={!!status?.whisper.loaded}
              label={status?.whisper.loaded ? 'Loaded' : 'Unloaded'}
            />
            {status?.whisper.model && (
              <span className="text-xs text-[var(--af-text-2)]">{status.whisper.model}</span>
            )}
          </div>
        </div>

        <div className="rounded-xl border border-[var(--af-border)] bg-[var(--af-panel)] p-4">
          <div className="mb-2 flex items-center gap-2 text-sm font-medium text-[var(--af-text)]">
            <HardDrive size={16} className="text-blue-400" /> Disk
          </div>
          <p className="text-xs text-[var(--af-text-2)]">
            Models: <strong>{formatBytes(status?.modelsDirBytes)}</strong>
            {' · '}
            App data: <strong>{formatBytes(status?.dataDirBytes)}</strong>
          </p>
          {status?.modelsDir && (
            <p className="mt-1 truncate text-[11px] text-[var(--af-text-3)]" title={status.modelsDir}>
              {status.modelsDir}
            </p>
          )}
        </div>

        <div className="rounded-xl border border-[var(--af-border)] bg-[var(--af-panel)] p-4">
          <div className="mb-2 flex items-center gap-2 text-sm font-medium text-[var(--af-text)]">
            <Cpu size={16} className="text-purple-400" /> Memory / GPU
          </div>
          <Pill
            ok={status?.sttBackend !== 'CPU'}
            label={`${status?.sttBackend || (status?.cuda ? 'CUDA' : status?.vulkan ? 'Vulkan' : 'CPU')} build`}
          />
          <p className="mt-1 text-xs text-[var(--af-text-2)]">
            Rough STT VRAM in use: ~{status?.vramHintMb ?? 0} MB
          </p>
        </div>

        <div className="rounded-xl border border-[var(--af-border)] bg-[var(--af-panel)] p-4">
          <div className="mb-2 flex items-center gap-2 text-sm font-medium text-[var(--af-text)]">
            <RefreshCw size={16} className="text-[var(--af-text-3)]" /> Idle unload
          </div>
          <p className="text-xs text-[var(--af-text-2)]">
            STT after {status?.sttIdleUnloadSecs ?? '—'}s · LLM after{' '}
            {status?.llmIdleUnloadSecs ?? '—'}s
          </p>
          <p className="mt-1 text-[11px] text-[var(--af-text-3)]">
            Last STT unload: {formatAgo(status?.sttLastUnloadSecs)} · Last LLM unload:{' '}
            {formatAgo(status?.llmLastUnloadSecs)}
          </p>
          {status?.recording && (
            <p className="mt-1 text-xs text-amber-300">Recording — unload is paused.</p>
          )}
        </div>

        <div className="rounded-xl border border-[var(--af-border)] bg-[var(--af-panel)] p-4">
          <div className="mb-2 flex items-center gap-2 text-sm font-medium text-[var(--af-text)]">
            <Network size={16} className="text-emerald-400" /> Network
          </div>
          <div className="flex items-center gap-2">
            <Shield size={14} className="text-emerald-400" />
            <Pill ok label="Local-first · no telemetry" />
          </div>
          <p className="mt-2 text-xs text-[var(--af-text-3)]">
            {status?.networkNote ||
              'Nothing leaves this PC unless you add a cloud API key and choose that provider for summaries.'}
          </p>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => void refresh()}
          className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--af-border-strong)] px-3 py-2 text-sm text-[var(--af-text-2)] hover:bg-[var(--af-hover)]"
        >
          <RefreshCw size={14} /> Refresh
        </button>
        <button
          type="button"
          disabled={busy || !!status?.recording}
          onClick={() => void unloadStt()}
          className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--af-border-strong)] px-3 py-2 text-sm text-[var(--af-text-2)] hover:bg-[var(--af-hover)] disabled:opacity-40"
        >
          <Trash2 size={14} /> Unload STT
        </button>
        <button
          type="button"
          disabled={busy || !!status?.recording}
          onClick={() => void freeAll()}
          className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--af-accent)] px-3 py-2 text-sm font-medium text-white hover:brightness-110 disabled:opacity-40"
        >
          <Trash2 size={14} /> Free all memory
        </button>
      </div>
    </div>
  );
}

export default LocalStackStatus;
