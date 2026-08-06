'use client';

/**
 * Settings → Local stack. Live snapshot of what is loaded on this machine:
 * Whisper/Parakeet STT, CUDA flag, idle-unload timers. Manual unload frees VRAM.
 */

import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'sonner';
import { Cpu, HardDrive, RefreshCw, Trash2, Zap } from 'lucide-react';

type StackStatus = {
  recording: boolean;
  whisper: { loaded: boolean; model: string | null };
  parakeet: { loaded: boolean; model: string | null };
  sttIdleUnloadSecs: number;
  llmIdleUnloadSecs: number;
  cuda: boolean;
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

  const unload = async () => {
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

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-base font-semibold text-[var(--af-text)]">Local stack</h3>
        <p className="mt-1 text-sm text-[var(--af-text-3)]">
          What is loaded on this PC right now. Models unload automatically after idle time to free
          memory — or free them manually below.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-xl border border-[var(--af-border)] bg-[var(--af-panel)] p-4">
          <div className="mb-2 flex items-center gap-2 text-sm font-medium text-[var(--af-text)]">
            <Cpu size={16} className="text-cyan-400" /> Transcription (Whisper)
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
            <Zap size={16} className="text-amber-400" /> Transcription (Parakeet)
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
            <HardDrive size={16} className="text-blue-400" /> Acceleration
          </div>
          <Pill ok={!!status?.cuda} label={status?.cuda ? 'CUDA build' : 'CPU / other build'} />
        </div>

        <div className="rounded-xl border border-[var(--af-border)] bg-[var(--af-panel)] p-4">
          <div className="mb-2 flex items-center gap-2 text-sm font-medium text-[var(--af-text)]">
            <RefreshCw size={16} className="text-[var(--af-text-3)]" /> Idle unload
          </div>
          <p className="text-xs text-[var(--af-text-2)]">
            STT after {status?.sttIdleUnloadSecs ?? '—'}s · LLM after{' '}
            {status?.llmIdleUnloadSecs ?? '—'}s
          </p>
          {status?.recording && (
            <p className="mt-1 text-xs text-amber-300">Recording — unload is paused.</p>
          )}
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
          onClick={() => void unload()}
          className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--af-accent)] px-3 py-2 text-sm font-medium text-white hover:brightness-110 disabled:opacity-40"
        >
          <Trash2 size={14} /> Unload STT models
        </button>
      </div>
    </div>
  );
}

export default LocalStackStatus;
