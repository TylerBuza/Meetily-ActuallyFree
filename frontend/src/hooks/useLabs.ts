'use client';

import { useEffect, useState } from 'react';
import { defaultLabsPreferences, LABS_CHANGED_EVENT, loadLabsPreferences, type LabsPreferences } from '@/lib/labs';

/**
 * The Labs switches, kept current as they change. `ready` turns true once the
 * saved values are read, so a page can wait before acting on them (e.g. before
 * writing a summary from the clean transcript).
 */
export function useLabs(): { labs: LabsPreferences; ready: boolean } {
  const [labs, setLabs] = useState<LabsPreferences>(defaultLabsPreferences);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const refresh = () => setLabs(loadLabsPreferences());
    refresh();
    setReady(true);
    window.addEventListener(LABS_CHANGED_EVENT, refresh);
    return () => window.removeEventListener(LABS_CHANGED_EVENT, refresh);
  }, []);

  return { labs, ready };
}
