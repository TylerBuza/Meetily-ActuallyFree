import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen, UnlistenFn } from '@tauri-apps/api/event';

export interface DiarizationStatusInfo {
  active_engine: string;
  pyannote_available: boolean;
  nemotron_available: boolean;
  current_available: boolean;
}

/** Refresh when active (defaults to true), so its controls match the selected engine. */
export function useDiarizationEngine(active: boolean = true) {
  const [engine, setEngine] = useState<string | null>(null);
  const [status, setStatus] = useState<DiarizationStatusInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    let revision = 0;
    let stop: UnlistenFn | undefined;
    setError(null);
    const refresh = () => {
      const request = ++revision;
      void invoke<DiarizationStatusInfo>('diarization_get_status')
        .then((s) => {
          if (!cancelled && request === revision) {
            setEngine(s.active_engine);
            setStatus(s);
            setError(null);
          }
        })
        .catch(() => {
          if (!cancelled && request === revision)
            setError('Could not load the selected diarization engine.');
        });
    };
    refresh();
    void listen('diarization-engine-changed', refresh)
      .then((unlisten) => {
        if (cancelled) unlisten();
        else {
          stop = unlisten;
          refresh();
        }
      })
      .catch((err) => {
        console.error('Could not listen for engine changes:', err);
        if (!cancelled) refresh();
      });
    return () => {
      cancelled = true;
      stop?.();
    };
  }, [active]);

  return {
    engine,
    status,
    error,
    isNemotron: engine === 'nemotron',
    pyannoteAvailable: status?.pyannote_available ?? false,
    nemotronAvailable: status?.nemotron_available ?? false,
    currentAvailable: status?.current_available ?? false,
  };
}
