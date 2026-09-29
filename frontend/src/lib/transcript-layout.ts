import { useEffect, useState } from 'react';
const KEY = 'meetily-transcript-left-aligned';
const EVENT = 'meetily-transcript-layout-changed';
export function useTranscriptLeftAligned() {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    const refresh = () => setEnabled(localStorage.getItem(KEY) === 'true');
    refresh();
    window.addEventListener(EVENT, refresh);
    window.addEventListener('storage', refresh);
    return () => { window.removeEventListener(EVENT, refresh); window.removeEventListener('storage', refresh); };
  }, []);
  const save = (value: boolean) => {
    localStorage.setItem(KEY, String(value));
    window.dispatchEvent(new Event(EVENT));
  };
  return [enabled, save] as const;
}
