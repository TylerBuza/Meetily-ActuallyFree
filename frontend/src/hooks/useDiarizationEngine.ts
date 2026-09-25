import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';

/** Refresh when a speaker dialog opens, so its controls match the selected engine. */
export function useDiarizationEngine(active: boolean) {
  const [engine, setEngine] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    setEngine(null);
    setError(null);
    invoke<{ active_engine: string }>('diarization_get_status')
      .then(status => { if (!cancelled) setEngine(status.active_engine); })
      .catch(() => { if (!cancelled) setError('Could not load the selected diarization engine. Reopen this dialog to retry.'); });
    return () => { cancelled = true; };
  }, [active]);
  return { engine, error, isNemotron: engine === 'nemotron' };
}
