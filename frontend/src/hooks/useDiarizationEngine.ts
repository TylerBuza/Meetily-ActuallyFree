import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen, UnlistenFn } from '@tauri-apps/api/event';

/** Refresh when a speaker dialog opens, so its controls match the selected engine. */
export function useDiarizationEngine(active: boolean) {
  const [engine, setEngine] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    let revision = 0;
    let stop: UnlistenFn | undefined;
    setEngine(null);
    setError(null);
    const refresh = () => {
      const request = ++revision;
      void invoke<{ active_engine: string }>('diarization_get_status')
        .then(status => { if (!cancelled && request === revision) { setEngine(status.active_engine); setError(null); } })
        .catch(() => { if (!cancelled && request === revision) setError('Could not load the selected diarization engine. Reopen this dialog to retry.'); });
    };
    void listen('diarization-engine-changed', refresh).then(unlisten => {
      if (cancelled) unlisten(); else { stop = unlisten; refresh(); }
    }).catch(error => { console.error('Could not listen for engine changes:', error); if (!cancelled) refresh(); });
    return () => { cancelled = true; stop?.(); };
  }, [active]);
  return { engine, error, isNemotron: engine === 'nemotron' };
}
