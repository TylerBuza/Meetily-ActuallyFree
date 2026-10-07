import { useEffect, useState } from 'react';
const KEY = 'meetily-transcript-left-aligned';
const EVENT = 'meetily-transcript-layout-changed';
export function useTranscriptLeftAligned() {
  return useLayoutPreference(KEY);
}
export function useTranscriptHideSpeakerDots() {
  return useLayoutPreference('meetily-transcript-hide-speaker-dots');
}
function useLayoutPreference(key: string) {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    const refresh = () => setEnabled(localStorage.getItem(key) === 'true');
    refresh();
    window.addEventListener(EVENT, refresh);
    window.addEventListener('storage', refresh);
    return () => { window.removeEventListener(EVENT, refresh); window.removeEventListener('storage', refresh); };
  }, [key]);
  const save = (value: boolean) => {
    localStorage.setItem(key, String(value));
    window.dispatchEvent(new Event(EVENT));
  };
  return [enabled, save] as const;
}
